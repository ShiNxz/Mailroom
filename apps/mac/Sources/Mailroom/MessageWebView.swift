import AppKit
import SwiftUI
import WebKit

// Shows one email's HTML (already sanitized by the API) in a WKWebView:
// - JavaScript off for the content
// - remote images blocked by a CSP until "Show images", so tracking pixels don't fire
// - inline images and attachments load through mailroom-asset://, which adds the bearer token
// - links open in the default browser
// - the view sizes itself to the content and passes scrolling on to the thread

private let assetScheme = "mailroom-asset"

/// Serves mailroom-asset://app/api/... by fetching the same path from the server with the session token
final class AssetHandler: NSObject, WKURLSchemeHandler {
	private var stopped = Set<ObjectIdentifier>()

	func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
		guard let url = task.request.url else { return }
		let path = url.path + (url.query.map { "?\($0)" } ?? "")
		let api = MainActor.assumeIsolated { AppStore.shared.api }
		guard path.hasPrefix("/api/"), let request = try? api.request(String(path.dropFirst(4)), timeout: 60) else {
			task.didFailWithError(URLError(.badURL))
			return
		}
		let id = ObjectIdentifier(task)
		URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
			DispatchQueue.main.async {
				guard let self, !self.stopped.contains(id) else { return }
				if let data, let http = response as? HTTPURLResponse {
					let headers = ["Content-Type": http.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"]
					let out = HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!
					task.didReceive(out)
					task.didReceive(data)
					task.didFinish()
				} else {
					task.didFailWithError(error ?? URLError(.unknown))
				}
			}
		}.resume()
	}

	func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
		stopped.insert(ObjectIdentifier(task))
	}
}

/// A web view that never scrolls itself: the wheel goes to the surrounding thread
final class PassThroughWebView: WKWebView {
	override func scrollWheel(with event: NSEvent) {
		nextResponder?.scrollWheel(with: event)
	}
}

struct MessageWebView: NSViewRepresentable {
	let html: String
	let allowImages: Bool
	@Binding var height: CGFloat
	@Environment(\.colorScheme) private var colorScheme

	private static let handler = AssetHandler()

	func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

	func makeNSView(context: Context) -> WKWebView {
		let config = WKWebViewConfiguration()
		config.setURLSchemeHandler(Self.handler, forURLScheme: assetScheme)
		config.websiteDataStore = .nonPersistent()
		config.defaultWebpagePreferences.allowsContentJavaScript = false
		let view = PassThroughWebView(frame: .zero, configuration: config)
		view.navigationDelegate = context.coordinator
		view.uiDelegate = context.coordinator
		view.setValue(false, forKey: "drawsBackground")
		return view
	}

	func updateNSView(_ view: WKWebView, context: Context) {
		let doc = document()
		guard context.coordinator.loaded != doc else { return }
		context.coordinator.loaded = doc
		view.loadHTMLString(doc, baseURL: URL(string: "\(assetScheme)://app/"))
	}

	private func document() -> String {
		let plain = html.hasPrefix("<div style=\"white-space:pre-wrap\">")
		let dark = colorScheme == .dark
		let img = allowImages ? "\(assetScheme): data: https: http:" : "\(assetScheme): data:"
		let style = allowImages ? "'unsafe-inline' https:" : "'unsafe-inline'"
		let fg = plain && dark ? "#e7e7ea" : "#1f2328"
		let bg = plain ? "transparent" : "#ffffff"
		let link = plain && dark ? "#a5b4fc" : "#4f46e5"
		let hideRemote = allowImages ? "" : "img[src^=\"http\"]{visibility:hidden}"
		return """
		<!doctype html><html><head><meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \(img); style-src \(style); font-src \(allowImages ? "data: https:" : "data:")">
		<style>
		html,body{margin:0;padding:0;background:\(bg);color:\(fg)}
		body{font:13px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:\(plain ? "0" : "16px")}
		img{max-width:100%;height:auto} table{max-width:100%} pre{white-space:pre-wrap}
		a{color:\(link)} \(hideRemote)
		blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d0d7de;color:\(plain && dark ? "#a1a1aa" : "#57606a")}
		</style></head><body>\(html)</body></html>
		"""
	}

	final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
		var loaded: String?
		let height: Binding<CGFloat>

		init(height: Binding<CGFloat>) { self.height = height }

		func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
			measure(webView)
			// Images that arrive later change the height
			for delay in [0.3, 1.0, 2.5] {
				DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak webView] in
					if let webView { self?.measure(webView) }
				}
			}
		}

		private func measure(_ webView: WKWebView) {
			webView.evaluateJavaScript("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)") { value, _ in
				if let h = value as? CGFloat, h > 0, abs(h - self.height.wrappedValue) > 1 { self.height.wrappedValue = h }
			}
		}

		func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
			if action.navigationType == .linkActivated, let url = action.request.url {
				if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
				return decisionHandler(.cancel)
			}
			decisionHandler(.allow)
		}

		// target=_blank links
		func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
			if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
			return nil
		}
	}
}
