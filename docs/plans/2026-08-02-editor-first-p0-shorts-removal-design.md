# P0: shorts 削除 — 「同一フォルダ内の第二プロジェクト」を型から消す

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: なし(母艦の最初の段)。sequence-time 母艦 S0〜S5 landing 済みが土台。

---

## 0. この plan が達成すること / しないこと

**する**: `shorts.json` を編集ファイルから外し、`Shorts` / `Short` 型・
`approvals.shorts`・`plan-shorts` コマンド・`--short` 系フラグ・エディタの
ショート UI・関連スキーマ・関連テストを削除する。

**しない**:
- 既存収録の `shorts.json` ファイルを削除する(人間のデータ。§6 の移行方針)
- キャンバス機能を足す(P1 の仕事。この段では**縦動画が作れなくなる**のを許容する)
- `src/lib/profile.ts` の `PROFILES` を消す(P1 が使う。§4 で「孤児として残す」)
- 描画エンジン(`src/engine/`)の意味論を変える

**この段の終了後、一時的に縦動画を作る手段が無くなる。** これは意図的で、
P1(キャンバス昇格)が引き継ぐ。母艦 §5 の順序(P0 → P1)がこれを保証する。

## 1. 削除する表面の完全な一覧

以下がこの plan の受け入れ基準そのものである。**すべて消えたら完了**。

### 1.1 CLI コマンド / フラグ(`src/cli.ts`)

| 表面 | 行(2026-08-02 時点) | 措置 |
|---|---|---|
| `plan-shorts <dir>` コマンド | `:533` | 削除 |
| `guardRerun` の `shorts.json` 特別扱い | `:230-252` 付近のコメント + `:544` | 削除 |
| `frames --short <name>` | `:1316` | 削除 |
| `av --short <name>` | `:1526` | 削除 |
| `setShortApproved()` ヘルパ | `:1687-1695` | 削除 |
| `approve --short <name>` | `:1724` | 削除 |
| `unapprove --short <name>` | `:1773` | 削除 |
| `render --short` / `--shorts` | `:1791-1827` | 削除(本編 render だけ残す) |
| `clean` の説明文中の `shorts/` | `:1829`, `:1836` | 文言修正 |
| `import { loadShort, loadShorts }` | `:33` | 削除 |

`--short` を消したあと、`approve` / `unapprove` は引数なしで cutplan だけを
対象にする。`render` は `--short` / `--shorts` を持たない。

### 1.2 削除するファイル(まるごと)

- `src/lib/shorts.ts`
- `src/stages/planShorts.ts`
- `prompts/plan-shorts.md`
- `schemas/shorts.schema.json`
- `schemas/examples/shorts.max.json`
- `test/planShorts.test.ts`
- `test/engineDescribeFrame.short.test.ts`
- `test/fixtures/engine/parity-project/shorts.json`

### 1.3 型(`src/types.ts`)

| 対象 | 措置 |
|---|---|
| `interface Shorts` / `interface Short` | 削除 |
| `Approvals.shorts?: Record<string, ApprovalRecord>` | 削除 |
| `ApplyBody.shorts?: Shorts \| null` | 削除 |
| `Assertion` の `outDuration` の `short?: string` | 削除 |
| `CaptionTrackDef` の doc コメント「shorts.json の各ショートの captionTracks で共用する」 | 文言修正 |
| `colorFilter` / `blurs` / `annotations` の doc コメント中の「ショート(profile 経路)には継承されない…」 | 削除(継承先が無くなるため記述自体が無意味) |

### 1.4 承認(`src/lib/approval.ts`)

削除する export: `shortApprovalHash` / `writeShortApproval` /
`clearShortApproval` / `isShortApproved`。
`clearCutplanApproval`(`:115`)が `{ version: 1, shorts: approvals.shorts }` を
書いている箇所は `{ version: 1 }` にする。
ファイル冒頭のコメント(`:3-10`)から short への言及を落とす。

**後方互換**: 既存 `approvals.json` に `shorts` キーが残っていても、
`readApprovals` は型に無いキーを無視するだけで壊れない。**消しに行かない**
(§6 の移行方針)。

### 1.5 id / 編集ドキュメント(`src/lib/ids.ts`)

- `EditableDocs.shorts: Shorts | null`(`:112`)を削除
- `collectExistingIds` の shorts 巡回(`:136`)を削除
- `stampDocs` の shorts 分岐(`:214-231`)を削除し、戻り値から `shorts` を落とす
- `import type { … Shorts … }`(`:9`)から `Shorts` を外す
- **`ID_PREFIX` の `rg_`(Short.ranges 用)を削除する。**
  `test/agentsMd.test.ts` が `ID_PREFIX` の網羅をピン留めしているので
  `AGENTS_CONTRACT.md` の対応表も同時に直す(§5 の5点セット)

連動: `src/stages/idStamp.ts` の `STAMP_FILE_OF`(`:27`)から `shorts` を外し、
`readEditableDocs`(`:44`)が `shorts.json` を読まないようにする。

### 1.6 ファイル分類(`src/lib/files.ts`)

- `EDITABLE_FILES` から `shorts.json` を削除
- `GENERATED_FILES` から `plan-shorts.raw.txt`(`:34`, `:199`)を削除
- ショート名付き生成物のパターン(`:65-66` のコメント + `cut.<name>.mp4` /
  `cut.<name>.keeps.json` / `render.<name>.props.json` / `render.<name>.key.json`)を削除。
  **HyperFrame カード名のパターン(`hyperframe.<name>.key.json`)は残す** —
  同じ仕組みを共有しているので、regex を壊さないよう注意する
- `GENERATED_DIRS` から `"shorts"`(`:114`)を削除
- `:85-86`, `:178`, `:194` のコメントから `shorts/` への言及を削除

⚠️ `clean` の挙動が変わる。既存収録に残った `shorts/` や `cut.<name>.mp4` は
**`clean` の対象外になり残り続ける**。これは意図した挙動(FrameWright が
知らないファイルには触れない)で、§6 の移行案内で人間に伝える。

### 1.7 stages

| ファイル | 措置 |
|---|---|
| `src/stages/render.ts` | `renderShort` / `renderShorts` / `renderOneShort`(`:342-510` 付近)を削除。`import { loadShort, loadShorts }`(`:42`)・`import { defaultShortProfileName }`(`:34`)を削除。**`resolveProfile` の import は残す**(`:257` の本編経路が使う) |
| `src/stages/validate.ts` | `shorts.json` の検証ブロック全体を削除。**代わりに §6 の移行警告を1件足す** |
| `src/stages/describe.ts` | ショート要約セクション(`:1257` 付近)を削除。`describe --json` の `shorts` キーを削除 |
| `src/stages/av.ts` | `shortName` パラメータ(`:118` 付近)と分岐を削除 |
| `src/stages/frames.ts` | `shortName` パラメータと分岐を削除(呼び出し元は cli / mcp / editor server) |
| `src/stages/assert.ts` | `outDuration` の `short` 対応を削除 |
| `src/stages/idStamp.ts` | §1.5 参照 |
| `src/stages/editorAi.ts` | LLM ツールスキーマ・プロンプトからショート宛先を削除 |
| `src/stages/review.ts` | ショート軸のレビューを削除 |
| `src/stages/plan.ts` / `planMaterials.ts` / `planEffects.ts` / `planBgm.ts` / `autoZoom.ts` / `hyperframe.ts` | コメント中の言及のみ。文言修正 |

### 1.8 lib(その他)

`applyEdits.ts`(shorts 宛先の allow-list・`ApplyBody.shorts` の書き込み)/
`docDiff.ts` / `contentVersion.ts` / `mention.ts`(`@id` の rg_ 解決)/
`editIntent.ts` / `review.ts` / `reviewEvents.ts` / `chunkCache.ts` /
`framesIndex.ts`(ショート経路のフィンガープリント)/ `renderSnapshot.ts` /
`renderReport.ts` / `renderTransaction.ts` / `materialAnchors.ts` /
`llm.ts` / `ai/types.ts` / `cliHelp.ts`(コマンド一覧から `plan-shorts` を削除)/
`config.ts`(`planShorts` 設定・`DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC` ·
`planShortsMaxSec()` · `editor.defaultShortRangeSec` · `DEFAULT_SHORT_RANGE_SEC`)/
`configEdit.ts`(同設定の編集経路)。

### 1.9 MCP(`src/mcp/tools.ts`)

`framewright_frames` の `short` 引数(`:350`, `:359`)、`:434`/`:452` の
`shortName`、`:546`/`:558` の `short` を削除。冒頭コメント(`:6`)の
`plan-shorts` 言及も落とす。

### 1.10 エディタ

**サーバ(`editor/server.ts`)**: `ProjectData` から `shorts` を削除、
`loadProject` / `saveProject` のショート読み書き、`/api/save` の shorts 経路、
`frames` 呼び出しの `shortName` 引数を削除。

**クライアント**:
- `editor/client/Panels.tsx` — `ShortsPanel`(`:1055-1120` 付近)を削除。
  `:1592-1640` 付近の「縦動画や別アスペクトは『ショート』で作成します」
  ヒントブロックを削除(**P1 でキャンバスの案内に置き換わる。ここでは消すだけ**)
- `editor/client/App.tsx` — `activeShortName` 状態とその派生、ショートタブ、
  ショート用のタイムライン切替(`:1361` 付近)、保存ペイロードの shorts を削除。
  **213箇所と最大なので、`activeShortName` を消して型エラーを潰す順で進めるのが速い**
- `editor/client/Inspector.tsx` — ショート節(74箇所)を削除
- `editor/client/model.ts` / `apiTypes.ts` — `Shorts` 型の再輸出・状態を削除
- `editor/client/DiffReview.tsx` / `SettingsModal.tsx` / `styles.css` — 言及・
  スタイル定義を削除

### 1.11 スキーマ

- `schemas/shorts.schema.json` / `schemas/examples/shorts.max.json` を削除
- `schemas/apply-patch.schema.json` から shorts 宛先を削除

## 2. 実装スライス(この順で進める)

各スライスの終わりに `npx tsc --noEmit` を通す。**通らない状態でコミットしない。**

| # | スライス | 内容 | 完了条件 |
|---|---|---|---|
| S1 | 型の中心 | §1.3 `src/types.ts` | tsc が「Shorts が無い」エラーだらけになる(想定どおり) |
| S2 | lib 基盤 | §1.4 approval / §1.5 ids + idStamp / §1.6 files | tsc のエラーが lib 層から消える |
| S3 | lib その他 | §1.8 | 同上 |
| S4 | stages | §1.7(render / validate / describe / av / frames / assert / editorAi / review) | tsc が stages で通る |
| S5 | CLI + MCP | §1.1 / §1.9 + `src/lib/shorts.ts` `src/stages/planShorts.ts` `prompts/plan-shorts.md` 削除 | `node src/cli.ts commands` が `plan-shorts` を出さない |
| S6 | エディタ サーバ | §1.10 サーバ側 | tsc 通過 |
| S7 | エディタ クライアント | §1.10 クライアント側 | `npm run typecheck` 全体通過 |
| S8 | スキーマ | §1.11 | `test/schema.test.ts` 通過 |
| S9 | 移行警告 | §6 の `validate` 警告を実装 | 新テストが通る |
| S10 | テスト | §3 | `npm test` 全緑 |
| S11 | ドキュメント | §5 | `test/agentsMd.test.ts` 通過 |

## 3. テストの措置

**削除**: `test/planShorts.test.ts` / `test/engineDescribeFrame.short.test.ts` /
`test/fixtures/engine/parity-project/shorts.json`。

**ショート関連のケースだけ削るファイル**(ファイル自体は残す):
`validate.test.ts`(69箇所・最大)/ `approval.test.ts`(34)/ `editorAi.test.ts`(26)/
`config.test.ts`(18)/ `editorServer.test.ts`(13)/ `docDiff.test.ts`(12)/
`describeJson.test.ts`(12)/ `applyEdits.test.ts`(11)/ `schema.test.ts`(10)/
`ids.test.ts`(9)/ `editorInspectorDesign.test.ts`(9)/ `clean.test.ts`(9)/
`renderProps.test.ts`(8)/ `mention.test.ts`(8)/ `editorPanelDesign.test.ts`(8)/
`saveProject.test.ts`(7)/ `renderPropsClassification.test.ts`(7)/
`describe.test.ts`(7)/ `assert.test.ts`(7)/ `files.test.ts`(6)/ ほか。

**新規に足すテスト**:
1. `validate` が `shorts.json` の存在を検出したとき、**warning を1件出し exit 0 を保つ**
2. `shorts.json` が無いプロジェクトでは何も出ない(バイト等価)
3. `approvals.json` に `shorts` キーが残っていても `readApprovals` / cutplan 承認が壊れない

**ゴールデン**: `test/fixtures/describe.golden.txt` からショート節を削除。
`test/fixtures/engine/pixel-golden/*.json`(`provenance.json` / `last-run.json`)の
ショート言及を更新。`test/fixtures/engine/parity-project/frames/index.json` も同様。

**画素ゲート**: `npm run gate:pixel` を実行し全一致を確認する
(`npm test` には含まれない独立コマンド)。ショート経路は golden に含まれないため
一致するはずだが、`renderProps` を触るので**必ず実行して確認する**。

## 4. `PROFILES` の扱い(重要)

`src/lib/profile.ts` は**この段では削除も改変もしない**。

削除後の `PROFILES` は「どこからも参照されない孤児」になる。TypeScript は
未使用 export をエラーにしないので tsc は通るが、`knip` 等の dead-code 検査を
かけると引っかかる。**その状態で正しい** — P1 がここを起点にキャンバスを作る。

ただし `defaultShortProfileName()`(`:65`)と `profileSupportsPlain()`(`:72`)は
**ショート専用のヘルパ**なので、この段で削除する。
`resolveProfile()` と `PROFILES` と `Profile` / `BasePanel` 型は残す。

`test/profile.test.ts`(4箇所)は `defaultShortProfileName` /
`profileSupportsPlain` のケースだけ削り、`resolveProfile` のテストは残す。

## 5. 5点セットの追随(必須)

この plan は**コマンドとファイル分類の両方を変える**ので、5点全部が対象:

1. `src/types.ts` のコメント — §1.3
2. `src/stages/validate.ts` — §1.7 + §6
3. `docs/usage.md` — shorts の表・章を削除(6箇所)
4. `schemas/*.schema.json` + `schemas/examples/*.max.json` — §1.11
5. `AGENTS_CONTRACT.md` — 編集ファイル一覧から `shorts.json`、`GENERATED_FILES` から
   ショート系、コマンド一覧から `plan-shorts` と `--short` 系、`ID_PREFIX` から
   `rg_`(18箇所)。**`test/agentsMd.test.ts` がピン留めしているので必須**

加えて `docs/guides/` の該当箇所:
`export.md`(12)/ `safe-editing.md`(11)/ `command-reference.md`(8)/
`effects.md`(7)/ `cut-planning.md`(6)/ `tools-and-ops.md`(4)/
`audio-bgm.md`(4)/ `ai-agents.md`(3)/ `style-and-rules.md`(1)。

`CLAUDE.md` も shorts の記述(編集ファイル表・中間生成物・コマンド一覧・
承認の `--short`)を削除する。

## 6. 移行方針 — 既存収録の `shorts.json`

**FrameWright は `shorts.json` を削除しない。** 人間が書いたデータであり、
勝手に動かさないという既存の一線に沿う(母艦 §8-4)。

`validate` に警告を1件足す(**exit 0 を保つ**):

```
警告: shorts.json は使われなくなりました(ショート機能は削除されました)。
  縦動画は「9:16 のプロジェクトを新しく作る」形で作成します。
  この収録の shorts.json / shorts/ / cut.*.mp4 は FrameWright が触らなくなるため、
  不要なら手で削除してください。
```

自動変換コマンド(`shorts.json` → 派生プロジェクト)は**この段では作らない**。
派生プロジェクトの形が P1(キャンバス)と P5(ランチャー)で決まってからでないと
変換先が定義できない。母艦 §6 の未決事項としてそのまま残す。

## 7. 受け入れ基準

1. `grep -ri "short" src/ editor/ schemas/ prompts/` の結果が、
   **`src/lib/profile.ts` の `Profile` 型関連と、無関係な英単語(`shorten` 等)だけ**になる
2. `npx tsc --noEmit` クリーン
3. `npm test` 全緑(既知の先行失敗を除く)
4. `npm run gate:pixel` 全フレーム一致
5. `node src/cli.ts commands` に `plan-shorts` が出ない
6. `node src/cli.ts render --help` に `--short` / `--shorts` が出ない
7. `shorts.json` を持つ収録で `validate` が警告1件・exit 0
8. `shorts.json` を持たない収録で、全コマンドの出力が削除前と**バイト等価**

## 8. 想定される落とし穴

- **`App.tsx` の 213箇所**: `activeShortName` を消して tsc のエラーを潰す順で
  進める。ショート用の分岐は「本編の値をそのまま使う」へ倒せば大半が消える
- **`files.ts` の regex**: ショート名付き生成物と HyperFrame カード名付き
  生成物が同じ仕組みを共有している。ショート側だけ外し、
  `hyperframe.<name>.key.json` の判定を壊さないこと。`test/files.test.ts` で確認
- **`approval.ts` の `clearCutplanApproval`**: `shorts` キーを引き継ぐ実装
  (`:115`)になっている。ここを直し忘れると型エラーで気づくが、
  既存 `approvals.json` の `shorts` キーが**保存され続ける**挙動は意図的に残さない
  (新しく書くときは落とす。既存ファイルを読むときは無視するだけ)
- **`describe --json` の契約変更**: `shorts` キーが消える。MCP 経由の外部
  エージェントが読んでいる可能性があるので、`docs/usage.md` の
  `describe --json` の節を必ず更新する

## 9. 完了記録(2026-08-02)

- shorts 専用の CLI / 型 / 承認 / render / MCP / editor / schema / prompt を削除した。
  `src/lib/profile.ts` の `PROFILES` と `resolveProfile()` は P1 の入力として残した。
- legacy `shorts.json` は読み込まず、存在時だけ移行警告を1件出す。壊れた JSON でも
  `validate` は shorts 起因で失敗せず、人間のデータや旧成果物を削除しない。
- 主担当が独立に実測したゲート:
  - `npm run typecheck`: PASS
  - `npm test`: **2691 / 2691 PASS**
  - `npm run gate:pixel`: **11 / 11 一致、exit 0**
  - `node src/cli.ts commands`: `plan-shorts` なし
  - `node src/cli.ts render --help`: `--short` / `--shorts` なし
  - legacy 有無の一時プロジェクトで `validate`: 無しは警告なし、有りは警告1件・exit 0
  - `git diff --check`: PASS
- 実装は P0 の focused commit にまとめた。次の一手は P1(canvas のプロジェクト昇格)。
