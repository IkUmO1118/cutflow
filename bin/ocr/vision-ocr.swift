// bin/ocr/vision-ocr.swift
//
// AI が画面内テキスト(コード/ターミナル/エラー)を読むための Apple Vision OCR
// ワンショット CLI。`src/lib/ocr.ts` が swiftc で事前コンパイルしたバイナリを
// 画像パス+言語 CSV を引数に実行し、stdout の JSON を受け取る(呼び出し方式は
// docs/plans/2026-07-06-readable-eyes-ocr-design.md 論点2の決定どおり)。
//
// 引数: <image-path> [languages-csv]("en,ja" 省略時 "en,ja")
// 出力(stdout): { "lines": [ { "text": "...", "confidence": 0.98,
//   "box": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05 } } ] }
//   box は Vision 標準の正規化座標(0..1・原点左下・y上向き)のまま返す。
//   左上原点・出力px への変換は Node 側(src/lib/ocr.ts)の純関数が行う。
//
// 失敗時は stderr にメッセージを出し非ゼロで終了する(呼び出し側 Node が
// try/catch で優雅に劣化させる。macOS 以外の環境ではこのバイナリ自体が
// ビルドできないので、そちらは Node 側の swiftc 失敗パスで劣化する)。

import Foundation
import Vision
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count >= 2 else {
    fail("usage: vision-ocr <image-path> [languages-csv]")
}
let imagePath = CommandLine.arguments[1]
let languagesCsv = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "en,ja"
let languages = languagesCsv
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }

guard let image = NSImage(contentsOfFile: imagePath) else {
    fail("failed to load image: \(imagePath)")
}
guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("failed to get CGImage from: \(imagePath)")
}

// 認識レベル・言語補正はコード内の閉じた定数(profile.ts の D1 と同じ思想:
// プリセット的で変える必要が薄いものは設定爆発を避けてコードに置く)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if !languages.isEmpty {
    request.recognitionLanguages = languages
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("Vision request failed: \(error)")
}

struct OcrBox: Codable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}
struct OcrLine: Codable {
    let text: String
    let confidence: Double
    let box: OcrBox
}
struct OcrOutput: Codable {
    let lines: [OcrLine]
}

var lines: [OcrLine] = []
for observation in request.results ?? [] {
    guard let top = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append(
        OcrLine(
            text: top.string,
            confidence: Double(top.confidence),
            box: OcrBox(x: box.minX, y: box.minY, w: box.width, h: box.height)
        )
    )
}

let encoder = JSONEncoder()
guard let data = try? encoder.encode(OcrOutput(lines: lines)),
      let json = String(data: data, encoding: .utf8) else {
    fail("failed to encode OCR result as JSON")
}
print(json)
