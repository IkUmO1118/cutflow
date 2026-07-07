# 機械可読契約(JSON Schema + AGENTS.md)— 設計

*2026-07-07 / 診断レビュー「E. ローカル×持ち込み AI の運用基盤」項目の設計。実装は別担当。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`(読むだけ・**触らない**)
> 「**機械可読な契約が無い(JSON Schema 0件)** — AGENTS.md 型の能力/不変条件
> マニフェストを出せば非 Claude(codex 等)も守って編集できる。主張#2(BYO-AI)の
> 要。現状の契約は200行の日本語散文 CLAUDE.md に散在し、実質 Claude 前提。」
> = severity **major** / effort **M**。

---

## ★ 実装順序の前提(この Feature は NEXT の最後に実装される)

NEXT 5機能は直列実装で、本 Feature が**最後**。実装時点で `src/types.ts` には
安定 id(`id?`。実装済み=`src/lib/ids.ts` / `mention.ts`)・注釈グラフィック
(`annotations` union。`docs/plans/2026-07-07-annotation-graphics-design.md`)・
apply の入力型(`ApplyPatch` / `EditOp`。`docs/plans/2026-07-07-atomic-apply-design.md`)・
plan perception の config(`docs/plans/2026-07-07-plan-eyes-ears-design.md`。ただし
これは config.yaml 側で**編集ファイルではない**)がすべて入り終えている。

**したがって本設計は「その最終状態のスキーマ全体を機械可読契約として書き出し、
以後ドリフトさせない仕組み」を設計する。** 個々のフィールドの中身を今の types.ts
だけから凍結しない。実装子は実装時点の types.ts / validate.ts / files.ts を正として
スキーマを起こし、**ドリフト検知テストが以後それを code の単一の出所に縛り続ける**。

---

## 背景とギャップ

現状、cutflow の「契約」は3箇所に**人間語で**散在している:

1. `CLAUDE.md`(200行超の日本語散文。Claude Code 固有語=「`claude -p`」「Claude Code」
   前提の運用指示を含む)。
2. `src/types.ts`(TS 型 + コメント。TS を読める者にしか効かない)。
3. `src/stages/validate.ts`(`validateDocs`。**実行時の不変条件の実体**=キー許可・
   enum・範囲・cross-field 検査。ただしコードを走らせないと分からない)。

この状態は Claude(CLAUDE.md を読み、`node src/cli.ts validate` を走らせられる)には
機能するが、**codex 等の他エージェント・素の JSON エディタには不可視**。BYO-AI
(主張#2・差別化の旗)は「video-as-code を任意のコーディングエージェントが編集できる」
ことが要なのに、外部エージェントが構造を機械的に検証・補完する足場が無い。

**ゴール**: (1) 8つの編集ファイルの **JSON Schema** を `schemas/` に checked-in で
用意し、任意のエージェント・JSON エディタ・外部バリデータが構造を機械検証・補完
できるようにする。(2) リポジトリ直下に **AGENTS.md**(emerging standard の agent 向け
マニフェスト)を置き、能力・不変条件・承認境界・触ってよい/いけないファイル・
主要コマンドを **Claude 非依存の言語**で機械可読に宣言する。**両者とも純粋な新規
成果物で、既存コマンド・出力をバイト等価に保つ。**

---

## スコープ

**やること(今回)**

- **JSON Schema**(`schemas/*.schema.json`。draft 2020-12):8編集ファイル
  (`cutplan` / `transcript` / `overlays` / `bgm` / `chapters` / `meta` / `shorts` /
  `thumbnail`)+ 共有 `$defs`(`common.schema.json`)+ **apply パッチ**
  (`apply-patch.schema.json`。AI の書き込み経路の入力形)。
- **AGENTS.md**(リポジトリ直下・英語・Claude 非依存):能力/不変条件/承認境界/
  触ってよい・いけないファイル/主要コマンド(validate / describe / frames /
  id-stamp / apply)/@id アドレッシングを機械可読に宣言。
- **ドリフト検知テスト**(`test/schema.test.ts` / `test/agentsMd.test.ts`):
  スキーマと AGENTS.md の列挙が、コード側の**既存の単一の出所**
  (`EDITABLE_FILES` / `GENERATED_FILES` / `ID_RE` / `ID_PREFIX` / validate.ts の
  enum 群 / コマンド登録)と食い違ったら落ちる。
- **3点セット規約の拡張**(`CLAUDE.md`):スキーマ変更時に揃える対象へ
  `schemas/*.json` と(分類・コマンドが変わったときだけ)`AGENTS.md` を追加。

**やらないこと(スコープ外)**

- **MCP サーバ本体**(Later「複数バックエンド + MCP で BYO-AI 実体化」)。契約の
  **提供**まで。JSON Schema は MCP tool の inputSchema にそのまま流用できる形に
  しておくが、tool 登録は書かない。
- **types.ts からの自動生成 codegen**(ts-json-schema-generator 等)。§論点1で不採用。
- **編集ファイルへの `$schema` キー注入**(§論点2でユーザーデータ不可侵として不採用)。
- **収録フォルダごとの per-project マニフェスト**(§論点4。`describe --json` が
  既にその役割を果たすため足さない)。
- **apply / annotations / ids の挙動変更**。本 Feature はそれらの契約を**書き写す
  だけ**の consumer に徹する(types.ts / validate.ts / apply / ids は無改変)。

---

## 中核原則:**契約は「既存の単一の出所」の機械可読な射影であり、二重管理しない**

本設計を貫く1つの規律:

> JSON Schema も AGENTS.md も**新しい真実を宣言しない**。types.ts(構造)・
> validate.ts(不変条件・enum)・files.ts(ファイル分類)・ids.ts(id 文法)・
> コマンド登録という**既に存在する単一の出所**を、language-neutral な形へ射影した
> ものにすぎない。ゆえに正しさの担保は「人間が両方を正しく書く」ではなく
> **「ドリフト検知テストがコード定数との一致を機械的に強制する」**に置く。

この原則が、診断の言う「200行の散文に散在」を「機械が縛る単一の出所からの射影」へ
置き換える。二重管理の負債(ソロ保守で最も危険なもの)を、テストで airtight にする。

---

## 論点と決定

### 論点1: JSON Schema の生成方式 → **決定: (A) 手書き静的スキーマ + コード定数へのピン留めテスト。依存追加ゼロ。(B) 自動生成は不採用**

| 案 | 依存 | 単一の出所 | type-stripping/no-build 相性 | 判断 |
|---|---|---|---|---|
| **(A) 手書き `schemas/*.json` + ドリフト検知テスト** | **ゼロ** | types と二重だが**テストが縛る** | ◎(ただの JSON。ビルド不要) | **採用** |
| (B) types.ts から codegen(ts-json-schema-generator 等) | 重い devDep + codegen 段 | ○(型が唯一) | ✗ 型検査器を走らせる codegen 段は「型を消すだけ」の思想・ソロ保守と衝突 | **却下** |
| (C) validateDocs から半生成 / 自前 DSL | 中 | △ | △ | **却下**(validate は cross-field 検査で構造宣言ではない。DSL 自作は保守増) |

**(B) 却下の理由(重要な論点=依存追加)**: このリポジトリは Node 23 の type
stripping で**ビルド工程が無い**のが背骨(CLAUDE.md)。ts-json-schema-generator /
typescript-json-schema は TS 型検査器を丸ごと走らせて schema を吐く codegen で、
(1)重い devDependency、(2)「型を消すだけ」の実行モデルに codegen 段を持ち込む、
(3)ソロ保守で「生成物が古い/生成器が壊れる」新しい失敗モードを増やす。差別化軸
「依存を増やさない・決定論」と正面衝突する。**却下**。

**(A) を選ぶ代わりに「二重管理」をテストで潰す**——これが本設計の肝。二重管理が
危険なのは「片方だけ変わって黙ってずれる」からで、**ずれたら落ちるテスト**があれば
負債ではなくなる。ピン留めの具体は §論点6。

**依存の最終判断**: **runtime 依存はゼロ。** ドリフト検知の「実データがスキーマに
valid」を確かめるバリデータも、**外部依存を足さず**、`schemas/` が使う JSON Schema
の**部分集合だけ**を実装した ~120行のテスト専用ヘルパ
(`test/helpers/jsonSchema.ts`)を vendored する(keyword: `$ref` / `$defs` /
`type` / `required` / `properties` / `additionalProperties` / `enum` / `const` /
`pattern` / `items` / `oneOf` / `minimum` / `maximum` / `minItems`)。スキーマ側を
意図的にこの部分集合に収める。ajv 等の devDependency 追加は「保守したくなければ
選べる代替」として明記するが、**推奨は zero-dep の vendored ヘルパ**(no-build
思想を割らない・schema が使う語彙を我々が完全に制御している)。

---

### 論点2: 粒度・配置・draft・任意フィールド → **決定: 1編集ファイル=1スキーマ + 共有 `$defs`。draft 2020-12。ユーザー JSON に `$schema` を注入しない**

**粒度**: **1編集ファイル=1スキーマ**(`schemas/cutplan.schema.json` 等)+
**共有 `schemas/common.schema.json`** に `$defs`(`Region` / `CaptionPos` /
`CaptionStyle` とその下位(`CaptionBackground` / `CaptionAnim` / `CaptionKaraoke`)/
`WordTiming` / `Annotation` union / `CaptionTrackDef` / `id` パターン / `Interval`)。
ファイル間は `$ref: "common.schema.json#/$defs/Region"` で参照。

- 1本の巨大スキーマ + トップ `oneOf` にしない理由:JSON エディタ・外部バリデータは
  「このファイルにこのスキーマ」と**ファイル単位で紐づける**のが自然
  (`cutplan.json` ↔ `cutplan.schema.json`)。ファイル=役割の単一モデル(files.ts)
  とも揃う。ドリフト検知も「`EDITABLE_FILES` ↔ `schemas/*.schema.json` の全単射」で
  縛れる(§論点6)。
- 共有 `$defs` を分離する理由:`CaptionStyle` は transcript / overlays.captionTracks /
  shorts.captionTracks / thumbnail が共有(types.ts と同じ DRY)。1箇所に置いて
  `$ref` すれば、スタイル拡張が全ファイルへ一度で伝播する。

**配置**: リポジトリ直下 `schemas/`(新規ディレクトリ。files.ts の分類には
現れない=収録フォルダ外のリポジトリ資産)。各スキーマの**最大例**を
`schemas/examples/<file>.max.json`(全任意フィールドを1つ以上使う「kitchen-sink」)
として置き、ドキュメントと**構造ドリフト検知**を兼ねる(§論点6)。

**draft / $id**: `"$schema": "https://json-schema.org/draft/2020-12/schema"`。
各ファイルに安定した `"$id"`(例 `"https://cutflow.dev/schemas/cutplan.schema.json"`)
を振り、`$ref` は相対で解決可能にする(2020-12 の `$ref` 解決規則)。

**任意フィールド(`id?` / `annotations` / `words` / style 各キー)**: `required` に
入れず `properties` に置くだけ=省略した既存 JSON はそのまま valid。`id` は
`common.schema.json#/$defs/id`(`{ "type": "string", "pattern": "<ID_RE.source>" }`)
を各要素の `properties.id` に `$ref`。`annotations` は `common` の discriminated
union(`oneOf` + `properties.type.const`)。

**`additionalProperties` の使い分け(=構造ドリフト検知の要)**:
validate.ts が**未知キーを警告する**オブジェクト(overlays トップの `KNOWN`・
`bgm` トップ・`colorFilter`・`anim`・`karaoke`)には `additionalProperties: false` を
置き、codex に validate と同じタイポ検出を与える。同時にこれが**構造ドリフト検知**
として働く:types.ts に新フィールドが増えて `schemas/examples/*.max.json` がそれを
使うと、schema 未更新なら fixture 検証が落ちる(§論点6)。validate が寛容な
オブジェクトは schema も寛容(`additionalProperties` 未指定=許容)にして挙動を揃える。

**`$schema` をユーザー JSON に注入しない**: 収録フォルダの `cutplan.json` 等に
`"$schema": "…"` を書き足せばエディタ補完は効くが、(1)**未使用時バイト等価/
opt-in 思想を割る**(既存ファイルが1バイト変わる)、(2)id と同じく「勝手に生えた
キー」になる。**却下**。ファイルとスキーマの紐付けは AGENTS.md の命名規約
(`<file>.json` ↔ `schemas/<file>.schema.json`)+ 各エージェント/エディタ側の
設定に委ねる。ユーザーデータは不可侵。

**既存 JSON が schema に valid か**: **テストで保証する**(§論点6 の fixture 検証)。
これが「schema が現実のデータと合っている」ことの一次証拠になる。

---

### 論点3: AGENTS.md の内容と生成 → **決定: 手書き Markdown(英語・Claude 非依存)を正とし、列挙部分をドリフト検知テストでコードに縛る。CLAUDE.md は併存し AGENTS.md を参照**

**何を書くか(目次案)**:

1. **What cutflow is** — video-as-code。編集=収録フォルダの JSON 編集(コード
   ではない)。動画ファイルは触らない。1収録=1フォルダ。
2. **Conventions**(規約)— 時刻はすべて**元収録(raw)の秒**(カット後秒への換算は
   ツール。頭で引き算しない)。座標はすべて**出力px**(テロップ pos・rect 共通)。
3. **Editable files**(表)— 8ファイル × {何を決めるか / スキーマへのリンク /
   1行要約}。この表の**ファイル名列**は `EDITABLE_FILES` にピン留め(§論点6)。
4. **Files you must NOT write**(中間生成物)— `GENERATED_FILES` +
   name パターン + ディレクトリから**生成/ピン留め**した deny 一覧。
5. **The approval boundary**(承認境界)— `approvals.json` は第3カテゴリ。エージェントは
   `approved: true` を自分で書かない・`approvals.json` を直接書かない。承認は
   `approve`/`unapprove` コマンドと GUI 保存の専権(人間の行為)。
6. **Addressing with @id**(@-mention)— `<prefix>_<base36 6桁>`(`ID_RE`)。id の
   発見は `describe --json`。採番は `id-stamp`。接頭辞表は `ID_PREFIX` にピン留め。
7. **How to edit safely: the write path** — `apply`(検査付きアトミック適用。
   set/remove/add op + 全置換。`--dry-run`)を**推奨の書き込み経路**として提示。
   生 JSON 手書き → `validate` の代替。apply-patch スキーマへのリンク。
8. **The verification triad** — `validate`(構造+不変条件)/ `describe --json`
   (機械可読な完全射影=現在状態の読み取り)/ `frames`(最終合成の見た目確認)。
9. **Re-run guards** — `plan` / `run` は再実行禁止(手編集を上書き)。cutplan を
   保ったまま章・タイトルだけ作り直すなら `remeta`。
10. **Commands**(表)— 各コマンド名 + 1行。**コマンド名**は CLI 登録に
    ピン留め(§論点6)。

**生成 vs 手書き(=論点の核)**: **ハイブリッド。散文(規約・ワークフロー・承認の
思想)は手書き、列挙(編集ファイル一覧・deny 一覧・id 接頭辞・コマンド名)は
コードにピン留めしたテストで縛る。** 生成コマンド(`agents-md` を新設して files.ts
から吐く)は**採らない**:AGENTS.md は稀にしか変わらない1枚の Markdown で、生成器を
足すのは machinery 過剰。既存リポジトリの流儀(CLAUDE.md が「厳密な一覧は
files.ts を参照」と**散文で code を指し**、validate.ts のコメントが「types.ts の
型定義と揃える」と**人間規約 + テスト**で縛る)と完全に一致させ、**手書き +
ドリフトテスト**にする。生成器化は Later の選択肢として本文に一言残す。

**Claude 非依存の言語**: AGENTS.md には「`claude -p`」「Claude Code」等の Claude
固有語を**持ち込まない**。「any coding agent」「run `node src/cli.ts validate <dir>`」
のように backend 非依存で書く。言語は**英語**(AGENTS.md は emerging standard で
codex 等が読む前提。英語が最も広く parse される)。日本語の運用ニュアンスは
CLAUDE.md / usage.md に残す。AGENTS.md は翻訳ではなく**契約の distillation**。

**CLAUDE.md との関係**: **併存。AGENTS.md を「契約(何が編集可能か・不変条件・
承認境界・コマンド)の正」とし、CLAUDE.md は「Claude Code 固有の運用ニュアンス」を
保つ。** CLAUDE.md 冒頭に AGENTS.md への1行ポインタ(「機械可読・エージェント非依存の
契約は AGENTS.md。本書は Claude Code 向けの運用補足」)を足す。200行を複製しない:
AGENTS.md は列挙 + 規約の要点 + リンクに絞り、詳細(backups の復元手順・frames の
stale 罠等)は usage.md/CLAUDE.md へリンクで逃がす。二重に持つ列挙(ファイル一覧等)は
**同じコード定数へ両方ピン留め**するので、片方だけずれることはない。

---

### 論点4: AGENTS.md の配置と per-project の是非 → **決定: リポジトリ直下 `AGENTS.md` のみ。収録フォルダの per-project マニフェストは足さない**

- **リポジトリ直下 `AGENTS.md`**(emerging standard。codex 等が既定で探す位置)。
- **per-project(収録フォルダ)マニフェストは足さない**:収録フォルダの「契約」は
  (1)JSON ファイル自身 + そのスキーマ(構造)と、(2)`describe --json`(**現在状態の
  機械可読な完全射影**=既に実装済み)で尽きている。per-folder に能力要約 md を
  置くと、生成物 or 手編集対象の**第4の何か**が増え、`describe --json` と二重になる。
  AGENTS.md は「per-project の状態は `describe --json <dir>` を読め」と誘導する
  (スコープを広げない)。

---

### 論点5: 検証(codex 等が本当に使えるか) → **決定: 3層で担保。(a) fixture/bench が schema に valid、(b) AGENTS.md の列挙が code 定数と一致、(c) 外部バリデータ + 実エージェントの手動実測**

1. **(a) schema が実データと合う**(自動):`test/fixtures/` の各編集ファイル・
   `schemas/examples/*.max.json` を vendored バリデータで各 schema に通し、**valid**を
   assert(§論点6-b)。「schema が現実を弾かない」ことの一次証拠。
2. **(b) 契約が実挙動と一致**(自動):AGENTS.md とスキーマの列挙(ファイル一覧・
   deny 一覧・id 接頭辞・enum・コマンド)を code 定数へピン留め(§論点6-a/c)。
   validate.ts の enum・files.ts の分類が変われば落ちる=「AGENTS.md が validate の
   実挙動と乖離しない」保証。**散文の不変条件**(keep 重なり禁止等)は validate.ts /
   approval.ts が実施者で、その主張が正しいことは各機能のテストが既に固定している
   (本 Feature は再検査しない=consumer に徹する)。
3. **(c) 手動実測**(実装後・人間):
   - 外部バリデータ(`ajv-cli` か VS Code の JSON schema 連携)で**実収録フォルダ**の
     8ファイルを各スキーマに通し valid を確認。わざとキーを壊して invalid になることも。
   - codex 等 Claude 以外のエージェントに AGENTS.md だけ渡し、収録フォルダを編集させ、
     (i)`approvals.json`/`GENERATED_FILES` に書かない、(ii)`validate` を通す編集を出す、
     を観察(BYO-AI の一次実測)。中立 cwd で実行(MEMORY
     `llm-command-verify-neutral-cwd`)。

---

### 論点6: ドリフト対策の仕組み化 → **決定: 3点セットを5点へ拡張し、CI 相当のドリフトテストを1本入れる**

**3点セット規約の拡張**(`CLAUDE.md`「コードを触るとき」):
現状「スキーマを変えたら types.ts コメント・validate.ts・usage.md を揃える」に
**`schemas/*.json`(第4点)**を追加し、**ファイル分類・コマンドが変わったときだけ
`AGENTS.md`(第5点)**を追加する、と明記。

**ドリフトテスト(`test/schema.test.ts` / `test/agentsMd.test.ts`)**:

- **(a) 全単射**: `schemas/` にある編集ファイル用スキーマの集合 ==
  `EDITABLE_FILES`(files.ts)。片方に増減があれば落ちる。`GENERATED_FILES` に
  対応するスキーマが**無い**ことも確認(生成物にスキーマを作らない)。
- **(b) fixture / example 検証**: 各 fixture・`schemas/examples/*.max.json` を
  vendored バリデータ(§論点1)で対応スキーマに通し **valid**。max 例は全任意
  フィールドを使うので、`additionalProperties: false` と併せて**「types.ts に
  フィールドが増えたのに schema 未更新」を落とす構造ドリフト検知**になる。
- **(c) enum/pattern ピン留め**: スキーマ中の enum/pattern を、**既存の単一の出所**へ
  1:1 で assert する。
  - `common#/$defs/id.pattern` === `ID_RE.source`(ids.ts)。
  - id 接頭辞の説明/例 === `ID_PREFIX`(ids.ts)。
  - CaptionAnim の `in`/`out` enum === `CAPTION_ANIM_KINDS`(validate.ts)。
  - blur `type` enum === `["blur","mosaic"]`(`BlurType`)、annotation `type` ===
    `["arrow","box","spotlight"]`(`AnnotationType`)、spotlight `shape` ===
    `SpotlightShape`。
  - overlays トップの `additionalProperties:false` の許可キー === validate.ts の
    `KNOWN` 配列。`colorFilter` キー === `CF_KEYS`。caption `anchor` /
    overlay `fit` の enum。
  - short `profile` enum === `Object.keys(PROFILES)`(profile.ts)。
  - これらを**テストで export 定数と突き合わせる**ことで、validate/types と schema が
    食い違った瞬間に赤くなる=手書き schema の二重管理負債を消す。
- **(d) AGENTS.md ピン留め**(`test/agentsMd.test.ts`):AGENTS.md 本文を読み、
  編集ファイル表の名前が `EDITABLE_FILES` を過不足なく含む・deny 節が
  `GENERATED_FILES`(+ `APPROVAL_FILE`)を含む・コマンド表がCLI登録の全コマンド名を
  含む・id 接頭辞節が `ID_PREFIX` を含む、を assert。散文の言い回しは検査せず、
  **列挙の網羅だけ**を機械照合する(文面の自由度は保ちつつ抜けを防ぐ)。

> **構造ドリフトの限界(明記)**: リフレクション/codegen 無しでは「types.ts に増えた
> フィールドを schema が持つか」を**完全**には自動照合できない。本設計はこれを
> (i)`additionalProperties:false` + kitchen-sink example の fixture 検証(使われる
> フィールドの欠落は落ちる)、(ii)5点セット規約(実装子が types と同時に schema を
> 更新する人間規律)、の二段で塞ぐ。enum/分類/コマンド/id 文法という**壊れると
> 一番痛い列挙**は (c)/(d) で機械的に airtight。これが no-dep での最善で、codegen 依存
> (論点1-B)を持ち込むより思想に合う。

---

## 成果物の一覧(ファイル)

```
schemas/
  common.schema.json          # $defs: id, Region, CaptionPos, CaptionStyle(+下位),
                              #        WordTiming, Annotation union, CaptionTrackDef, Interval
  cutplan.schema.json
  transcript.schema.json
  overlays.schema.json        # overlays/inserts/wipeFull/hideCaption/zooms/blurs/
                              #        annotations/colorFilter/layerOrder/captionTracks
  bgm.schema.json
  chapters.schema.json
  meta.schema.json
  shorts.schema.json
  thumbnail.schema.json
  apply-patch.schema.json     # ApplyPatch / EditOp(AI の書き込み経路の入力形)
  examples/
    cutplan.max.json          # 全任意フィールドを使う kitchen-sink(構造ドリフト検知兼ドキュメント)
    …(各編集ファイルぶん)
AGENTS.md                     # リポジトリ直下・英語・Claude 非依存
test/
  helpers/jsonSchema.ts       # vendored な JSON Schema 部分集合バリデータ(テスト専用・zero-dep)
  schema.test.ts              # 全単射 / fixture・example 検証 / enum・pattern ピン留め
  agentsMd.test.ts            # AGENTS.md 列挙 ↔ code 定数のピン留め
```

`approvals.json` は**第3カテゴリ**(AI 非書き込み)。スキーマは v1 では作らない
(全単射テストを `EDITABLE_FILES` に単純化するため)。AGENTS.md の承認境界節で
「approve/unapprove コマンドと GUI だけが書く」と散文で宣言する。将来 reference-only
スキーマが要れば別途(全単射の対象外として)。`manifest.json` / `cuts.auto.json` 等の
生成物にもスキーマは作らない(全単射テストが「作らない」ことを保証)。

---

## タスク分解(1タスク=1コミット)

先行機能マージで行番号はずれるため**シンボル名で特定**。各タスクは
`npx tsc --noEmit` と `npm test` が緑を必須とする。**本 Feature の全成果物は新規
ファイルで、既存の `src/` / `remotion/` / `editor/` コードを1バイトも変えない**
(唯一の既存ファイル編集は CLAUDE.md/usage.md/types.ts コメントのドキュメント整合=
T6。挙動には無影響)。

### T1: vendored バリデータ + 共有 `$defs`(`schemas/common.schema.json` + `test/helpers/jsonSchema.ts`)

- **触る(新規)**: `test/helpers/jsonSchema.ts`(JSON Schema 2020-12 の部分集合を
  評価する純関数 `validateAgainstSchema(data, schema, refResolver): string[]`。
  keyword は §論点1 の一覧に限定)。`schemas/common.schema.json`(`$defs`:
  実装時点の types.ts の `Region` / `CaptionPos` / `CaptionStyle` + 下位型 /
  `WordTiming` / `Annotation` union / `CaptionTrackDef` / `id`(pattern=`ID_RE`)/
  `Interval`)。
- **テスト方針**(`test/helpers/jsonSchema.test.ts`):バリデータ自体の単体テスト
  (required 欠落・enum 外・pattern 不一致・additionalProperties・`$ref` 解決・
  `oneOf`/discriminator を最小ケースで固定)。バリデータは**自前ロジックなので
  必ず単体テストで固める**(これが全 schema テストの土台)。
- **壊してはいけない挙動**: 新規ファイルのみ。既存コードへの import ゼロ。

### T2: 8編集ファイルのスキーマ(`schemas/<file>.schema.json` × 8 + `schemas/examples/*.max.json`)

- **触る(新規)**: `cutplan` / `transcript` / `overlays` / `bgm` / `chapters` /
  `meta` / `shorts` / `thumbnail` の各 `.schema.json`(実装時点の types.ts を正に
  起こす。`id?` / `annotations` / `words` / style 各キーは optional。`$ref` で
  common を参照)。各 `examples/<file>.max.json`(全任意フィールドを1つ以上使う)。
  overlays トップ・bgm トップ・colorFilter・anim・karaoke に
  `additionalProperties: false`(§論点2)。
- **テスト方針**(`test/schema.test.ts` の一部):各 example を T1 バリデータで対応
  スキーマに通し **valid**。既存 `test/fixtures/` の編集ファイルも valid(実データ
  適合)。
- **壊してはいけない挙動**: 新規成果物。既存コマンド・出力に無影響(byte 等価)。

### T3: ドリフト検知テスト(`test/schema.test.ts` 本体)

- **触る**: `test/schema.test.ts` に §論点6 の (a) 全単射(`EDITABLE_FILES` ↔
  schemas、`GENERATED_FILES` に schema 無し)、(b) fixture/example 検証、
  (c) enum/pattern ピン留め(`ID_RE` / `ID_PREFIX` / `CAPTION_ANIM_KINDS` /
  `BlurType` / `AnnotationType` / `SpotlightShape` / validate.ts `KNOWN`・`CF_KEYS` /
  `Object.keys(PROFILES)`)を実装。**code 側の export を import して突き合わせる**。
- **テスト方針**: このタスク自体がテスト。わざと片方をずらすと落ちること
  (=ガードが効くこと)を実装中に手で確認。
- **壊してはいけない挙動**: 既存テストに触れない(新規テストファイル)。

### T4: apply パッチのスキーマ(`schemas/apply-patch.schema.json`)

- **触る(新規)**: `apply-patch.schema.json`(実装時点の `ApplyPatch` / `EditOp`
  union=`set`/`remove`/`add`。`add` の `target` は allow-list コレクション選択子の
  enum、`set` の `target` は `@id` 文字列)。`add` 選択子 enum は apply の
  allow-list(`applyEdits.ts`)にピン留めできるなら `test/schema.test.ts` に追加。
- **テスト方針**: apply の fixture パッチ(あれば `test/applyEdits.test.ts` の
  サンプル)を通して valid。`set` で `approved` を触る op が **schema 段でも**
  弾ければ望ましいが、cross-field(承認差分)は validate/apply 側の責務なので
  schema は構造だけ(op 形状)を固定。
- **壊してはいけない挙動**: apply 実装(applyEdits.ts / types.ts)は無改変。schema は
  その入力形の**射影**。

### T5: AGENTS.md(`AGENTS.md` + `test/agentsMd.test.ts`)

- **触る(新規)**: `AGENTS.md`(§論点3 の目次。英語・Claude 非依存。編集ファイル表は
  各 `schemas/*.schema.json` と usage.md/`describe --json` へリンク。承認境界・
  apply の書き込み経路・検証トライアド・再実行禁止を明記)。`test/agentsMd.test.ts`
  (§論点6-d:編集ファイル名・deny 一覧・コマンド名・id 接頭辞の網羅をピン留め)。
- **テスト方針**: AGENTS.md を読み、`EDITABLE_FILES` / `GENERATED_FILES` +
  `APPROVAL_FILE` / CLI コマンド名 / `ID_PREFIX` を過不足なく含むことを assert。
  文面自体は検査しない(列挙の網羅のみ)。
- **壊してはいけない挙動**: 新規成果物。コマンド名一覧は CLI 登録(`src/cli.ts` の
  `.command(...)`)を単一の出所として参照。

### T6: ドキュメント整合(3点セット→5点セット規約)

- **触る**: `CLAUDE.md`(「コードを触るとき」の3点セットへ `schemas/*.json`・
  `AGENTS.md` を追加。冒頭へ AGENTS.md ポインタ)。`docs/usage.md`(「機械可読契約」
  節=schemas の場所・命名規約・`$schema` を注入しない旨・外部バリデータの使い方・
  AGENTS.md への言及)。`src/types.ts`(各スキーマ対応のコメントに「`schemas/<file>.
  schema.json` と揃える」を一言。**型・順序は不変**)。
- **テスト方針**: なし(ドキュメント)。`npx tsc --noEmit`・`npm test` 緑。
- **壊してはいけない挙動**: `docs/reviews/` は**触らない**。types.ts のコメント追記は
  型・フィールド順・既存コメントを1バイトも動かさない(挙動無影響)。

> 依存順: T1 → T2 → T3(T2 に依存)/ T4(T1 に依存・T2 と並行可)→ T5 → T6。

---

## 不変条件(実装・レビューで必ず守る)

1. **純粋な新規成果物 = 既存挙動バイト等価**: `schemas/` と `AGENTS.md` の追加で、
   既存の全コマンド(`validate` / `describe` / `plan` / `transcribe` / `render` /
   `frames` / `apply` / editor 保存 …)の出力・書き込みバイトは**一切変わらない**。
   本 Feature は `src/` / `remotion/` / `editor/` の実行コードを触らない(唯一の
   既存ファイル編集は CLAUDE.md/usage.md/types.ts の**コメント**=挙動無影響)。
2. **runtime 依存追加ゼロ**: `package.json` の `dependencies` は不変。ドリフト検知は
   vendored バリデータ(テスト専用・zero-dep)。ajv 等は不採用(no-build 思想)。
3. **ユーザーデータ不可侵**: 収録フォルダの編集ファイルに `$schema` 等のキーを
   注入しない。schema/AGENTS.md は収録フォルダの外(リポジトリ資産)。
4. **契約は既存の単一の出所の射影**: schema/AGENTS.md は新しい真実を宣言せず、
   `types.ts` / `validate.ts` / `files.ts` / `ids.ts` / CLI 登録へ**テストでピン留め**。
   食い違ったら `npm test` が落ちる。
5. **Claude 非依存**: AGENTS.md に Claude 固有語(`claude -p` / Claude Code)を
   持ち込まない。backend 非依存の言葉と `node src/cli.ts …` で書く。
6. **consumer に徹する**: apply / annotations / ids / validate は無改変。本 Feature は
   それらの契約を書き写すだけ。

---

## スコープ境界(明記)

- **やる**: 8編集ファイル + apply パッチの JSON Schema(draft 2020-12・共有 `$defs`・
  checked-in)、AGENTS.md(英語・Claude 非依存・列挙ピン留め)、ドリフト検知テスト
  1系統、5点セット規約への反映。
- **やらない**: types からの codegen、MCP サーバ/tool 本体、複数バックエンド実体化
  (Later)、ユーザー JSON への `$schema` 注入、per-project マニフェスト、
  approvals/生成物のスキーマ、AGENTS.md 生成コマンド。ただし **apply コマンド
  (Feature 4)への参照は AGENTS.md の「書き込み経路」節に含める**(推奨経路として
  提示 + apply-patch スキーマへリンク)。
```
