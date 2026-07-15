# 自動編集を壊さない仕組み(id / apply / assert / 契約)

> 安定 id・検査付きアトミック適用・意図検査・機械可読契約。AI やスクリプトで安全に JSON を編集するための土台。
> 関連: [ai-agents.md](ai-agents.md) / [command-reference.md](command-reference.md) / [../usage.md](../usage.md)

## 安定 id / @-mention

編集ファイルの各要素(`cutplan.segments` / `transcript.segments` /
`overlays.json` の各配列 / `chapters.chapters` / `bgm.tracks` / 各ショートの
`ranges`・`captionTracks` / `thumbnail.texts`)には、任意で**安定 id**
(`id?: string`。例 `seg_a1b2c3`)を付けられる。文法は
`<種別を表す2〜3文字の接頭辞>_<英数字6桁>`(`seg`=cutplan の区間 / `cap`=テロップ /
`mat`=素材 / `ins`=挿入 / `zm`=ズーム / `bl`=ぼかし / `wf`=ワイプ全画面 /
`hc`=字幕非表示 / `ct`=テロップトラック標準設定 / `ch`=章 / `bg`=BGM区間 /
`rg`=ショートの range / `tx`=サムネのテキスト)。**shorts(ショート本体)だけは
`name` がそのまま id 代わり**で、別の id フィールドは持たない
(`@<name>` または `@short:<name>` で指せる)。

- **一度振ったら内容・位置が変わっても不変**(id は「この要素」を指す
  永続アドレス。`@id` で人間/AI が位置に依存せず参照できる)。
- **opt-in・sticky**: プロジェクトに `id` が1つも無ければ「id 無効」で、
  全コマンドの出力は本機能導入前と完全に同じ(バイト等価)。`id-stamp <dir>`
  を一度実行すると「id 有効」になり、以後は `plan` / `transcribe` /
  `plan-shorts` の再実行や GUI 保存が新規要素にだけ id を採番し、既存 id は
  常に保つ。**id 無効なプロジェクトを触らない限り、この機能は一切見えない**。
- **`id-stamp <dir>`**: 既存プロジェクトへの一括採番コマンド(冪等。既存 id は
  不変、無い要素にだけ新規採番。内容が実際に変わったファイルだけ書く)。
  `validate` と同じ検査を通してから書く。`approvals.json`(承認レコード)には
  一切触れない。
- **id の発見手段は `describe <dir> --json`**(散文 `describe` には出ない。
  golden 出力を汚さないため)。各要素の `index` の次に `id`(採番済みのものだけ)
  が載る。
- **`validate`** は id の重複・形式不正・(有効時の)欠落密度を**警告**で知らせる
  (id は render に一切影響しないため error にはしない。id が無いプロジェクトでは
  この検査自体が no-op で警告も増えない)。
- **id は render / preview / frames / 承認 hash に一切影響しない**(アドレッシング
  専用。cut 決定のハッシュは `[start, end]` のみを見るので、id を stamp しても
  承認は失効しない)。
- `@id` を宛先にした差分適用(パッチ)は `apply <dir>` コマンドで行う
  (下記「検査付きアトミック適用(apply)」参照)。配列添字を書かず、
  `@id` と1フィールドの新しい値だけで編集を当てられる。


## 検査付きアトミック適用(apply)

`cutplan.json` 等を Write/Edit で直接書き換える(=検査は書いた後の
`validate` 任せ)代わりに、`apply <dir>` は**「全部 valid なら全部書く、
1つでもエラーなら1バイトも書かない」全か無か**で編集を当てるコマンド。
GUI エディタの保存(`/api/save`)が既に持っていた「検査を通さないと保存
できない」を CLI/AI へ露出したもの(GUI と同じ merge+検査を共有=
`src/lib/applyEdits.ts` の `mergeBodyOverDisk`)。

```sh
node src/cli.ts apply <dir> --patch edit.json     # ファイルからパッチを読む
node src/cli.ts apply <dir> < edit.json           # stdin から(--patch 省略時)
node src/cli.ts apply <dir> --patch edit.json --dry-run   # 検査・要約だけ。書かない
```

パッチ(`ApplyPatch`。`src/types.ts`)は次の2形式を両方受け付ける(両方
あるときは ops を先に適用し、その結果へ replace を重ねる):

- **`ops`**(`@id` 指定の高水準オペレーション列。**推奨経路**): 配列添字を
  一切書かず、Feature 2 の安定 id(`describe --json` / `id-stamp` で確認)
  だけで宛先を指す。

  | op | target | 追加フィールド | 意味 |
  |---|---|---|---|
  | `set` | 既存要素の `@id` | `field`(ドット区切りパス。例 `"style.fontSizePx"`) / `value` | 指した要素の1フィールドを設定。パス末端の置換のみ(中間の欠落・配列添字(`words[0]`)はエラー。勝手に中間オブジェクトを作らない) |
  | `remove` | 既存要素の `@id` | — | 指した要素を所属配列から削除 |
  | `add` | コレクション選択子(例 `"cutplan.segments"`) | `value`(新要素オブジェクト) / `at?`(挿入位置。省略時は末尾) | コレクションへ新要素を追加。id 有効プロジェクトなら新要素にも自動採番される |

  `add` の選択子は allow-list(`cutplan.segments` / `transcript.segments` /
  `overlays.overlays` / `overlays.inserts` / `overlays.zooms` /
  `overlays.blurs` / `overlays.wipeFull` / `overlays.hideCaption` /
  `overlays.captionTracks` / `chapters.chapters` / `bgm.tracks` /
  `thumbnail.texts`)のみ。**shorts[] 自体の追加、および shorts 配下
  (`ranges`/`captionTracks`)への set/remove/add は対象外**(`@id` だけでは
  「どのショートか」を一意に復元できないため。全置換(`replace`)で編集する)。
  `cut`/`keep` も独立 op にせず `{op:"set", target:"@seg_x", field:"action", value:"cut"}`
  で表す。
- **`replace`**(ファイル単位の全置換。`SaveRequest` と同型の低水準の脱出
  ハッチ): split・要素の並べ替え・shorts[] 自体の追加など、`ops` の3種で
  表せない編集に使う。`bgm`/`shorts` は `null` で該当ファイルを削除できる
  (`undefined` はそのファイルを触らない)。

**守られる不変条件**(コードで強制。「自分の判断で回避」できない):

1. **`approvals.json` を一切書かない・読んで判定に使わない**。承認は
   `approve`/`unapprove` コマンドと GUI 保存の専権のまま。
2. **`approved` を変更できない**。`set` の `field` に `approved` を指定、
   `add` の `value` に `approved` を含める、`replace` で
   `cutplan.approved`/`shorts[].approved` をディスク現状と違う値にする
   —— いずれもエラーで拒否される(cutplan/short の `approved` は常に
   ディスク現状の値へ強制されて書き戻される)。承認を変えたいときは
   `approve <dir>` / `unapprove <dir>` を使う。
3. **エラー時ゼロ書き込み**: 宛先未解決・op 不正・JSON パース失敗・
   `validate` と同じ不変条件違反(keep の重なり・尺超え・overlays の file
   欠落等)のいずれでも、収録フォルダのファイルは1バイトも変わらない
   (`backups/` も作られない)。
4. **書き込みはファイル単位で `<file>.tmp` → rename(アトミック確定)**。
   書く前に `backupEditableFiles` と同じ仕組みで上書き対象の現状を
   `backups/<日時>/` へ退避する。
5. **apply が書けるのは cutplan/transcript/overlays/chapters/bgm/shorts/
   thumbnail の7ファイルだけ**(`meta.json` は id を持つ要素が無いため
   `apply` のスキーマ自体に含まれない。触りたいときは通常の Write/Edit で
   直接編集する)。`approvals.json` や中間生成物は物理的に書き込み対象に
   入らない。

**出力・exit code は `validate` と同形式**: エラーは `✖ file where: message`
(`(patch)` file は「JSON 本体・パッチ形式そのものの問題(未解決 @id・
未知の op 等)」を表す)、警告は `⚠ ...`。エラーがあれば(`--dry-run` でも)
exit 1。`--dry-run` は `@id` 単位の変更要約(`field: 旧 → 新`)と
`validate` 相当の検査結果を出し、書かずに検査だけしたいときに使う。

現状スコープ外: MCP サーバ本体(`applyEdits(dir, patch)` は
`process.exit`/`console` に依存しない純関数なので、将来 MCP tool から
呼び出す土台にはなっている)、split/move 等の複合 op。


## 編集後の意図検査(assert)

`validate` が答えるのは「この編集は**壊れていない**か」(スキーマ・keep の
重なり・参照ファイルの存在・尺超えという普遍の不変条件)。一方 `assert <dir>`
が答えるのは「この編集は**私が意図した状態になっている**か」——「ショートを
60秒以内に収めたはずだ」「@cap_x のテロップは本編に残っているはずだ」
「API キーを写した区間は目隠しできているはずだ」というこの収録固有の期待値
(`docs/plans/2026-07-07-visual-assertions-design.md` 設計)。

期待値は `assertions.json`(収録フォルダ直下)に平文で宣言する。人間/AI が
手で書く**第3の宣言ファイル**で、`rules.md` / `brief.md` と同じく
`EDITABLE_FILES`(plan/transcribe 再実行の退避対象)にも `GENERATED_FILES`
(中間生成物)にも属さない。**どの生成コマンドも上書きしない**ので、
`plan --force` で cutplan をやり直しても assertions.json は残り、そのまま
再評価できる。

```sh
node src/cli.ts assert <dir>            # Tier 1(構造)だけ評価。fail/error があれば exit 1
node src/cli.ts assert <dir> --visual   # Tier 1 + Tier 2(OCR)。非対応環境は Tier 2 を skip
node src/cli.ts assert <dir> --json     # AssertReport を純 JSON で stdout(パイプ可。診断の所要時間行は stderr へ)
```

`assertions.json` が無ければ「アサーションがありません」と表示して **exit 0**
(未使用時は無害)。

```jsonc
{
  "schemaVersion": 1,
  "assertions": [
    { "label": "本編は5分以内", "type": "outDuration", "op": "<=", "value": 300 },
    { "type": "keepCount", "op": ">=", "value": 3 },
    { "type": "captionVisible", "ref": "@cap_qs3bwg", "visible": true },
    { "type": "noCaptionOverlap" }
  ]
}
```

### 語彙(9種。type で判別)

各アサーションは共通で任意の `label?`(レポート表示用の作者ラベル。要素の
`@id` とは別物)を持てる。`op` は `"<=" | ">=" | "<" | ">" | "=="`。

**Tier 1(構造。`describe --json` 射影から。依存ゼロ・数ミリ秒・全環境。
既定 `assert <dir>` で評価される)**

| type | フィールド | 意味 |
|---|---|---|
| `outDuration` | `op, value, short?` | 出力尺の比較。`short` 指定でそのショートの `outDurationSec`、省略で本編 `summary.outDurationSec` |
| `keepCount` | `op, value` | keep 区間数(`summary.keepCount`)の比較 |
| `captionVisible` | `ref, visible?` | `@id` のテロップが出力に現れるか。`visible` 省略時 true |
| `captionText` | `ref, contains?, equals?` | `@id` のテロップ本文が部分一致/完全一致するか(手編集で文言が保たれたかの確認) |
| `timeKept` | `at, kept?` | 元収録秒 `at` が出力に残っているか(keep 内)。`kept` 省略時 true |
| `materialExists` | `ref` | `@id` の素材の参照ファイルが実在するか |
| `noCaptionOverlap` | `track?` | テロップの出力秒区間が同一トラック内で重ならない。`track` 省略で全トラックを検査 |

**Tier 2(視覚。`frames --ocr` から。macOS 依存・重い。`--visual` のときだけ
評価。既定では `skip`)**

| type | フィールド | 意味 |
|---|---|---|
| `screenText` | `at, contains, present?` | 元収録秒 `at` の画面 OCR 全文に文字列が含まれる/含まれない |
| `regionClear` | `ref` | `@id` の blur 領域内に OCR テキスト行が無い(=目隠しできている) |

`ref` を取るアサーション(`captionVisible` / `captionText` / `materialExists` /
`regionClear`)は `@id` で対象を指す。**プロジェクトに id が1つも無い
(id-stamp 未実行)場合は `fail` ではなく `error`**(`id-stamp <dir>` を実行
してから @id で指定するよう促す)。ref が解決できない(id はあるが該当が
無い)場合も `error`。

### 結果の意味論

1件ごとに `pass`(成立)/ `fail`(不成立)/ `skip`(視覚アサーションで
`--visual` 無し、または OCR 非対応環境)/ `error`(宣言そのものが評価不能:
未知 type・ref 未解決・id 未採番・`at` が収録尺外 等)。**exit code は
`fail > 0 || error > 0` なら 1**(`skip` だけでは 1 にしない=非対応環境で
CI/ループが赤にならない優雅な劣化)。CLI 表示は `validate` に揃える:
`✔`(pass)/ `✖`(fail)/ `⚠`(error)/ `–`(skip)。


## 機械可読契約(JSON Schema / AGENTS_CONTRACT.md)

Claude Code に限らず、任意のコーディングエージェント・素の JSON エディタ・
外部バリデータが CutFlow の編集ファイルを機械的に検証・補完できるよう、
契約をコードから射影した2種類の成果物がある(`docs/plans/2026-07-07-machine-contract-design.md`
設計。types.ts / validate.ts / files.ts / ids.ts という**既存の単一の出所**の
射影であり、新しい真実は宣言しない。ずれたら `npm test`(`test/schema.test.ts` /
`test/agentsMd.test.ts`)が落ちる)。

- **`schemas/*.schema.json`**(draft 2020-12): 8編集ファイル
  (`cutplan` / `transcript` / `overlays` / `bgm` / `chapters` / `meta` /
  `shorts` / `thumbnail`)それぞれに1スキーマ + 共有 `$defs`
  (`schemas/common.schema.json`。`Region` / `CaptionPos` / `CaptionStyle` 系 /
  `WordTiming` / `Annotation` union / `CaptionTrackDef` / `id` パターン /
  `Interval`)。`schemas/apply-patch.schema.json` は `apply` コマンドの入力形
  (`ApplyPatch` / `EditOp`)。各スキーマの kitchen-sink 例は
  `schemas/examples/<file>.max.json`(全任意フィールドを1つ以上使う。
  ドキュメント兼・構造ドリフト検知の fixture)。
  - **ファイル自体には `$schema` キーを注入しない**(収録フォルダの JSON は
    このスキーマ導入前とバイト等価。ユーザーデータ不可侵)。エディタ/
    バリデータ側の設定で `<file>.json` ↔ `schemas/<file>.schema.json` の
    命名規約に紐づける。
  - 外部バリデータ(例: `ajv-cli`)で実収録フォルダの JSON を検証したい場合、
    `--schema schemas/<file>.schema.json` に加えて `schemas/common.schema.json`
    を(`$ref` 解決のため)一緒に読み込ませる。
  - `schemas/assertions.schema.json` は8編集ファイルには含まれない
    (`assertions.json` は「other」カテゴリの宣言ファイル。上の
    「編集後の意図検査(assert)」参照)。`test/schema.test.ts` の全単射
    テストは `common.schema.json` / `apply-patch.schema.json` と同様に
    これを除外している。
- **`AGENTS_CONTRACT.md`**(リポジトリ直下・英語・Claude 非依存): 能力・不変条件・
  承認境界・触ってよい/いけないファイル・`@id` アドレッシング・主要コマンドを
  宣言する emerging standard のエージェント向けマニフェスト。CLAUDE.md との
  役割分担は「AGENTS_CONTRACT.md=契約(何が編集可能か・不変条件・コマンド)の正、
  CLAUDE.md=Claude Code 向けの運用ニュアンス」。

依存追加はゼロ(ajv 等の runtime 依存は足していない)。`test/helpers/jsonSchema.ts`
はテスト専用の vendored な JSON Schema 部分集合バリデータ(`$ref` / `$defs` /
`type` / `required` / `properties` / `additionalProperties` / `enum` /
`const` / `pattern` / `items` / `oneOf` / `minimum` / `maximum` / `minItems`)。


