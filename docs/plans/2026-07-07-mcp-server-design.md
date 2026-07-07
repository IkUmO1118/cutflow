# MCP サーバ設計(Next / Theme B「編集 action space + MCP サーバ」)

*2026-07-07 / 設計担当。実装しない。この doc 1本が成果物。*

診断レビュー `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Next 項目
「編集 action space + MCP サーバ」(Theme B / severity blocker / effort L)のうち、
**MCP サーバ**部分を設計する。action space(高水準 `@id` 編集オペレーション)は
`apply <dir>`(`src/lib/applyEdits.ts`)として実装済み。本 doc は cutflow の
**読取+承認スコープ外の安全編集プリミティブを Model Context Protocol の tool として
露出**し、任意の MCP 対応エージェント(Claude Desktop / codex 等)が cutflow を
発見可能・安全に操作できるようにする設計を確定する。診断の主張 #1(BYO-AI)と
#2(video-as-code をオープン標準へ)を同時に前進させる。

この機能は完全に新規追加であり、**既存 CLI・出力・生成物は1バイトも変わらない**
(opt-in。`mcp` コマンドを起動しない限り、cutflow の挙動はこの機能導入前と同一)。

---

## 0. TL;DR(決定の要約)

- **プロトコル実装 → 自前 stdio JSON-RPC 2.0 最小実装を採用**(公式 SDK は足さない)。
  vendored JSON Schema バリデータ(`test/helpers/jsonSchema.ts`)で ajv を退けた
  zero-dep 実績と同じ判断軸。扱うメソッドは `initialize` / `notifications/initialized` /
  `tools/list` / `tools/call` の4種+`ping` のみ。実装量は約250〜350行。
- **露出する tool は「読む」+「承認スコープ外の安全編集」に限定**:
  `cutflow_describe` / `cutflow_validate` / `cutflow_frames`(読取・知覚)、
  `cutflow_apply` / `cutflow_id_stamp`(安全編集)。
  **approve / unapprove / render / plan / remeta / plan-shorts / run / ingest /
  transcribe / detect / preview / thumbnail / editor / learn / frames-serve は
  レジストリに載せない=物理的に呼べない**。
- **サーバは `mcp <dir>` で1収録に束縛**(Option A)。dir は起動時に固定し、
  各 tool は dir 引数を取らない。プロセスは1収録フォルダの外に出られない=
  最も強い信頼境界。config は起動時に `loadConfig(--config)` で1回ロード。
- **エラーは2層**:プロトコル異常(不正 JSON-RPC・未知メソッド・引数欠落)は
  JSON-RPC error オブジェクト(`-32xxx`)。ドメイン結果(validate がエラーを
  検出・apply が検査で拒否)は `tools/call` の成功応答に `isError: true` +
  構造化 `content`(`Problem[]` の JSON をそのまま同梱)で返し、エージェントが
  自己修正できるようにする。
- **tool レジストリは `ToolDef[]` 配列 + name→handler の Map**。F1/F2/F3 の新
  コマンドは「配列に1件 push + handler 1関数 + AGENTS.md に1行」で足せる。
- **信頼モデル宣言**:MCP は cutflow の承認境界(`src/lib/approval.ts` の hash 束縛・
  非対話 `--yes` ゲート)を一切露出しない。承認は人間だけの行為のまま。

---

## 1. 論点1: プロトコル実装 — 公式 SDK vs 自前 stdio JSON-RPC 2.0

### 選択肢

| | 公式 `@modelcontextprotocol/sdk` | 自前 stdio JSON-RPC 2.0 最小実装 |
|---|---|---|
| 依存追加 | ランタイム依存 +1(推移的に zod 等) | **ゼロ**(`node:process` / `node:readline` のみ) |
| 正確さ・追従 | 仕様改訂に公式が追従 | 自分で protocolVersion 文字列を更新 |
| 実装量 | ハンドラだけ書けばよい | フレーミング+ディスパッチ 約250〜350行 |
| 表面積 | SDK 全体(transport 多様・auth・resources 等) | 使う4メソッドだけ |
| 保守負担 | SDK の破壊的変更に追従 | 小さく固定・単体テストで凍結 |

### 判断

cutflow は**依存追加ゼロを強く志向する**プロジェクトであり、`docs/plans/2026-07-07-machine-contract-design.md`
§論点1 で「ajv を足さず、`schemas/` が使うキーワードだけを実装した純関数にする」
という前例を確立している(`test/helpers/jsonSchema.ts`)。現状のランタイム依存は
remotion 一族・react・commander・yaml のみで、いずれも中核機能に不可欠なもの。
MCP のためだけに SDK+zod を足すのは、この設計思想と正面から衝突する。

一方 MCP の stdio 上の要求は**極めて小さい**:

- transport は **改行区切り(newline-delimited)UTF-8 JSON**。各 JSON-RPC メッセージは
  1行(埋め込み改行禁止)。`JSON.stringify`(pretty 無し)は単一行を生むので安全、
  受信は stdin を行バッファリングして `\n` で分割するだけ。LSP 風の `Content-Length`
  ヘッダは不要。
- 必須メソッドは4つだけ(§下記)。resources / prompts / sampling / completion は
  MVP では実装しない(capabilities で宣言しなければクライアントは呼ばない)。

したがって**自前実装を採用する**。これは zero-dep 実績(vendored schema validator)と
完全に一貫し、露出面が小さいためリスクも限定的。SDK の利点(仕様追従)は、
`protocolVersion` 文字列の1行更新と少数メソッドの安定性で十分カバーできる。

> 誠実な但し書き:MCP 仕様が将来 stdio フレーミングや必須メソッドを大きく変えた場合、
> 自前実装は手で追従が要る。緩和策 = (a) `protocolVersion` を1定数に集約、
> (b) メソッドを最小に保つ、(c) `initialize` の往復と各メソッドを単体テストで凍結、
> (d) 露出 tool を「読む+安全編集」に絞り破壊的操作を持たない(万一の互換ずれでも
> 承認・render は最初から範囲外なので事故の上限が低い)。

### 自前実装が扱う JSON-RPC メソッド仕様

改行区切り JSON-RPC 2.0。サーバは**受信専用のレスポンダ**(サーバ発の
リクエストは出さない=sampling 等を使わない)。

| 方向 | メソッド | 種別 | サーバの応答 |
|---|---|---|---|
| C→S | `initialize` | request | `{ protocolVersion, capabilities:{ tools:{} }, serverInfo:{ name:"cutflow", version } }` を result で返す。client の `protocolVersion` を受け、サーバ対応版を返す |
| C→S | `notifications/initialized` | notification | 応答しない(通知には id が無い) |
| C→S | `tools/list` | request | `{ tools: ToolDef[].map(公開形) }`(cursor ページングは不要=全件返す) |
| C→S | `tools/call` | request | `{ content: ContentBlock[], isError?: boolean }` を result で返す |
| C→S | `ping` | request | `{}`(空 result。任意だが安価なので実装) |

- **id 一致**:request の `id` を result/error にそのまま返す。`id` の無いメッセージ=
  notification は応答を返さない。
- **エラーコード**:`-32700` parse error / `-32600` invalid request /
  `-32601` method not found / `-32602` invalid params / `-32603` internal error。
  これらは JSON-RPC error オブジェクトで返す(プロトコル層)。tool のドメイン失敗
  (validate がエラーを検出等)は error では**なく** `tools/call` の成功 result 内の
  `isError:true` で返す(§論点4)。
- **stdout は JSON-RPC 専用**:サーバのログ・診断は**必ず stderr**へ。stdout に
  1バイトでも余計な出力を混ぜると transport が壊れる(§4 の cli.ts postAction 対応)。

---

## 2. 論点2: tool の粒度と一覧 — 「読む」+「安全に編集する」に絞る

### 方針の是非

診断は MCP を「読取+安全編集までに限定」せよと明確に指示している。これは正しい:

- **承認境界(`src/lib/approval.ts`)は人間だけの行為**。approve/unapprove/render を
  tool 化すれば、承認 hash ゲート・非対話 `--yes` ゲートという中核の安全設計を
  MCP が横から無効化できてしまう。**載せない**ことが唯一の確実な防御(§論点6)。
- **plan/remeta/plan-shorts/run は LLM 生成物でユーザの手編集を上書き**する
  (`guardRerun` が `--force` を要求する破壊的コマンド)。MCP 経由で reflex 的に
  呼べてしまうと手編集消失事故を招く。**載せない**。
- **ingest/transcribe/detect** は収録の初期化(whisper/ffmpeg 等の重い外部依存を要し、
  生成物 `manifest.json`/`cuts.auto.json` を作る)。「編集」ではなくパイプラインの
  前段。**載せない**。
- **preview/thumbnail/render** はメディア出力生成(重い・「読む+安全編集」の範囲外)。
  **載せない**(preview は将来 opt-in で検討可)。
- **editor/frames-serve** は常駐サーバ。tool として意味をなさない。**載せない**。

「1コマンド=1 tool」を素直に守るが、**露出集合は意図的に部分集合**にする。この
非対称(全コマンドを機械的に露出しない)こそが安全設計の実体。

### 露出する tool 一覧(MVP)

`mcp <dir>` で dir を起動時固定するため、各 tool は dir 引数を取らない。

| tool name | 種別 | 説明(description に載せる要旨) | inputSchema | 呼ぶ内部関数 |
|---|---|---|---|---|
| `cutflow_describe` | 読取 | 編集状態の機械可読な完全射影(元秒⇔出力秒・全文・`@id` 発見)。JSON を手で読む代わりにこれを使う | `{}`(引数なし) | `describeJson(dir)`(`src/stages/describe.ts`) |
| `cutflow_validate` | 読取 | 編集ファイルの構造・不変条件検査。errors=要修正 / warnings=情報。編集後は必ず通す | `{}` | `validate(dir)`(`src/stages/validate.ts`) |
| `cutflow_frames` | 読取(知覚) | 指定時刻を最終合成の見た目で PNG 出力(`frames/`)。`ocr` で画面内テキスト抽出。書いた PNG/OCR の絶対パスと OCR 要約を返す | `{ t?:string, captions?:bool, every?:number, out?:bool, short?:string, ocr?:bool, fullRes?:bool }`(`t`/`captions`/`every` は排他=handler で検査) | `frames(dir, req, cfg, short, ocr, fullRes)`(`src/stages/frames.ts`) |
| `cutflow_apply` | 安全編集 | `@id` op 列(`set`/`remove`/`add`)/全置換パッチの**検査付きアトミック適用**。全部 valid なら全書込・1つでもエラーなら1バイトも書かない。`approved` は変更不可・`approvals.json` は触らない。`dryRun` で書かず diff だけ | `{ patch: <apply-patch.schema.json>, dryRun?: bool }` | `applyEdits(dir, patch)` / `planApply(dir, patch)`(`src/lib/applyEdits.ts`) |
| `cutflow_id_stamp` | 安全編集 | 各要素に安定 `@id` を一括採番(冪等・既存 id 不変・`approvals.json` 非改変)。`@id` mention の前提を整える | `{}` | `idStamp(dir)`(`src/stages/idStamp.ts`) |

補足:

- **`cutflow_apply` に `dryRun` を畳む**。apply は CLI で1コマンド+`--dry-run` フラグ
  なので、tool でも1 tool + `dryRun` 引数が素直(「1コマンド=1 tool」に整合)。
- **`cutflow_id_stamp` を安全編集として含める理由**:`cutflow_describe` が返す `@id` は
  id 採番済みのときだけ出る(`describe --json` の仕様)。BYO エージェントが既存要素を
  `@id` で指すには id が存在している必要があるため、採番手段を露出しておく。
  id-stamp は冪等・sticky・`approvals.json` 非改変で、apply の新規要素採番
  (`stampNewElements`)と同じ保証。承認境界には触れない。

### inputSchema と `schemas/*.json` の再利用

- `cutflow_apply` の `patch` 引数 = **`schemas/apply-patch.schema.json` をそのまま
  inputSchema に埋め込む**(起動時に `readFileSync` でロードし、tool の
  `inputSchema.properties.patch` に差し込む)。この schema は
  `{ ops?: EditOp[], replace?: {...} }` の構造を固定済み。`$ref`(`cutplan.schema.json`
  等)を含むが、これは discovery/補完のヒントであり、**厳密な検査はサーバ側
  `planApply` が構造化 `Problem[]` として返す**(schema 段の cross-field 検査は
  もともと applyEdits の責務=apply-patch.schema.json の `$comment` 参照)。
  クライアントによる `$ref` 解決可否に依存しない。
- 他 tool の引数は小さいので inputSchema は手書き(`{}` または上表の shape)。
- **重要**:MCP の inputSchema は**引数オブジェクトのスキーマ**(discovery 用)であり、
  cutflow の編集ファイルスキーマそのものではない。編集ファイルの妥当性は
  `validate`/`apply` の実行時検査が正であり、schema は二重化しない
  (§machine-contract-design の思想と一貫:schema は構造ヒント、検査は validate.ts が正)。

---

## 3. 論点3: サーバ起動と対象フォルダ

### 選択肢

- **Option A: `mcp <dir>`** — 1収録に束縛。dir を起動時固定、tool は dir 引数なし。
- **Option B: `mcp`** — dir を毎 tool 呼び出しで受ける。1サーバで複数収録。

### 判断 → Option A(dir 束縛)を採用

理由:

1. **信頼境界が構造的に強い**。プロセスは1収録フォルダ(+その config)の外に
   出られない。dir を tool 引数で受ける Option B は、プロセス権限内の任意パスを
   読み書きできる面を開く(パストラバーサル・別収録の誤操作の余地)。Option A は
   「このサーバはこの収録しか触れない」を**起動構成で保証**する=BYO-AI の
   信頼モデルとして最も明快。
2. **`agentsMd.test.ts` の規約と自然に整合**。同テストは登録コマンド名 `<name>` ごとに
   AGENTS.md が `` `<name> <dir>` `` を含むことを要求する。`mcp <dir>` はこの規約に素直。
3. **config ロードが単純**。起動時 `loadConfig(program.opts().config)` で1回。
   frames が要求する encoder 等の設定もここで確定。
4. **MCP ホストの複数サーバ構成に載る**。Claude Desktop 等は複数 MCP サーバを
   同時登録できるので、複数収録を扱うなら収録ごとにサーバ項目を足せばよい
   (むしろ収録ごとに権限が分離されて安全)。

Option B の利点(1プロセスで複数収録)は、cutflow の「1収録=1フォルダ=1文脈」という
データモデルではメリットが薄く、リスク(パス面の拡大)が上回る。将来どうしても
必要になれば、起動時 `--root <dir>` による配下限定(tool 引数 dir が root 配下で
あることを強制)を足す拡張余地を残す。

### config.yaml のロード経路

- `mcp <dir>` の action で `loadConfig(program.opts().config)` を呼び、`Config` を
  サーバ起動関数へ渡す(`frames-serve`/`editor` と同じ流儀)。
- config はプロセスグローバル(収録ごとではない)。dir 束縛なので1収録=1 config で
  齟齬なし。

---

## 4. 論点4: エラー/検査結果の伝え方

MCP の `tools/call` result は `{ content: ContentBlock[], isError?: boolean }`。
`content` には `{ type:"text", text }` を基本に使う。

### 2層のエラー分離

- **プロトコル層(JSON-RPC error)**:不正 JSON / 未知メソッド / 引数の型欠落 /
  `dir` 不在等、**tool を実行する以前の失敗**。`-32600`〜`-32603` を error で返す。
- **ドメイン層(tool result 内 `isError`)**:tool は正常に走ったが、**編集状態が
  不正 / apply が検査で拒否**等の結果。これは `tools/call` の**成功 result** に
  `isError: true` を立て、`content` に構造化情報を同梱する。MCP の設計意図どおり
  (LLM がその失敗を読んで自己修正できるようにする)。

### tool ごとの result 形

- **`cutflow_validate`**:`isError = (errors.length > 0)`。content =
  (1) 人間可読テキスト(`✖ file where: message` / `⚠ ...` の一覧、CLI と同文面)、
  (2) 機械可読 JSON ブロック(`{ errors: Problem[], warnings: Problem[], summary }`)。
  `Problem` は `validate.ts` の `{ file, where, message }` をそのまま JSON 化。
- **`cutflow_apply`**:
  - `planApply`/`applyEdits` の `plan.errors.length > 0` → `isError: true`、content に
    `Problem[]`(`@id` 未解決・不変条件違反・approved 変更拒否 等)。**1バイトも
    書いていない**旨を明記。
  - 成功 → `isError` 無し、content に `written`(書いたファイル名)+ `diff`
    (`ApplyDiffEntry[]`。`@id`⇔file⇔before/after)+ `backupDir`。`dryRun` 時は
    `changedFiles` + `diff` のみ(書いていない旨)。
- **`cutflow_describe`** / **`cutflow_id_stamp`**:成功前提。describe は
  `DescribeProjection` の JSON を content に(純 JSON ブロック)。id-stamp は
  `changed` ファイル一覧 + 付随する validate 結果。
- **`cutflow_frames`**:content に、書いた PNG の**絶対パス一覧**+各 shot の
  `note`(スナップ・映っているテロップ)+ `--ocr` 時は OCR 要約テキスト。
  ローカルファーストなので MCP ホストは同一マシン上=絶対パスを自分のファイル
  ツールで Read できる(画像を base64 の `image` content で同梱する拡張は将来
  オプション。MVP はパス返却で軽量)。

いずれも**人間可読テキスト + 機械可読 JSON の両方**を content に入れ、Claude 系
(散文も読む)と codex 系(JSON を構造消費)の双方が扱えるようにする。

---

## 5. 論点5: tool レジストリの拡張機構

### 型

```ts
// src/mcp/types.ts(抜粋・実装時に確定)
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
export interface ToolDef {
  name: string;                       // "cutflow_apply" 等(MCP 慣習で snake_case)
  description: string;                // tools/list に出る説明
  inputSchema: JsonSchema;            // 引数オブジェクトのスキーマ(discovery 用)
  handler: (args: unknown) => ToolResult; // 引数を検査し内部関数を呼ぶ
}
```

### レジストリ

- `src/mcp/tools.ts` が **`makeTools(dir: string, cfg: Config): ToolDef[]`** を
  export する。dir/cfg を closure に捕捉した ToolDef 配列を返す(dir 束縛=§論点3)。
- `tools/list` は `TOOLS.map(t => ({ name, description, inputSchema }))`。
- `tools/call` は `new Map(TOOLS.map(t => [t.name, t]))` で name 引きし
  `t.handler(params.arguments)` を呼ぶ。未知 name は JSON-RPC `-32602`(invalid params)。

### 「1コマンド=1 tool を後から足す」パターン

新コマンドを露出するには **ToolDef を1件 push するだけ**:

```ts
// 例: F3「assert <dir>」が実装されたら makeTools に1件足す
{
  name: "cutflow_assert",
  description: "編集後の視覚的アサーションを検査する ...",
  inputSchema: { type: "object", properties: { /* assert の引数 */ } },
  handler: (args) => toToolResult(assertCmd(dir, parseAssertArgs(args))),
}
```

`toToolResult`(内部関数の戻り値 → `ToolResult` への共通アダプタ:
`Problem[]` があれば `isError`、無ければ成功 content)を1つ用意しておけば、
handler は「引数パース + 内部関数呼び出し + アダプタ」の3行で書ける。

### 先行 F1/F2/F3 のための予約スロット(名前・引数は実装時=最後に親が確定)

| 先行機能 | 見込む tool | 種別 | 備考 |
|---|---|---|---|
| F1 音声知覚 | **新 tool 不要の見込み** | 読取 | system transcript / keep 内の間 / 非言語音は `describe --json` の出力フィールドが増える形。`cutflow_describe` の payload が自動で豊かになる(tool 追加ゼロ)。仮に `transcribe` 系の新コマンドが増えても、それは破壊的/重い前段なので**露出しない** |
| F2 素材知覚 | `cutflow_materials` | 読取 | `materials <dir>`(B-roll の中身把握)。読取なので露出対象 |
| F3 自動検証・視覚的アサーション | `cutflow_assert` | 読取(検証) | `assert <dir>`。読取/検証なので露出対象 |

いずれも `makeTools` の配列に1件足す + AGENTS.md §11 に1行足す + docs で触れるだけで
済む。**破壊的・承認系は増えても露出集合に入れない**という §論点2 の方針は不変。

---

## 6. 論点6: セキュリティ / 信頼モデル宣言

### コードで保証すること

1. **承認・render はレジストリに存在しない=物理的に呼べない**。`makeTools` が返す
   配列に approve/unapprove/render/plan/… の handler が**そもそも無い**。`tools/list`
   に出ず、`tools/call` で name を引いても Map に無く `-32602` で拒否。これが唯一
   確実な防御(運用ルールや description の注意書きに頼らない)。
2. **generic な「CLI を実行する」tool を作らない**。handler は特定の内部関数を
   名指しで呼ぶだけ。`node src/cli.ts approve` を Bash 的に叩ける汎用 tool は存在しない。
3. **`cutflow_apply` は `approvals.json` を触れない**。`applyEdits` は
   `APPLY_FILE_NAME` の固定7ファイルにしか書かず、書き込み直前に `fileRole(file)` が
   `"approval"`/`"generated"` なら例外を投げる(`src/lib/applyEdits.ts` §不変条件1・5)。
   さらに `enforceApprovedUnchanged` が `approved` をディスク現状値へ強制し、異なる値の
   指定はエラーで拒否する(§不変条件2)。MCP はこの関数を**そのまま**呼ぶので、
   apply が持つ保証を1つも緩めない。
4. **サーバは1収録フォルダに束縛**(§論点3 Option A)。別収録・リポジトリ本体・
   ホーム配下へ出られない。dir は起動時 `resolveDir`(存在検査)で1回だけ確定。
5. **stdout は JSON-RPC 専用**(§論点1・§7)。`approve` 等が混線する余地もない。

### 信頼モデル宣言(AGENTS.md §11 / docs にも明記する)

> cutflow の MCP サーバが露出するのは **「読む」(describe / validate / frames)** と
> **「承認スコープ外の安全編集」(apply / id-stamp)** だけである。
> **承認(approve / unapprove)・最終出力(render)・LLM 再生成(plan / remeta /
> plan-shorts / run)・収録初期化(ingest / transcribe / detect)は MCP tool として
> 一切露出しない。** 承認は人間だけの行為であり、その実体は `approvals.json` の
> keep 集合 hash に束縛された承認レコード(`src/lib/approval.ts`)である。MCP から
> `approved` を書き換えることも、承認レコードを mint することも、render ゲートを
> 回避することもできない。`cutflow_apply` は `approvals.json` に物理的に書けず、
> `approved` フィールドを変更できない。サーバは起動時に指定された1収録フォルダの
> 外に出られない。

---

## 7. アーキテクチャ(ファイル構成)

すべて新規追加(`src/mcp/`)+ `src/cli.ts` に1コマンド配線。既存ファイルは
cli.ts の postAction ハンドラ以外**無改変**。

```
src/mcp/
  types.ts       # JSON-RPC / ToolDef / ToolResult の型(fs 非依存・純)
  jsonrpc.ts     # JSON-RPC 2.0 フレーミング&ディスパッチ(純関数。I/O なし)
  protocol.ts    # MCP メソッド(initialize / tools/list / tools/call / ping)。
                 #   レジストリを受けて result を組む純ロジック
  tools.ts       # makeTools(dir, cfg): ToolDef[]。内部関数(describeJson/validate/
                 #   applyEdits/planApply/frames/idStamp)を呼ぶ handler と toToolResult
  server.ts      # stdio ループ(実 I/O)。stdin を行分割 → jsonrpc.dispatch →
                 #   stdout へ改行区切りで書く。ログは stderr。SIGINT で終了
src/cli.ts       # `mcp <dir>` コマンドを追加(startMcpServer を動的 import)。
                 #   postAction timing を mcp では stderr へ逃がす
```

### 層の責務(テスト容易性のための分離)

- **`jsonrpc.ts`(純)**:1つの受信メッセージ(パース済み object)+ メソッド
  ハンドラ Map を受け、`{ response | null }` を返す純関数。framing(行の
  parse/stringify)も純関数として分離(`parseLine` / `serializeMessage`)。
  → 単体テストで request→response・各エラーコード・notification 無応答を凍結。
- **`protocol.ts`(純)**:`initialize`/`tools/list`/`tools/call` の result を、
  レジストリ(ToolDef[])を引数に組む純ロジック。fs/プロセス非依存。
  → 単体テストで capabilities・tools/list 網羅・未知 tool の `-32602`・
  `isError` セマンティクスを凍結。
- **`tools.ts`(薄いアダプタ)**:handler は「引数検査 → 内部関数呼び出し →
  `toToolResult`」。内部関数は既に純度が高く単体テスト済みなので、ここは
  配線の正しさ(正しい関数を呼ぶ・結果を正しく content 化する)だけ検査。
- **`server.ts`(I/O)**:唯一の副作用境界。stdin/stdout/stderr と SIGINT。
  → 統合テストで実プロセスを spawn し JSON-RPC を往復。

### stdout 汚染の防止(cli.ts への唯一の改変)

`src/cli.ts` の `postAction` フックは、`describe --json` 以外のコマンドで所要時間を
**stdout** に `console.log` する。`mcp` はサーバであり stdout が JSON-RPC 専用
チャネルなので、**timing 行を stdout に出してはならない**。既存の
`describe && --json` 分岐と同じ形で `mcp` を stderr 側へ加える(1行の条件追加)。
サーバは通常 SIGINT まで返らないので postAction は多くの場合発火しないが、
安全のため明示的に逃がす。これが cli.ts への唯一の挙動変更で、他コマンドの
stdout はバイト不変。

---

## 8. ドキュメント波及(5点セット判定)

本機能は**スキーマ変更でも編集/生成ファイル分類の変更でもない**(新しい編集
ファイルも生成物も増えない。MCP は既存の内部関数を露出するだけ)。したがって
**5点セットのうち `src/types.ts` / `src/stages/validate.ts` / `schemas/*.schema.json`
は触らない**。波及は「CLI コマンドが1つ増える」ことに閉じる:

| ファイル | 変更 | 理由 / テスト |
|---|---|---|
| `src/cli.ts` | `mcp <dir>` コマンド追加 + postAction stderr 対応 | 実配線 |
| `AGENTS.md` | §10 コマンド表に `` `mcp <dir>` `` を1行追加。加えて **§11「MCP tools」新設**(露出 tool 一覧 + §6 の信頼モデル宣言)。BYO-AI の契約面なので AGENTS.md が正しい載せ先 | `test/agentsMd.test.ts` が全登録コマンド名を要求(§下記の落とし穴) |
| `CLAUDE.md` | コマンド一覧(日本語)に `mcp` を追記。「MCP は読む+安全編集だけ・承認/render は露出しない」の運用ニュアンス | 日本語運用 doc |
| `docs/usage.md` | 「MCP サーバ(`mcp`)」節を新設(起動法・ホスト設定例・露出 tool・信頼モデル) | 使い方 doc |

**落とし穴(実装時に必ず踏む)**:`test/agentsMd.test.ts` の
「コマンド表が CLI 登録の全コマンド名を過不足なく含む」テストは、`src/cli.ts` の
`.command("mcp ...")` を検出したら AGENTS.md に文字列 `` `mcp <dir>` `` があることを
要求する。**cli.ts に `mcp` を足したコミットと同じコミットで AGENTS.md を更新**
しないと `npm test` が落ちる(T4 と T5 の順序に注意、または1コミットに束ねる)。

MCP は Claude 非依存で書くこと(`test/agentsMd.test.ts` は AGENTS.md に
`claude -p` / `Claude Code` の混入を禁止)。tool 説明・信頼モデルは backend 非依存の
英語で書く。

---

## 9. タスク分解(1タスク=1コミット)

各タスクに (a) 触るファイル (b) テスト方針 (c) 壊してはいけない既存挙動。

### T1: JSON-RPC 2.0 コア(純)

- **(a) 触る**: `src/mcp/types.ts`(新), `src/mcp/jsonrpc.ts`(新),
  `test/mcpJsonrpc.test.ts`(新)。
- 内容: `parseLine`(1行→JSON-RPC message or parse error)、`serializeMessage`
  (message→1行、埋め込み改行が出ないことを保証)、`dispatch(message, handlers)`
  (id 付与・notification 無応答・未知メソッド `-32601`・handler 例外→`-32603`)。
  型定義(Request/Response/Error/Notification)。
- **(b) テスト**: 正常 request→response の id 一致 / parse error `-32700` /
  invalid request `-32600` / method not found `-32601` / handler throw→`-32603` /
  notification(id 無し)は `null`(無応答)/ serialize が単一行。
- **(c) 壊さない**: 新規ファイルのみ。既存挙動への影響ゼロ。

### T2: MCP メソッド + レジストリ型(純)

- **(a) 触る**: `src/mcp/protocol.ts`(新), `src/mcp/types.ts`(`ToolDef`/`ToolResult`
  追記), `test/mcpProtocol.test.ts`(新)。
- 内容: `initialize`(protocolVersion / capabilities `{tools:{}}` / serverInfo)、
  `tools/list`(ToolDef[]→公開形)、`tools/call`(name 引き→handler、未知は
  `-32602`)、`ping`。`ToolDef[]` を引数で受ける(この時点ではダミー/空でも可)。
- **(b) テスト**: initialize の result 形 / tools/list が渡した ToolDef を網羅 /
  tools/call が正しい handler を呼ぶ / 未知 tool name→`-32602` / handler が
  `isError` を立てた result をそのまま透過。
- **(c) 壊さない**: 新規ファイルのみ。

### T3: tool handler(内部関数のアダプタ)

- **(a) 触る**: `src/mcp/tools.ts`(新), `test/mcpTools.test.ts`(新)。
- 内容: `makeTools(dir, cfg): ToolDef[]` = `cutflow_describe` / `cutflow_validate` /
  `cutflow_frames` / `cutflow_apply` / `cutflow_id_stamp`。`toToolResult` アダプタ
  (`Problem[]`→isError、成功→content)。`cutflow_apply` の inputSchema に
  `schemas/apply-patch.schema.json` をロードして差し込む。frames 引数の
  `t`/`captions`/`every` 排他検査(CLI と同ルール)。
- **(b) テスト**: `test/fixtures` の収録に対し `makeTools` を作り各 tool を呼ぶ。
  describe→`DescribeProjection` が返る / validate エラー収録→`isError:true`+
  `Problem[]` / apply(dryRun)→書かず diff / apply(実行・不正パッチ)→
  `isError`・ディスク不変 / id-stamp→冪等。**approve 系 tool が配列に無いこと**を
  明示的に assert(レジストリからの欠落を凍結)。
- **(c) 壊さない**: `applyEdits`/`planApply`/`validate`/`describeJson`/`frames`/`idStamp`
  は**呼ぶだけ・無改変**。シグネチャを変えない。

### T4: stdio サーバ + CLI 配線

- **(a) 触る**: `src/mcp/server.ts`(新), `src/cli.ts`(`mcp <dir>` 追加・
  postAction stderr 対応), `test/mcpServer.test.ts`(新・統合)。
- 内容: `startMcpServer(dir, cfg)` = stdin を行バッファリング→`dispatch`→stdout へ
  改行区切り書き込み、ログは stderr、SIGINT で終了。cli.ts は `editor` と同様
  **動的 import**(`await import("./mcp/server.ts")`)で MCP コードを他コマンド
  起動時に読ませない。postAction の timing を `mcp` では stderr へ(既存
  `describe --json` 分岐に `|| name==="mcp"` 相当を追加)。
- **(b) テスト**: `node src/cli.ts mcp <fixtureDir>` を spawn し、stdin へ
  `initialize`→`notifications/initialized`→`tools/list`→`tools/call`(describe /
  validate)を書き、stdout の改行区切り応答を parse して検証(往復)。stdout に
  JSON-RPC 以外が混ざらないことを assert(timing 行が来ない)。
- **(c) 壊さない**: **他の全 CLI コマンドの stdout は不変**(postAction は `mcp` と
  `describe --json` のみ stderr、他は従来どおり stdout)。動的 import なので
  `mcp` 未起動時は MCP モジュールをロードしない=起動コスト/挙動不変。

### T5: ドキュメント + 契約(T4 と同一 or 直後のコミット)

- **(a) 触る**: `AGENTS.md`(§10 に `mcp <dir>`、§11「MCP tools」新設),
  `CLAUDE.md`(コマンド一覧・運用ニュアンス), `docs/usage.md`(MCP 節)。
- **(b) テスト**: `test/agentsMd.test.ts` が緑(`mcp <dir>` 追加で通る・Claude 固有語
  混入なし)。`test/schema.test.ts` は schema 無変更なので不動。
- **(c) 壊さない**: schema/types/validate は触らない(5点セットのうち3点は不変)。
  **T4 で cli.ts に `mcp` を足すなら、agentsMd.test を割らないため T5 を同じ
  コミットに束ねるか、T4→T5 を連続で入れる**(§8 の落とし穴)。

### T6(予約枠・F1/F2/F3 実装時に着手): tool を1件足す

- **(a) 触る**: `src/mcp/tools.ts`(`makeTools` に ToolDef を1件 push +
  handler 1関数), `AGENTS.md` §11(1行), `docs/usage.md`(1行),
  `test/mcpTools.test.ts`(その tool の往復1ケース)。
- 内容: F2 `cutflow_materials` / F3 `cutflow_assert` を、それぞれの CLI コマンド
  (`materials`/`assert`)が実装され次第、上記「§論点5 の追加パターン」で露出。
  F1(音声知覚)は `cutflow_describe` の payload が増えるだけで**新 tool 不要**の
  見込み(実装時に親が確定)。
- **(c) 壊さない**: 既存 tool・レジストリ機構は不変。破壊的/承認系は露出しない方針を維持。

### 実装順序

`T1 → T2 → T3 → T4(+T5 同梱) → 以後 T6`。T1〜T3 は純関数で fs/プロセス非依存の
ため先に固め、T4 で初めて I/O 境界を足す。T5 は T4 と束ねて agentsMd ドリフト
テストを割らない。

---

## 10. 未解決・実装時に親が確定する点

- **`protocolVersion` の具体値**:実装時点の MCP 最新安定リビジョン文字列を1定数に
  置く(client の要求版と非互換なら自サーバ対応版を返す)。
- **frames の画像返却形**:MVP は絶対パス返却。`image` content(base64)同梱は
  ペイロード肥大とのトレードオフで将来 opt-in。
- **`--root` 配下限定**:Option A(dir 束縛)では不要。将来 Option B を足す場合の拡張枠。
- **F1/F2/F3 の tool 名・引数**:本ロードマップで F4(MCP)は最後に実装されるため、
  先行機能の CLI が確定してから §論点5 のパターンで露出する。
