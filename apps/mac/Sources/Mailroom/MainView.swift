import SwiftUI

struct MainView: View {
	@Environment(AppStore.self) private var store
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		@Bindable var store = store
		NavigationSplitView {
			SidebarView()
				.navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
		} content: {
			Group {
				if store.selection == .scheduled { ScheduledListView() } else { ThreadListView() }
			}
			.navigationSplitViewColumnWidth(min: 300, ideal: 380, max: 520)
		} detail: {
			ThreadDetailView()
		}
		.toolbar {
			ToolbarItem(placement: .navigation) {
				Button {
					openWindow(id: "compose", value: store.newDraft())
				} label: {
					Label("New Message", systemImage: "square.and.pencil")
				}
				.help("New Message (⌘N)")
			}
		}
		.onChange(of: store.selection) { _, _ in
			store.selectedThreadId = nil
			store.threads = []
			Task { await store.reloadThreads() }
		}
		.onChange(of: store.selectedThreadId) { _, id in
			Task { await store.openThread(id) }
		}
	}
}

// MARK: Sidebar

struct SidebarView: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		@Bindable var store = store
		List(selection: $store.selection) {
			Section {
				ForEach(SidebarItem.views, id: \.id) { v in
					Label(v.title, systemImage: v.icon)
						.badge(v.id == "inbox" ? (store.boot?.unread ?? 0) : 0)
						.tag(SidebarItem.view(v.id))
				}
				Label("Scheduled", systemImage: "paperplane.circle")
					.badge(store.boot?.counts.scheduled ?? 0)
					.tag(SidebarItem.scheduled)
			}

			ForEach(store.boot?.projects ?? []) { project in
				Section {
					Label {
						Text("All of \(project.name)")
					} icon: {
						Image(systemName: "tray.2")
					}
					.badge(project.mailboxes.reduce(0) { $0 + $1.unread })
					.tag(SidebarItem.project(project.id))
					ForEach(project.mailboxes) { mailbox in
						MailboxRow(mailbox: mailbox, folders: store.boot?.folders.filter { $0.mailboxId == mailbox.id } ?? [])
					}
				} header: {
					HStack(spacing: 6) {
						Circle().fill(Color(hex: project.color)).frame(width: 8, height: 8)
						Text(project.name)
					}
				}
			}

			if let boot = store.boot, boot.projects.isEmpty {
				Text("No projects yet. Create one in the web app and connect a mailbox.")
					.font(.caption)
					.foregroundStyle(.secondary)
			}
		}
		.listStyle(.sidebar)
	}
}

struct MailboxRow: View {
	let mailbox: Mailbox
	let folders: [Folder]
	@State private var expanded = false

	private static let order = ["inbox", "sent", "drafts", "archive", "all", "junk", "trash"]

	var sorted: [Folder] {
		folders.filter { $0.specialUse != "flagged" }.sorted {
			let a = $0.specialUse.flatMap { Self.order.firstIndex(of: $0) } ?? 99
			let b = $1.specialUse.flatMap { Self.order.firstIndex(of: $0) } ?? 99
			return a == b ? $0.path < $1.path : a < b
		}
	}

	var body: some View {
		DisclosureGroup(isExpanded: $expanded) {
			ForEach(sorted) { folder in
				Label(folder.name, systemImage: icon(folder.specialUse))
					.badge(folder.specialUse == "inbox" || folder.specialUse == nil ? folder.unread : 0)
					.tag(SidebarItem.folder(folder.id))
			}
		} label: {
			HStack(spacing: 6) {
				StatusDot(status: mailbox.status)
				Text(mailbox.address).lineLimit(1).truncationMode(.middle)
			}
			.help(statusText)
			.badge(mailbox.unread)
			.tag(SidebarItem.mailbox(mailbox.id))
		}
	}

	private var statusText: String {
		switch mailbox.status {
		case "idle": "Up to date"
		case "syncing": mailbox.totalCount > 0 ? "Syncing \(mailbox.syncedCount) of \(mailbox.totalCount)" : "Syncing"
		case "error": "Error: \(mailbox.statusMessage ?? "")"
		case "paused": "Paused"
		default: "Connecting"
		}
	}

	private func icon(_ use: String?) -> String {
		switch use {
		case "inbox": "tray"
		case "sent": "paperplane"
		case "drafts": "doc"
		case "archive", "all": "archivebox"
		case "junk": "xmark.bin"
		case "trash": "trash"
		default: "folder"
		}
	}
}

struct StatusDot: View {
	let status: String
	var body: some View {
		Circle()
			.fill(status == "idle" ? Color.green : status == "error" ? .red : status == "paused" ? .gray : .orange)
			.frame(width: 7, height: 7)
	}
}

// MARK: Thread list

struct ThreadListView: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		@Bindable var store = store
		Group {
			if store.loadingThreads && store.threads.isEmpty {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if store.threads.isEmpty {
				ContentUnavailableView(store.search.isEmpty ? "Nothing here" : "No matches", systemImage: store.search.isEmpty ? "tray" : "magnifyingglass")
			} else {
				List(selection: $store.selectedThreadId) {
					ForEach(store.threads) { t in
						ThreadRowView(thread: t, project: store.boot?.project(of: t.mailboxId), showProject: (store.boot?.mailboxes.count ?? 0) > 1)
							.tag(t.threadId)
							.contextMenu { rowMenu(t) }
							.swipeActions(edge: .trailing) {
								Button(role: .destructive) { Task { await store.act([t.threadId], "trash") } } label: { Label("Delete", systemImage: "trash") }
								Button { Task { await store.act([t.threadId], "archive") } } label: { Label("Archive", systemImage: "archivebox") }
									.tint(.indigo)
							}
							.swipeActions(edge: .leading) {
								Button { Task { await store.act([t.threadId], t.unread ? "read" : "unread") } } label: {
									Label(t.unread ? "Read" : "Unread", systemImage: t.unread ? "envelope.open" : "envelope.badge")
								}
								.tint(.blue)
							}
							.onAppear {
								if t.threadId == store.threads.last?.threadId { Task { await store.loadMore() } }
							}
					}
				}
				.listStyle(.inset)
			}
		}
		.navigationTitle(title)
		.searchable(text: $store.search, placement: .toolbar, prompt: "Search")
		.onSubmit(of: .search) { Task { await store.reloadThreads() } }
		.onChange(of: store.search) { _, value in
			if value.isEmpty { Task { await store.reloadThreads() } }
		}
		.toolbar {
			ToolbarItem {
				Button {
					Task {
						await store.refreshBoot()
						await store.reloadThreads()
					}
				} label: {
					Label("Refresh", systemImage: "arrow.clockwise")
				}
				.help("Get new mail")
			}
		}
	}

	private var title: String {
		switch store.selection {
		case let .view(v): SidebarItem.views.first { $0.id == v }?.title ?? "Mail"
		case let .project(id): store.boot?.projects.first { $0.id == id }?.name ?? "Project"
		case let .mailbox(id): store.boot?.mailboxes.first { $0.id == id }?.address ?? "Mailbox"
		case let .folder(id): store.boot?.folders.first { $0.id == id }?.name ?? "Folder"
		case .scheduled: "Scheduled"
		case nil: "Mail"
		}
	}

	@ViewBuilder
	private func rowMenu(_ t: ThreadRow) -> some View {
		Button(t.unread ? "Mark as Read" : "Mark as Unread") { Task { await store.act([t.threadId], t.unread ? "read" : "unread") } }
		Button(t.starred ? "Unstar" : "Star") { Task { await store.act([t.threadId], t.starred ? "unstar" : "star") } }
		Divider()
		Button("Archive") { Task { await store.act([t.threadId], "archive") } }
		Button("Move to Trash") { Task { await store.act([t.threadId], "trash") } }
		Button("Mark as Spam") { Task { await store.act([t.threadId], "spam") } }
		Divider()
		Menu("Snooze") { SnoozeItems(ids: [t.threadId]) }
	}
}

struct ThreadRowView: View {
	let thread: ThreadRow
	let project: Project?
	let showProject: Bool

	private var people: String {
		let names = (thread.participants.isEmpty ? [thread.from] : thread.participants).map(\.display)
		var unique: [String] = []
		for n in names where !unique.contains(n) { unique.append(n) }
		return unique.count <= 2 ? unique.joined(separator: ", ") : "\(unique[0]), \(unique[1]) +\(unique.count - 2)"
	}

	var body: some View {
		HStack(alignment: .top, spacing: 8) {
			Circle()
				.fill(thread.unread ? Color.accentColor : .clear)
				.frame(width: 8, height: 8)
				.padding(.top, 5)
			VStack(alignment: .leading, spacing: 2) {
				HStack(alignment: .firstTextBaseline) {
					Text(people).fontWeight(thread.unread ? .semibold : .regular).lineLimit(1)
					if thread.count > 1 { Text("\(thread.count)").font(.caption).foregroundStyle(.secondary) }
					Spacer(minLength: 4)
					if thread.starred { Image(systemName: "star.fill").font(.caption2).foregroundStyle(.yellow) }
					if let until = thread.snoozedUntil {
						Label(Dates.list(until), systemImage: "clock").font(.caption).foregroundStyle(.orange).labelStyle(.titleAndIcon)
					} else {
						Text(Dates.list(thread.date)).font(.caption).foregroundStyle(thread.unread ? .primary : .secondary)
					}
				}
				Text(thread.subject.isEmpty ? "(no subject)" : thread.subject)
					.lineLimit(1)
					.fontWeight(thread.unread ? .medium : .regular)
				HStack(spacing: 6) {
					Text(thread.snippet).font(.callout).foregroundStyle(.secondary).lineLimit(2)
					Spacer(minLength: 0)
					if thread.hasAttachments { Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary) }
					if showProject, let project {
						Circle().fill(Color(hex: project.color)).frame(width: 7, height: 7).help(project.name)
					}
				}
			}
		}
		.padding(.vertical, 4)
	}
}

struct SnoozeItems: View {
	let ids: [String]
	@Environment(AppStore.self) private var store

	var body: some View {
		ForEach(options, id: \.0) { title, date in
			Button("\(title) (\(date.formatted(.dateTime.weekday(.abbreviated).hour().minute())))") {
				Task { await store.act(ids, "snooze", until: date) }
			}
		}
	}

	private var options: [(String, Date)] {
		let cal = Calendar.current
		let now = Date()
		func at(_ day: Date, _ hour: Int) -> Date { cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day }
		var list: [(String, Date)] = []
		if cal.component(.hour, from: now) < 18 { list.append(("Later Today", now.addingTimeInterval(3 * 3600))) }
		list.append(("Tomorrow", at(cal.date(byAdding: .day, value: 1, to: now)!, 8)))
		let saturday = cal.nextDate(after: now, matching: DateComponents(weekday: 7), matchingPolicy: .nextTime) ?? now
		list.append(("This Weekend", at(saturday, 9)))
		let monday = cal.nextDate(after: now, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime) ?? now
		list.append(("Next Week", at(monday, 8)))
		return list
	}
}

// MARK: Scheduled

struct ScheduledListView: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		Group {
			if store.outbox.isEmpty {
				ContentUnavailableView("Nothing scheduled", systemImage: "paperplane", description: Text("Use the clock next to Send to pick a time."))
			} else {
				List(store.outbox) { item in
					VStack(alignment: .leading, spacing: 4) {
						HStack {
							Text("To \(item.payload.to.map(\.display).joined(separator: ", "))").fontWeight(.medium).lineLimit(1)
							Spacer()
							if item.status == "failed" {
								Text("Failed").font(.caption.weight(.semibold)).foregroundStyle(.red)
							} else {
								Text(Dates.full(item.sendAt)).font(.caption).foregroundStyle(.secondary)
							}
						}
						Text(item.payload.subject.isEmpty ? "(no subject)" : item.payload.subject).lineLimit(1)
						if let error = item.error { Text(error).font(.caption).foregroundStyle(.red) }
						HStack {
							Button(item.status == "failed" ? "Retry Now" : "Send Now") { Task { await store.sendNow(item) } }
							Button("Edit") { Task { await store.cancelScheduled(item, edit: true) } }
							Button("Cancel") { Task { await store.cancelScheduled(item, edit: false) } }
						}
						.controlSize(.small)
					}
					.padding(.vertical, 4)
				}
			}
		}
		.navigationTitle("Scheduled")
		.task { await store.loadOutbox() }
	}
}

extension Color {
	init(hex: String) {
		let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
		let v = UInt64(h, radix: 16) ?? 0x6366F1
		self.init(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
	}

	/// Stable color per address, for avatars
	static func person(_ key: String) -> Color {
		var h: UInt32 = 0
		for c in key.unicodeScalars { h = h &* 31 &+ c.value }
		return Color(hue: Double(h % 360) / 360, saturation: 0.45, brightness: 0.75)
	}
}
