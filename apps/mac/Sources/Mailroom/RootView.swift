import AppKit
import SwiftUI

struct RootView: View {
	@MainActor static var openedDevCompose = false
	@Environment(AppStore.self) private var store
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		Group {
			switch store.phase {
			case .starting:
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			case .signedOut:
				LoginView()
			case .signedIn:
				MainView()
			}
		}
		.overlay(alignment: .bottom) {
			if let banner = store.banner {
				BannerView(banner: banner)
					.padding(.bottom, 18)
					.transition(.move(edge: .bottom).combined(with: .opacity))
			}
		}
		.animation(.snappy, value: store.banner)
		// Dev hook (with MAILROOM_TOKEN): MAILROOM_OPEN_COMPOSE=reply opens a reply to the first thread
		.onChange(of: store.thread?.threadId) { _, _ in
			let env = ProcessInfo.processInfo.environment
			guard env["MAILROOM_TOKEN"] != nil, env["MAILROOM_OPEN_COMPOSE"] == "reply", !RootView.openedDevCompose,
			      let m = store.thread?.messages.last else { return }
			RootView.openedDevCompose = true
			openWindow(id: "compose", value: store.newDraft(store.replyDraft("reply", to: m)))
		}
		// Undo send brings the draft back into a compose window
		.onChange(of: store.reopenDraft) { _, id in
			if let id {
				openWindow(id: "compose", value: id)
				store.reopenDraft = nil
			}
		}
	}
}

struct BannerView: View {
	let banner: Banner
	@Environment(AppStore.self) private var store

	var body: some View {
		HStack(spacing: 12) {
			if banner.isError { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
			Text(banner.text).lineLimit(2)
			if let title = banner.actionTitle, let action = banner.action {
				Button(title) {
					action()
					store.banner = nil
				}
				.buttonStyle(.borderless)
				.fontWeight(.semibold)
			}
			Button {
				store.banner = nil
			} label: {
				Image(systemName: "xmark").font(.caption)
			}
			.buttonStyle(.borderless)
			.foregroundStyle(.secondary)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.background(.regularMaterial, in: Capsule())
		.shadow(color: .black.opacity(0.15), radius: 12, y: 4)
	}
}

struct LoginView: View {
	@Environment(AppStore.self) private var store
	@State private var server = AppStore.shared.server
	@State private var error: String?
	@State private var pending: AppStore.DeviceSignIn?
	@State private var flow: Task<Void, Never>?

	var body: some View {
		VStack(spacing: 18) {
			BrandLogo(branding: store.branding, size: 56)
			VStack(spacing: 4) {
				Text("Sign in to \(store.branding.name)").font(.title2.weight(.semibold))
				Text(pending == nil ? "You sign in on the web app, with your passkey or code." : "Approve the sign-in in your browser.")
					.foregroundStyle(.secondary)
			}
			if let pending {
				VStack(spacing: 10) {
					Text("Check that the browser shows this code")
						.font(.callout)
						.foregroundStyle(.secondary)
					Text(pending.userCode)
						.font(.system(size: 30, weight: .semibold, design: .monospaced))
						.textSelection(.enabled)
					HStack(spacing: 8) {
						ProgressView().controlSize(.small)
						Text("Waiting for approval...").foregroundStyle(.secondary)
					}
					HStack {
						Button("Open the browser again") { open(pending) }
						Button("Cancel", role: .cancel) { cancel() }
					}
					.padding(.top, 4)
				}
				.frame(width: 380)
			} else {
				Form {
					TextField("Server", text: $server, prompt: Text("https://mail.example.com"))
						.onSubmit(signIn)
				}
				.formStyle(.grouped)
				.frame(width: 380)
				.scrollDisabled(true)
				.fixedSize(horizontal: false, vertical: true)
				Button(action: signIn) {
					Label("Sign in with browser", systemImage: "safari").frame(minWidth: 180)
				}
				.buttonStyle(.borderedProminent)
				.controlSize(.large)
				.keyboardShortcut(.defaultAction)
				.disabled(server.trimmingCharacters(in: .whitespaces).isEmpty)
			}
			if let note = store.signInNote, error == nil, pending == nil {
				Text(note).foregroundStyle(.secondary).font(.callout).multilineTextAlignment(.center).frame(width: 360)
			}
			if let error {
				Text(error).foregroundStyle(.red).font(.callout).multilineTextAlignment(.center).frame(width: 360)
			}
		}
		.padding(40)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		// Show the server's branding as soon as its address is in
		.task(id: server) {
			try? await Task.sleep(for: .milliseconds(400))
			guard !Task.isCancelled, server.contains(".") || server.contains("localhost") else { return }
			await store.loadBranding(server: server)
		}
		.onDisappear { flow?.cancel() }
	}

	private func open(_ start: AppStore.DeviceSignIn) {
		if let url = store.deviceURL(server: server, start) { NSWorkspace.shared.open(url) }
	}

	private func signIn() {
		error = nil
		flow?.cancel()
		flow = Task {
			do {
				let start = try await store.startDeviceSignIn(server: server)
				pending = start
				open(start)
				try await store.finishDeviceSignIn(server: server, start)
			} catch is CancellationError {
			} catch {
				self.error = error.localizedDescription
			}
			pending = nil
		}
	}

	private func cancel() {
		flow?.cancel()
		flow = nil
		pending = nil
	}
}

/// The instance logo, or the app mark when there is none or it doesn't load
struct BrandLogo: View {
	let branding: Branding
	var size: CGFloat = 28

	var body: some View {
		if let raw = branding.logoUrl, let url = URL(string: raw) {
			AsyncImage(url: url) { phase in
				if let image = phase.image {
					image.resizable().scaledToFit()
				} else if phase.error != nil {
					AppMark(size: size)
				} else {
					ProgressView().controlSize(.small)
				}
			}
			.frame(width: size, height: size)
			.clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
		} else {
			AppMark(size: size)
		}
	}
}

/// The app mark: an envelope on an indigo tile, as in the icon
struct AppMark: View {
	var size: CGFloat = 28
	var body: some View {
		RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
			.fill(LinearGradient(colors: [Color(red: 0.42, green: 0.45, blue: 0.98), Color(red: 0.3, green: 0.27, blue: 0.85)], startPoint: .top, endPoint: .bottom))
			.frame(width: size, height: size)
			.overlay(Image(systemName: "envelope.fill").font(.system(size: size * 0.46)).foregroundStyle(.white))
	}
}
