# Vendored OpenScreen — 単体カーソルヘルパ（MIT・vendor + 小改変）

母艦: `docs/programs/openscreen-cursor-zoom-program.md`。設計: `docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md`（D1/D2）。

このディレクトリには OpenScreen の**単体 Swift カーソルヘルパ**（`OpenScreenMacOSCursorHelper/`）だけを
vendor する。OpenScreen の撮影スタック本体（Electron + ScreenCaptureKit/WGC ヘルパ + webcam +
WebAudio mix・Pixi/WebCodecs 描画）は取り込まない（CutFlow は OBS を撮影の主役として維持する。
母艦 §1・§5）。

## 素性

| 項目 | 値 |
|---|---|
| upstream（現役版・参照素性） | `https://github.com/getopenscreen/openscreen`（v1.7.0 時点で現役） |
| 参照クローン（ローカル・repo外） | `~/dev/labs/openscreen`（`https://github.com/siddharthvaddem/openscreen`。archived 旧本家）。
  当該ファイル（`OpenScreenMacOSCursorHelper/main.swift`）は getopenscreen 現役版とバイト同一と確認済み（調査レポート `~/dev/labs/openscreen-research-for-cutflow.md` §9 相当・母艦 冒頭） |
| 参照クローンの commit | `f57e36e25448b5af6c7b1b271066fe5beb9b8a49`（2026-06-16。当該ファイルの最終更新） |
| 取得元パス | `electron/native/screencapturekit/Sources/OpenScreenMacOSCursorHelper/` |
| license | MIT © 2025 Siddharth Vaddem。全文は下記「MIT notice」節 |
| 取得日 | 2026-07-24 |

## vendor しているファイル

| ファイル | 状態 |
|---|---|
| `OpenScreenMacOSCursorHelper/main.swift` | **vendor + 小改変**（下記「改変点」参照） |
| `OpenScreenMacOSCursorHelper/Package.swift` | vendor + trim（upstream は2ターゲット構成（capture helper + cursor helper）。CutFlow が使うのはカーソルヘルパだけなので、この1ターゲットだけに絞った）。**CutFlow のビルド経路（`doctor`・後続 P）はこのファイルではなく `swiftc main.swift -o <bin>` を直接叩く**（単一ファイル・外部パッケージ依存ゼロなので SwiftPM のパッケージ解決が不要。このファイルは upstream 構成との対応関係を示す参照用） |

## 改変点（vendor + 小改変。母艦 §3 の訂正）

Upstream の `main.swift` は `sample` イベントで**カーソル形状（type + 画像）とクリックだけ**を emit し、
**位置（座標）を一切出していない**。OpenScreen 本体では位置サンプリングは Electron 側
（`screen.getCursorScreenPoint()`）が担当する分業になっており、CutFlow は Electron を持たない
（Node に screen 系 API が無い）ため、**この vendor コピーにだけ位置出力を追加した**:

1. `CursorHelperRequest` に `displayId: UInt32?`（`CGDirectDisplayID`）を追加。指定時はそのディスプレイの
   `CGDisplayBounds` で正規化、未指定時は `CGMainDisplayID()`（無効な ID が来た場合もこれにフォールバック）。
2. `resolveTargetDisplayBounds(displayId:)` / `normalizedCursorPosition(in:)` を追加し、`sample` イベントへ
   `cx`, `cy`（ともに Double。対象ディスプレイ内で 0〜1 に正規化、ディスプレイ外は範囲外の値がそのまま出る）、
   `inBounds`（Bool）を追加。
3. その他のロジック（カーソル形状判定・クリックの `CGEvent` タップ・カーソル画像のキャプチャ・`ready` イベント）は
   **一切変更していない**。

### 座標系（実装時にハマった罠と実測での確認）

`accessibilityPointForMouse()`（upstream 既存関数）は `NSEvent.mouseLocation`（Cocoa: 左下原点・Y上向き）を
**プライマリディスプレイの高さを軸に1回だけ Y 反転**して、グローバルな Quartz 座標（左上原点・Y下向き。
`CGDisplayBounds` と同じ座標系）に変換する。この変換はプライマリ以外のディスプレイ上の点にも**そのまま
成り立つ**（剛体的な鏡映変換のため）。したがって `normalizedCursorPosition(in:)` は、この関数の戻り値を
**対象ディスプレイの `CGDisplayBounds` に対してそのまま**（Y 反転を重ねずに）引き算して正規化している:

```swift
let point = accessibilityPointForMouse()  // 既にグローバル Quartz 座標（左上原点・Y下向き）
let cx = (point.x - bounds.minX) / bounds.width
let cy = (point.y - bounds.minY) / bounds.height  // ここでもう一度 (bounds.maxY - point.y) 式の反転を
                                                    // 重ねると二重反転になり cy が上下反転する（要注意）
```

設計書（D1 plan §2 D2）の一次案は `cy = (bounds.maxY - mouseY) / bounds.height` という式だったが、これは
`mouseY` が「まだ反転していない生の Cocoa 座標」であることを前提にした式で、既に `accessibilityPointForMouse()`
を経由した点（1回反転済み）に対して適用すると**二重反転（上下ミラー）になるバグ**になる。実装時にこの点を
上記のとおり解決し、実機で以下を確認した（2026-07-24・`swiftc` ビルド + 単発起動の手動 smoke）:

- `CGGetActiveDisplayList` で実機の2ディスプレイを列挙し、`CGDisplayCreateUUIDFromDisplayID` の UUID が
  obs-websocket の `GetInputSettings`（`display_uuid`）で観測した値と**完全一致**（内蔵 Retina =
  `37D8832A-2D66-02CA-B9F7-8F30A301B230` / 外部モニタ = `05FD3730-92F0-4138-BC72-3A1B013AACF4`）。
  D4（obs-websocket との UUID 突き合わせ）が実装可能と確認できた。
- `displayId` 未指定（プライマリへフォールバック）でヘルパを起動し、マウスがプライマリ外（セカンダリ
  ディスプレイ上）にあるとき `cx>1`・`inBounds:false` を確認（範囲外が正しく検出される）。
- `displayId` にセカンダリの実 ID（`3`）を指定して起動し、マウスをそのディスプレイ上に置いた状態で
  `cx=0.592, cy=0.256, inBounds:true` のように `[0,1]` に収まる値を確認（二重反転していれば `cy` が
  `1 - 0.256 = 0.744` 付近に出るはずだが、そうならなかった＝反転は1回だけで正しい）。

### 追加の小改変(P4・D4 テレメトリ推論フォールバック)

D4(対象ディスプレイの自動一致)の第3段「テレメトリ自身から推論(in-bounds 滞在最長の
ディスプレイ)」は、録画開始前に対象ディスプレイを決められなかったときのフォールバック
であるため、**どのディスプレイに対して正規化すべきかを録画後まで判定できない**。この
段だけのために、`sample` へ生の Quartz グローバル座標(`ax`, `ay`。正規化前・displayId に
依存しない)を追加した。`cx`/`cy`/`inBounds`(spawn 時に解決済みの displayId に対する
正規化)は不変。Node 側(`src/lib/cursorGeom.ts` の `absolutePointToNormalized`)が録画
停止後、`ax`/`ay` の集計からどのディスプレイの bounds が最も多くのサンプルを含むかを
判定し、そのディスプレイに対して事後的に再正規化する。

## MIT notice

```
MIT License

Copyright (c) 2025 Siddharth Vaddem

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 本家追従について

母艦 §5 の方針どおり、**取り込み切り**（本家の以後の更新を追従しない）。位置出力の改変は
このリポジトリだけの差分として維持する。
