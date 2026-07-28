# vendor provenance — 外部依存の出所・ライセンス・pin 理由

CutFlow は依存追加ゼロ主義だが、render エンジン置換（
`docs/programs/render-engine-replacement-program.md`）の M3a だけは意図的例外として
npm パッケージを追加する（母艦§5参照）。追加のたびにここへ1段落ずつ記録する。

## opencut-wasm@0.2.10（**2026-07-28 削除・不採用に変更**）

一時導入していたが、CutFlow の唯一のバンドラ esbuild でも実ブラウザの
ネイティブ ES Module 機構でもロードできないと判明したため削除した
（詳細は母艦§9「M3a Phase5 直前・重大発見」ログ）。理由: このパッケージの
JS エントリ（wasm-bindgen の "bundler" ターゲット出力）が
`import * as wasm from "./opencut_wasm_bg.wasm"` という WASM の ES Module
直 import 構文を使っており、(1) chrome-headless-shell(Remotion 同梱)へ
`<script type=module>` で読ませると
`Failed to load module script: ... MIME type of "application/wasm"` で
失敗する(WASM/ESM integration はどのブラウザにも既定で入っていない未成熟
仕様)。(2) esbuild は `.wasm` 用の loader を持たず、`--loader:.wasm=file`
を強制しても `import * as wasm` の中身が `{default: "url文字列"}` という
静的アセット参照になるだけで、wasm-bindgen が要求する実際の wasm exports
オブジェクトにならない(実行時に確実に壊れる)。Vite/webpack 等の特定
bundler 前提の出力で、esbuild へのネイティブ対応が無い。ユーザー判断で
**自前 WGSL バックエンドへ切替**（`src/engine/runtime/webgpuBackend.ts`）。
FrameDescriptor が継ぎ目のため、frameSource/sourcePool/frameBlit/
audioScheduler/clock(Phase2・Phase4)は無改変で流用できた。npm からは
`npm uninstall opencut-wasm` で削除済み（package.json に残っていない）。

## mediabunny@1.51.0

出所: [mediabunny](https://mediabunny.dev/)（[GitHub](https://github.com/Vanilagy/mediabunny)）。
WebCodecs ベースの動画デコード/エンコード/mux ライブラリ。CutFlow は `VideoSampleSink`/
`samplesAtTimestamps` 等でプロキシ動画のフレーム供給に使う（`<video>` 要素を使わないための
中核依存。母艦§1-2）。ライセンス: **MPL-2.0**（母艦§5は当初「MIT」と誤記していたが
`npm view mediabunny license` で MPL-2.0 と確認し、2026-07-28 に母艦側を訂正した）。
MPL-2.0 はファイル単位の弱いコピーレフトで、CutFlow 本体（MIT）を MPL 化する義務は無く、
mediabunny 自体を改変しない限り追加の開示義務も発生しない。CutFlow は mediabunny のソースを
改変せず npm 依存として利用するのみ。`1.51.0` に固定する理由: `opencut-wasm` と同様に
Phase 1 導入時点の挙動を固定するため（VideoFrame 供給の細部は Phase 2 で作り込むため、
マイナーバージョン差による API 変化を避けたい）。
なお `@remotion/bundler` 等 Remotion 系パッケージが `mediabunny@1.47.0` を推移的依存として
既に持っているが（`npm ls mediabunny` で確認）、これは Remotion 内部の録画補助機能が使う
別インスタンスであり CutFlow のエンジンコードとは無関係（import しない・依存を共有しない）。
