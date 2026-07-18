# HyperFrames skills 棚卸し(C3)

HeyGen HyperFrames の19本の AI skills(`skills/*/SKILL.md`。GitHub
`heygen-com/hyperframes` @ `main`、npm パッケージには含まれない)を棚卸しし、
Cutflow の native な作図契約(C1/C2)に意味があるものだけを翻案した記録。
統合プログラムの正本は `../programs/hyperframes-integration-program.md`
(このディレクトリの作業は同 doc の C3 フェーズ)。

## 採否

| skill | 判定 | 理由 |
|---|---|---|
| `hyperframes-core` | **SELECT(契約を精読)** | composition の作図契約(root/clip の `data-*`・typed variables・determinism)そのもの。`authoring-contract.md` に翻案 |
| `hyperframes-animation` | **SELECT(css/waapi adapter のみ精読)** | GSAP 前提の6 adapter は不採用。CSS/WAAPI の2 adapter だけが Cutflow の native interpreter と一致する |
| `hyperframes-keyframes` | **SELECT(seek-safe 作法のみ精読)** | 「render-critical motion で使ってはいけない API」の禁止リストが check ゲート(C2)の Rule 5 と同型。pose 作法は `motion-css-waapi.md` に翻案 |
| `faceless-explainer` | **SELECT(デザイン感性のみ採取)** | 実写素材が無い前提でタイポグラフィ/図解/データ可視化だけを発明する原則が、Cutflow のカード生成(素材が無い状態から HTML を書く)と完全に一致。CLI/audio/subagent 機構は不採用 |
| `motion-graphics` | **SELECT(デザイン感性のみ採取)** | kinetic-type / stat / diagram(maps を一般化) / lower-third / code 系のカテゴリ分類を `card-patterns.md` の menu の土台にした。HeyGen registry block・media-use 検索は不採用 |
| `pr-to-video` | **SELECT(デザイン感性のみ採取)** | 「navy code surface」のコードカード発想を `card-patterns.md` #5 に単純化して採取。`gh` 連携・diff 抽出・credits close 等は不採用(そもそも Cutflow のカードに PR 入力は無い) |
| `hyperframes-creative` | **SELECT(デザイン感性のみ採取)** | パレット/タイポグラフィの発想(「web ページに見せない」余白設計等)を各パターンの配色メモに反映。frame-preset のロード機構・design-spec のフロントマター解決は不採用 |
| `talking-head-recut` | REJECT | 実写トーキングヘッド映像の再編集が前提。Cutflow のカードは無音・実写無しの素材専用 |
| `music-to-video` | REJECT | 音楽駆動のビート同期編集。Cutflow のカードは無音(BGM は `bgm.json` の別レイヤーで扱う) |
| `figma` | REJECT | Figma MCP 連携によるアセット取込み。Cutflow はローカルファースト+オフラインが前提で外部 API 連携を持ち込まない |
| `remotion-to-hyperframes` | REJECT | Remotion → HyperFrames への移植ツール。Cutflow は逆方向(HyperFrames の契約を Remotion の native interpreter で実装する側)なので不要 |
| `hyperframes-cli` | REJECT | `npx hyperframes init/lint/check/snapshot/preview/render` 等の CLI 操作。Cutflow は自前の `validate`/`apply`/`frames`/`render` に契約を実装するので CLI 自体は持ち込まない |
| `hyperframes-registry` | REJECT | `npx hyperframes add <block>` のコンポーネントレジストリ。ネットワーク経由の block 取得は Cutflow のオフライン方針(check ゲートのリモート URL 禁止)と相容れない |
| `media-use` | REJECT | HeyGen カタログ/ブランドロゴのオンライン解決。Cutflow の素材は収録フォルダの `materials/` がローカルの正 |
| `embedded-captions` | REJECT | HyperFrames 側の字幕焼き込み機構。Cutflow は独自のテロップ契約(`transcript.json` の `CaptionStyle`)を既に持つ |
| `general-video` | REJECT | 長尺・ナレーション有り・複数シーンの汎用動画制作フロー全体(director/builder/frame-worker のフルオーケストレーション)。Cutflow のカードは単一・無音・自己完結の素材に限定 |
| `product-launch-video` | REJECT | プロダクトサイトのキャプチャからのプロモ動画。Cutflow のカードにサイトキャプチャは無い |
| `slideshow` | REJECT | 画像スライドショー生成。Cutflow は既存の `materials`/`overlays` で同等の役割を持つ |
| `hyperframes`(メイン router) | REJECT | 上記スキル群への意図分岐ルータそのもの。Cutflow 側は `prompts/hyperframe.md` 1本+固定パターンメニューに置き換えたので不要 |

## ゲート規約(test/hyperframeSkills.test.ts が強制する)

このディレクトリと `prompts/hyperframe.md` に書く composition 例は、次の
規約に従うこと:

- **完全な composition** は ```` ```html ```` フェンスで書く。これは
  `test/hyperframeSkills.test.ts` の抽出対象になり、`checkComposition` に
  かけられ**0エラー**であることを機械検証される
- **「悪い例」(壊れた composition・アンチパターン)を示したいときは
  ```` ```text ```` フェンスで書く**。```` ```html ```` にすると
  「本物の composition 例」として抽出・検査されてしまうため、意図的に
  ゲートを通らない例を書くときは必ず `text` フェンスにする(抽出器は
  `html` フェンスしか見ない)
- **部分的なスニペット**(ルート要素の `data-composition-id` を持たない
  断片)は抽出対象にならない(抽出器は `data-composition-id` を含む
  ```` ```html ```` ブロックだけを拾う)。断片を見せたいときはルート要素を
  省いて書けば自然に検査対象から外れる

## 各ファイル

- [`PROVENANCE.md`](./PROVENANCE.md) — 素性(取得元・ref・取得日・
  ライセンス・翻案方針)
- [`authoring-contract.md`](./authoring-contract.md) — `hyperframes-core`
  の契約を Cutflow 向けに要約(root/clip/variables/determinism)
- [`motion-css-waapi.md`](./motion-css-waapi.md) — `hyperframes-animation`
  の CSS/WAAPI adapter + `hyperframes-keyframes` の seek-safe 作法
- [`card-patterns.md`](./card-patterns.md) — カードパターンの numbered
  menu(6パターン、各 gate 通過の ```html 例付き)
- [`../../prompts/hyperframe.md`](../../prompts/hyperframe.md) — 上記を
  踏まえた C4 の運用プロンプト本体
- [`../../remotion/vendor/hyperframes/upstream-docs/`](../../remotion/vendor/hyperframes/upstream-docs/) —
  作図契約の**正**(HF 公式 docs のそのまま vendor)。ここの3ファイルは
  あくまで要約・翻案であり、詳細な `data-*` の網羅表はそちらを見る
