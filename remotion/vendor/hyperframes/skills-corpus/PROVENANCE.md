# PROVENANCE

このディレクトリ(`skills-corpus/`)は HeyGen HyperFrames の skills 群から、
Markdown と HTML(テキストのみ・バイナリ/スクリプト無し)を**ほぼそのまま
(near-as-is)複製**した参照コーパスである。人間/AI の作者が執筆時に参照する
ソース資料であり、**CutFlow のコードからは一切読まれない**(実行時に import
されるファイルは無い)。

`docs/hyperframes-skills/` の翻案層(upstream の記法を CutFlow native
interpreter 向けに書き換えたもの)とは異なり、ここに含まれるファイルは
**原文のまま逐語複製**する(改変しない)。

## 取得元

| 項目 | 値 |
|---|---|
| upstream | `https://github.com/heygen-com/hyperframes` |
| ref | `main` |
| commit SHA | `458df4c41294655f76e551100a9b634114209bb9` |
| 取得日 | 2026-07-20 |
| license | Apache-2.0(全文は `../LICENSE`) |

`talking-head-recut/NOTICE.md` は upstream 側が保持している vtake-skills
(`vtake-cut`)由来の MIT 帰属表示を、そのまま逐語で維持している(この
ディレクトリの Apache-2.0 表示に加えて、当該スキルにだけ適用される個別の
attribution)。

## 収録している skill サブツリー

- `hyperframes-animation/`(`adapters/` は下記の4本を除く全 md + `examples/` の
  html 13 本。`scripts/`(mjs)は除外)
- `music-to-video/references/motion-primitives/`(html 37 本)・
  `music-to-video/references/templates/`(html 9 本)・
  `motion-primitive-catalog.md` / `template-catalog.md`
- `talking-head-recut/references/`(styles/layouts/frames の html 17 本 +
  `DESIGN_INDEX.md`)+ `NOTICE.md`
- `hyperframes-core/references/`(契約系 8 本: data-attributes /
  determinism-rules / tracks-and-clips / variables-and-media /
  sub-compositions / composition-patterns / minimal-composition /
  full-screen-motion)
- `hyperframes-keyframes/`(`SKILL.md` + `references/keyframe-patterns.md`)
- `motion-graphics/`(`SKILL.md` + `catalog-map.md` +
  `samples/asset-fusion/_ref-circle-highlight.html` の1本のみ)
- `faceless-explainer/` / `pr-to-video/` / `product-launch-video/` の
  `references/visual-design.md` / `references/motion-language.md`
  (`pr-to-video` はさらに `references/code-vocabulary.md`)

## 除外している層

- **バイナリ/非テキスト資産**: `woff2` / `png` / `mp3` / その他フォント・
  画像・音声ファイル
- **スクリプト/実行コード**: `.mjs` / `.cjs` / `.json`(`scripts/` 配下含む。
  HyperFrames の engine/runtime そのものは持ち込まない方針 ——
  memory `hyperframes-integration-native-decision` 参照)
- **未 pin の runtime adapter**: `hyperframes-animation/adapters/` のうち
  `animejs.md` / `three.md` / `typegpu.md` / `html-in-canvas-patterns.md`
  (CutFlow は GSAP 3.14.2 / Lottie 5.12.2 だけを pin 済み。Three.js /
  Anime.js / TypeGPU は `src/lib/hyperframeCdn.ts` の CDN_PINS に無い)
- **ワークフロー/オーケストレーション系 md**: 各 skill の `SKILL.md` 本体
  (`hyperframes-keyframes` / `motion-graphics` を除く)や、上記以外の
  reference(P0 の抽出計画で対象外とされた層)
