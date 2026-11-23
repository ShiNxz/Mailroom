import Foundation

// Mirrors packages/shared/src/index.ts. Dates stay ISO strings, parsed where they are shown.

struct Address: Codable, Hashable {
	var name: String
	var address: String

	var display: String { name.isEmpty ? (address.split(separator: "@").first.map(String.init) ?? address) : name }
	var full: String { name.isEmpty ? address : "\(name) <\(address)>" }
}

struct UserSettings: Codable, Hashable {
	var undoSeconds: Int?
	var showImages: Bool?
	var notifications: Bool?
}

struct User: Codable, Hashable {
	let id: String
	let email: String
	let name: String
	let role: String
	let settings: UserSettings
}

struct Mailbox: Codable, Identifiable, Hashable {
	let id: String
	let projectId: String
	let address: String
	let displayName: String
	let status: String
	let statusMessage: String?
	let syncedCount: Int
	let totalCount: Int
	let unread: Int
	let signature: String
	let enabled: Bool

	var label: String { displayName.isEmpty ? address : "\(displayName) <\(address)>" }
}

struct Project: Codable, Identifiable, Hashable {
	let id: String
	let name: String
	let color: String
	let mailboxes: [Mailbox]
	let canManage: Bool
}

struct Folder: Codable, Identifiable, Hashable {
	let id: String
	let mailboxId: String
	let path: String
	let name: String
	let specialUse: String?
	let total: Int
	let unread: Int
}

struct Counts: Codable, Hashable {
	let drafts: Int
	let scheduled: Int
	let failed: Int
}

struct Bootstrap: Codable {
	let projects: [Project]
	let folders: [Folder]
	let counts: Counts

	var mailboxes: [Mailbox] { projects.flatMap(\.mailboxes) }
	var unread: Int { mailboxes.reduce(0) { $0 + $1.unread } }
	func project(of mailboxId: String) -> Project? { projects.first { $0.mailboxes.contains { $0.id == mailboxId } } }
}

struct ThreadRow: Codable, Identifiable, Hashable {
	let threadId: String
	let mailboxId: String
	let messageId: String
	let subject: String
	let snippet: String
	let participants: [Address]
	let from: Address
	let date: String
	let count: Int
	let unread: Bool
	let starred: Bool
	let hasAttachments: Bool
	let snoozedUntil: String?

	var id: String { threadId }
}

struct ThreadPage: Codable {
	let threads: [ThreadRow]
	let next: String?
}

struct Attachment: Codable, Hashable, Identifiable {
	let partId: String
	let filename: String
	let contentType: String
	let size: Int
	let cid: String?
	let inline: Bool

	var id: String { partId }
}

struct Message: Codable, Identifiable, Hashable {
	let id: String
	let mailboxId: String
	let folderId: String
	let threadId: String
	let messageId: String?
	let subject: String
	let from: Address
	let to: [Address]
	let cc: [Address]
	let bcc: [Address]
	let replyTo: [Address]
	let date: String
	let snippet: String
	let html: String?
	let text: String
	let attachments: [Attachment]
	let seen: Bool
	let flagged: Bool
	let snoozedUntil: String?
	let listUnsubscribe: String?
	let hasRemoteImages: Bool
}

struct MailThread: Codable {
	let threadId: String
	let mailboxId: String
	let subject: String
	let messages: [Message]
}

struct ComposePayload: Codable, Hashable {
	var mailboxId: String
	var to: [Address]
	var cc: [Address]
	var bcc: [Address]
	var subject: String
	var html: String
	var replyToMessageId: String?
	var forwardOfMessageId: String?
	var attachmentIds: [String]
	var forwardAttachments: [String]?
}

struct OutboxItem: Codable, Identifiable, Hashable {
	let id: String
	let mailboxId: String
	let status: String
	let sendAt: String
	let error: String?
	let payload: ComposePayload
}

struct Upload: Codable, Hashable, Identifiable {
	let id: String
	let filename: String
	let contentType: String
	let size: Int
}

struct Template: Codable, Identifiable, Hashable {
	let id: String
	let projectId: String?
	let name: String
	let subject: String
	let html: String
}

struct Contact: Codable, Hashable {
	let name: String
	let address: String
}

/// Server-sent event from /api/events
struct ServerEvent: Decodable {
	struct NewMail: Decodable {
		let messageId: String
		let from: Address
		let subject: String
	}

	let type: String
	let mailboxId: String?
	let newInbox: [NewMail]?
	let status: String?
	let error: String?
}

/// What the sidebar shows in the list column
enum SidebarItem: Hashable {
	case view(String)
	case project(String)
	case mailbox(String)
	case folder(String)
	case scheduled

	static let views: [(id: String, title: String, icon: String)] = [
		("inbox", "Inbox", "tray"),
		("starred", "Starred", "star"),
		("snoozed", "Snoozed", "clock"),
		("sent", "Sent", "paperplane"),
		("archive", "Archive", "archivebox"),
		("junk", "Spam", "xmark.bin"),
		("trash", "Trash", "trash"),
	]

	/// Query string for /threads
	var query: String? {
		switch self {
		case let .view(v): "view=\(v)"
		case let .project(id): "view=inbox&projectId=\(id)"
		case let .mailbox(id): "view=inbox&mailboxId=\(id)"
		case let .folder(id): "folderId=\(id)"
		case .scheduled: nil
		}
	}
}

enum Dates {
	private static let iso: ISO8601DateFormatter = {
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return f
	}()

	private static let isoPlain = ISO8601DateFormatter()

	static func parse(_ s: String) -> Date { iso.date(from: s) ?? isoPlain.date(from: s) ?? .distantPast }
	static func string(_ d: Date) -> String { iso.string(from: d) }

	static func list(_ s: String) -> String {
		let d = parse(s)
		let cal = Calendar.current
		if cal.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
		if cal.isDateInYesterday(d) { return "Yesterday" }
		if cal.isDate(d, equalTo: .now, toGranularity: .year) { return d.formatted(.dateTime.month(.abbreviated).day()) }
		return d.formatted(date: .numeric, time: .omitted)
	}

	static func full(_ s: String) -> String { parse(s).formatted(date: .abbreviated, time: .shortened) }
}
