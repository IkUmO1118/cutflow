# AI / エージェント連携のセットアップ

> AI プロバイダ設定・MCP サーバ・GUI の AI 提案/検索など、外部 AI との接続。
> 関連: [safe-editing.md](safe-editing.md) / [command-reference.md](command-reference.md) / [tools-and-ops.md](tools-and-ops.md) / [../usage.md](../usage.md)

## AI provider 設定

AI は未設定でも deterministic な CLI / editor / render は動く。AI を使うときは
`config.yaml` の `ai:` で provider を設定する。旧形式の
`ai.provider` / `ai.model` と `llm.backend` はそのまま動くが、**新規設定は
profiles + routes を推奨**する。

```yaml
ai:
  profiles:
    local:
      adapter: openai-compatible
      protocol: chat-completions
      baseUrl: http://127.0.0.1:11434/v1
      model: qwen-local
      auth: { type: none }
      capabilities:
        structuredOutput: json-object
        imageInput: false

    cloud-vision:
      adapter: openai
      model: gpt-5.4-mini

  routes:
    text: local
    structured: local
    vision: cloud-vision
```

- `text`: 自由文生成
- `structured`: plan / remeta / plan-shorts / plan-materials / plan-effects / plan-bgm / editor AI 提案の schema 付き出力
- `vision`: still 比較の VLM review

組み込み adapter:

| adapter | text | structured | image | 備考 |
|---|---|---|---|---|
| `claude-code` | yes | native schema | no | `claude` CLI |
| `codex` | yes | prompt | no | `codex exec` |
| `openai` | yes | native schema | yes | `OPENAI_API_KEY` |
| `anthropic` | yes | native schema(tool) | yes | `ANTHROPIC_API_KEY` |
| `openai-compatible` | yes | explicit | explicit | local / self-hosted 用 |

`openai-compatible` は capability を推測しない。`structuredOutput` と
`imageInput` を明示する。

### AI doctor

接続確認は `ai doctor` で行う。収録フォルダは不要で、`config.yaml` だけを使う。

```sh
node src/cli.ts ai doctor
node src/cli.ts ai doctor --profile local
node src/cli.ts ai doctor --route vision
node src/cli.ts ai doctor --json
```

検査内容:

- config validation
- credential の有無
- text probe
- structured probe
- image probe

`imageInput=false` や `structuredOutput=none` の profile は対応 check を `skip`
する。`ai doctor` は recording JSON や artifact を書かない。

### VLM review と送信先

GUI の「画像もAIに確認させる」は既定 off。次の条件をすべて満たすときだけ使える。

- `editor.aiReview.vlm=true`
- `vision` route がある
- その profile が `imageInput=true`
- credential が揃っている

送るのは **縮小 still のみ**。raw 動画、raw 音声、full-res still、recording path、
`.env`、approval record は送らない。送信枚数は 2 または 4 枚に正規化される。
before/after のペアは崩さない。

### 失敗ポリシー

- plan / remeta / plan-shorts / plan-materials / plan-effects / plan-bgm / editor AI 提案: provider failure はその操作の error。
  editable JSON は変えない。
- VLM review: optional lane。失敗しても deterministic review bundle は成功させ、
  warning として表示する。
- provider 間の自動 fallback はしない。local failure で勝手に cloud へ送らない。

### Privacy / secret

- API key は `config.yaml` に書かず、環境変数名だけを使う
- browser / log / artifact に key 値は出さない
- custom endpoint は `https` または loopback `http` だけ許可
- redirect は拒否し、response size は上限付きで読む

id が付いた配列は要素/フィールド単位でレビューできる。id が無い配列は
安全のため配列まるごと1 hunk として扱う。`approved` はレビュー対象外で、
承認の実体は引き続き `approvals.json` と approve/unapprove 経路が担う。


## MCP サーバ(`mcp`)

`AGENTS_CONTRACT.md`(機械可読契約)を JSON ファイルの読み書き規約として公開するのに
加え、`node src/cli.ts mcp <dir>` は同じ契約を [Model Context Protocol](https://modelcontextprotocol.io/)
の tool として露出する。Claude Desktop・codex 等、任意の MCP 対応ホストが
この収録フォルダを発見・操作できるようになる(`docs/plans/2026-07-07-mcp-server-design.md`
設計)。依存追加はゼロ(公式 SDK は使わず、`node:readline`/`node:process` だけの
自前 stdio JSON-RPC 2.0 最小実装。schema バリデータを自前実装した前例と同じ
判断軸)。

### 起動方法

```sh
node src/cli.ts mcp <dir>
```

起動すると1つの収録フォルダ `<dir>` に**束縛**される(dir は起動時に固定、
各 tool は dir 引数を取らない)。プロセスはこのフォルダの外に読み書きできない。
標準入出力で改行区切りの JSON-RPC 2.0 をやり取りする(`initialize` /
`notifications/initialized` / `tools/list` / `tools/call` / `ping`)。ログ・
診断は標準エラーへ出す(標準出力は JSON-RPC 専用チャネル)。終了は Ctrl+C。

### ホストへの登録例

**収録フォルダごとに1エントリ**を追加する(dir 束縛の設計上、複数の収録を
1サーバで扱うことはしない)。3つのホストで **`command`/`args` は完全に同じ**で、
置き場所(設定ファイル)だけが違う。

- `<REPO>` = CutFlow を clone した**絶対パス**(例: `/Users/you/dev/cutflow`)。
- `<REC>` = 対象の収録フォルダの**絶対パス**(例: `/Users/you/Movies/cutflow/2026-07-02-xxx`)。
  **相対パスは不可**(ホストの作業ディレクトリ次第で解決に失敗する)。

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cutflow-2026-07-02-xxx": {
      "command": "node",
      "args": ["<REPO>/src/cli.ts", "mcp", "<REC>"]
    }
  }
}
```

**Claude Code** — プロジェクト直下の `.mcp.json`(上と同じ `mcpServers` 形式)、
または CLI 一発:

```sh
claude mcp add cutflow -- node <REPO>/src/cli.ts mcp <REC>
```

**Cursor** — `.cursor/mcp.json`(同じ `mcpServers` 形式):

```json
{
  "mcpServers": {
    "cutflow": {
      "command": "node",
      "args": ["<REPO>/src/cli.ts", "mcp", "<REC>"]
    }
  }
}
```

> **Node のバージョンに注意**: CutFlow はビルド無しで TS を直接実行する
> (Node **23.6 以上**の type-stripping)。ホストが PATH 上の古い node を拾うと
> TS 構文エラーで即死する。`node --version` が 23.6 未満なら、`command` に
> 23.6+ の node バイナリの**絶対パス**(例: nvm の `~/.nvmrc` 相当)を書く。
> `cwd` 設定は不要(スキーマ等は実行ファイル位置から解決する)。

### 露出する tool

「読む」+「承認スコープ外の安全編集」に限定している(AGENTS_CONTRACT.md §11 が正の
一覧・信頼モデル宣言):

| tool | 種別 | 対応する CLI |
|---|---|---|
| `cutflow_describe` | 読取 | `describe <dir> --json` |
| `cutflow_validate` | 読取 | `validate <dir>` |
| `cutflow_frames` | 読取(知覚) | `frames <dir>` |
| `cutflow_materials` | 読取 | `materials <dir>` |
| `cutflow_av` | 読取 | `av <dir>` |
| `cutflow_assert` | 読取(検証) | `assert <dir>` |
| `cutflow_apply` | 安全編集 | `apply <dir>`(`dryRun` 引数で `--dry-run` 相当) |
| `cutflow_id_stamp` | 安全編集 | `id-stamp <dir>` |

`approve` / `unapprove` / `render` / `plan` / `remeta` / `plan-shorts` /
`plan-materials` / `plan-effects` / `plan-bgm` / `run` / `ingest` / `transcribe` / `detect` / `preview` / `thumbnail` /
`editor` / `frames-serve` / `learn` は**レジストリに存在せず、tool として
一切呼べない**(汎用の「CLI を実行する」tool も無い)。承認は人間だけの
行為であり、その実体は `approvals.json` の keep 集合ハッシュに束縛された
承認レコード(「承認の実体」節参照)。`cutflow_apply` は `apply <dir>` と同じ
`applyEdits`/`planApply` をそのまま呼ぶので、`approvals.json` 非改変・
`approved` 変更不可の保証を一切緩めない。

ドメイン層の失敗(`validate` がエラーを検出・`apply` が検査で拒否)は
JSON-RPC エラーではなく `tools/call` の成功 result に `isError: true` +
構造化 JSON として返る(呼び出し側のエージェントが読んで自己修正できる
ように)。不正な JSON-RPC・未知メソッド・未知 tool 名・引数の型違反は
標準の JSON-RPC エラーコード(`-32700`〜`-32603`)で返る。

### 承認境界を deny テンプレで固める(`.claude/settings.json`)

MCP 経由なら承認は **safe by construction** で守られる(上表の露出 tool に
`approve`/`render`/`plan` は無く、`AGENTS_CONTRACT.md` §11 の信頼モデルが正)。
一方で、Claude Code 等が **MCP を介さず収録フォルダの JSON を直接 Write/Bash**
できる場合は、`承認レコード(approvals.json)を自分で書く`・`approve --yes を
強行する` といった意図的バイパスをコードだけでは塞げない。これを塞ぐ層が
Claude Code の権限設定(deny ルール)で、SD-A5 はそれを**ターンキーの実ファイル**
として同梱する:

```sh
cp docs/examples/claude-settings-deny.json <あなたのプロジェクト>/.claude/settings.json
```

`<あなたのプロジェクト>` は Claude Code が project ルートとみなす場所(CutFlow
リポジトリ直下、または収録フォルダ直下のどちらでもよい。deny グロブは `**/` 前置
なので階層を問わず収録フォルダ内の `approvals.json` に一致する)。テンプレの中身:

```json
{
  "permissions": {
    "deny": [
      "Write(**/approvals.json)",
      "Edit(**/approvals.json)",
      "Bash(node src/cli.ts approve*)"
    ]
  }
}
```

- **load-bearing(本質)は上の3行**。`Write/Edit(**/approvals.json)` が承認
  レコードの物理的な書き込みを止める(母艦 §2 原則4・CLAUDE.md「権限設定」)。
  `Bash(node src/cli.ts approve*)` は `approve --yes` の反射実行を止める
  best-effort(コマンドの綴り替えで回避され得るので belt 扱い)。
- 同梱ファイル(`docs/examples/claude-settings-deny.json`)には、これに加えて
  **中間生成物/キャッシュへの誤書き込み**を防ぐ belt グロブ(`manifest.json` /
  `*.key.json` / `*.raw.txt` / `frames/**` / `render.chunks/**` / `*.probe/**`
  ほか)も入っている。これらは `src/lib/files.ts` の `GENERATED_FILES` /
  `GENERATED_NAME_PATTERNS` / `GENERATED_DIRS` から派生した一覧で、`files.ts` が
  分類の**単一の出所**(母艦 §2 原則5)。`files.ts` を変えたらこのテンプレも追随
  させる。belt が未網羅でも承認境界(load-bearing)は変わらない。
- deny グロブは**編集ファイル**(`cutplan.json` / `chapters.json` / `meta.json` /
  `transcript.json` / `overlays.json`)には一切当たらない(`transcript.system.json`
  は別名の生成物)。= 「cut は編集させるが承認は書かせない」を表現する。


## AI提案の比較・高水準編集・ローカル検索

GUIのAI提案では、保存前にbefore/after still、任意の30秒以内のclip、
structure/motion/sound/OCRの決定論的checkを生成できる。画像対応API providerを
使う場合だけ、次を明示設定したうえで比較画面のチェックボックスを有効にすると、
最大4枚を長辺1600px以下へ縮小して外部APIへ送る。既定はoffで、VLMの失敗は
保存や決定論的reviewを失敗させない。

```yaml
editor:
  aiReview:
    vlm: false
    maxImages: 4
```

過去recordingとmaterialは外部APIなしで索引・検索できる。

```sh
node src/cli.ts index
node src/cli.ts search "ログイン画面" --kind material --json
```

MCPでは`cutflow_review`、`cutflow_edit`、`cutflow_search`を利用できる。
`cutflow_edit`は`dryRun`が必須で、書き込み時も既存の`planApply`検査を通る。
検索はread-onlyで、結果に絶対pathを含めず、他recordingの素材をコピーしない。


