# Vendored HyperFrames — 作図契約 spec の参照のみ（実行コードは持ち込まない）

このディレクトリには HyperFrames の**作図契約の spec（docs）**だけを置く。engine
（Chrome seek + ffmpeg）も runtime（seek IIFE）も **HF の実行コードは一切 vendor
しない**。Cutflow は同じ data-* 契約を **native な Remotion interpreter** で実装する
（`docs/programs/hyperframes-integration-program.md` §1・§4）。

## なぜ実行コードを持ち込まないか

作図契約は実装非依存の**仕様**であり、HF runtime はその一実装にすぎない。Cutflow の
素材用途（章タイトル / 説明カード / 図解 / kinetic typography）は CSS/WAAPI の範囲に
収まり、CSS/WAAPI アニメはブラウザ標準で seek 可能（`element.getAnimations()` の
`currentTime`）なので、HF runtime（267KB / 12,300 行）を追従・保守せずに契約を
native で honor できる。GSAP/Lottie が必要になった場合も小さな native shim で足りる。

## 素性（spec docs の出所）

| 項目 | 値 |
|---|---|
| upstream | https://github.com/heygen-com/hyperframes (`packages/cli`) |
| npm package | `hyperframes@0.7.62`（`dist/docs/` を参照コピー） |
| license | Apache-2.0（`./LICENSE`。docs 再配布の attribution 用） |
| 内容 | `upstream-docs/`: `data-attributes.md` / `compositions.md` / `gsap.md` / `rendering.md` / `examples.md` / `troubleshooting.md` |
| 取得日 | 2026-07-18 |

## 使い方

`upstream-docs/data-attributes.md` 等を**契約の正**として、Cutflow 側で次を実装する:

- **check gate**（`docs/…hyperframes-integration-program.md` C2）: typed variables 配列
  形式・composition/clip の必須 `data-*`・remote URL 禁止・seek-safe・font 埋め込み。
- **native seek interpreter**（同 C1）: data-* を読み、Remotion の `useCurrentFrame()`
  から CSS/WAAPI アニメを `getAnimations().currentTime` で seek。GSAP/Lottie は必要時に
  小 shim を足す。

## fallback（現時点では不使用）

native の backend カバレッジが、必要な演出に対して実測で不足した場合に限り、その
backend のためだけに HF runtime（`hyperframe-runtime.js`）の vendor を再検討する。
その場合は npm `hyperframes@0.7.62` の `dist/hyperframe-runtime.js`（SHA-256
`42602044e898c332ba4cfb28b0834939ca1c6cce0e55caceef5954291493ddd3`）を無改変で取り込み、
本表に追記する。判断基準は統合プログラム doc §4.1。
