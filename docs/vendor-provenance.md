# vendor provenance — 外部依存の出所・ライセンス・pin 理由

CutFlow は依存追加ゼロ主義だが、render エンジン置換（
`docs/programs/render-engine-replacement-program.md`）の M3a だけは意図的例外として
2つの npm パッケージを追加する（母艦§5参照）。追加のたびにここへ1段落ずつ記録する。

## opencut-wasm@0.2.10

出所: [OpenCut](https://github.com/opencut/opencut) プロジェクトが公開する prebuilt
WebAssembly バイナリ（Rust の `compositor`/`gpu`/`effects`/`masks` クレートを wasm-bindgen で
ビルドしたもの）。ライセンス: MIT。CutFlow はこれを WebGPU/WebGL2 コンポジタとして
`renderFrame`/`uploadTexture`/`initCompositor` 等の公開 API 経由でのみ利用する
（fork のソースは読むが Rust 側には一切手を入れない。母艦§4「実装セッション共通ルール」）。
`0.2.10` に固定する理由: 2026-07-28 の Phase 0 被覆確認（母艦§9「M3a Phase0」ログ）で
このバージョンの registry 実装（`gaussian-blur` シェーダ1本・`LayerDescriptor` の
transform/opacity/blendMode/mask）を実地に検証済みであり、それ以外のバージョンは
未検証。upstream は開発が止まっている prebuilt のため、意図せぬ挙動変化を避けるため
exact pin（`^`/`~` を使わない）とする。

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
