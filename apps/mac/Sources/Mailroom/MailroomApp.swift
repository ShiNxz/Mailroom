import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
	func applicationDidFinishLaunching(_ notification: Notification) {
		UNUserNotificationCenter.current().delegate = self
		// Started from the command line (swift run) there is no bundle: still show up as a regular app
		NSApp.setActivationPolicy(.regular)
		NSApp.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

	// Clicking a notification brings the app forward
	func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
		NSApp.activate(ignoringOtherApps: true)
		done()
	}

	func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
		done([.banner, .sound])
	}
}

@main
struct MailroomApp: App {
	@NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
	@State private var store = AppStore.shared

	var body: some Scene {
		WindowGroup("Mailroom", id: "main") {
			RootView()
				.environment(store)
				.frame(minWidth: 900, minHeight: 560)
				.task { if store.phase == .starting { await store.start() } }
		}
		.defaultSize(width: 1280, height: 820)
		.commands { MailCommands(store: store) }

		WindowGroup("New Message", id: "compose", for: UUID.self) { $id in
			if let id {
				ComposeView(draftId: id).environment(store)
			}
		}
		.defaultSize(width: 720, height: 640)

		Settings {
			SettingsView().environment(store)
		}
	}
}

struct MailCommands: Commands {
	let store: AppStore
	@Environment(\.openWindow) private var openWindow

	private var current: Message? { store.thread?.messages.last }

	var body: some Commands {
		CommandGroup(replacing: .newItem) {
			Button("New Message") { openWindow(id: "compose", value: store.newDraft()) }
				.keyboardShortcut("n")
				.disabled(store.phase != .signedIn)
		}
		CommandMenu("Message") {
			Button("Reply") { if let m = current { openWindow(id: "compose", value: store.newDraft(store.replyDraft("reply", to: m))) } }
				.keyboardShortcut("r")
				.disabled(current == nil)
			Button("Reply All") { if let m = current { openWindow(id: "compose", value: store.newDraft(store.replyDraft("replyAll", to: m))) } }
				.keyboardShortcut("r", modifiers: [.command, .shift])
				.disabled(current == nil)
			Button("Forward") { if let m = current { openWindow(id: "compose", value: store.newDraft(store.replyDraft("forward", to: m))) } }
				.keyboardShortcut("f", modifiers: [.command, .shift])
				.disabled(current == nil)
			Divider()
			Button("Archive") { act("archive") }
				.keyboardShortcut("e", modifiers: [.command])
				.disabled(store.selectedThreadId == nil)
			Button("Move to Trash") { act("trash") }
				.keyboardShortcut(.delete, modifiers: [.command])
				.disabled(store.selectedThreadId == nil)
			Button("Mark as Spam") { act("spam") }
				.keyboardShortcut("j", modifiers: [.command, .shift])
				.disabled(store.selectedThreadId == nil)
			Button("Mark as Unread") { act("unread") }
				.keyboardShortcut("u", modifiers: [.command, .shift])
				.disabled(store.selectedThreadId == nil)
			Button("Star") { act(store.thread?.messages.contains { $0.flagged } == true ? "unstar" : "star") }
				.keyboardShortcut("l", modifiers: [.command, .shift])
				.disabled(store.selectedThreadId == nil)
			Divider()
			Button("Get New Mail") { Task { await store.refreshBoot(); await store.reloadThreads() } }
				.keyboardShortcut("n", modifiers: [.command, .shift])
		}
	}

	private func act(_ action: String) {
		guard let id = store.selectedThreadId else { return }
		Task { await store.act([id], action) }
	}
}
