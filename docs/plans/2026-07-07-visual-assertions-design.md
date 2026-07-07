# 編集後の自動検証・視覚的アサーション — 設計

*2026-07-07 / 診断レビュー「D. 高速フィードバックループ」#2 の設計。実装は別担当。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ D「高速フィードバックループ」/ 項目「**編集後の自動検証・視覚的
> アサーションが無い**」= severity **minor** / effort **M**。
>
> 現状「`validate` は JSON の整合性(スキーマ・不変条件)は見るが、"編集意図が
> 満たされているか" は検査できない」。AI が編集した後に「意図どおりか」を
> **宣言的に**検査する層を足す。**minor / M なので過剰実装を避け、既存トライアド
> (`validate` / `describe --json` / `frames --ocr`)の上に薄く載せる**。未使用時
> (assertions.json を置かないプロジェクト)は 1 バイトも挙動が変わらない。

---

## 背景とギャップ

`validate` が答えるのは「この編集は**壊れていない**か」(スキーマ・keep の重なり・
参照ファイルの存在・尺超え)。誰のプロジェクトでも同じ**普遍の不変条件**だ。

一方 AI が編集ループを回すとき本当に知りたいのは「この編集は**私が意図した状態に
なっている**か」——「ショートを 60 秒以内に収めたはずだ」「@cap_x のテロップは
本編に残っているはずだ」「API キーを写した区間は目隠しできているはずだ」。これは
**プロジェクト固有の期待値**で、validate の普遍不変条件には置けない。

今その期待値を確かめる手段は `describe --json` を自分で読んで目視照合するか、
`frames` の PNG を Read して目で見るか。どちらも AI が毎回**手で判定ロジックを
再発明**する低帯域ループで、しかも判定は AI の注意力に委ねられ、後から grep も
diff も再実行もできない。**video-as-code なら「期待値」も平文 JSON で宣言でき、
決定論的に再評価できるべき**——それがこの層だ。

**設計の核**: これは既存トライアドを置き換えるものではなく、その上に載る
「**期待値の宣言 + 自動照合**」層。判定入力は既に存在する:

- 構造アサーションの入力源 = `describe --json`(`DescribeProjection`)。尺・可視性・
  出力秒・存在・keep 集合が**決定論的に完全射影**されている(`src/stages/describe.ts`)。
- 視覚アサーションの入力源 = `frames --ocr`(`OcrResult`。text 全文 + lines[].box は
  出力px)。「この時刻の画面にこの文字が見える/この領域が目隠しできている」を読む
  (`src/stages/frames.ts` / `src/lib/ocr.ts`)。

新規に書くのは **(1) 期待値を宣言する平文 JSON (`assertions.json`)、(2) それを上の
2 つの射影と照合する純関数、(3) それを叩く `assert <dir>` コマンド**だけ。

---

## 論点1: アサーションの置き場と形 → **決定: (a) 宣言的 `assertions.json` + `assert <dir>` コマンド**

| 案 | 中身 | 判定 |
|---|---|---|
| **(a)** | 収録フォルダに `assertions.json`(AI/人間が書く平文の期待値宣言)を置き、`assert <dir>` コマンドが `describe --json` 射影と照合して pass/fail を出す | **採用** |
| (b) | `validate` に組み込みルールとして足す | **却下**。validate は「誰のプロジェクトでも壊れている」を検出する普遍不変条件の場所。「60秒以内であるべき」はこの収録固有の意図で、普遍条件ではない。混ぜると validate が「壊れていないのに fail する」道具になり、最高トラフィックの検証地点の意味がぶれる。LoadedDocs / validateDocs の純関数契約も汚す |
| (c) | 仕組みを足さず `describe --json` を外部が各自読んで判定 | **却下(=現状)**。まさに今の摩擦。AI が毎回判定ロジックを再発明し、宣言が残らず grep/diff/再実行できない。video-as-code の思想(期待値も平文で宣言)に反する |

**決定と理由**

- 差別化の核は video-as-code。**期待値もファイルにして grep/diff/git/再実行できる**のが
  この製品の筋。(a) だけがそれを満たす。
- validate との役割分離を明確に保つ: **validate = 壊れていないか(普遍) / assert =
  意図どおりか(この収録固有)**。exit 1 の意味が別物なので、コマンドも別にする。
- `assert` は `describe --json`(既存・決定論・fs 読み取り)を内部で呼ぶだけ。新しい
  知覚経路を一切増やさない。

### `assertions.json` のファイル分類(files.ts への波及)

`assertions.json` は **`fileRole` の "other" カテゴリ**にする(`rules.md` / `brief.md` と
同じ、人間/AI が手で書く宣言ファイルで、どの生成コマンドも上書きしない)。

- **`EDITABLE_FILES` に足さない**。この定数は「plan/transcribe 再実行が backups/ へ
  退避してから上書きする対象」という狭い意味(`src/lib/files.ts` の定義コメント参照)。
  assertions.json はどの生成コマンドも書かないので退避対象ではない。むしろ **plan を
  やり直しても assertions.json は残って再評価できる**のが正しい挙動(意図の宣言は
  生成物の作り直しをまたいで生き残るべき)。
- **`GENERATED_FILES` にも足さない**(中間生成物ではない)。
- したがって **`src/lib/files.ts` は変更不要**(未列挙 → 自動的に "other")。
  `fileRole("assertions.json") === "other"` が成り立ち、`test/files.test.ts`(EDITABLE/
  GENERATED を厳密固定)も**無変更で green のまま**。

> 波及の要点: 新カテゴリの定数を増やさない=既存のファイル分類テストを 1 行も
> 動かさない。これがスコープ最小の肝。

---

## 論点2: アサーションの語彙 → **決定: 固定の型付きボキャブラリ。構造(Tier 1)を第一級、視覚(Tier 2)を opt-in の第二階層に分離**

「パス + 演算子 + 期待値」の汎用エンジン(JSONPath 的)ではなく、**用途ごとの
型付きアサーション**にする。理由: minor/M では発見可能性(スキーマで列挙)と良い
エラーメッセージが効き、汎用パスエンジンは決定論の担保もメッセージ整形も重い。

各アサーションは共通で任意の `label?`(レポート表示用の作者ラベル。要素の `@id` とは
別物)を持てる。

### Tier 1: 構造アサーション(`describe --json` 射影から。依存ゼロ・数ミリ秒・全環境)

| type | フィールド | 意味(射影のどこを見るか) |
|---|---|---|
| `outDuration` | `op, value, short?` | 出力尺の比較。`short` 指定でそのショートの `outDurationSec`、省略で本編 `summary.outDurationSec` |
| `keepCount` | `op, value` | keep 区間数(`summary.keepCount`)の比較 |
| `captionVisible` | `ref, visible?` | `@id` のテロップが出力に現れるか(`captions[].visible`)。`visible` 省略時 true |
| `captionText` | `ref, contains? / equals?` | `@id` のテロップ本文(`captions[].text`)が部分一致/完全一致するか(手編集で文言が保たれたかの確認) |
| `timeKept` | `at, kept?` | 元収録秒 `at` が出力に残っているか(keep 内 = `keeps[]` のどれかに含まれる)。`kept` 省略時 true。「この瞬間をカットしていないはず」の確認 |
| `materialExists` | `ref` | `@id` の素材の参照ファイルが実在するか(`overlays.materials[].exists`) |
| `noCaptionOverlap` | `track?` | テロップの出力秒区間(`captions[].out`)が同一トラック内で重ならない。`track` 省略で全トラック横断 |

`op` = `"<=" | ">=" | "<" | ">" | "=="`(尺・数の比較)。

### Tier 2: 視覚アサーション(`frames --ocr` から。重い・macOS 依存・**opt-in `--visual` のときだけ実行**)

| type | フィールド | 意味 |
|---|---|---|
| `screenText` | `at, contains, present?` | 元収録秒 `at` の画面 OCR 全文に文字列が含まれる/含まれない(`present` 省略時 true)。「この時刻にこのコマンドが映っているはず / この秘密は映っていないはず」 |
| `regionClear` | `ref` | `@id` の blur 領域内に OCR テキスト行が無い(=目隠しできている)。blur の出力秒区間の中央でサンプルし、`overlays.blurs[].rect` と OCR `lines[].box`(共に出力px)の交差を見る |

合計 **9 種**(10 以内)。Tier 1 の 7 種だけで「尺・可視性・存在・cut 帰属・重なり」を
カバーし、多くの「意図どおりか」確認はここで完結する。Tier 2 は秘匿目隠しの検証
(`regionClear`)と画面内容の確認(`screenText`)という、OCR でしか答えられない 2 用途に
絞る。

---

## 論点3: 対象指定 → **決定: `@id` 中心。id 未採番プロジェクトでは error(skip でも fail でもない)で id-stamp を促す**

- `ref` を取るアサーション(`captionVisible` / `captionText` / `materialExists` /
  `regionClear`)は `@id`(または `@` なしの素の id)で対象を指す。解決は
  `describe --json` 射影が既に載せている `id` フィールドを走査するだけ(射影自己完結。
  `src/lib/mention.ts` の resolveMention は "@" 剥がし等の正規化に流用可)。
- **degrade の決定**: プロジェクトに id が 1 つも無い(id-stamp 未実行)場合、`ref`
  必須のアサーションは **`error`** 結果にして「`node src/cli.ts id-stamp <dir>` を実行
  してから @id で指してください」と出す。**fail ではなく error**(期待値が偽だったの
  ではなく、宣言が評価不能)。value ベースのアサーション(`outDuration` / `keepCount` /
  `timeKept` / `noCaptionOverlap` / `screenText`)は ref 不要なので未採番でも普通に動く。
- 位置指定(`caption[3]` 等の添字)は**採らない**。添字は編集で容易にずれ、安定
  アドレッシングという既存 @id 基盤の思想に反する。`run` は新規収録で id-stamp を
  自動実行する(`src/cli.ts`)ので、実運用では大半のプロジェクトに id がある。

---

## 論点4: 実行結果の形 → **決定: validate の Problem とは別の pass/fail/skip/error 型。exit code は fail か error があれば 1**

`validate` の `{file, where, message}`(error/warning)は「壊れている箇所」の列挙で、
アサーションの「1 件ごとの合否」とは意味論が違う(pass も見せたい・skip という
第3の状態がある)。よって**専用の結果型**にする(CLI の表示スタイルだけ揃える)。

```ts
// 1 件のアサーションの評価結果
export interface AssertOutcome {
  index: number;            // assertions[] の添字
  label?: string;           // 作者ラベル(あれば)
  type: string;             // "outDuration" 等
  status: "pass" | "fail" | "skip" | "error";
  message: string;          // 人間可読("出力尺 98.4s <= 60s: 満たされません" 等)
}
export interface AssertReport {
  outcomes: AssertOutcome[];
  counts: { pass: number; fail: number; skip: number; error: number };
}
```

- **status の意味**:
  - `pass` … 期待値が成立
  - `fail` … 期待値が不成立(意図と現状の乖離)
  - `skip` … 視覚アサーションで OCR 非対応環境(macOS 以外・swift 無し)など、優雅劣化。
    `runOcr` が null を返したら skip(`src/lib/ocr.ts` の劣化契約に乗る)
  - `error` … アサーション宣言そのものが評価不能(未知 type・ref 未解決・id 未採番・
    `at` が収録尺外 等)
- **CLI exit code**: `fail > 0 || error > 0` なら **1**、それ以外(全 pass、または pass +
  skip のみ)なら **0**。**skip だけでは 1 にしない**(非対応環境で CI/ループが赤に
  ならない=優雅劣化の要)。
- CLI 表示は validate に揃える: `✔`(pass)/ `✖`(fail)/ `⚠`(error)/ `–`(skip)。

---

## 論点5: スコープ規律 → **決定: 第一段は Tier 1(構造)+ `assert` + スキーマまで。Tier 2(視覚 OCR)は同 doc 内の後続タスクとして分離**

- **第一段(構造)を必ず先に完成・出荷**する。理由: 依存ゼロ・全環境・数ミリ秒で、
  「意図どおりか」の大半(尺・可視性・存在・cut 帰属・重なり)をカバーする。ここだけで
  AI の自己完結ループが 1 段深くなる。
- **Tier 2(視覚)は `--visual` フラグの後ろに隔離**し、既定オフ。理由: OCR は
  frames レンダー + Apple Vision で**秒〜十数秒/枚**かかり、**macOS 依存**。第一段の
  価値を OCR の重さ・環境依存で人質に取らない。`--visual` を付けない限り frames も
  OCR も一切動かず、Tier 1 だけが走る(未使用時バイト等価の原則)。
- **やらないこと(意図的)**: 汎用パスエンジン、正規表現マッチ(`contains`/`equals` の
  部分/完全一致で足りる)、音声アサーション(耳の射影がまだ弱い。診断テーマ A の
  範疇)、GUI 連携(CLI 完結で十分)。minor/M を守る。

---

## `assertions.json` スキーマ案

平文・手書き前提。`schemaVersion` で将来の非互換に備える。

```jsonc
{
  "schemaVersion": 1,
  "assertions": [
    { "label": "本編は5分以内", "type": "outDuration", "op": "<=", "value": 300 },
    { "label": "ショートは60秒以内", "type": "outDuration", "op": "<=", "value": 60, "short": "intro" },
    { "type": "keepCount", "op": ">=", "value": 3 },
    { "type": "captionVisible", "ref": "@cap_qs3bwg", "visible": true },
    { "type": "captionText", "ref": "@cap_qs3bwg", "contains": "テスト" },
    { "type": "timeKept", "at": 42.0, "kept": true },
    { "type": "materialExists", "ref": "@mat_ab12cd" },
    { "type": "noCaptionOverlap" },

    // Tier 2(--visual のときだけ評価。無いときは skip 扱いにはせず未評価)
    { "type": "screenText", "at": 90, "contains": "npm run build", "present": true },
    { "type": "screenText", "at": 120, "contains": "sk-", "present": false },
    { "type": "regionClear", "ref": "@bl_ff33aa" }
  ]
}
```

TS 型(`src/types.ts` に追加。コメントは既存 8 ファイルの書式に揃える):

```ts
export type AssertOp = "<=" | ">=" | "<" | ">" | "==";
export type Assertion =
  | { label?: string; type: "outDuration"; op: AssertOp; value: number; short?: string }
  | { label?: string; type: "keepCount"; op: AssertOp; value: number }
  | { label?: string; type: "captionVisible"; ref: string; visible?: boolean }
  | { label?: string; type: "captionText"; ref: string; contains?: string; equals?: string }
  | { label?: string; type: "timeKept"; at: number; kept?: boolean }
  | { label?: string; type: "materialExists"; ref: string }
  | { label?: string; type: "noCaptionOverlap"; track?: number }
  // Tier 2(視覚・opt-in)
  | { label?: string; type: "screenText"; at: number; contains: string; present?: boolean }
  | { label?: string; type: "regionClear"; ref: string };
export interface AssertionsDoc { schemaVersion: number; assertions: Assertion[] }
```

---

## `assert` コマンド仕様

```sh
node src/cli.ts assert <dir>            # Tier 1(構造)だけ評価。fail/error あれば exit 1
node src/cli.ts assert <dir> --visual   # Tier 1 + Tier 2(OCR)。非対応環境は Tier 2 を skip
node src/cli.ts assert <dir> --json     # AssertReport を純 JSON で stdout(パイプ可)
```

- `assertions.json` が無ければ「アサーションがありません(assertions.json を置くと
  意図を宣言的に検査できます)」と出して **exit 0**(未使用は無害)。
- 既定(`--visual` なし)で Tier 2 のアサーションに遭遇したら、実行はせず結果に
  含めない(または `status:"skip", message:"--visual が必要"`)。**決定: skip とし、
  skip は exit code に影響しない**——「視覚検査を今は回していない」を明示しつつ CI を
  赤にしない。
- 純/不純の分離は validate に倣う:
  - **純コア**(fs 非依存・テスト容易):
    `evaluateStructural(proj: DescribeProjection, spec: AssertionsDoc): AssertOutcome[]`
    と `evaluateVisual(spec, ocrByTime: Map<number, OcrResult | null>, blurs): AssertOutcome[]`。
  - **fs ラッパー** `assert(dir, opts)`: `describeJson(dir)` を呼んで純コアへ渡し、
    `--visual` 時は必要な元収録秒を集めて `frames`/`ocr` 経路で OCR を取り、
    `ocrByTime` を組んで純コアへ渡す。

配置: `src/stages/assert.ts`(純コア + fs ラッパー。describe/validate と同じ stages 流儀)。

---

## 5点セット波及

| 対象 | 変更 |
|---|---|
| `src/types.ts` | `Assertion` / `AssertionsDoc` / `AssertOp` 型 + コメント(既存 8 ファイルと同じ書式)を追加 |
| `src/stages/validate.ts` | **無変更**(意図的)。assertions.json は validate の LoadedDocs/普遍不変条件の対象外。宣言の構造検査は `assert` 自身が行い(未知 type・欠損フィールドは `error` 結果)、validate の純関数契約を汚さない |
| `docs/usage.md` | 「編集後の意図検査(assert)」節を追加(語彙表・`assert` の使い方・Tier 分離) |
| `schemas/assertions.schema.json` + `schemas/examples/assertions.max.json` | 追加(BYO-agent が JSON Schema で補完・検査できるよう既存 8 ファイルに倣う)。**注意**: `test/schema.test.ts` の「全単射」テスト(schemas/ の *.schema.json 集合 == 8編集ファイル)は `common.schema.json` / `apply-patch.schema.json` を除外している(L92-94)。`assertions.schema.json` も**同じ除外リストに追加**しないと全単射テストが落ちる |
| `AGENTS.md` | (1) §10 コマンド表に `` `assert <dir>` `` を追加(**必須**: `test/agentsMd.test.ts` が cli.ts の全 `.command()` 名を AGENTS.md 命令表に要求する)。(2) §3 付近に assertions.json を「意図宣言ファイル(第3の手書きカテゴリ・render に影響しない)」として1段落追記 |
| `src/lib/files.ts` | **無変更**(論点1: "other" 扱い)。`test/files.test.ts` も無変更で green |

> ドリフトテストのピン留め要注意点(実装者向けチェックリスト):
> - `test/agentsMd.test.ts`: `assert` コマンド名が AGENTS.md 命令表に必要。
> - `test/schema.test.ts` L92-94: `assertions.schema.json` を全単射テストの除外に追加。
> - `test/files.test.ts`: EDITABLE/GENERATED を触らなければ無変更で通る(=触らない)。

---

## タスク分解(1タスク=1コミット)

### T1: 型 + 純評価コア(構造 Tier 1)

- **触るファイル**: `src/types.ts`(Assertion 型)、`src/stages/assert.ts`(新規・
  `evaluateStructural` 純関数のみ。CLI 配線はまだしない)。
- **テスト方針**: `test/assert.test.ts` を新規。`describe.test.ts` の
  `buildRichFixture` が作る射影(または手組みの `DescribeProjection`)を入力に、
  各 type の pass/fail/error を単体で固定。特に:
  - `outDuration` の各 op、`short` 指定と本編の切替
  - `captionVisible`/`captionText`/`materialExists` の ref 解決成功・ref 未解決(error)・
    id 未採番プロジェクト(error, "id-stamp を実行")
  - `timeKept` の keep 内(pass)/カット内(fail)/尺外 `at`(error)
  - `noCaptionOverlap` の重なりあり(fail)/なし(pass)、`track` 指定
- **壊してはいけない挙動**: describe/validate に手を入れない(読むだけ)。
  `DescribeProjection` の形に依存するので、describe --json の射影は不変前提。

### T2: `assert` コマンド(構造のみ)+ fs ラッパー + JSON 出力

- **触るファイル**: `src/stages/assert.ts`(fs ラッパー `assert(dir)` 追加)、
  `src/cli.ts`(`assert <dir>` 登録・`--json`・exit code)。
- **テスト方針**: fs ラッパーの実データ検証を `test/assert.test.ts` に追加
  (tmp フォルダに fixture の編集ファイル群 + assertions.json を書いて `assert(dir)` を
  呼び、`AssertReport.counts` と exit 相当(fail+error)を固定)。assertions.json 無し
  → 空レポート + exit 0。純コアの単体は T1 で担保済み。
- **壊してはいけない挙動**: 既存 CLI コマンドの挙動・postAction の所要時間表示
  (`describe --json` の stderr 逃がし規約と整合させる:`assert --json` も診断行を
  stderr へ)。

### T3: スキーマ + example + ドキュメント + AGENTS.md

- **触るファイル**: `schemas/assertions.schema.json`、`schemas/examples/assertions.max.json`、
  `test/schema.test.ts`(除外リストに assertions を追加)、`docs/usage.md`、`AGENTS.md`。
- **テスト方針**: `test/schema.test.ts` の kitchen-sink 検証に assertions.max.json を
  加える(全 type を1件ずつ含む max example がスキーマに valid)。agentsMd.test が
  `assert <dir>` を要求するので、AGENTS.md 更新で green になることを確認。
- **壊してはいけない挙動**: 既存 8 ファイルの全単射テスト(除外追加で維持)。

> ここまで(T1〜T3)が**第一段=構造アサーション**。ここで一度出荷可能。

### T4: 視覚アサーションの純コア(Tier 2)

- **触るファイル**: `src/types.ts`(screenText/regionClear は T1 で型に入れておくが、
  評価は T4)、`src/stages/assert.ts`(`evaluateVisual` 純関数)。
- **テスト方針**: `OcrResult` を手組みして純コアを固定。`screenText` の
  present true/false × 含む/含まない、`regionClear` の box が blur rect に交差する
  (fail)/しない(pass)、`ocrByTime` に null(非対応環境)→ skip。
- **壊してはいけない挙動**: `ocr.ts` の座標系(box は screenRegion 出力px)と
  `overlays.blurs[].rect`(出力px)が同座標系である前提を守る(交差判定はそのまま px 比較)。

### T5: `--visual` 配線(OCR 実行の不純ラッパー)

- **触るファイル**: `src/stages/assert.ts`(`--visual` 時に必要時刻を集めて OCR を取り
  `ocrByTime` を組む)、`src/cli.ts`(`--visual` フラグ)。OCR 実行は `frames.ts` /
  `ocr.ts` の既存経路を再利用(screenStill → runOcr)。
- **テスト方針**: OCR 実行自体は macOS 依存で単体テスト困難なので、`--visual` なしの
  ときに Tier 2 が skip になり exit 0 のままであること(全環境で回る)を固定。
  実 OCR 経路は実データ検証(下記)で人手確認。
- **壊してはいけない挙動**: `--visual` を**付けない**限り frames/OCR を一切呼ばない
  (Tier 1 の速度・全環境性を維持)。非対応環境で例外を投げず skip(ocr.ts の劣化契約)。

---

## 実データ検証手順

検証フォルダ: `~/Movies/cutflow/2026-07-07`(id 採番済み・keep 18・テロップ 35・
出力尺 98.4s。`describe --json` で確認済みの実データ)。

### 構造(T1〜T3)

1. 期待値を書く(pass と fail を1件ずつ意図的に混ぜる):

```jsonc
// ~/Movies/cutflow/2026-07-07/assertions.json
{
  "schemaVersion": 1,
  "assertions": [
    { "label": "60秒以内(意図的に fail させる)", "type": "outDuration", "op": "<=", "value": 60 },
    { "label": "3秒以上のkeepがある",            "type": "keepCount",  "op": ">=", "value": 3 },
    { "type": "captionVisible", "ref": "@cap_qs3bwg", "visible": true },
    { "type": "captionText",    "ref": "@cap_qs3bwg", "contains": "テスト" },
    { "type": "noCaptionOverlap" }
  ]
}
```

2. `node src/cli.ts assert ~/Movies/cutflow/2026-07-07` を実行。
   期待: `outDuration`(98.4 <= 60)が **fail**、残り 4 件が **pass**、exit code **1**。
   `--json` で `counts: {pass:4, fail:1, skip:0, error:0}` を確認。
3. `value` を `120` に直して再実行 → 全 pass・exit 0 を確認。
4. degrade 確認: id を含まない別フォルダ(または assertions の ref を存在しない
   `@cap_zzzzzz` に)で ref 系が **error**(id-stamp を促す/未解決)になり exit 1、
   value 系は評価され続けることを確認。

### 視覚(T4〜T5)

1. 画面内に映るコマンドを狙って `{ "type": "screenText", "at": <秒>, "contains": "...", "present": true }` を書く
   (`at` は `frames <dir> --t <秒> --ocr` で当該秒の OCR 全文を見て文字列を選ぶ)。
2. `node src/cli.ts assert ~/Movies/cutflow/2026-07-07 --visual` を実行し pass を確認。
   `present: false` に反転させて fail を確認。
3. `regionClear`: `overlays.json` に blur を1つ足して id-stamp → その `@bl_...` を
   `regionClear` で指し、blur 内に文字が無い(pass)/rect をわざと外して文字が入る
   (fail)を確認。
4. 非対応環境の代理確認: `--visual` を**外す**と Tier 2 が skip・exit 0 に戻ること
   (= OCR を一切呼ばないこと)を確認。

> 実測は中立 cwd から(repo 直下だと LLM 系の副作用は無いが、習慣として絶対パスで
> 走らせる)。`assert` は LLM を一切呼ばない決定論コマンドなので出力は安定。

---

## 実装順序(段階)

```
第一段(構造・全環境・出荷可能):  T1 → T2 → T3
第二段(視覚・opt-in・macOS):      T4 → T5
```

- **第一段だけでも独立に価値**が出る(依存ゼロの構造アサーション + CLI + スキーマ)。
  ここで一度止めて出荷してよい。
- 第二段は第一段の純コア/fs 分離をそのまま踏襲して視覚を足すだけ。`--visual` の
  後ろに隔離されるので、第二段を入れても第一段の速度・全環境性は不変。
- **未使用時バイト等価**: assertions.json を置かないプロジェクトでは `assert` は
  「アサーションなし・exit 0」を返すだけで、他コマンド(validate/describe/frames/
  render)の挙動は 1 バイトも変わらない。
```
