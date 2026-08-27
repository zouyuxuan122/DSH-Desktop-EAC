// macOS OCR engine for the picturereader DSH plugin (image_ocr engine="macos").
//
// Wraps Apple Vision framework text recognition (VNRecognizeTextRequest) in a
// tiny CLI so the Node plugin can spawn it exactly like the Windows engine.
// Fully local: no network, no Python, no third-party dependency. Build once:
//   xcrun swiftc -O -swift-version 5 macos-ocr.swift -o ~/.dsh/cache/picturereader/macos-ocr
//
// Usage:
//   macos-ocr <png-path> [language]
//     <png-path>  absolute path to a PNG/JPEG/TIFF image file
//     [language]  optional BCP-47 tag (e.g. zh-Hans, en-US); default zh-Hans first
//
// Output (stdout), coordinates in pixels with top-left origin to match the
// paddle/rapid engines' contract:
//   {"lines":[{"text":"...","score":0.97,"x":12,"y":34,"width":180,"height":40},...]}
// Exit codes: 0 success (possibly zero lines) / 1 usage or IO / recognition error.

import Foundation
import Vision
import CoreGraphics
import ImageIO

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("macos-ocr: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, arguments.count <= 3 else {
    fail("usage: macos-ocr <png-path> [language]")
}
let imagePath = arguments[1]
let languageArgument = arguments.count == 3 ? arguments[2] : nil

// Load the image through ImageIO (PNG/JPEG/TIFF/BMP…).
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("cannot read image: \(imagePath)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false  // faithful transcription, no autocorrect

// Language priority follows array order; Chinese-first by default to match the
// plugin's primary use case, English as the ever-present fallback.
var languages = languageArgument.map { [$0, "en-US"] } ?? ["zh-Hans", "en-US"]
var seen = Set<String>()
languages = languages.filter { seen.insert($0).inserted }
request.recognitionLanguages = languages

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("recognition failed: \(error)")
}

// Vision reports normalized bounding boxes with bottom-left origin; convert to
// pixel coordinates with top-left origin (y flip), rounding outward edges.
let width = CGFloat(cgImage.width)
let height = CGFloat(cgImage.height)

var lines: [[String: Any]] = []
if let observations = request.results {
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        let x = Int((box.origin.x * width).rounded())
        let y = Int(((1 - box.origin.y - box.height) * height).rounded())
        let boxWidth = Int((box.width * width).rounded())
        let boxHeight = Int((box.height * height).rounded())
        lines.append([
            "text": candidate.string,
            "score": Double(candidate.confidence),
            "x": x,
            "y": y,
            "width": boxWidth,
            "height": boxHeight
        ])
    }
}

let output: [String: Any] = ["lines": lines]
guard let data = try? JSONSerialization.data(withJSONObject: output),
      let json = String(data: data, encoding: .utf8) else {
    fail("cannot serialize result")
}
print(json)
