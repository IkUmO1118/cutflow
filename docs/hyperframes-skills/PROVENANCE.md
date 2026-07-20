# 素性(HyperFrames skills から採取したコンテンツの出所)

このディレクトリの markdown は、HeyGen HyperFrames の AI skills(`skills/*/SKILL.md`)
から**設計上の知見だけを抽出・翻案**したものです。§10 判断履歴(統合プログラム
`docs/programs/hyperframes-integration-program.md` C3)に基づく成果物。

| 項目 | 値 |
|---|---|
| upstream | https://github.com/heygen-com/hyperframes |
| path | `skills/` |
| ref | `main` = SHA `458df4c41294655f76e551100a9b634114209bb9` |
| 取得日 | 2026-07-18 / 2026-07-20(references 層フル抽出) |
| license | Apache-2.0。全文は複製せず `../../remotion/vendor/hyperframes/LICENSE` を参照する |
| 翻案した skills | `hyperframes-core` / `hyperframes-animation` / `hyperframes-keyframes`(契約+作法を精読) / `faceless-explainer` / `motion-graphics` / `pr-to-video` / `hyperframes-creative`(デザイン感性のみ採取) |

## 翻案の方針

このリポジトリの native interpreter(C1: `remotion/HyperFrame.tsx` +
`src/lib/hyperframe.ts`)は CSS アニメーション + WAAPI(`element.animate`)を
`document.getAnimations()` 経由で seek するのに加えて、GSAP 3.14.2・
Lottie 5.12.2・Anime.js 3.2.2 を pin 済み(`src/lib/hyperframeCdn.ts`)で、
`window.__timelines`(GSAP の paused timeline)/ `window.__hfLottie`(Lottie
animation)/ `window.__hfAnime`(Anime.js instance配列)への登録経由で絶対時刻へ
seek 駆動できます(Three.js / TypeGPU は未 pin のまま対象外)。同様に check ゲート(C2: `src/lib/hyperframeCheck.ts`)は
リモート URL(pin 外)・タイマー・非決定的 API を一律で禁止します。したがって
上記 skills の内容は**そのまま複製できません**。次を取り除いた上で、Cutflow の
native な作図契約に合わせて書き直しています(seek-safe/決定論のドクトリンは
GSAP/Lottie/Anime.js を pin した後も不変で、自走・壁時計依存は引き続き禁止):

- Three.js / TypeGPU 等、pin 外の非 CSS/WAAPI バックエンド
  (GSAP・Lottie・Anime.js は pin 済みで `data-hf-requires="gsap"`/
  `"lottie"`/`"anime"` 経由で利用可能)
- `npx hyperframes` CLI(`init`/`lint`/`check`/`snapshot`/`preview`/`render`
  等)・HeyGen サインイン・`media-use` によるアセット解決
- capture(URL キャプチャ)・registry(`npx hyperframes add <block>`)・
  sub-agent オーケストレーション(director/builder/frame-worker の分業)

残したのは、**composition の作図契約**(root/clip の `data-*`・typed
variables・determinism)と、**seek-safe なモーションの作法**(何を避けるべきか
= `Math.random`/`Date.now`/`performance.now`/タイマー/非同期生成タイムライン)、
そして **カードのデザイン感性**(パレット・タイポグラフィ・レイアウトの発想)
だけです。これは HeyGen skills の**逐語的な再配布ではありません**
(verbatim redistribution ではない翻案)。

## 対応表

| このリポジトリのファイル | 由来 |
|---|---|
| `authoring-contract.md` | `hyperframes-core`(SKILL.md 本文+ Non-Negotiable Rules 節)を Cutflow 向けに要約 |
| `motion-css-waapi.md` | `hyperframes-animation`(css/waapi adapter の選定理由+Anime.js adapterの要点)+ `hyperframes-keyframes`(seek-safe pose rules・禁止リスト) |
| `card-patterns.md` | `faceless-explainer` / `motion-graphics` / `pr-to-video` / `hyperframes-creative` のデザイン感性(カテゴリ分類・パレット/タイポの発想)から起こしたオリジナルの numbered menu |
| `../../prompts/hyperframe.md` | 上記3ファイルを踏まえて書いた C4 用の運用プロンプト |

full な契約仕様(`data-*` の網羅表・CLI 未使用の native 実装への正の参照)は
このディレクトリではなく `../../remotion/vendor/hyperframes/upstream-docs/`
(HF 公式 docs のそのまま vendor)を見る。
