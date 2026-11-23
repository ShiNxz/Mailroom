// swift-tools-version:6.0
import PackageDescription

// The Mailroom Mac app. Built with the command line tools, no Xcode project:
//   scripts/bundle.sh   -> build/Mailroom.app
let package = Package(
	name: "Mailroom",
	platforms: [.macOS(.v14)],
	targets: [
		.executableTarget(name: "Mailroom", path: "Sources/Mailroom"),
	],
	swiftLanguageModes: [.v5]
)
