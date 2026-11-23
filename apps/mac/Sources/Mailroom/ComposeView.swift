import SwiftUI
import UniformTypeIdentifiers

struct ComposeView: View {
	let draftId: UUID
	@Environment(AppStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var showCc = false
	@State private var showQuoted = false
	@State private var sending = false
	@State private var uploading = 0
	@State private var pickingFiles = false
	@State private var scheduling = false
	@State private var scheduleAt = Calendar.current.date(byAdding: .day, value: 1, to: .now).map {
		Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: $0) ?? $0
	} ?? .now

	private var draft: Binding<ComposeDraft> {
		Binding(
			get: { store.drafts[draftId] ?? ComposeDraft(id: draftId) },
			set: { store.drafts[draftId] = $0 }
		)
	}

	var body: some View {
		if store.drafts[draftId] == nil {
			ContentUnavailableView("This draft is gone", systemImage: "doc", description: Text("It was sent or discarded."))
				.frame(minWidth: 400, minHeight: 300)
		} else {
			editor
		}
	}

	private var editor: some View {
		VStack(spacing: 0) {
			Form {
				Picker("From", selection: draft.mailboxId) {
					ForEach(store.boot?.projects.filter { !$0.mailboxes.isEmpty } ?? []) { project in
						Section(project.name) {
							ForEach(project.mailboxes) { m in
								Text(m.label).tag(Optional(m.id))
							}
						}
					}
				}
				RecipientField(label: "To", text: draft.to) {
					if !showCc {
						Button("Cc/Bcc") { showCc = true }.buttonStyle(.link).font(.caption)
					}
				}
				if showCc || !draft.wrappedValue.cc.isEmpty || !draft.wrappedValue.bcc.isEmpty {
					RecipientField(label: "Cc", text: draft.cc) { EmptyView() }
					RecipientField(label: "Bcc", text: draft.bcc) { EmptyView() }
				}
				TextField("Subject", text: draft.subject)
			}
			.formStyle(.columns)
			.padding(.horizontal, 16)
			.padding(.top, 14)
			.padding(.bottom, 8)

			Divider()

			ScrollView {
				VStack(alignment: .leading, spacing: 12) {
					TextEditor(text: draft.body)
						.font(.system(size: 14))
						.scrollDisabled(true)
						.frame(minHeight: 220)
						.overlay(alignment: .topLeading) {
							if draft.wrappedValue.body.isEmpty {
								Text("Write your message").foregroundStyle(.tertiary).padding(.leading, 5).allowsHitTesting(false)
							}
						}
					let signature = store.signature(for: draft.wrappedValue.mailboxId)
					if !htmlToPlain(signature).isEmpty {
						HStack(alignment: .top) {
							Text(htmlToPlain(signature))
								.foregroundStyle(draft.wrappedValue.includeSignature ? .secondary : .tertiary)
								.strikethrough(!draft.wrappedValue.includeSignature)
							Spacer()
							Button(draft.wrappedValue.includeSignature ? "Remove Signature" : "Add Signature") {
								draft.wrappedValue.includeSignature.toggle()
							}
							.buttonStyle(.link)
							.font(.caption)
						}
					}
					if !draft.wrappedValue.quotedHTML.isEmpty {
						DisclosureGroup(isExpanded: $showQuoted) {
							Text(htmlToPlain(draft.wrappedValue.quotedHTML))
								.foregroundStyle(.secondary)
								.textSelection(.enabled)
								.frame(maxWidth: .infinity, alignment: .leading)
								.padding(.leading, 10)
								.overlay(alignment: .leading) { Rectangle().fill(.separator).frame(width: 2) }
						} label: {
							Text(draft.wrappedValue.forwardOfMessageId != nil ? "Forwarded message" : "Quoted text").foregroundStyle(.secondary)
						}
					}
					if !draft.wrappedValue.uploads.isEmpty || !draft.wrappedValue.forwardAttachments.isEmpty || uploading > 0 {
						FlowChips(draft: draft, uploading: uploading)
					}
				}
				.padding(16)
			}

			Divider()
			bottomBar
		}
		.frame(minWidth: 560, minHeight: 460)
		.navigationTitle(draft.wrappedValue.subject.isEmpty ? draft.wrappedValue.title : draft.wrappedValue.subject)
		.fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
			if case let .success(urls) = result { attach(urls) }
		}
		.onDrop(of: [.fileURL], isTargeted: nil) { providers in
			for p in providers {
				_ = p.loadObject(ofClass: URL.self) { url, _ in
					if let url { DispatchQueue.main.async { attach([url]) } }
				}
			}
			return true
		}
		.sheet(isPresented: $scheduling) {
			VStack(alignment: .leading, spacing: 16) {
				Text("Schedule Send").font(.headline)
				DatePicker("Send at", selection: $scheduleAt, in: Date().addingTimeInterval(120)...)
					.datePickerStyle(.graphical)
				HStack {
					Spacer()
					Button("Cancel") { scheduling = false }
					Button("Schedule") {
						scheduling = false
						send(at: scheduleAt)
					}
					.keyboardShortcut(.defaultAction)
				}
			}
			.padding(20)
			.frame(width: 360)
		}
	}

	private var bottomBar: some View {
		HStack(spacing: 10) {
			Button {
				send(at: nil)
			} label: {
				Label("Send", systemImage: "paperplane.fill")
			}
			.buttonStyle(.borderedProminent)
			.keyboardShortcut(.return, modifiers: .command)
			.disabled(sending || uploading > 0)

			Menu {
				ForEach(schedulePresets, id: \.0) { title, date in
					Button("\(title) (\(date.formatted(.dateTime.weekday(.abbreviated).hour().minute())))") { send(at: date) }
				}
				Divider()
				Button("Pick Date and Time...") { scheduling = true }
			} label: {
				Label("Send Later", systemImage: "clock")
			}
			.fixedSize()
			.disabled(sending || uploading > 0)

			Button {
				pickingFiles = true
			} label: {
				Label("Attach", systemImage: "paperclip")
			}

			if !store.templates.isEmpty {
				Menu {
					ForEach(store.templates) { t in
						Button(t.name) {
							let text = htmlToPlain(t.html)
							draft.wrappedValue.body += (draft.wrappedValue.body.isEmpty ? "" : "\n\n") + text
							if draft.wrappedValue.subject.isEmpty { draft.wrappedValue.subject = t.subject }
						}
					}
				} label: {
					Label("Templates", systemImage: "doc.text")
				}
				.fixedSize()
			}

			Spacer()
			if sending { ProgressView().controlSize(.small) }
			Button(role: .destructive) {
				store.drafts[draftId] = nil
				dismiss()
			} label: {
				Label("Discard", systemImage: "trash")
			}
			.help("Discard this draft")
		}
		.labelStyle(.titleAndIcon)
		.padding(12)
	}

	private var schedulePresets: [(String, Date)] {
		let cal = Calendar.current
		let now = Date()
		func at(_ d: Date, _ h: Int) -> Date { cal.date(bySettingHour: h, minute: 0, second: 0, of: d) ?? d }
		let tomorrow = cal.date(byAdding: .day, value: 1, to: now)!
		let monday = cal.nextDate(after: now, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime) ?? tomorrow
		var list = [("Tomorrow Morning", at(tomorrow, 8)), ("Tomorrow Afternoon", at(tomorrow, 13)), ("Monday Morning", at(monday, 8))]
		if cal.component(.hour, from: now) < 17 { list.insert(("This Evening", at(now, 18)), at: 0) }
		return list
	}

	private func send(at date: Date?) {
		sending = true
		Task {
			let ok = await store.send(draftId, at: date)
			sending = false
			if ok { dismiss() }
		}
	}

	private func attach(_ urls: [URL]) {
		for url in urls {
			uploading += 1
			Task {
				let scoped = url.startAccessingSecurityScopedResource()
				defer {
					if scoped { url.stopAccessingSecurityScopedResource() }
					uploading -= 1
				}
				do {
					let upload = try await store.api.upload(url)
					store.drafts[draftId]?.uploads.append(upload)
				} catch {
					store.report(error)
				}
			}
		}
	}
}

/// A recipients line with contact suggestions for the address being typed
struct RecipientField<Trailing: View>: View {
	let label: String
	@Binding var text: String
	@ViewBuilder let trailing: () -> Trailing
	@Environment(AppStore.self) private var store
	@State private var suggestions: [Contact] = []
	@State private var lookup: Task<Void, Never>?

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack {
				TextField(label, text: $text, prompt: Text("name@example.com, ..."))
				trailing()
			}
			if !suggestions.isEmpty {
				HStack(spacing: 6) {
					ForEach(suggestions.prefix(4), id: \.address) { c in
						Button {
							var parts = text.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
							parts.removeLast()
							parts.append(c.name.isEmpty ? c.address : "\(c.name) <\(c.address)>")
							text = parts.filter { !$0.isEmpty }.joined(separator: ", ") + ", "
							suggestions = []
						} label: {
							Text(c.name.isEmpty ? c.address : "\(c.name) · \(c.address)").lineLimit(1)
						}
						.buttonStyle(.bordered)
						.controlSize(.small)
					}
				}
			}
		}
		.onChange(of: text) { _, value in
			lookup?.cancel()
			let current = value.split(separator: ",", omittingEmptySubsequences: false).last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
			guard current.count >= 2, !current.contains("<") else {
				suggestions = []
				return
			}
			lookup = Task {
				try? await Task.sleep(for: .milliseconds(200))
				guard !Task.isCancelled else { return }
				let found = await store.contacts(current)
				if !Task.isCancelled { suggestions = found }
			}
		}
	}
}

struct FlowChips: View {
	@Binding var draft: ComposeDraft
	let uploading: Int

	var body: some View {
		LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
			ForEach(draft.forwardAttachments) { a in
				chip(a.filename, a.size) { draft.forwardAttachments.removeAll { $0.partId == a.partId } }
			}
			ForEach(draft.uploads) { u in
				chip(u.filename, u.size) { draft.uploads.removeAll { $0.id == u.id } }
			}
			ForEach(0 ..< uploading, id: \.self) { _ in
				HStack {
					ProgressView().controlSize(.small)
					Text("Uploading...").font(.caption)
				}
			}
		}
	}

	private func chip(_ name: String, _ size: Int, remove: @escaping () -> Void) -> some View {
		HStack(spacing: 6) {
			Image(systemName: "paperclip")
			Text(name).lineLimit(1).truncationMode(.middle)
			Text(fileSize(size)).foregroundStyle(.secondary)
			Button(action: remove) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
		}
		.font(.caption)
		.padding(.horizontal, 10)
		.padding(.vertical, 6)
		.background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
	}
}

/// HTML to readable text, for signature and quote previews and inserted templates
func htmlToPlain(_ html: String) -> String {
	var s = html
	let rules: [(String, String)] = [
		("(?is)<(style|script|head)[^>]*>.*?</\\1>", ""),
		("(?i)<br\\s*/?>", "\n"),
		("(?i)</(p|div|tr|li|h[1-6]|blockquote)>", "\n"),
		("<[^>]+>", ""),
	]
	for (pattern, with) in rules { s = s.replacingOccurrences(of: pattern, with: with, options: .regularExpression) }
	let entities = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'"]
	for (k, v) in entities { s = s.replacingOccurrences(of: k, with: v) }
	return s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
}
