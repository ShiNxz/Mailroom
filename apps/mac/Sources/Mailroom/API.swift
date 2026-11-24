import Foundation
import Security

struct APIError: LocalizedError {
	let status: Int
	let message: String
	/// The server's reason, like "mfa_setup_required" or "expired"
	var code: String? = nil
	var errorDescription: String? { message }
}

/// Talks to the web app's /api proxy (the same one the browser uses) with a bearer session token.
struct API: Sendable {
	let server: String
	let token: String?

	static func normalize(_ server: String) -> String {
		var base = server.trimmingCharacters(in: .whitespacesAndNewlines)
		if !base.contains("://") { base = "https://" + base }
		while base.hasSuffix("/") { base.removeLast() }
		return base
	}

	func url(_ path: String) throws -> URL {
		guard let url = URL(string: API.normalize(server) + "/api" + path), url.host != nil else {
			throw APIError(status: 0, message: "The server address isn't valid")
		}
		return url
	}

	func request(_ path: String, method: String = "GET", timeout: TimeInterval = 30) throws -> URLRequest {
		var r = URLRequest(url: try url(path), timeoutInterval: timeout)
		r.httpMethod = method
		r.setValue("application/json", forHTTPHeaderField: "Accept")
		if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
		return r
	}

	@discardableResult
	func send(_ path: String, method: String = "GET", body: Encodable? = nil) async throws -> Data {
		var r = try request(path, method: body == nil ? method : (method == "GET" ? "POST" : method))
		if let body {
			r.setValue("application/json", forHTTPHeaderField: "Content-Type")
			r.httpBody = try JSONEncoder().encode(AnyEncodable(body))
		}
		return try await run(r)
	}

	func run(_ r: URLRequest) async throws -> Data {
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await URLSession.shared.data(for: r)
		} catch {
			throw APIError(status: 0, message: "Can't reach \(r.url?.host ?? "the server"): \(error.localizedDescription)")
		}
		guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "No answer from the server") }
		guard (200 ..< 300).contains(http.statusCode) else {
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
			throw APIError(
				status: http.statusCode,
				message: json?["error"] as? String ?? "Request failed (HTTP \(http.statusCode))",
				code: json?["code"] as? String
			)
		}
		return data
	}

	func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
		try JSONDecoder().decode(T.self, from: try await send(path))
	}

	func post<T: Decodable>(_ path: String, _ body: Encodable, as: T.Type = T.self, method: String = "POST") async throws -> T {
		try JSONDecoder().decode(T.self, from: try await send(path, method: method, body: body))
	}

	/// multipart/form-data upload of one file to /uploads
	func upload(_ file: URL) async throws -> Upload {
		let data = try Data(contentsOf: file)
		let boundary = "mailroom-\(UUID().uuidString)"
		var body = Data()
		let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "_")
		body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n".data(using: .utf8)!)
		body.append("Content-Type: \(mimeType(for: file))\r\n\r\n".data(using: .utf8)!)
		body.append(data)
		body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
		var r = try request("/uploads", method: "POST", timeout: 120)
		r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
		r.httpBody = body
		struct Out: Decodable { let upload: Upload }
		return try JSONDecoder().decode(Out.self, from: try await run(r)).upload
	}
}

private func mimeType(for url: URL) -> String {
	switch url.pathExtension.lowercased() {
	case "pdf": "application/pdf"
	case "png": "image/png"
	case "jpg", "jpeg": "image/jpeg"
	case "gif": "image/gif"
	case "txt": "text/plain"
	case "csv": "text/csv"
	case "zip": "application/zip"
	case "doc": "application/msword"
	case "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	default: "application/octet-stream"
	}
}

/// Lets `send` take any Encodable body
private struct AnyEncodable: Encodable {
	let value: Encodable
	init(_ value: Encodable) { self.value = value }
	func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// The session token lives in the login keychain, never in a file
enum Keychain {
	private static let service = "com.shinxz.mailroom"

	static func read(_ account: String) -> String? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
		return String(data: data, encoding: .utf8)
	}

	static func write(_ account: String, _ value: String?) {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		SecItemDelete(query as CFDictionary)
		guard let value, !value.isEmpty else { return }
		var add = query
		add[kSecValueData as String] = Data(value.utf8)
		SecItemAdd(add as CFDictionary, nil)
	}
}
