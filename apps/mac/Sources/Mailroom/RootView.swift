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
	@State private var email = ""
	@State private var password = ""
	@State private var error: String?
	@State private var busy = false

	var body: some View {
		VStack(spacing: 18) {
			BrandLogo(branding: store.branding, size: 56)
			VStack(spacing: 4) {
				Text("Sign in to \(store.branding.name)").font(.title2.weight(.semibold))
				Text("Use the same account as the web app.").foregroundStyle(.secondary)
			}
			Form {
				TextField("Server", text: $server, prompt: Text("https://mail.example.com"))
				TextField("Email", text: $email, prompt: Text("you@company.com"))
					.textContentType(.username)
				SecureField("Password", text: $password)
					.textContentType(.password)
					.onSubmit(signIn)
			}
			.formStyle(.grouped)
			.frame(width: 380)
			.scrollDisabled(true)
			.fixedSize(horizontal: false, vertical: true)
			if let error {
				Text(error).foregroundStyle(.red).font(.callout).multilineTextAlignment(.center).frame(width: 360)
			}
			Button(action: signIn) {
				if busy { ProgressView().controlSize(.small) } else { Text("Sign In").frame(width: 120) }
			}
			.buttonStyle(.borderedProminent)
			.controlSize(.large)
			.keyboardShortcut(.defaultAction)
			.disabled(busy || email.isEmpty || password.isEmpty)
		}
		.padding(40)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		// Show the server's branding as soon as its address is in
		.task(id: server) {
			try? await Task.sleep(for: .milliseconds(400))
			guard !Task.isCancelled, server.contains(".") || server.contains("localhost") else { return }
			await store.loadBranding(server: server)
		}
	}

	private func signIn() {
		busy = true
		error = nil
		Task {
			do {
				try await store.signIn(server: server, email: email, password: password)
			} catch {
				self.error = error.localizedDescription
			}
			busy = false
		}
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
