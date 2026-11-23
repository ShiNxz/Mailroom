import SwiftUI

struct ThreadDetailView: View {
	@Environment(AppStore.self) private var store
	@Environment(\.openWindow) private var openWindow
	@State private var expanded = Set<String>()

	var body: some View {
		Group {
			if let thread = store.thread, thread.threadId == store.selectedThreadId {
				ScrollView {
					VStack(alignment: .leading, spacing: 10) {
						Text(thread.subject.isEmpty ? "(no subject)" : thread.subject)
							.font(.title2.weight(.semibold))
							.textSelection(.enabled)
							.padding(.bottom, 6)
						ForEach(thread.messages) { m in
							MessageCard(message: m, expanded: expanded.contains(m.id)) {
								if expanded.contains(m.id) { expanded.remove(m.id) } else { expanded.insert(m.id) }
							} reply: { kind in
								openWindow(id: "compose", value: store.newDraft(store.replyDraft(kind, to: m)))
							}
						}
						HStack {
							Button { reply("reply") } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
							Button { reply("replyAll") } label: { Label("Reply All", systemImage: "arrowshape.turn.up.left.2") }
							Button { reply("forward") } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
						}
						.controlSize(.large)
						.padding(.top, 6)
					}
					.frame(maxWidth: 900, alignment: .leading)
					.padding(24)
					.frame(maxWidth: .infinity)
				}
				.onAppear { expandDefault(thread) }
				.onChange(of: thread.threadId) { _, _ in expandDefault(thread) }
				.onChange(of: thread.messages.count) { _, _ in expandDefault(thread) }
			} else if store.selectedThreadId != nil {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			} else {
				ContentUnavailableView("No Conversation Selected", systemImage: "envelope.open", description: Text("⌘N writes a new message."))
			}
		}
		.toolbar { toolbar }
	}

	private func expandDefault(_ thread: MailThread) {
		expanded = Set(thread.messages.enumerated().filter { i, m in !m.seen || i == thread.messages.count - 1 }.map(\.element.id))
	}

	private func reply(_ kind: String) {
		if let m = store.thread?.messages.last { openWindow(id: "compose", value: store.newDraft(store.replyDraft(kind, to: m))) }
	}

	@ToolbarContentBuilder
	private var toolbar: some ToolbarContent {
		let ids = store.selectedThreadId.map { [$0] } ?? []
		let none = ids.isEmpty || store.thread == nil
		let folders = store.boot?.folders ?? []
		let uses = Set(store.thread?.messages.compactMap { m in folders.first { $0.id == m.folderId }?.specialUse } ?? [])
		let starred = store.thread?.messages.contains { $0.flagged } ?? false
		ToolbarItemGroup {
			if uses.contains("inbox") || none {
				Button { Task { await store.act(ids, "archive") } } label: { Label("Archive", systemImage: "archivebox") }
					.help("Archive (⌘E)").disabled(none)
			} else {
				Button { Task { await store.act(ids, "inbox") } } label: { Label("Move to Inbox", systemImage: "tray.and.arrow.down") }
					.help("Move to Inbox")
			}
			if uses == ["trash"] {
				Button { Task { await store.act(ids, "delete") } } label: { Label("Delete Forever", systemImage: "trash.slash") }
					.help("Delete forever")
			} else {
				Button { Task { await store.act(ids, "trash") } } label: { Label("Delete", systemImage: "trash") }
					.help("Move to Trash (⌘⌫)").disabled(none)
			}
			if uses.contains("junk") {
				Button { Task { await store.act(ids, "notspam") } } label: { Label("Not Spam", systemImage: "checkmark.shield") }
			} else {
				Button { Task { await store.act(ids, "spam") } } label: { Label("Spam", systemImage: "xmark.bin") }
					.help("Mark as spam").disabled(none)
			}
			Button { Task { await store.act(ids, "unread") } } label: { Label("Mark Unread", systemImage: "envelope.badge") }
				.help("Mark as unread (⇧⌘U)").disabled(none)
			Menu {
				SnoozeItems(ids: ids)
			} label: {
				Label("Snooze", systemImage: "clock")
			}
			.help("Snooze").disabled(none)
			Menu {
				ForEach(folders.filter { $0.mailboxId == store.thread?.mailboxId && !["flagged", "all"].contains($0.specialUse ?? "") }) { f in
					Button(f.path) { Task { await store.act(ids, "move", folderId: f.id) } }
				}
			} label: {
				Label("Move", systemImage: "folder")
			}
			.help("Move to folder").disabled(none)
			Button { Task { await store.act(ids, starred ? "unstar" : "star") } } label: {
				Label(starred ? "Unstar" : "Star", systemImage: starred ? "star.fill" : "star")
			}
			.help("Star (⇧⌘L)").disabled(none)
		}
	}
}

struct MessageCard: View {
	let message: Message
	let expanded: Bool
	let toggle: () -> Void
	let reply: (String) -> Void
	@Environment(AppStore.self) private var store
	@State private var height: CGFloat = 60
	@State private var showImages = false

	private var imagesAllowed: Bool { showImages || (store.user?.settings.showImages ?? false) }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .top, spacing: 10) {
				Avatar(address: message.from, size: expanded ? 34 : 26)
				VStack(alignment: .leading, spacing: 2) {
					HStack(alignment: .firstTextBaseline, spacing: 6) {
						Text(message.from.display).fontWeight(.semibold)
						if expanded { Text("<\(message.from.address)>").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
					}
					if expanded {
						Text(recipients).font(.caption).foregroundStyle(.secondary).lineLimit(2)
					} else {
						Text(message.snippet).font(.callout).foregroundStyle(.secondary).lineLimit(1)
					}
				}
				Spacer()
				Text(Dates.full(message.date)).font(.caption).foregroundStyle(.secondary)
				if expanded {
					Menu {
						Button("Reply") { reply("reply") }
						Button("Reply All") { reply("replyAll") }
						Button("Forward") { reply("forward") }
					} label: {
						Image(systemName: "arrowshape.turn.up.left")
					} primaryAction: {
						reply("reply")
					}
					.menuStyle(.borderlessButton)
					.fixedSize()
				}
			}
			.padding(14)
			.contentShape(Rectangle())
			.onTapGesture(perform: toggle)

			if expanded {
				if message.hasRemoteImages && !imagesAllowed {
					HStack {
						Image(systemName: "photo.badge.exclamationmark")
						Text("Remote images are hidden so the sender can't tell you opened this.")
						Spacer()
						Button("Show Images") { showImages = true }.buttonStyle(.link)
					}
					.font(.caption)
					.foregroundStyle(.secondary)
					.padding(.horizontal, 14)
					.padding(.bottom, 10)
				}
				if let html = message.html {
					MessageWebView(html: html, allowImages: imagesAllowed, height: $height)
						.frame(height: height)
						.clipShape(RoundedRectangle(cornerRadius: 8))
						.padding(.horizontal, 14)
						.padding(.bottom, 14)
				}
				let files = message.attachments.filter { !($0.inline && $0.cid != nil && (message.html ?? "").contains("/attachments/\($0.partId)")) }
				if !files.isEmpty {
					Divider()
					AttachmentGrid(files: files) { a in Task { await store.download(a, of: message) } }
						.padding(14)
				}
			}
		}
		.background(.background, in: RoundedRectangle(cornerRadius: 12))
		.overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
	}

	private var recipients: String {
		let me = store.myAddresses
		let name: (Address) -> String = { me.contains($0.address) ? "me" : $0.display }
		var s = "to " + (message.to.isEmpty ? "undisclosed recipients" : message.to.map(name).joined(separator: ", "))
		if !message.cc.isEmpty { s += ", cc " + message.cc.map(name).joined(separator: ", ") }
		return s
	}
}

struct AttachmentGrid: View {
	let files: [Attachment]
	let open: (Attachment) -> Void

	var body: some View {
		LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
			ForEach(files) { a in
				Button { open(a) } label: {
					HStack(spacing: 6) {
						Image(systemName: "paperclip")
						Text(a.filename).lineLimit(1).truncationMode(.middle)
						Spacer(minLength: 4)
						Text(fileSize(a.size)).foregroundStyle(.secondary)
					}
					.font(.caption)
					.padding(.horizontal, 10)
					.padding(.vertical, 7)
					.background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
				}
				.buttonStyle(.plain)
				.help("Download to Downloads")
			}
		}
	}
}

struct Avatar: View {
	let address: Address
	var size: CGFloat = 32

	private var initials: String {
		let source = address.name.isEmpty ? address.address : address.name
		let parts = source.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
		let first = parts.first?.first.map(String.init) ?? "?"
		let last = parts.count > 1 ? (parts.last?.first.map(String.init) ?? "") : ""
		return (first + last).uppercased()
	}

	var body: some View {
		Circle()
			.fill(Color.person(address.address))
			.frame(width: size, height: size)
			.overlay(Text(initials).font(.system(size: size * 0.38, weight: .medium)).foregroundStyle(.white))
	}
}
