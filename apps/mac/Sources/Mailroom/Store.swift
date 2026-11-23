import AppKit
import Foundation
import Observation
import UserNotifications

/// A message being written. Lives in the store so its window can be closed and reopened (undo send).
struct ComposeDraft: Identifiable, Hashable {
	let id: UUID
	var title = "New Message"
	var mailboxId: String?
	var to = ""
	var cc = ""
	var bcc = ""
	var subject = ""
	var body = ""
	var quotedHTML = ""
	var replyToMessageId: String?
	var forwardOfMessageId: String?
	var forwardAttachments: [Attachment] = []
	var uploads: [Upload] = []
	var includeSignature = true
}

struct Banner: Identifiable, Equatable {
	let id = UUID()
	let text: String
	var actionTitle: String?
	var isError = false
	var action: (() -> Void)?

	static func == (a: Banner, b: Banner) -> Bool { a.id == b.id }
}

enum Phase { case starting, signedOut, signedIn }

@MainActor
@Observable
final class AppStore {
	static let shared = AppStore()

	// Session
	var phase: Phase = .starting
	var server: String = UserDefaults.standard.string(forKey: "server") ?? "https://mail.lue.my"
	private(set) var token: String?
	var user: User?

	// Data
	var boot: Bootstrap?
	var selection: SidebarItem? = .view("inbox")
	var search = ""
	var threads: [ThreadRow] = []
	var nextCursor: String?
	var loadingThreads = false
	var selectedThreadId: String?
	var thread: MailThread?
	var loadingThread = false
	var outbox: [OutboxItem] = []
	var templates: [Template] = []

	var branding = Branding.standard

	// UI
	var drafts: [UUID: ComposeDraft] = [:]
	var banner: Banner?
	var notificationsOn = UserDefaults.standard.object(forKey: "notifications") as? Bool ?? true

	private var events: Task<Void, Never>?
	private var refreshTask: Task<Void, Never>?
	private var listGeneration = 0

	var api: API { API(server: server, token: token) }
	var myAddresses: Set<String> { Set(boot?.mailboxes.map(\.address) ?? []) }

	// MARK: Session

	func start() async {
		// Dev hook: MAILROOM_SERVER + MAILROOM_TOKEN skip the keychain (used to test against a local server)
		let env = ProcessInfo.processInfo.environment
		if let s = env["MAILROOM_SERVER"] { server = s }
		if env["MAILROOM_SERVER"] != nil, let t = env["MAILROOM_TOKEN"] {
			token = t
		} else {
			token = Keychain.read("token:\(API.normalize(server))")
		}
		guard token != nil else { return phase = .signedOut }
		do {
			struct Me: Decodable { let user: User }
			user = try await api.get("/auth/me", as: Me.self).user
			phase = .signedIn
			await afterSignIn()
		} catch let error as APIError where error.status == 401 {
			token = nil
			phase = .signedOut
		} catch {
			// Offline: stay signed in with what we have and retry through the event stream
			phase = .signedIn
			banner = Banner(text: error.localizedDescription, isError: true)
			await afterSignIn()
		}
	}

	func signIn(server: String, email: String, password: String) async throws {
		let server = API.normalize(server)
		struct Body: Encodable {
			let email: String
			let password: String
			let client = "native"
			let device: String
		}
		struct Out: Decodable {
			let user: User
			let token: String
		}
		let device = "Mac app (\(Host.current().localizedName ?? "Mac"))"
		let out: Out = try await API(server: server, token: nil).post("/auth/login", Body(email: email, password: password, device: device))
		self.server = server
		UserDefaults.standard.set(server, forKey: "server")
		token = out.token
		Keychain.write("token:\(server)", out.token)
		user = out.user
		phase = .signedIn
		await afterSignIn()
	}

	func signOut() async {
		_ = try? await api.send("/auth/logout", method: "POST", body: [String: String]())
		Keychain.write("token:\(API.normalize(server))", nil)
		events?.cancel()
		token = nil
		user = nil
		boot = nil
		threads = []
		thread = nil
		selectedThreadId = nil
		phase = .signedOut
		NSApp.dockTile.badgeLabel = nil
	}

	private func afterSignIn() async {
		// Never wait on the permission prompt: mail loads while it is up. Skipped in dev runs (MAILROOM_TOKEN).
		if notificationsOn, ProcessInfo.processInfo.environment["MAILROOM_TOKEN"] == nil {
			Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
		}
		startEvents()
		async let a: Void = refreshBoot()
		async let b: Void = reloadThreads()
		async let c: Void = loadTemplates()
		async let d: Void = loadBranding()
		_ = await (a, b, c, d)
		if ProcessInfo.processInfo.environment["MAILROOM_OPEN_FIRST"] != nil, let first = threads.first {
			selectedThreadId = first.threadId
		}
	}

	// MARK: Data

	/// Public, so the sign-in screen can show it before there is a session
	func loadBranding(server: String? = nil) async {
		let target = API(server: server ?? self.server, token: nil)
		if let b = try? await target.get("/branding", as: Branding.self) { branding = b } else if server != nil { branding = .standard }
	}

	func refreshBoot() async {
		guard phase == .signedIn else { return }
		do {
			boot = try await api.get("/bootstrap", as: Bootstrap.self)
			let unread = boot?.unread ?? 0
			NSApp.dockTile.badgeLabel = unread > 0 ? (unread > 999 ? "999+" : String(unread)) : nil
		} catch {
			report(error)
		}
	}

	private func threadsQuery(cursor: String? = nil) -> String? {
		guard var q = selection?.query else { return nil }
		let term = search.trimmingCharacters(in: .whitespaces)
		if !term.isEmpty {
			if case .view("inbox") = selection { q = "view=all" }
			q += "&q=\(term.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? term)"
		}
		q += "&limit=50"
		if let cursor { q += "&cursor=\(cursor)" }
		return q
	}

	func reloadThreads() async {
		listGeneration += 1
		let generation = listGeneration
		if selection == .scheduled {
			await loadOutbox()
			return
		}
		guard let q = threadsQuery() else { return }
		loadingThreads = threads.isEmpty
		defer { if generation == listGeneration { loadingThreads = false } }
		do {
			let page = try await api.get("/threads?\(q)", as: ThreadPage.self)
			guard generation == listGeneration else { return }
			threads = page.threads
			nextCursor = page.next
		} catch {
			report(error)
		}
	}

	func loadMore() async {
		guard let cursor = nextCursor, let q = threadsQuery(cursor: cursor), !loadingThreads else { return }
		nextCursor = nil
		do {
			let page = try await api.get("/threads?\(q)", as: ThreadPage.self)
			let known = Set(threads.map(\.threadId))
			threads += page.threads.filter { !known.contains($0.threadId) }
			nextCursor = page.next
		} catch {
			report(error)
		}
	}

	func openThread(_ id: String?) async {
		guard let id else {
			thread = nil
			return
		}
		if thread?.threadId != id { loadingThread = true }
		defer { loadingThread = false }
		do {
			let t = try await api.get("/threads/\(id)", as: MailThread.self)
			guard selectedThreadId == id else { return }
			thread = t
			if t.messages.contains(where: { !$0.seen }) {
				try? await Task.sleep(for: .milliseconds(500))
				if selectedThreadId == id { await act([id], "read", quiet: true) }
			}
		} catch {
			report(error)
		}
	}

	func loadOutbox() async {
		struct Out: Decodable { let items: [OutboxItem] }
		do {
			outbox = try await api.get("/outbox?status=queued,failed", as: Out.self).items.filter {
				$0.status == "failed" || Dates.parse($0.sendAt) > Date().addingTimeInterval(5)
			}
		} catch {
			report(error)
		}
	}

	func loadTemplates() async {
		struct Out: Decodable { let templates: [Template] }
		templates = (try? await api.get("/templates", as: Out.self).templates) ?? []
	}

	/// Coalesces bursts of server events (a history backfill sends many) into one refresh
	func scheduleRefresh() {
		refreshTask?.cancel()
		refreshTask = Task {
			try? await Task.sleep(for: .milliseconds(600))
			guard !Task.isCancelled else { return }
			await refreshBoot()
			await reloadThreads()
			if let id = selectedThreadId, thread?.threadId == id {
				thread = try? await api.get("/threads/\(id)", as: MailThread.self)
			}
		}
	}

	// MARK: Actions

	private static let removing: Set<String> = ["archive", "trash", "spam", "notspam", "inbox", "move", "snooze", "delete", "unsnooze"]
	private static let doneText: [String: String] = [
		"archive": "Archived", "trash": "Moved to Trash", "spam": "Marked as spam", "inbox": "Moved to Inbox",
		"notspam": "Moved to Inbox", "snooze": "Snoozed", "delete": "Deleted forever", "move": "Moved",
	]

	func act(_ ids: [String], _ action: String, folderId: String? = nil, until: Date? = nil, quiet: Bool = false) async {
		struct Body: Encodable {
			let threadIds: [String]
			let action: String
			let folderId: String?
			let until: String?
		}
		if Self.removing.contains(action) {
			// Out of the list right away; the selection moves to the next thread like Mail does
			if let current = selectedThreadId, ids.contains(current) {
				let index = threads.firstIndex { $0.threadId == current } ?? 0
				let rest = threads.filter { !ids.contains($0.threadId) }
				selectedThreadId = rest.isEmpty ? nil : rest[min(index, rest.count - 1)].threadId
			}
			threads.removeAll { ids.contains($0.threadId) }
		}
		do {
			try await api.send("/threads/actions", method: "POST", body: Body(threadIds: ids, action: action, folderId: folderId, until: until.map(Dates.string)))
			if !quiet, let text = Self.doneText[action] {
				let undo: String? = ["archive", "trash", "spam"].contains(action) ? "inbox" : action == "snooze" ? "unsnooze" : nil
				show(Banner(text: text, actionTitle: undo == nil ? nil : "Undo", action: undo.map { u in { Task { await self.act(ids, u, quiet: true) } } }))
			}
		} catch {
			report(error)
		}
		await refreshBoot()
		if !Self.removing.contains(action) { await reloadThreads() }
		if let id = selectedThreadId, ids.contains(id), !Self.removing.contains(action) {
			thread = try? await api.get("/threads/\(id)", as: MailThread.self)
		}
	}

	func show(_ b: Banner) {
		banner = b
		let id = b.id
		Task {
			try? await Task.sleep(for: .seconds(b.actionTitle == "Undo" && b.text.hasPrefix("Sending") ? 12 : 6))
			if banner?.id == id { banner = nil }
		}
	}

	func report(_ error: Error) {
		if let e = error as? APIError, e.status == 401 {
			Task { await signOut() }
			return
		}
		show(Banner(text: error.localizedDescription, isError: true))
	}

	// MARK: Compose

	func newDraft(_ draft: ComposeDraft? = nil) -> UUID {
		var d = draft ?? ComposeDraft(id: UUID())
		if d.mailboxId == nil {
			switch selection {
			case let .mailbox(id): d.mailboxId = id
			case let .project(id): d.mailboxId = boot?.projects.first { $0.id == id }?.mailboxes.first?.id
			default: d.mailboxId = boot?.mailboxes.first?.id
			}
		}
		drafts[d.id] = d
		return d.id
	}

	func replyDraft(_ kind: String, to m: Message) -> ComposeDraft {
		var d = ComposeDraft(id: UUID())
		d.mailboxId = m.mailboxId
		let subject = m.subject
		if kind == "forward" {
			d.title = "Forward"
			d.subject = subject.lowercased().hasPrefix("fwd:") || subject.lowercased().hasPrefix("fw:") ? subject : "Fwd: \(subject)"
			let header = [
				"---------- Forwarded message ---------",
				"From: \(escapeHTML(m.from.full))",
				"Date: \(escapeHTML(Dates.full(m.date)))",
				"Subject: \(escapeHTML(subject))",
				"To: \(escapeHTML(m.to.map(\.full).joined(separator: ", ")))",
			].joined(separator: "<br>")
			d.quotedHTML = "<div>\(header)<br><br>\(m.html ?? "")</div>"
			d.forwardOfMessageId = m.id
			d.forwardAttachments = m.attachments.filter { !$0.inline }
			return d
		}
		let me = myAddresses
		let fromMe = me.contains(m.from.address)
		let primary = fromMe ? m.to : (m.replyTo.isEmpty ? [m.from] : m.replyTo)
		var to = primary
		var cc: [Address] = []
		if kind == "replyAll" {
			var seen = Set(primary.map(\.address))
			let keep: (Address) -> Bool = { a in
				guard !me.contains(a.address), !seen.contains(a.address) else { return false }
				seen.insert(a.address)
				return true
			}
			if !fromMe { to += m.to.filter(keep) }
			cc = m.cc.filter(keep)
		}
		d.title = kind == "replyAll" ? "Reply All" : "Reply"
		d.to = to.map(\.full).joined(separator: ", ")
		d.cc = cc.map(\.full).joined(separator: ", ")
		d.subject = subject.lowercased().hasPrefix("re:") ? subject : "Re: \(subject)"
		d.quotedHTML = "<div>On \(escapeHTML(Dates.full(m.date))), \(escapeHTML(m.from.full)) wrote:</div><blockquote style=\"margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex\">\(m.html ?? "")</blockquote>"
		d.replyToMessageId = m.id
		return d
	}

	func signature(for mailboxId: String?) -> String {
		boot?.mailboxes.first { $0.id == mailboxId }?.signature ?? ""
	}

	/// Sends (or schedules) a draft. Returns false when it stays open because something is missing.
	func send(_ draftId: UUID, at sendAt: Date? = nil) async -> Bool {
		guard let d = drafts[draftId] else { return false }
		guard let mailboxId = d.mailboxId else {
			show(Banner(text: "Pick a mailbox to send from", isError: true))
			return false
		}
		let to = parseAddresses(d.to), cc = parseAddresses(d.cc), bcc = parseAddresses(d.bcc)
		if to.isEmpty && cc.isEmpty && bcc.isEmpty {
			show(Banner(text: "Add at least one recipient", isError: true))
			return false
		}
		if let bad = (to + cc + bcc).first(where: { !isEmail($0.address) }) {
			show(Banner(text: "\"\(bad.address)\" is not a valid address", isError: true))
			return false
		}
		var html = textToHTML(d.body)
		let sig = signature(for: mailboxId)
		if d.includeSignature, !sig.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			html += "<div class=\"mr-signature\" style=\"margin-top:14px\">\(sig)</div>"
		}
		if !d.quotedHTML.isEmpty { html += "<div class=\"mr-quoted\" style=\"margin-top:18px\">\(d.quotedHTML)</div>" }
		let payload = ComposePayload(
			mailboxId: mailboxId, to: to, cc: cc, bcc: bcc, subject: d.subject, html: html,
			replyToMessageId: d.replyToMessageId, forwardOfMessageId: d.forwardOfMessageId,
			attachmentIds: d.uploads.map(\.id), forwardAttachments: d.forwardAttachments.map(\.partId)
		)
		struct Body: Encodable {
			let payload: ComposePayload
			let sendAt: String?
		}
		struct Out: Decodable { let item: OutboxItem }
		do {
			let out: Out = try await api.post("/send", Body(payload: payload, sendAt: sendAt.map(Dates.string)))
			drafts[draftId] = nil
			let reopen: () -> Void = { [weak self] in
				Task {
					guard let self else { return }
					do {
						try await self.api.send("/outbox/\(out.item.id)/cancel", method: "POST", body: [String: String]())
						self.drafts[d.id] = d
						self.reopenDraft = d.id
					} catch {
						self.report(error)
					}
				}
			}
			if let sendAt {
				show(Banner(text: "Scheduled for \(sendAt.formatted(date: .abbreviated, time: .shortened))", actionTitle: "Undo", action: reopen))
			} else if (user?.settings.undoSeconds ?? 10) > 0 {
				show(Banner(text: "Sending...", actionTitle: "Undo", action: reopen))
			} else {
				show(Banner(text: "Sent"))
			}
			await refreshBoot()
			return true
		} catch {
			report(error)
			return false
		}
	}

	/// Set when undo send brings a draft back; the main window opens a compose window for it
	var reopenDraft: UUID?

	func cancelScheduled(_ item: OutboxItem, edit: Bool) async {
		do {
			try await api.send("/outbox/\(item.id)/cancel", method: "POST", body: [String: String]())
			if edit {
				var d = ComposeDraft(id: UUID())
				d.title = "Edit Scheduled Message"
				d.mailboxId = item.mailboxId
				d.to = item.payload.to.map(\.full).joined(separator: ", ")
				d.cc = item.payload.cc.map(\.full).joined(separator: ", ")
				d.bcc = item.payload.bcc.map(\.full).joined(separator: ", ")
				d.subject = item.payload.subject
				d.quotedHTML = item.payload.html
				d.includeSignature = false
				d.replyToMessageId = item.payload.replyToMessageId
				drafts[d.id] = d
				reopenDraft = d.id
			}
		} catch {
			report(error)
		}
		await loadOutbox()
		await refreshBoot()
	}

	func sendNow(_ item: OutboxItem) async {
		struct Body: Encodable { let sendAt = "now" }
		do {
			try await api.send("/outbox/\(item.id)", method: "PATCH", body: Body())
			show(Banner(text: "Sending now"))
		} catch {
			report(error)
		}
		await loadOutbox()
	}

	func contacts(_ q: String) async -> [Contact] {
		struct Out: Decodable { let contacts: [Contact] }
		let term = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
		return (try? await api.get("/contacts?q=\(term)", as: Out.self).contacts) ?? []
	}

	/// Downloads an attachment to ~/Downloads and shows it in Finder
	func download(_ attachment: Attachment, of message: Message) async {
		do {
			let r = try api.request("/messages/\(message.id)/attachments/\(attachment.partId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? attachment.partId)", timeout: 120)
			let data = try await api.run(r)
			let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
			var target = folder.appendingPathComponent(attachment.filename)
			var n = 1
			let base = (attachment.filename as NSString).deletingPathExtension
			let ext = (attachment.filename as NSString).pathExtension
			while FileManager.default.fileExists(atPath: target.path) {
				n += 1
				target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
			}
			try data.write(to: target)
			NSWorkspace.shared.activateFileViewerSelecting([target])
		} catch {
			report(error)
		}
	}

	// MARK: Live updates

	private func startEvents() {
		events?.cancel()
		events = Task { [weak self] in
			var backoff: UInt64 = 2
			while !Task.isCancelled {
				guard let self, let r = try? self.api.request("/events", timeout: 120) else { return }
				do {
					let (bytes, response) = try await URLSession.shared.bytes(for: r)
					if (response as? HTTPURLResponse)?.statusCode == 401 {
						await self.signOut()
						return
					}
					backoff = 2
					// Catch up on anything missed while disconnected
					self.scheduleRefresh()
					for try await line in bytes.lines {
						guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8),
						      let event = try? JSONDecoder().decode(ServerEvent.self, from: data) else { continue }
						self.handle(event)
					}
				} catch {}
				try? await Task.sleep(for: .seconds(Double(backoff)))
				backoff = min(backoff * 2, 60)
			}
		}
	}

	private func handle(_ event: ServerEvent) {
		switch event.type {
		case "messages":
			scheduleRefresh()
			if let mails = event.newInbox, !mails.isEmpty, notificationsOn, !NSApp.isActive {
				for m in mails.prefix(3) {
					let content = UNMutableNotificationContent()
					content.title = m.from.display
					content.body = m.subject.isEmpty ? "(no subject)" : m.subject
					content.sound = .default
					UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: m.messageId, content: content, trigger: nil))
				}
			}
		case "branding":
			Task { await loadBranding() }
		case "outbox":
			if event.status == "failed" { show(Banner(text: "A message could not be sent: \(event.error ?? "")", isError: true)) }
			if selection == .scheduled { Task { await loadOutbox() } }
			Task { await refreshBoot() }
		default:
			Task { await refreshBoot() }
		}
	}
}

// MARK: Helpers

func escapeHTML(_ s: String) -> String {
	s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
		.replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}

/// Plain text from the composer to simple HTML: paragraphs, line breaks, links
func textToHTML(_ text: String) -> String {
	let paragraphs = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n")
	return paragraphs.map { p in
		let lines = p.components(separatedBy: "\n").map { line -> String in
			var l = escapeHTML(line)
			if let re = try? NSRegularExpression(pattern: "(https?://[^\\s<]+)") {
				l = re.stringByReplacingMatches(in: l, range: NSRange(l.startIndex..., in: l), withTemplate: "<a href=\"$1\">$1</a>")
			}
			return l
		}
		return "<p>\(lines.joined(separator: "<br>"))</p>"
	}.joined()
}

func parseAddresses(_ input: String) -> [Address] {
	input.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" }).compactMap { raw in
		let s = raw.trimmingCharacters(in: .whitespaces)
		guard !s.isEmpty else { return nil }
		if let lt = s.lastIndex(of: "<"), let gt = s.lastIndex(of: ">"), lt < gt {
			let name = s[..<lt].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
			return Address(name: name, address: s[s.index(after: lt) ..< gt].lowercased())
		}
		return Address(name: "", address: s.lowercased())
	}
}

func isEmail(_ s: String) -> Bool {
	s.range(of: #"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$"#, options: .regularExpression) != nil
}

func fileSize(_ bytes: Int) -> String {
	ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}
