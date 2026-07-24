// bin/displays/list-displays.swift
//
// アクティブなディスプレイを列挙するワンショット CLI(引数なし)。
// `src/lib/displayList.ts` が swiftc で事前コンパイルしたバイナリを実行し、
// stdout の JSON を受け取る(呼び出し方式は bin/ocr/vision-ocr.swift と同じ)。
//
// D4(対象ディスプレイの自動一致)が、obs-websocket の GetInputSettings が返す
// display_uuid と突き合わせる相手・「アクティブディスプレイが1枚だけか」の
// 判定・テレメトリ推論(どのディスプレイの bounds に最も多くのサンプルが
// 収まるか)の3用途すべてにこの一覧を使う。
//
// 出力(stdout): { "displays": [ { "id": 1, "uuid": "...",
//   "bounds": { "x":0, "y":0, "w":1470, "h":956 }, "isMain": true } ],
//   "accessibilityTrusted": false }
// bounds は CGDisplayBounds(Quartz グローバル座標。左上原点・Y下向き)。
// accessibilityTrusted は AXIsProcessTrusted()(プロンプトを出さない読み取り
// 専用チェック。カーソルヘルパの AXIsProcessTrustedWithOptions とは違い許可を
// 要求しない)。`doctor` の D9 accessibility チェックがこれを読む(位置サンプルは
// 権限不要・形状/クリックだけがこの許可に依存するため未許可は warn に留める)。
//
// 失敗時は stderr にメッセージを出し非ゼロで終了する(呼び出し側 Node が
// try/catch で優雅に劣化させる)。

import CoreGraphics
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(0, nil, &displayCount) == .success else {
    fail("CGGetActiveDisplayList(count) failed")
}
var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
guard CGGetActiveDisplayList(displayCount, &displayIds, &displayCount) == .success else {
    fail("CGGetActiveDisplayList(ids) failed")
}

var displays: [[String: Any]] = []
for id in displayIds {
    let bounds = CGDisplayBounds(id)
    let uuidString: String
    if let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() {
        uuidString = CFUUIDCreateString(nil, uuid) as String? ?? ""
    } else {
        uuidString = ""
    }
    displays.append([
        "id": id,
        "uuid": uuidString,
        "bounds": [
            "x": bounds.minX,
            "y": bounds.minY,
            "w": bounds.width,
            "h": bounds.height,
        ],
        "isMain": CGDisplayIsMain(id) != 0,
    ])
}

let payload: [String: Any] = [
    "displays": displays,
    "accessibilityTrusted": AXIsProcessTrusted(),
]
guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
    let json = String(data: data, encoding: .utf8)
else {
    fail("failed to serialize JSON")
}
print(json)
