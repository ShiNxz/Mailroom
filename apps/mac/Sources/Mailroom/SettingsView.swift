import SwiftUI

struct SettingsView: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		TabView {
			AccountSettings()
				.tabItem { Label("Account", systemImage: "person.crop.circle") }
			GeneralSettings()
				.tabItem { Label("General", systemImage: "gearshape") }
		}
		.frame(width: 460)
		.padding(20)
	}
}

private struct AccountSettings: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		Form {
			LabeledContent("Server", value: store.server)
			if let user = store.user {
				LabeledContent("Signed in as", value: "\(user.name) (\(user.email))")
				LabeledContent("Role", value: user.role.capitalized)
			}
			HStack {
				if let url = URL(string: store.server) {
					Link("Open Web App", destination: url)
				}
				Spacer()
				if store.phase == .signedIn {
					Button("Sign Out") { Task { await store.signOut() } }
				}
			}
			Text("Projects, domains, mailboxes and people are managed in the web app.")
				.font(.caption)
				.foregroundStyle(.secondary)
		}
		.formStyle(.grouped)
	}
}

private struct GeneralSettings: View {
	@Environment(AppStore.self) private var store

	var body: some View {
		@Bindable var store = store
		Form {
			Toggle("Notify me about new mail", isOn: $store.notificationsOn)
				.onChange(of: store.notificationsOn) { _, on in UserDefaults.standard.set(on, forKey: "notifications") }
			Picker("Undo send", selection: Binding(
				get: { store.user?.settings.undoSeconds ?? 10 },
				set: { value in Task { await save(["undoSeconds": value]) } }
			)) {
				Text("Off").tag(0)
				ForEach([5, 10, 20, 30], id: \.self) { Text("\($0) seconds").tag($0) }
			}
			Toggle("Always load remote images", isOn: Binding(
				get: { store.user?.settings.showImages ?? false },
				set: { value in Task { await save(["showImages": value]) } }
			))
			Text("Undo send and images are saved to your account, so the web app uses them too.")
				.font(.caption)
				.foregroundStyle(.secondary)
		}
		.formStyle(.grouped)
	}

	private func save(_ settings: [String: AnyHashable]) async {
		struct Body: Encodable {
			let settings: [String: Value]
			enum Value: Encodable {
				case int(Int), bool(Bool)
				func encode(to encoder: Encoder) throws {
					var c = encoder.singleValueContainer()
					switch self {
					case let .int(v): try c.encode(v)
					case let .bool(v): try c.encode(v)
					}
				}
			}
		}
		struct Out: Decodable { let user: User }
		let values = settings.compactMapValues { v -> Body.Value? in
			if let b = v as? Bool { return .bool(b) }
			if let i = v as? Int { return .int(i) }
			return nil
		}
		do {
			let out: Out = try await store.api.post("/auth/me", Body(settings: values), method: "PATCH")
			store.user = out.user
		} catch {
			store.report(error)
		}
	}
}
