# Remotion 完全排除母艦 — HyperFrames も含めて `remotion` / `@remotion/*` を依存から消す

> 状態: **READY（2026-07-29・設計完了・実装未着手）**
> — §5 の決定（headless Chrome の取得方法）はユーザー批准済み。
> X0〜X7 の実装 plan は `docs/plans/2026-07-29-remotion-x*-*.md`（§5.1 の表）。
>
> 位置づけ: `docs/programs/render-engine-replacement-program.md`（以下「置換母艦」）の
> **§7 削除リストを引き取り、さらに HyperFrames サイドカーと headless Chrome 取得層まで
> 広げた後継母艦**。置換母艦は「本編の絵を自前エンジンへ移す」ところまでを担い、
> §8 で「HF サイドカーは本母艦では一切触らない / 依存スリム化は M4 後の別課題」と
> 明記していた。**その別課題が本書**。
>
> 粒度が食い違う場合、**本編経路の削除に関しては本書が優先**する（置換母艦 §7 は
> 本書 X1/X4 に発展的に解消）。エンジンそのものの設計・画素ゲートの正本は
> 置換母艦のまま。

## 0. 結論（先に答え）

**可能。ただし「消すだけ」では終わらず、4つの実装を先に作る必要がある。**

現状 `remotion` / `@remotion/*` は次の4系統に食い込んでいて、単純削除は不可能:

| 系統 | 中身 | 現状 | 難度 |
|---|---|---|---|
| **A. 死にコード** | `render.fast`/`render.chunks` 一式・本編 composition・`*Still.tsx` | どのステージからも呼ばれていない（`fastRender`/`fastSegment`/`fastPlan`/`fastBase` を参照する stage・CLI はゼロ）。テストだけが生かしている | **低**（消すだけ） |
| **B. 生きている本編 Remotion** | `designStill`（design 静的資産の PNG 焼き）/ `review`（AI copilot の before/after still）/ `renderOneShort`（ショートは丸ごと Remotion CLI）/ frames・thumbnail・framesServe の自動降格 | 全部エンジンで置き換え可能。素材は既に揃っている | **中** |
| **C. HyperFrames サイドカー** | `remotion/HyperFrame.tsx` + `hyperframe` の bundle→`renderMedia` | Remotion を「iframe を毎フレーム `__seek()` してスクショする器」としてしか使っていない。**`engineSession.ts` と `hyperframeAudit.ts` が既に同じことを CDP 直叩きでやっている** | **中**（新規発明はゼロ） |
| **D. headless Chrome の取得** | `ensureBrowser()` が `chrome-headless-shell` を落とす。**自前エンジンの `findHeadlessShell()` がその成果物にぶら下がっている**（`src/lib/engineSession.ts:83`） | ここだけは代替の**新規実装 or 新規依存**が要る。唯一の本質的な追加作業 | **中**（要・意思決定） |

D が唯一の「決めないと進めない」論点（§5）。それ以外は既存部品の組み替え。

**副次的な果実**（消すこと自体より価値があるかもしれない点）:

- `node_modules/@remotion` **93MB** + `node_modules/remotion` 2.3MB + `node_modules/.remotion` **193MB** = 約 **288MB** が消える
- 収録フォルダごとの `.remotion/`（約200MB×収録数の重複。CLAUDE.md が「純粋な再取得可能キャッシュ」と書いているもの）を、**`~/.cutflow/chrome/` の1本へ集約できる**（D の実装で自然にそうなる）
- 「エンジン失敗→旧経路へ自動降格」が4箇所から消え、**置換母艦 §1-10 の「恒久 dual-path にしない」が初めて実際に守られる**（降格は現状 `console.warn` だけで、絵が静かに別経路へ落ちても気づけない）
- review の before/after still が**書き出しと同じエンジン**で撮られるようになる（現状は Remotion オラクル＝実際の `final.mp4` と別経路の絵をユーザーにレビューさせている）

## 1. 現状の完全な棚卸し（2026-07-29 実測）

`grep -rn "from \"@remotion/\|from \"remotion\"" src/ editor/ remotion/ scripts/ test/` の全35件を分類した。

### A. 死にコード（stage / CLI からの到達経路なし）

| ファイル | 備考 |
|---|---|
| `src/lib/fastRender.ts` / `fastSegment.ts` / `fastPlan.ts` / `fastBase.ts` / `fastBaseCapability.ts` | `render.fast/` 高速パス。参照元は自分同士とテストのみ |
| `src/lib/captionStill.ts` / `overlayStill.ts` / `annotationStill.ts` | `render.fast/*/` へ PNG を焼くラッパー。**ただし `captionStill.ts` の `withCaptionStillAssets` だけは生きている `designStill.ts` が使う**（B へ引き継ぎ） |
| `remotion/Main.tsx`(748行) / `CaptionLayer.tsx` / `OverlayLayer.tsx` / `AnnotationLayer.tsx` / `CaptionStill.tsx` / `OverlayStill.tsx` / `AnnotationStill.tsx` / `loadFonts.ts` / `playerFlags.ts` | 本編 composition 一式 |
| `test/fastPlan.test.ts`(826) / `fastSegment.test.ts`(816) / `fastRender.test.ts`(339) / `fastSegmentDesign.test.ts`(274) / `fastBase.test.ts`(194) / `fastBaseCapability.test.ts`(137) / `overlayStill.test.ts`(138) / `annotationStill.test.ts`(104) | 死にコードのテスト。**約2,800行** |
| `remotion.config.ts` | Remotion CLI 設定 |

`test/annotation.test.ts` / `insertMix.test.ts` / `renderPropsClassification.test.ts` / `editorDesignAssets.test.ts` は
**純ロジック側（`src/lib/annotation.ts` 等）も検証していて生きている**ので、fast 経路の項目だけ間引く。

### B. 生きている本編 Remotion

| 場所 | 何をしているか | 置き換え先 |
|---|---|---|
| `src/lib/designStill.ts:113-133` | `DesignStill` composition を `renderStill` して backdrop/screenMask/cameraShadow/cameraMask の4 PNG を焼く。**`renderEngine.ts:21` / `frames.ts:42` / `render.ts:39` / `editor/server.ts:25` から呼ばれる＝エンジン経路の内側に Remotion が残っている** | X2。`remotion/DesignStill.tsx` は `AbsoluteFill`＝div / `Img`＝img / `staticFile`＝パス解決だけで、**Remotion の実行時機能を一切使っていない**（96行）。素の HTML 文字列生成へ落として、engineSession と同じ CDP スクショで焼ける |
| `src/stages/review.ts:338-470, 552-610` | AI copilot diff review の before/after still を `Main` composition の `renderStill` で撮る | X3。`createEngineSession(...).renderAndCapture(tOut)` がまさに「指定出力秒の PNG」を返す。差し替えるだけで**絵が書き出しと一致するようになる**（改善） |
| `src/stages/render.ts:551-563`（`renderOneShort`） | ショートだけ `npx remotion render remotion/index.ts Main` の丸ごと Remotion CLI。**エンジン経路が無い** | X4。`resolveSnapshotRenderContext`（`frames --short` が既に使っている props 構築）＋ `renderEngine` の書き出しループを共有化する |
| `src/stages/frames.ts:97-117` / `thumbnail.ts:33-48` / `framesServe.ts:200-217` | `render.engineExport !== false` でエンジン、失敗すると `console.warn` して Remotion へ降格 | X4。降格ごと削除。`engineExport` config も削除 |
| `editor/client/App.tsx:4` / `EnginePreview.tsx:8` | `@remotion/player` の **`import type` のみ**（`CallbackListener` / `PlayerRef` / `EventTypes`）。`<Player>` の実体は既に無く `EnginePreview` が本番 | X1。ローカル型宣言へ写して依存を切る（実質コメント整理） |

### C. HyperFrames サイドカー

| 場所 | 何をしているか |
|---|---|
| `remotion/HyperFrame.tsx`(128行) | カード HTML を iframe `srcDoc` に流し、`useCurrentFrame()` ごとに `__hyperframes.__seek(frame/fps*1000)` を呼び、`__isReady()` を待って `continueRender`。fatal は `cancelRender` |
| `src/stages/hyperframe.ts:334-370` | `ensureBrowser` → `bundle` → `openBrowser`（profile が angle なら `chromiumOptions.gl`）→ `selectComposition("HyperFrame")` → `renderMedia(codec:"h264")` |
| `src/stages/hyperframeAudit.ts:298-312` | `openBrowser` → `newPage` → `page.goto(dataUrl)` → `page.evaluate(__isReady)` → 時間グリッドで `__seek` して DOM を採取。**Remotion をブラウザ起動器としてしか使っていない** |
| `remotion/Root.tsx:97-107` | `HyperFrame` composition 登録 |
| `scripts/hyperframe-verify.ts` / `hyperframe-webgl-verify.ts` / `hyperframe-audit-calibrate.ts` | 検証スクリプト（同じパターン） |
| `remotion/vendor/hyperframes/` | LICENSE / PROVENANCE / skills-corpus / upstream-docs。**コードは読んでいない**（移設のみ） |

**要点**: HF の Remotion 利用は「毎フレーム `__seek()` して待ってスクショして h264 に固める」だけで、
Remotion のタイムライン・合成・補間は一切使っていない。`engineSession.ts` の
`renderAndCapture(t)` → ffmpeg `image2pipe` パイプ（`renderEngine.ts:107-146`）と
`hyperframeAudit.ts` の `__isReady()` 待ち＋`__seek` 駆動が**既に両方の半分ずつを実装済み**。

### D. headless Chrome の取得

`src/lib/engineSession.ts:82-88` の `findHeadlessShell()` は
`node_modules/.remotion` → `~/Library/Caches/ms-playwright` → `~/Library/Caches/remotion` を
`find` して `chrome-headless-shell` を拾う。エラー文が
**「先に render/frames を1回実行してください」**＝Remotion の `ensureBrowser()` に取得を
依存している。ここが最後の結び目。

## 2. 目標状態

```
package.json dependencies から消えるもの:
  remotion / @remotion/bundler / @remotion/cli / @remotion/player / @remotion/renderer

残るブラウザ利用（すべて自前 CDP）:
  src/lib/browser.ts（新設）— chrome-headless-shell の取得・起動・CDP 接続の唯一の出所
      ├─ engineSession.ts        本編 render / frames / thumbnail / review still
      ├─ designAssets（X2）      design 静的資産の PNG 焼き
      ├─ hyperframeSession（X5） HF カードの render（__seek 駆動 → ffmpeg）
      └─ hyperframeAudit         HF の動的監査（既に CDP 相当の使い方）

remotion/ ディレクトリは消滅。残す中身の行き先:
  remotion/props.ts        → src/lib/renderPropsTypes.ts（Remotion 非依存の純型。約349行）
  remotion/fonts/          → assets/fonts/（Noto Sans JP 可変フォント + OFL）
  remotion/vendor/         → docs/hyperframes-vendor/（LICENSE/PROVENANCE/コーパス。コードなし）
  remotion/DesignStill.tsx → src/lib/designAssetHtml.ts（HTML 文字列生成へ）
  remotion/HyperFrame.tsx  → src/lib/hyperframeSeekDriver.ts（seek 駆動ロジックへ）
  それ以外（Main/Root/index/各Layer/各Still/loadFonts/playerFlags）→ 削除
```

## 3. フェーズと完了ゲート

**実行順は依存順**。X0 は他のすべてに先行する（D の結び目を解かないと A すら安全に消せない）。

| 順 | ID | 内容 | 完了ゲート |
|---|---|---|---|
| 1 | **X0** | `src/lib/browser.ts` 新設。chrome-headless-shell の**取得**（§5 の決定に従う）・起動・CDP 接続を1箇所へ集約。`engineSession.ts` の `findHeadlessShell`/`launchHeadlessShell`/`connectCdp` をここへ移し、`node_modules/.remotion` 依存を切る。取得先は `~/.cutflow/chrome/<buildId>/` | `rm -rf node_modules/.remotion` した状態から `node src/cli.ts frames <dir> --t 10` が通る（＝Remotion の取得物ゼロで自前エンジンが動く）。`npm run gate:pixel` 緑 |
| 2 | **X1** | 死にコード一括削除（§1-A）。`@remotion/player` 型のローカル化。`remotion/props.ts` → `src/lib/renderPropsTypes.ts` 移設（import 元の一括書き換え。約20ファイル） | `npx tsc --noEmit` 緑・`npm test` 緑（削除したテスト分だけ件数が減る。**残ったテストの書き換えはゼロであること**）・`npm run gate:pixel` 緑 |
| 3 | **X2** | design 静的資産を脱 Remotion 化。`DesignStill.tsx` の DOM/CSS を**逐語で** HTML 文字列生成へ写し、X0 の browser で4 PNG を焼く。`captionStill.ts`（＝`withCaptionStillAssets`）を削除 | 移行前後で4 PNG が**画素一致**（`scripts/lib/pixelCompare.mjs` で `maxdiff=0`）・`npm run gate:pixel` 緑・`test/designStill.test.ts` は renderer 差し替えフックのまま通る |
| 4 | **X3** | `review.ts` の before/after still を `createEngineSession().renderAndCapture()` へ差し替え。`bundle`/`openBrowser`/`selectComposition`/`renderStill` を撤去 | エディタの AI copilot diff review が実収録で動作（before/after が出る）・still が `frames` の出力と一致 |
| 5 | **X4** | 本編の Remotion 経路を全撤去。`renderOneShort` をエンジン化（`resolveSnapshotRenderContext` + 書き出しループ共有）・frames/thumbnail/framesServe の自動降格削除・`render.engineExport` config 削除・`remotionResourceArgs` 削除 | `render --short <name>` がエンジンでショートを出す（フレーム数＋video stream duration 検証。**container duration は使わない**）・`frames`/`thumbnail` が Remotion 不在で通る・`npm run gate:pixel` 緑 |
| 6 | **X5** | HF render の脱 Remotion 化。`src/lib/hyperframeSession.ts` 新設（X0 browser → カード HTML を iframe に流す → `__isReady()` 待ち → 毎フレーム `__seek(tMs)` + 2×rAF → `Page.captureScreenshot` → ffmpeg `image2pipe` → h264）。`hyperframeAudit.ts` の `openBrowser` を X0 browser へ差し替え。profile の `chromiumGl:"angle"` は起動フラグへ写す | 既存 HF カード（`test/fixtures/` の全 recipe + 実カード）が render でき、`hyperframe-check` の warn 件数が移行前と同じ。`--from-brief` → `hyperframe` → `hyperframe-place` の鎖が実収録で通る |
| 7 | **X6** | `remotion/` ディレクトリ消滅（残す中身は §2 の行き先へ）。`package.json` から5パッケージ削除。`remotion.config.ts` 削除。検証スクリプト3本を X0/X5 ベースへ書き換え | `grep -rn "@remotion\|from \"remotion\"" src/ editor/ scripts/ test/` が**0件**・`npm ls remotion` が空・`node_modules` 再作成後に全コマンドが動く |
| 8 | **X7** | 契約・文書の追随。`src/lib/files.ts`（`.remotion` の扱い）→ `AGENTS_CONTRACT.md` → `CLAUDE.md` → `docs/usage.md` → `config.yaml` | `test/agentsMd.test.ts` 緑・`node src/cli.ts clean <dir> --dry-run` が既存収録の `.remotion/` を**引き続き掃除できる**（レガシー残骸の回収） |

各ゲートで `npm run gate:pixel`（画素ゲート）を通すのは置換母艦 §7 と同じ規律。
**G1/G2 で緑化済みの物差しを、Remotion オラクルが消える前に毎回使う**のがこの母艦の安全装置。

> ⚠ **X6 の一方向性**: X6 を過ぎると `test/fixtures/engine/pixel-golden/` の
> golden を「捕獲し直す」ことは二度とできない（オラクルが存在しなくなる）。
> golden PNG 12枚は `provenance.json` 付きでコミット済みなので**比較は永続的に可能**だが、
> 出力仕様を意図的に変える改修が将来入ったときは golden を人間の目視承認で
> 打ち直す運用へ変わる。X6 の PR 説明とゲート文書に明記すること。

## 4. HyperFrames をどう置き換えるか（C の具体）

現状 Remotion が提供している機能と、自前での対応:

| Remotion 機能 | HF が使っている理由 | 自前での対応 |
|---|---|---|
| `useCurrentFrame()` | 時刻を進める | ホスト側ループが `t = i/fps` を渡す（`renderEngine.ts` と同型） |
| `delayRender`/`continueRender` | `__isReady()` とレイアウト確定を待ってから撮る | `await evalJs(cdp, "__hyperframes.__isReady()", true)` → `requestAnimationFrame` 2回待ち → スクショ。**`hyperframeAudit.ts:104` が既にこのパターンで動いている** |
| `cancelRender` | fatal な card 失敗で render を止める | `__hyperframes.__failed` を毎フレーム読み、fatal があれば throw（現行 `HyperFrame.tsx` のロジックをそのまま移植） |
| `renderMedia(codec:"h264")` | PNG 列 → mp4 | `renderEngine.ts:107-146` の ffmpeg `image2pipe` パイプを共有関数へ抽出して再利用 |
| `openBrowser({chromiumOptions:{gl:"angle"}})` | WebGL/Three.js カード | X0 browser の起動フラグ（`--use-angle=metal` は既に `engineSession.ts:106` で渡している） |
| `Composition` の `calculateMetadata` | width/height/fps/durationSec 解決 | `resolveHyperframeBuild()` が既に解決済み。composition 登録が要らなくなるだけ |

**新規発明はゼロ**。既存2箇所（engineSession / hyperframeAudit）のパターンの合成。

### HF 特有のリスク: 出力バイトが変わる

memory `hyperframe-render-determinism-composition-dependent` のとおり、HF の render は
composition によって byte 一致したりしなかったりする（AA jitter）。**レンダラを替える以上、
既存の `materials/hyperframes/*.mp4` は一度だけ全再生成になる**（`hyperframe.<name>.key.json`
のキャッシュキーにレンダラ世代を含めて明示的に無効化する）。

これは `final.mp4` に載る素材の絵が変わりうるということなので、
**X5 の完了ゲートに「実カードの render 前後を目視で比較」を含める**（画素 byte 一致は
置換母艦 §1-8 の2層契約どおり要求しない）。

## 5. 決めてほしいこと — headless Chrome をどう手に入れるか

X0 の実装方針。ここだけは新規実装か新規依存かの選択で、後から替えると全フェーズに響く。

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| **(a) `@puppeteer/browsers` を依存追加（推奨）** | Chrome 公式の browser 取得ライブラリ（Apache-2.0）。`install({browser:"chrome-headless-shell", buildId})` の1行 | バージョン解決・プラットフォーム判定・展開・キャッシュ配置が全部済んでいる。差し引き**依存は5個減って1個増える**。Windows/Linux 対応も無料で付いてくる | CutFlow の依存追加ゼロ主義に対する2件目の意図的例外（1件目は mediabunny） |
| (b) 自前ダウンローダ | `chrome-for-testing-public` の Last-Known-Good-Versions JSON → zip 取得 → 展開 | 依存ゼロ | バージョン解決・展開・破損リトライ・プラットフォーム分岐を自前で持つ。**Remotion が肩代わりしていた面倒をそのまま引き受ける**（実装 200〜300行 + 保守） |
| (c) システム Chrome を使う | `/Applications/Google Chrome.app` 等を探す | 実装最小 | ユーザー環境依存で**決定性が崩れる**（置換母艦 §1-9「CLI が pin した Chromium ＝ユーザーのブラウザと無関係」に真っ向から反する）。**不採用推奨** |

**推奨は (a)**。理由は 288MB と5パッケージを削る作業で、代わりに入るのが
「Chrome を落とす」1機能に閉じた公式の薄いパッケージであること。
(b) は依存数だけ見れば理想だが、置換母艦 §1-9 が要求する **pin された Chromium** の
保守を CutFlow が自前で背負う意味になり、削減の目的（保守面積を減らす）と逆行する。

> **決定（2026-07-29・ユーザー批准）: (a) `@puppeteer/browsers` を依存に追加する。**
> 取得先は `~/.cutflow/chrome/<buildId>/`、バージョンはソースに文字列で pin
> （初期値 `149.0.7790.0` ＝ 現在 Remotion が落としているのと同じ Chrome for Testing）。
> `CUTFLOW_CHROME_PATH` を脱出口として持つ。詳細は X0 の plan。

### 5.1 フェーズ別の実装 plan（Sonnet 向け・実装単位）

X0〜X7 はそれぞれ独立の設計書として `docs/plans/` にある。**この順で実行する**。

| 順 | plan |
|---|---|
| X0 | `docs/plans/2026-07-29-remotion-x0-browser-acquisition-design.md` |
| X1 | `docs/plans/2026-07-29-remotion-x1-dead-code-removal-design.md` |
| X2 | `docs/plans/2026-07-29-remotion-x2-design-assets-design.md` |
| X3 | `docs/plans/2026-07-29-remotion-x3-review-stills-design.md` |
| X4 | `docs/plans/2026-07-29-remotion-x4-mainline-removal-design.md` |
| X5 | `docs/plans/2026-07-29-remotion-x5-hyperframe-render-design.md` |
| X6 | `docs/plans/2026-07-29-remotion-x6-package-removal-design.md` |
| X7 | `docs/plans/2026-07-29-remotion-x7-contract-docs-design.md` |

**X1 は `remotion/Main.tsx` を消すため、その時点で `frames`/`thumbnail`/`review`/
`render --short` の Remotion フォールバックは機能しなくなる**（X0 でエンジンが
Remotion 非依存に動くことを実証済みなのが前提。X3/X4 がその復旧と撤去を担う）。
X3 が review の still **と clip** の両方を引き取る点は起草時の §1-B の表より広い
（clip も `Main` composition に依存していたため）。

## 6. 不変条件（全フェーズ）

置換母艦 §6 を継承し、本母艦固有のものを足す:

1. **JSON が正**・**AI 契約 / CLI / 承認境界（`approvals.json` の hash 失効・`approve` の TTY ゲート）不変**
2. **絵の回帰ゼロ**: 各フェーズのゲートで `npm run gate:pixel` を通す。X6 より前は Remotion オラクルが生きているので、疑わしいときは即座に突き合わせられる
3. **`hyperframes/<name>.html` の作図契約（`buildIframeSrcdoc` / `__hyperframes` API / `checkComposition`）は不変**。替えるのは「誰がその iframe を駆動するか」だけ
4. **`materials/hyperframes/<name>.mp4` は成果物**（`final.mp4` と同格）。再生成は明示的に告知する
5. **決定性の2層契約**（FrameDescriptor＝byte 一致 / 画素＝知覚一致）は置換母艦のまま
6. 実収録（`~/Movies/cutflow/2026-07-12` / `2026-07-21`）では `clean` / `ingest` / `run` / `plan*` / `render` / `approve` を実行しない。検証は `~/Movies/cutflow/test` の scratch コピーで

## 7. リスク

- **X0 が最大の関門**: 自前 Chrome 取得が転ぶと、そこから先が全部止まる。X0 の完了ゲートを
  「`rm -rf node_modules/.remotion` から `frames` が通る」という**破壊的な実測**にしているのはそのため
- **HF の profile 差**: `chromiumGl:"angle"` 系（WebGL/Three.js カード）の再現。X5 の
  ゲートに `scripts/hyperframe-webgl-verify.ts` 相当の実 render を含める
- **`.remotion/` レガシー残骸**: 既存収録に約200MB×N が残る。X7 で `files.ts` から
  エントリを消すと `clean` が回収できなくなる。**エントリは「レガシー」注記付きで残す**
- **テスト件数の激減**: X1 で約2,800行が消える。`npm test` の総件数が下がるのは正常だが、
  **残ったテストを1行も書き換えずに緑**であることをゲートにする（書き換えが要る＝生きコードを
  巻き込んでいる証拠）
- **編集オーサリング/エディタ母艦との競合**: `editor-opencut-redesign-program.md` が
  `App.tsx` を大きく触る。**本母艦の editor への変更は X1 の型移設だけ**（実質コメント）なので
  並走可。ただし X3（review.ts）は AI copilot 母艦の範囲と重なるので着手前に git log を確認する

## 8. 削除の証憑（完了判定）

X6/X7 完了時に以下が全部真であること:

```sh
grep -rn "@remotion\|from \"remotion\"" src/ editor/ scripts/ test/ remotion/   # → 0件
ls remotion/                                                                    # → No such file
grep -n "remotion" package.json                                                 # → 0件
du -sh node_modules/@remotion node_modules/remotion node_modules/.remotion      # → 存在しない
npx tsc --noEmit && npm test && npm run gate:pixel                              # → 全緑
```

追随更新（`test/agentsMd.test.ts` がピン留めしているので機械的に検出される）:
`src/lib/files.ts` → `AGENTS_CONTRACT.md` → `CLAUDE.md` → `docs/usage.md` → `config.yaml`。

## 9. モデル運用

置換母艦 §4 と同じリレー（設計＝高モデル / 実装＝Sonnet）。実装セッション共通ルール:

- **サブエージェント起動禁止。自分で Read/Edit する**
- **1タスク=1コミット。中断時はどこまでコミット済みかを報告**
- Phase 0 で設計書のアンカー（ファイル・シンボル）を実コードで検証し、**食い違ったら
  実装せず止まって報告**（行番号はズレるのでシンボル名で特定する）
- **既存 golden / 既存テストの書き換えが必要になったら設計違反＝止まって報告**
  （§1-A の死にコードのテスト**削除**は例外＝設計に含まれる）
- `approvals.json`・承認 hash・CLI 契約・`prompts/` に触れない
- Node 23 type stripping 制約: enum / namespace / 実行時デコレータ /
  コンストラクタのパラメータプロパティは使えない
- editor クライアントは起動時に1回だけバンドルされる＝**UI 検証前に必ずサーバ再起動**。
  `--stop` は自分が起動した pid にだけ使う

## 10. 意思決定ログ

- **2026-07-29（起草）**: 「HF も含めて Remotion を全削除したい」というユーザーの意図を受け、
  置換母艦 §8 が別課題として切り出していた HF スリム化を本母艦へ引き取った。棚卸しの結果、
  **削除不能な本質的ブロッカーは無く、唯一の新規作業は headless Chrome の取得層（§5）**と判定。
  HF の Remotion 利用は「iframe を毎フレーム `__seek` してスクショする」だけで、
  同等の実装が `engineSession.ts` と `hyperframeAudit.ts` に既に存在することを確認した。
- **2026-07-29（§5 決定）**: headless Chrome の取得は **(a) `@puppeteer/browsers`** で確定
  （ユーザー批准）。X0〜X7 の実装 plan を `docs/plans/` に8本起草した（§5.1）。
  起草時に判明した追加の事実:
  - **review は still だけでなく clip（`renderMedia`）も `Main` composition に依存**していた
    → X3 が両方を引き取る
  - **`render.fast/` は `src/lib/files.ts` の生成物分類に入っていない**（＝`clean` が
    回収できない）。fast 経路本体が消えたあとも design 静的資産
    （`render.fast/design/*.png`）が現役でここに置かれるため、X7 で分類を追加する
  - **エンジンの書き出しページは同梱フォント（Noto Sans JP）を読み込んでいない**
    （`buildExportHtml` に `@font-face` が無い）。エンジン置換のときに落ちた別の欠陥で、
    直すと画素が変わるため本母艦では**フォントを `assets/fonts/` へ保全するだけ**にし、
    残件として記録する（X6 §1.4）
- **2026-07-29（X0 完了）**: `@puppeteer/browsers` で
  `chrome-headless-shell` buildId `149.0.7790.0`（Google Chrome for Testing
  `149.0.7790.0`）を `~/.cutflow/chrome` に取得。`node_modules/.remotion` 退避状態で
  `frames test/fixtures/engine/parity-project --t 10` と `npm run gate:pixel`（12枚一致）が通過。
- **2026-07-29（X1 完了）**: 死にコードの `render.fast` 経路、Remotion 本編
  composition（`Main` / 各 Layer / 各 Still）、`@remotion/player` 型 import、
  `remotion/props.ts` 配置、死んだ `render.fastPath` 設定を削除・移設した。
  `remotion/fonts/` は X6 まで保持。`render.fast/` ディレクトリ名は
  `bgmMix` / `insertMix` / `designStill` の現役用途として保持。
  この時点で `Main` composition が無いため Remotion fallback 経路は機能しない
  （X4 で fallback 自体を削除する）。検証: `npx tsc --noEmit` 緑、
  `npm test` 2880→2716 件 pass、`npm run gate:pixel` 緑、scratch で
  `frames --t 10` / `thumbnail` / `editor --detach --status --stop` 通過。
- **2026-07-29（X2 完了）**: design 静的資産の生成を `DesignStill` composition から
  `src/lib/designAssetHtml.ts` + `src/lib/stillCapture.ts` の自前 CDP capture へ移した。
  T-4 では旧 Remotion 出力（commit `4f1f54c`）と新実装出力を
  `/private/tmp/cutflow-x2-archive-51827` の scratch recording で比較し、
  `backdrop` / `screenMask` / `cameraShadow` / `cameraMask` の4 role すべて
  `maxdiff=0`（差分画素数0）を確認した。Remotion 側の `DesignStill.tsx` と
  `Root.tsx` の `DesignStill` composition 登録は削除済みで、`Root.tsx` に残る
  composition は `HyperFrame` のみ。検証: `npx tsc --noEmit` 緑、
  `npm test` 2724 件 pass、`npm run gate:pixel` 緑（12枚一致）。
- （以降、各フェーズの完了・ゲート判定・実測値をここへ追記する）
