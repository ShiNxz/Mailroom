#!/bin/bash
# Builds build/Mailroom.app from the Swift package: release build, Info.plist, icon, ad-hoc signature.
# No Xcode needed, the command line tools are enough.
#   apps/mac/scripts/bundle.sh            build only
#   apps/mac/scripts/bundle.sh --install  and copy it to /Applications
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release

APP=build/Mailroom.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Mailroom "$APP/Contents/MacOS/Mailroom"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# The icon is drawn once and kept in build/
if [ ! -f build/AppIcon.icns ]; then
	swift scripts/make-icon.swift build/icon-1024.png
	ICONSET=build/AppIcon.iconset
	rm -rf "$ICONSET" && mkdir -p "$ICONSET"
	for s in 16 32 128 256 512; do
		sips -z $s $s build/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
		sips -z $((s * 2)) $((s * 2)) build/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
	done
	iconutil -c icns "$ICONSET" -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: enough to run on this Mac. macOS asks once to allow keychain access after each rebuild.
codesign --force --deep --sign - "$APP"
echo "Built $APP"

if [ "${1:-}" = "--install" ]; then
	rm -rf /Applications/Mailroom.app
	cp -R "$APP" /Applications/Mailroom.app
	echo "Installed /Applications/Mailroom.app"
fi
