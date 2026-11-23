// Draws the app icon: a white envelope on an indigo tile, like the web app's mark.
//   swift scripts/make-icon.swift build/icon-1024.png
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.dropFirst().first ?? "icon-1024.png"
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func rgb(_ hex: Int, _ alpha: CGFloat = 1) -> CGColor {
	CGColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255,
	        blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

// The tile, on Apple's icon grid (824 pt inside 1024), with a soft shadow
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.28))
ctx.addPath(tilePath)
ctx.setFillColor(rgb(0x4F46E5))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let ground = CGGradient(colorsSpace: space, colors: [rgb(0x7C83FF), rgb(0x4338CA)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(ground, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
let glow = CGGradient(colorsSpace: space, colors: [rgb(0xFFFFFF, 0.22), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 360, y: 800), startRadius: 0, endCenter: CGPoint(x: 360, y: 800),
                       endRadius: 520, options: [])
ctx.restoreGState()

// The envelope: a rounded white body and the flap as two strokes meeting in the middle
let body = CGRect(x: 262, y: 322, width: 500, height: 360)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x1E1B4B, 0.35))
ctx.addPath(CGPath(roundedRect: body, cornerWidth: 54, cornerHeight: 54, transform: nil))
ctx.setFillColor(rgb(0xFFFFFF))
ctx.fillPath()
ctx.restoreGState()

ctx.setStrokeColor(rgb(0x4F46E5))
ctx.setLineWidth(34)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.move(to: CGPoint(x: body.minX + 56, y: body.maxY - 64))
ctx.addLine(to: CGPoint(x: body.midX, y: body.midY + 6))
ctx.addLine(to: CGPoint(x: body.maxX - 56, y: body.maxY - 64))
ctx.strokePath()

let image = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("Wrote \(out)")
