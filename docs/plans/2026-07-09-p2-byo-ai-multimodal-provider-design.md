# P2 BYO-AI / マルチモーダル provider 拡張 実装設計書

*2026-07-09 / 実装担当: gpt-5.4 想定*

対象:

- `docs/reviews/2026-07-06-ai-native-nle-diagnosis-2026-07-08-update.html`
  の P2「BYO-AI / マルチモーダル provider 拡張」
- 現行 `src/lib/llm.ts` の `claude-code` / `codex` / `anthropic` / `openai`
- P1 の限定 VLM review

この文書は、実装者が新しい仕様判断をせずに実装できることを優先する。設定形式、
capability、adapter責務、画像の扱い、認証、network安全性、後方互換、実装順、テストを
正本として固定する。

参照した一次資料:

- [OpenAI API models / capability表示](https://developers.openai.com/api/docs/models)
- [Anthropic vision / Messages API画像入力](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/)

特定のモデル名、価格、context長を本設計へ固定しない。これらは変化するため、
ユーザーが `config.yaml` で明示する。

---

## 0. 結論

現行の単一 `ai.provider` / `ai.model` を後方互換として維持しつつ、次を追加する。

1. 名前付き provider profile
2. 用途別 route: `text` / `structured` / `vision`
3. 固定 adapter registry
4. 明示的 capability
5. OpenAI-compatible Chat Completions endpoint
6. provider共通のtimeout、retry、response上限、sanitized error
7. `ai doctor` による接続・能力検査

設定例:

```yaml
ai:
  profiles:
    local-text:
      adapter: openai-compatible
      protocol: chat-completions
      baseUrl: http://127.0.0.1:11434/v1
      model: qwen-local
      auth:
        type: none
      capabilities:
        structuredOutput: prompt
        imageInput: false

    cloud-vision:
      adapter: openai
      model: your-vision-model
      auth:
        apiKeyEnv: OPENAI_API_KEY

  routes:
    text: local-text
    structured: local-text
    vision: cloud-vision
```

現行設定:

```yaml
ai:
  provider: openai
  model: your-model
```

は内部で `legacy-default` profileと全routeへ解決し、挙動を変えない。

---

## 1. 目的

### 1.1 ユーザー価値

- OpenAI / Anthropic以外のOpenAI互換endpointを使える。
- Ollama、LM Studio、vLLM等のlocal endpointを接続できる。
- text生成はlocal、画像reviewだけcloudのように用途を分けられる。
- providerごとの能力差をUIとCLIで確認できる。
- 画像を送るproviderをユーザーが明示的に選べる。
- provider障害でもdeterministic review結果を失わない。

### 1.2 技術的な目的

- `llm.ts` のprovider分岐とHTTP body生成をadapterへ分離する。
- callerはOpenAI / Anthropic固有形式を知らない。
- text、structured output、image inputを共通requestへ正規化する。
- API key、画像base64、promptをログやartifactへ漏らさない。
- custom endpointのredirectや無制限responseによる事故を防ぐ。
- model名からcapabilityを推測しない。

### 1.3 成功条件

- legacy 4 providerの既存testが同じ挙動で通る。
- OpenAI互換local endpointでtext / structured / visionを構成できる。
- routeごとに別profileを使える。
- capability不足はrequest前に明確なerrorになる。
- VLM off / unsupported / failedでもdeterministic reviewは成功する。
-画像送信先profile名とendpoint originを実行前に確認できる。

---

## 2. 非対象

v1では次を実装しない。

- 任意JavaScript pluginの動的load
- npm packageとしてのprovider plugin
- ユーザー指定shell command adapter
- provider間の自動fallback
- load balancing、round-robin
- streaming UI
- conversation state、thread ID
- function callingによるagent loop
- 音声fileのmodel直接入力
- 動画fileのmodel直接入力
- image generation
- embeddings provider
- realtime API
- OAuth
- browserへAPI keyを渡す処理
- providerから返るpatchの自動適用
- provider/modelの自動ダウンロード
- model名に基づくcapability自動判定
- endpointの自動探索
- cloud providerの料金計算

「マルチモーダル」はv1では**text + image入力、text出力**を意味する。音声は既存transcript /
sound probe、動画はstill / clip probeを一次観測として使い続ける。

---

## 3. 最優先の不変条件

### 3.1 local-first

- AI未設定でもdeterministic CLI、Editor、renderは動く。
- AI provider失敗でeditable JSONを書かない。
- VLM失敗でdeterministic review bundleを捨てない。
- retrieval indexに外部embedding APIを必須化しない。

### 3.2 明示的な外部送信

- vision routeはprofileを明示する。
- VLMは既存どおりconfigとGUIの二重opt-in。
- request直前に送信先originと画像枚数をUIへ表示する。
- text routeからvision routeへ自動fallbackしない。
- local endpoint失敗時にcloudへ自動fallbackしない。

### 3.3 secret

- API keyの値を `config.yaml` に書かない。
- configには環境変数名だけを書く。
- API keyをHTTP response、Editor payload、log、error、artifactへ載せない。
- `.env` 読み込みの現行互換は維持する。
- browserはkeyの有無だけ知り、値を受け取らない。

### 3.4 structured output

- providerがnative JSON schema対応でも、返却JSONをcallerのruntime検査へ通す。
- prompt-only providerの出力を型castだけで信頼しない。
- JSON parse / domain validation失敗時に編集proposalを生成しない。
- markdown code fence除去は許可するが、文章中の最初と最後のbraceを雑に切り出さない。

### 3.5 approval

- providerは `approvals.json` を書かない。
- AI proposalは既存diff review、`planApply` / `applyEdits` を迂回しない。
- VLM結果だけでaccept / reject / approvalを決めない。

### 3.6 後方互換

- `ai.provider` / `ai.model` は読み続ける。
- 旧 `llm.backend` は読み続ける。
- legacy設定しか無い場合のcommand、endpoint、request bodyを変えない。
- `editor.aiReview.vlm` の既定falseを変えない。

---

## 4. 現状と解消する問題

現行 `src/lib/llm.ts` は次を1ファイルで行っている。

- config解決
- provider分岐
- CLI実行
- API key読込
- OpenAI request / response
- Anthropic request / response
- image file読込とbase64化
- structured output変換

問題:

1. provider追加ごとに中央のif chainが増える。
2. 単一providerがtextとvisionを兼ねる。
3. `supportsImageReview` がprovider名だけを見る。
4. model固有capabilityを表せない。
5. custom base URLを指定できない。
6. timeout、retry、response byte上限が無い。
7. OpenAI / Anthropicで重複処理が多い。
8. image labelがadapter inputに無く、画像と文脈の対応が弱い。
9. API error bodyをそのままerrorへ含める。
10. provider healthを実行前に検査できない。

---

## 5. 設定仕様

### 5.1 新旧union

`AiConfig` は次のunionにする。

```ts
export interface LegacyAiConfig {
  provider: AiProvider;
  model?: string;
}

export interface RoutedAiConfig {
  profiles: Record<string, AiProfileConfig>;
  routes: AiRoutesConfig;
  defaults?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxResponseBytes?: number;
  };
}

export type AiConfig = LegacyAiConfig | RoutedAiConfig;
```

同じ `ai` blockで `provider` と `profiles` を併記した場合はconfig error。暗黙の優先順位を作らない。

### 5.2 profile名

```ts
export type AiProfileName = string;
```

runtime規則:

- regex: `^[a-z][a-z0-9-]{0,31}$`
- 予約名: `legacy-default`
- 最大16 profiles
- 大文字、underscore、spaceは禁止

### 5.3 adapter

```ts
export type AiAdapterKind =
  | "claude-code"
  | "codex"
  | "openai"
  | "anthropic"
  | "openai-compatible";
```

任意文字列adapterは許可しない。動的code loadもしない。

### 5.4 profile

```ts
export interface AiProfileConfig {
  adapter: AiAdapterKind;
  model?: string;
  /** openai-compatibleだけで使用 */
  protocol?: "chat-completions" | "responses";
  /** openai-compatibleだけで使用 */
  baseUrl?: string;
  auth?: AiAuthConfig;
  capabilities?: AiCapabilitiesConfig;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
}

export type AiAuthConfig =
  | { type: "none" }
  | { type: "bearer"; apiKeyEnv: string }
  | { type: "x-api-key"; apiKeyEnv: string };

export interface AiCapabilitiesConfig {
  structuredOutput?: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput?: boolean;
  maxImages?: number;
}
```

### 5.5 route

```ts
export interface AiRoutesConfig {
  text: string;
  structured: string;
  vision?: string;
}

export type AiRoute = "text" | "structured" | "vision";
```

用途:

| Route | caller |
|---|---|
| `text` | plain `complete`、自由文生成 |
| `structured` | plan、plan-shorts、Editor AI proposal等schema付き出力 |
| `vision` | VLM still review |

`vision`省略時はvision unsupported。`structured`を暗黙fallbackに使わない。

### 5.6 built-in profile defaults

| adapter | endpoint/protocol | auth default | structured default | image default |
|---|---|---|---|---|
| claude-code | CLI | none | native-json-schema | false |
| codex | CLI | none | prompt | false |
| openai | Responses | bearer `OPENAI_API_KEY` | native-json-schema | true |
| anthropic | Messages | x-api-key `ANTHROPIC_API_KEY` | native-json-schema相当(tool) | true |
| openai-compatible | config必須 | config必須 | **none** | **false** |

custom endpointのcapabilityは推測しない。`openai-compatible` は
`capabilities.structuredOutput` と `imageInput` を明示必須にする。

### 5.7 limits

既定:

```ts
export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_AI_MAX_RETRIES = 1;
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 8192;
export const MAX_AI_IMAGES = 4;
export const MAX_AI_IMAGE_BYTES_TOTAL = 12 * 1024 * 1024;
```

config範囲:

- timeout: 1,000〜300,000ms
- retries: 0〜2
- response: 1KB〜8MB
- output tokens: 64〜131,072
- maxImages: 1〜4

### 5.8 設定例

OpenAI:

```yaml
ai:
  profiles:
    main:
      adapter: openai
      model: your-model
    vision:
      adapter: openai
      model: your-vision-model
  routes:
    text: main
    structured: main
    vision: vision
```

Anthropic:

```yaml
ai:
  profiles:
    main:
      adapter: anthropic
      model: your-model
  routes:
    text: main
    structured: main
    vision: main
```

local OpenAI-compatible:

```yaml
ai:
  profiles:
    local:
      adapter: openai-compatible
      protocol: chat-completions
      baseUrl: http://127.0.0.1:8000/v1
      model: local-model
      auth:
        type: none
      capabilities:
        structuredOutput: prompt
        imageInput: false
  routes:
    text: local
    structured: local
```

local text + cloud vision:

```yaml
ai:
  profiles:
    local:
      adapter: openai-compatible
      protocol: chat-completions
      baseUrl: http://127.0.0.1:11434/v1
      model: local-model
      auth:
        type: none
      capabilities:
        structuredOutput: json-object
        imageInput: false
    vision:
      adapter: anthropic
      model: your-vision-model
  routes:
    text: local
    structured: local
    vision: vision
```

---

## 6. 解決済みruntime設定

### 6.1 型

```ts
export interface ResolvedAiProfile {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  protocol: "cli" | "responses" | "messages" | "chat-completions";
  baseUrl?: string;
  auth: AiAuthConfig;
  capabilities: {
    textInput: true;
    textOutput: true;
    structuredOutput: "native-json-schema" | "json-object" | "prompt" | "none";
    imageInput: boolean;
    maxImages: number;
  };
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
}

export interface ResolvedAiConfig {
  profiles: ReadonlyMap<string, ResolvedAiProfile>;
  routes: {
    text: string;
    structured: string;
    vision?: string;
  };
  source: "routed" | "legacy-ai" | "legacy-llm" | "default";
}
```

### 6.2 resolver

```ts
export function resolveAiRuntimeConfig(cfg: Config): ResolvedAiConfig;
export function profileForRoute(
  runtime: ResolvedAiConfig,
  route: AiRoute,
): ResolvedAiProfile;
```

`resolveAiCfg` は互換wrapperとして残す。

```ts
export function resolveAiCfg(cfg: Config): Required<LegacyAiConfig> {
  const runtime = resolveAiRuntimeConfig(cfg);
  const profile = profileForRoute(runtime, "text");
  return {
    provider: legacyProviderName(profile),
    model: profile.model,
  };
}
```

新コードは `resolveAiCfg` を使わない。

### 6.3 legacy変換

`ai.provider`:

- profile名 `legacy-default`
- adapter = provider
- routes text / structured = legacy-default
- openai / anthropicだけvision = legacy-default
- model = `ai.model ?? "auto"`

旧 `llm`:

- `claude-cli` -> claude-code
- `api` -> anthropic
- 同じlegacy-default

何も無い:

- claude-code / auto
- textとstructured routeのみ
- vision無し

---

## 7. capability

### 7.1 API

```ts
export interface AiCapabilities {
  textInput: boolean;
  textOutput: boolean;
  structuredOutput: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput: boolean;
  maxImages: number;
}

export function aiCapabilities(
  cfg: Config,
  route: AiRoute,
): AiCapabilities | null;
```

route未設定はnull。

### 7.2 `supportsImageReview`

provider名判定を削除する。

```ts
export function supportsImageReview(cfg: Config): boolean {
  const caps = aiCapabilities(cfg, "vision");
  return caps?.imageInput === true;
}
```

### 7.3 model能力を推測しない

built-in adapterが画像形式を実装できることと、選択modelが画像を理解できることは別である。

- built-in openai / anthropicはadapter capabilityをtrueにする。
- 実model非対応は`ai doctor`または実request errorで検出する。
- model名prefix tableをコードへ持たない。
- custom profileはユーザーが明示する。

### 7.4 capability不足

request前に次のerror:

```text
AI route "vision" は未設定です
AI profile "local" は imageInput=false です
AI profile "local" は structuredOutput=none です
```

model API errorに到達させてから判定しない。

---

## 8. provider-neutral request

### 8.1 content

```ts
export interface AiTextPart {
  type: "text";
  text: string;
}

export interface AiImagePart {
  type: "image";
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  label: string;
}

export type AiInputPart = AiTextPart | AiImagePart;

export interface AiRequest {
  route: AiRoute;
  parts: AiInputPart[];
  output?: {
    kind: "text";
  } | {
    kind: "json-schema";
    format: JsonSchemaTextFormat;
  };
  maxOutputTokens?: number;
  purpose: "plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other";
}

export interface AiResponse {
  text: string;
  profile: string;
  adapter: AiAdapterKind;
  model: string;
  requestId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

### 8.2 public API

```ts
export async function completeAi(
  req: AiRequest,
  cfg: Config,
): Promise<AiResponse>;
```

既存wrapper:

```ts
complete(prompt, cfg)
completeWithJsonSchema(prompt, cfg, format)
completeImageReview(prompt, files, cfg, format)
```

は `completeAi` を呼ぶだけにする。既存call siteは段階的に移行できる。

### 8.3 image label

labelをpromptへ明示的に挿入する。

```text
[image 0: before source=12.00 output=8.20 reason=selection-start]
[image 1: after source=12.00 output=8.20 reason=selection-start]
```

adapterは画像partの直前にlabel text partを置く。file名や絶対pathは送らない。

### 8.4 input上限

`completeAi` のadapter前検査:

- parts最大32
- text合計最大2,000,000文字
- image数はprofile maxImages以下かつ4以下
- imageはregular file
- media typeはextensionだけで決めずmagic bytes確認
- image1枚最大8MB
- total最大12MB
- recording root外fileも内部生成tempなら許可するため、許可rootをrequestに持たせず、
  callerが生成したfileだけを渡す現行責務を維持

VLM reviewは既存どおり長辺1600px以下へ縮小してから渡す。

---

## 9. adapter interface

### 9.1 interface

新規 `src/lib/ai/types.ts`:

```ts
export interface AiAdapter {
  readonly kind: AiAdapterKind;
  complete(
    request: AiRequest,
    profile: ResolvedAiProfile,
    context: AiAdapterContext,
  ): Promise<AiResponse>;
}

export interface AiAdapterContext {
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  readFile: (path: string) => Buffer;
  run: typeof run;
}
```

testでfetch / read / runを注入する。global monkey patchを新testで増やさない。

### 9.2 registry

新規 `src/lib/ai/registry.ts`:

```ts
const ADAPTERS: Readonly<Record<AiAdapterKind, AiAdapter>> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
  "openai-compatible": openAiCompatibleAdapter,
};

export function adapterFor(kind: AiAdapterKind): AiAdapter;
```

configからmodule pathを受け取らない。

### 9.3 推奨file構成

```text
src/lib/ai/
  types.ts
  config.ts
  registry.ts
  client.ts
  http.ts
  images.ts
  structured.ts
  adapters/
    claudeCode.ts
    codex.ts
    openai.ts
    anthropic.ts
    openaiCompatible.ts
```

`src/lib/llm.ts` はcompatibility facadeだけに縮小する。

---

## 10. built-in adapter

### 10.1 Claude Code

現行commandを維持。

text:

```text
claude -p --output-format text [--model MODEL]
```

structured:

```text
claude -p --output-format text --json-schema SCHEMA [--model MODEL]
```

image:

- v1 unsupported
- CLIの将来機能を推測しない

### 10.2 Codex

現行commandを維持。

```text
codex exec --sandbox read-only [--model MODEL] -
```

- text対応
- structuredは`prompt` mode
- imageはunsupported
- cutflow recordingへwrite権限を渡さない

### 10.3 OpenAI

- endpoint固定: `https://api.openai.com/v1/responses`
- auth: bearer
- model明示必須
- text / structured / image
- structuredはResponses APIのJSON schema形式
- imageはdata URL

request bodyは現行を基準にする。

```ts
{
  model,
  input: [{
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: dataUrl }
    ]
  }],
  max_output_tokens,
  text: {
    format: {
      type: "json_schema",
      name,
      strict,
      schema
    }
  }
}
```

text-onlyでschema無しなら現在の `input: prompt` を維持してもよい。adapter内testで固定する。

### 10.4 Anthropic

- endpoint固定: `https://api.anthropic.com/v1/messages`
- `x-api-key`
- `anthropic-version: 2023-06-01`
- model明示必須
- text / structured / image

structuredは現行どおり強制tool:

```ts
tools: [{
  name: "structured_output",
  description: "...",
  input_schema: schema
}],
tool_choice: { type: "tool", name: "structured_output" }
```

image:

```ts
{
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data
  }
}
```

### 10.5 OpenAI-compatible

protocolで分岐する。

#### Chat Completions

endpoint:

```text
normalize(baseUrl) + "/chat/completions"
```

request:

```ts
{
  model,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "..." },
      { type: "image_url", image_url: { url: dataUrl } }
    ]
  }],
  max_tokens
}
```

text-onlyでは互換性のため `content: string` を使う。

structured:

- native-json-schema:
  `response_format: {type:"json_schema",json_schema:{name,strict,schema}}`
- json-object:
  `response_format: {type:"json_object"}` + prompt末尾にschema
- prompt:
  response_format無し + prompt末尾にschema
- none:
  request前error

response:

```ts
choices[0].message.content
```

contentがstringでなければerror。配列responseの独自拡張を推測しない。

#### Responses

OpenAI built-inと同じrequest shapeをcustom base URLへ送る。
custom serverがResponses APIを完全実装している場合だけ使う。

---

## 11. structured output

### 11.1 schema変換

provider-neutral schemaを正本とする。

- OpenAI系native: `oneOf` -> `anyOf` の既存変換を維持。
- Anthropic tool schema:元schemaをそのまま。
- prompt/json-object:schemaをminified JSONでpromptへ追記。
- callerのschema objectをmutateしない。

### 11.2 prompt fallback

共通suffix:

```text
Return exactly one JSON value matching this schema.
Do not use Markdown fences.
Do not add explanation before or after the JSON.
Schema:
<MINIFIED_SCHEMA>
```

### 11.3 JSON抽出

新規 `src/lib/ai/structured.ts`:

```ts
export function normalizeJsonText(text: string): string;
```

許可:

- 前後whitespace除去
- 全体が単一 ```json ... ``` fenceならfence除去

禁止:

- prose中のbrace substring抽出
- 複数JSONから最初だけ採用
- trailing prose無視
- syntax修復

`JSON.parse`に失敗したらerror。

### 11.4 domain validation

generic AI層はJSON parseまで行い、domain shapeはcallerが既存validatorで検査する。

- Editor proposal -> `parseEditorAiResponse`
- VLM -> `VlmReviewResult` runtime check
- plan / shorts -> 既存parse / validate

将来共通JSON Schema validatorを導入する場合も別PR。provider拡張と依存追加を混ぜない。

---

## 12. image pipeline

### 12.1 ImageInput

```ts
export interface ImageInput {
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  label: string;
}
```

現行 `completeImageReview(prompt, string[])` wrapperはfile名からlabelを生成せず、
caller `runVlmReview` が正しいlabelを渡す新APIへ移行する。

### 12.2 resize

resizeはprovider adapterではなくreview callerの責務。

- 長辺1600px
- aspect維持
- PNG
- OS temp
- finally削除
- original full-resをadapterへ渡さない

adapterはbytesをbase64化するだけ。

### 12.3 labels

`runVlmReview` はstill metadataからlabelを作る。

- before / after
- sourceSec
- outputSec
- reason
- frame index

絶対path、recording folder名、ユーザー名をlabelへ含めない。

### 12.4 順序

before/after pairを保つ。

```text
before t1
after t1
before t2
after t2
```

単純 `flatMap().slice()` でもpair途中で切れないよう、maxImagesを偶数へ丸めるか、
最後のunpaired画像を落とす。既定4、許可2または4。configで1/3を指定した場合は
直前の偶数へ下げ、1はbefore/after比較にならないため2へ上げる。簡潔にするなら
config自体を2または4だけ許可する。**本設計では2または4だけ許可**する。

### 12.5 VLM結果

P1の制約を維持。

- observations only
- pass/fail禁止
- patch禁止
- coordinates禁止
- approval recommendation禁止
- deterministic checks優先
- provider情報は監査用metadataとしてbundleへ追加可能

```ts
vlmProvider?: {
  profile: string;
  adapter: AiAdapterKind;
  model: string;
}
```

base URLやkey env名はartifactへ保存しない。

---

## 13. HTTP共通層

### 13.1 URL検査

新規 `src/lib/ai/http.ts`:

```ts
export function normalizeBaseUrl(value: string): URL;
```

規則:

- URL parse可能
- username/password禁止
- query/hash禁止
- protocolはhttps
- httpはloopback (`127.0.0.0/8`, `::1`, `localhost`)だけ既定許可
- non-loopback httpは拒否
- trailing slash除去
- path prefixは許可(`/v1`等)

LAN上のHTTP server対応は将来 `allowInsecureHttp` を明示追加する。v1で暗黙許可しない。

### 13.2 redirect

```ts
fetch(url, { redirect: "error", ... })
```

Authorization headerが別originへ転送されるのを防ぐ。

### 13.3 timeout

requestごとに `AbortController`。

```ts
const signal = AbortSignal.timeout(profile.timeoutMs);
```

caller signalとの合成が必要なら `AbortSignal.any` を使う。Node対象versionで利用可否を
typecheckし、不可ならmanual controllerを実装する。

### 13.4 retry

retry対象:

- network error
- HTTP 429
- HTTP 502 / 503 / 504

retryしない:

- 400 / 401 / 403 / 404
- schema parse error
- capability error
- timeout
- response size超過

backoff:

```text
attempt 1 -> 500ms
attempt 2 -> 1500ms
```

`Retry-After` が0〜30秒なら優先。最大2 retries。
provider間fallbackはしない。

### 13.5 response byte上限

`Content-Length` が上限超ならbody読込前にerror。
無い場合はstream readerで累積し、上限超でabortする。
`await response.text()` の無制限読込は禁止する。

### 13.6 error

```ts
export class AiProviderError extends Error {
  code:
    | "config"
    | "capability"
    | "auth"
    | "network"
    | "timeout"
    | "rate-limit"
    | "provider"
    | "response-too-large"
    | "invalid-response";
  profile: string;
  adapter: AiAdapterKind;
  status?: number;
  retryable: boolean;
  requestId?: string;
}
```

error messageへ含める:

- profile
- adapter
- status
- provider request ID
- sanitised error summary最大500文字

含めない:

- request body
- prompt
- image data
- authorization
- API key envの値
- full provider response

---

## 14. 認証

### 14.1 key解決

```ts
export function resolveCredential(
  auth: AiAuthConfig,
  env: NodeJS.ProcessEnv,
): string | null;
```

`type:none`はnull。
それ以外:

- `apiKeyEnv` regex `^[A-Z][A-Z0-9_]{1,63}$`
- process.envを先に見る
- 無ければ既存 `loadRepoEnv()`
- それでも無ければprofile名付きerror

### 14.2 keyをconfigに書かせない

次をschema / runtimeでunknown keyとして拒否:

- `apiKey`
- `token`
- `authorization`
- `headers`

任意headersを許可しない。secret漏洩とhost固有仕様の無制限化を防ぐ。

### 14.3 auth mapping

- bearer -> `Authorization: Bearer <key>`
- x-api-key -> `x-api-key: <key>`
- none -> auth header無し

Anthropic built-inは追加でversion headerをadapterが固定する。

### 14.4 Editor API

project response:

```ts
interface AiProfileStatus {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  credential: "not-required" | "present" | "missing";
  capabilities: AiCapabilities;
}
```

API key値、env変数名、base URL pathは返さない。originだけ返す。

---

## 15. config validation

### 15.1 validator

新規:

```ts
export function validateAiConfig(value: unknown): string[];
```

config load時に実行し、不正ならAI command開始前にまとめて表示する。
render等AIを使わないcommandまで止めるかは既存config方針に合わせる。
推奨はconfig load errorとして全commandを止める。typoを黙殺しないため。

### 15.2 error条件

- legacyとrouted併記
- unknown top/profile/auth/capability key
- profile名不正、重複、16件超
- adapter不明
- route先profile不存在
- text / structured route欠落
- openai-compatibleのbaseUrl/protocol/model欠落
- built-in openai/anthropicのbaseUrl指定
- CLI adapterのbaseUrl/auth指定
- custom capability未指定
- vision route profileでimageInput false
- structured route profileでstructuredOutput none
- auth typeとapiKeyEnv不整合
- plain API key field
- limit範囲外
- URL credentials/query/hash
- non-loopback HTTP

### 15.3 warning

- text/structured/vision全てcloud origin
- vision routeがHTTP loopbackでなく外部origin
- structuredOutput prompt
- model `auto` をAPI adapterで使用
- maxOutputTokensが小さすぎる
- legacy `llm` 使用
- legacy単一provider使用。廃止warningではなくprofiles利用案内。

---

## 16. `ai doctor`

### 16.1 CLI

```sh
node src/cli.ts ai doctor
node src/cli.ts ai doctor --profile local
node src/cli.ts ai doctor --route vision
node src/cli.ts ai doctor --json
```

recording dirは不要。configだけを使う。

### 16.2 検査段階

各profile:

1. config validation
2. credential presence
3. endpoint URL
4. text probe
5. structured probe
6. image probe

capability falseのprobeは`skipped`。

### 16.3 probe

text:

```text
Reply with exactly: cutflow-ok
```

structured schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["ok"],
  "properties": { "ok": { "const": true } }
}
```

image:

- codeで16x16 PNG fixtureを生成しない。
- `test/fixtures/ai-doctor.png` をrepo assetとして追加するか、既存小PNGを使用。
- prompt: `Return {"saw":"red-square"}` 等。
- model意味理解に依存しすぎるため、response shapeだけを合否とし内容はwarning。

### 16.4 output

```text
PROFILE       ADAPTER             TEXT  STRUCTURED  IMAGE  AUTH
local         openai-compatible   ok    warn        skip   n/a
cloud-vision  openai              ok    ok          ok     present
```

JSON:

```ts
interface AiDoctorResult {
  profile: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  checks: {
    config: DoctorCheck;
    credential: DoctorCheck;
    text: DoctorCheck;
    structured: DoctorCheck;
    image: DoctorCheck;
  };
}
```

### 16.5 side effect

- editable JSONを書かない。
- artifactをrecording folderへ書かない。
- prompt/responseを保存しない。
- API課金が発生しうることをhelpへ明記。

---

## 17. route別call site

### 17.1 text

- plain `complete`
- 将来の自由文説明

### 17.2 structured

- plan
- remeta
- plan-shorts
- Editor AI proposal
- schema付きtask-level edit

現在plain `complete` を使い後段でJSON parseしているcall siteはstructured routeへ移す。

### 17.3 vision

- review still比較だけ

P2の別項目「VLMをagent loopやGUI AI workflowの二次観測へ広げる」は本設計の基盤を使うが、
自動適用はしない。

### 17.4 route metadata

各operation logはsecret無しで1行:

```text
AI: purpose=editor-proposal route=structured profile=local adapter=openai-compatible model=local-model
```

vision:

```text
AI: purpose=vision-review route=vision profile=cloud-vision origin=https://api.openai.com images=4
```

promptやresponseは出さない。

---

## 18. Editor UI

### 18.1 Settings

設定modalへread-only「AI provider」sectionを追加する。

- text route profile
- structured route profile
- vision route profile
- adapter
- model
- endpoint origin
- credential present/missing
- structured / image capability

v1ではprofileの追加・base URL・env名をbrowserから編集しない。`config.yaml` を直接編集する。
理由:

- secret周辺設定を汎用config patchへ広げない。
- endpoint typoやcapabilityの複雑なvalidationを先にserver側で完成させる。
- browserに認証情報を露出しない。

### 18.2 Test button

「接続確認」はserver側doctor endpointを呼ぶ。

```http
POST /api/ai/doctor
{ "route": "vision" }
```

許可keyはrouteだけ。profile configやendpointをclientから受け取らない。

### 18.3 VLM toggle

既存toggle:

```text
[ ] 画像もAIに確認させる
```

表示:

- vision route無し -> disabled
- imageInput false -> disabled
- credential missing -> disabled
- config `editor.aiReview.vlm=false` -> disabled + 管理設定off
- 利用可能 ->送信先originと画像最大数

文言:

```text
最大4枚の縮小stillを cloud-vision (https://api.example.com) へ送信します。
```

### 18.4 workflow

VLM失敗:

- workflow全体をerrorにしない。
- deterministic reviewを表示。
- VLM sectionへstructured warning。
- retry buttonは同じproposalId / accepted hunksを使う。
-別profileへ自動切替しない。

---

## 19. privacy / security

### 19.1 送信対象

text route:

-既存prompt内容
- project projection / transcript等

vision route:

-縮小still
- deterministic checks
- OCR抜粋
- structure delta

送信しない:

- raw動画
- raw音声
- full-resolution still
- recording folder path
- `.env`
- approval record
- provider config全体

### 19.2 log redaction

共通logger helper:

```ts
export function aiRequestSummary(req: AiRequest, profile: ResolvedAiProfile): string;
```

summaryだけをlogする。
fetch request/response objectを`console.log`しない。

### 19.3 artifact

`review.probe/index.json`:

- VLM結果
- profile名
- adapter
- model
- requestId optional

保存禁止:

- base64
- prompt全文
- API response全文
- endpoint URL
- credential/env名

### 19.4 custom endpoint

config.yamlはtrusted local inputだが、redirect禁止、HTTP制限、response上限は守る。
Editor requestからbase URLを受け取らないため、remote clientによるSSRFを作らない。

---

## 20. failure policy

### 20.1 plan / editor proposal

AIが本処理なのでprovider失敗はoperation error。

- editable file不変
- proposal storeへpartial recordを残さない
- error codeとprofileを表示
- retryは人間操作

### 20.2 VLM review

optional laneなのでwarningへ降格。

- deterministic bundle成功
- `vlm` field無し
- warningsへsanitized error
- HTTP bodyは保存しない

### 20.3 no fallback

理由:

- localからcloudへprompt/画像が漏れる可能性
- providerごとにmodel品質が違う
-課金先が変わる
- failure原因が隠れる

将来fallbackを入れる場合はrouteごとの明示listと送信先確認を別設計する。

---

## 21. concurrency / cancellation

### 21.1 heavy job lock

Editor AI proposal / reviewは既存heavy job lockを使う。provider層で別queueを作らない。

### 21.2 cancellation

client disconnectやjob cancelを `AbortSignal` でadapterへ伝える。

- fetch abort
- CLI process killは既存`run`がsignal非対応なら別sliceで追加
- canceled requestをretryしない
- temp imageはfinally削除

### 21.3 duplicate request

Editor reviewの既存request keyに次を含める。

- vision opt-in
- resolved vision profile name
- model

config変更後に古いin-flight responseを新config結果として表示しない。

---

## 22. files

### 新規

- `src/lib/ai/types.ts`
- `src/lib/ai/config.ts`
- `src/lib/ai/registry.ts`
- `src/lib/ai/client.ts`
- `src/lib/ai/http.ts`
- `src/lib/ai/images.ts`
- `src/lib/ai/structured.ts`
- `src/lib/ai/adapters/claudeCode.ts`
- `src/lib/ai/adapters/codex.ts`
- `src/lib/ai/adapters/openai.ts`
- `src/lib/ai/adapters/anthropic.ts`
- `src/lib/ai/adapters/openaiCompatible.ts`
- `src/stages/aiDoctor.ts`
- `test/aiConfig.test.ts`
- `test/aiClient.test.ts`
- `test/aiHttp.test.ts`
- `test/aiAdapters.test.ts`
- `test/aiDoctor.test.ts`

### 変更

- `src/lib/config.ts`
- `src/lib/llm.ts`
- `src/cli.ts`
- `src/stages/plan.ts`
- `src/stages/planShorts.ts`
- `src/stages/editorAi.ts`
- `src/stages/review.ts`
- `editor/server.ts`
- `editor/client/apiTypes.ts`
- `editor/client/SettingsModal.tsx`
- `editor/client/App.tsx`
- `docs/usage.md`
- `config.example.yaml` またはrepoの標準config
-既存LLM / Editor / review tests

---

## 23. 実装slice

弱いモデルは必ずS1から順に実装する。複数adapterを一度に移動しない。

### S1: config model

1. legacy/routed型。
2. profile/route/capability型。
3. `validateAiConfig`。
4. `resolveAiRuntimeConfig`。
5. legacy変換test。
6. `resolveAiCfg`互換test。
7. URL validation。
8. typecheck。

完了条件:新設定を解決できるが、call pathはまだ現行`llm.ts`。

### S2: neutral client

1. `AiRequest` / `AiResponse`。
2. adapter interface / registry。
3. capability check。
4. timeout。
5. retry。
6. bounded response reader。
7. error class / sanitization。
8. fake adapter tests。

完了条件: provider固有HTTP無しでclient orchestrationをtest可能。

### S3: OpenAI移設

1.現行OpenAI text testをadapterへ移す。
2. structured schema変換。
3. image content。
4. response parse。
5. auth。
6. legacy body regression。

完了条件: `ai.provider=openai` の既存挙動不変。

### S4: Anthropic移設

1. text。
2. tool schema。
3. image blocks。
4. response。
5. auth/version header。
6. regression。

完了条件:既存Anthropic挙動不変。

### S5: CLI移設

1. claude-code。
2. codex。
3. structured mode。
4. image unsupported。
5. command args regression。

完了条件:既存CLI provider挙動不変。

### S6: OpenAI-compatible

1. URL join。
2. chat text。
3. chat multimodal。
4. structured 4 modes。
5. Responses protocol。
6. auth 3 modes。
7. local fake HTTP integration。

完了条件:local endpointで3 routeを個別構成できる。

### S7: call site routing

1. plan / remeta -> structured。
2. plan-shorts -> structured。
3. Editor proposal -> structured。
4. VLM review -> vision。
5. supportsImageReviewをcapability化。
6. provider metadata。
7. optional VLM fallback。

完了条件:用途別profileが実際に使われる。

### S8: doctor

1. stage。
2. CLI。
3. JSON output。
4. credential status。
5. text/schema/image probe。
6. no artifact test。

完了条件:本番workflow前に接続可否を検査できる。

### S9: Editor

1. project API status。
2. Settings read-only表示。
3. doctor endpoint/button。
4. VLM toggle capability。
5. origin送信文言。
6. retry / warning。

完了条件:画像送信先と能力をユーザーが確認できる。

### S10: docs

1. usage。
2.標準config例。
3. migration。
4. privacy。
5. troubleshooting。
6. full test/typecheck。

---

## 24. 必須テスト

### 24.1 config

- legacy provider 4種。
- legacy llm 2種。
- default claude-code。
- routed正常系。
- mixed legacy/routed拒否。
- route先不存在。
- profile名不正。
- unknown key。
- plaintext key拒否。
- custom capability欠落。
- vision/image不一致。
- limit境界。
- max profiles。

### 24.2 URL / HTTP

- HTTPS。
- localhost HTTP。
- 127.0.0.1 HTTP。
- IPv6 loopback。
- remote HTTP拒否。
- credentials拒否。
- query/hash拒否。
- path prefix join。
- redirect拒否。
- timeout。
- response byte上限。
- retry 429 / 503。
- no retry 400 / 401。
- Retry-After。
- error redaction。

### 24.3 structured

- native schema body。
- oneOf->anyOf非破壊変換。
- json-object body。
- prompt suffix。
- exact JSON。
- whole fence。
- prose付き拒否。
-複数JSON拒否。
- invalid JSON。
- schema mode noneのpreflight error。

### 24.4 image

- PNG / JPEG / WebP magic bytes。
- extension偽装拒否。
- image count。
- bytes per image。
- total bytes。
- label順序。
- absolute pathがrequest bodyに入らない。
- base64がlog/errorに入らない。

### 24.5 adapters

OpenAI:

- endpoint / auth。
- text。
- structured。
- multiple images。
- output_text fallback。
- request ID。

Anthropic:

- headers。
- text。
- tool schema / forced choice。
- image block。
- tool_use欠落。

CLI:

- args。
- stdin。
- model auto省略。
- image capability error。

compatible:

- chat string content。
- multimodal array content。
- response_format 3種。
- responses protocol。
- auth 3種。

### 24.6 route

- text / structured / visionが別profile。
- vision未設定。
- local failureでcloudへfallbackしない。
- config変更でreview request keyが変わる。
- legacy単一providerが全既存callへ使われる。

### 24.7 VLM

- config off。
- UI off。
- capability false。
- credential missing。
- max2 / max4。
- before/after pair。
- resize temp cleanup成功時/失敗時。
- provider failureでもbundle成功。
- resultにpatch/pass/failが無い。
- artifactにbase64/prompt/endpoint無し。

### 24.8 doctor

-全check ok。
- skipped capability。
- missing auth。
- timeout。
- JSON stable shape。
- editable/generated artifact不変。
- key値を出力しない。

### 24.9 regression

-現行`complete` tests。
-現行Editor AI tests。
-現行review tests。
- plan / plan-shorts fixture。
- AI未使用command。
- `npm test`。
- `npm run typecheck`。

---

## 25. fake provider test server

外部APIをtestで呼ばない。Node `http.createServer` でloopback serverを立てる。

endpoint:

- `/v1/chat/completions`
- `/v1/responses`
- `/redirect`
- `/large`
- `/rate-limit`
- `/slow`

記録:

- method
- path
- headersのkey名
- parsed body

API key値はassertに必要でもfailure messageへ出さない。

serverはtest終了時に必ずcloseする。portは0でOS割当。parallel testで固定portを使わない。

---

## 26. 手動確認

### 26.1 legacy

1.既存 `ai.provider` 設定。
2. Editor proposal。
3. plan。
4. VLM review。
5.導入前と同じprovider/modelが使われる。

### 26.2 local text

1. OpenAI互換local server起動。
2. `ai doctor --profile local`。
3. Editor caption edit proposal。
4. diff review。
5. apply前に内容確認。

### 26.3 split route

1. text/structuredをlocal。
2. visionをcloud。
3. VLM toggle offで画像送信無し。
4. toggle onでorigin表示。
5.最大4枚だけ送信。
6. cloud停止時もdeterministic bundle表示。

### 26.4 secret

次を検索:

```sh
rg 'sk-|API_KEY_VALUE|data:image/.+base64' review.probe .editor-draft.json .
```

fixture dummy secretを使い、artifact/logに現れないことを確認する。

---

## 27. migration

### 27.1変更不要

```yaml
ai:
  provider: claude-code
  model: auto
```

そのまま動く。

### 27.2 profilesへ移行

before:

```yaml
ai:
  provider: openai
  model: your-model
```

after:

```yaml
ai:
  profiles:
    main:
      adapter: openai
      model: your-model
  routes:
    text: main
    structured: main
    vision: main
```

### 27.3 deprecation

v1でlegacy設定をdeprecated errorにしない。

- docsはprofilesを推奨。
- doctorでinformational migration note。
-削除時期を決めない。
- legacy testsを残す。

---

## 28. ドキュメント

`docs/usage.md`:

- profiles / routes。
- adapter matrix。
- local endpoint例。
- API key env。
- image opt-in。
- doctor。
- failure policy。
- no automatic fallback。
- privacy。

標準config:

- legacy既定をprofilesへ即変更しない。既存ユーザーとの差を小さくする。
-コメント付きprofiles例を追加する。

`AGENTS_CONTRACT.md`:

- editable recording fileの契約は変更なし。
- AI providerはrecording JSONではなくconfigの運用設定。
- provider failureでapprovalを書かないことを再確認。
-外部送信対象はusageへpointerを置く。

---

## 29. 受け入れ条件

以下をすべて満たしたときP2「BYO-AI / マルチモーダル provider拡張」v1完了とする。

-名前付きprovider profilesを設定できる。
- text / structured / visionを別profileへrouteできる。
- legacy ai / llm設定が従来どおり動く。
- OpenAI、Anthropic、claude-code、codexがadapter化される。
- OpenAI互換Chat Completions / Responses endpointを追加できる。
- capability不足をrequest前に検出できる。
- model名から能力を推測しない。
-画像は最大4枚、縮小済み、明示opt-inでだけ送る。
- timeout、retry、response上限、redirect拒否が共通化される。
- API keyは環境変数だけで、browser/log/artifactへ出ない。
- provider間自動fallbackが無い。
- VLM失敗でもdeterministic reviewが成功する。
- proposalは既存diff/apply/approval境界を迂回しない。
- `ai doctor` でconfig/auth/text/structured/imageを検査できる。
- Editorでroute、capability、送信先originを確認できる。
- fake server tests、`npm test`、`npm run typecheck`が成功する。

---

## 30. 将来拡張

v1完了後、別設計で追加する。

1. 明示fallback chain。
2. provider plugin package。
3. streaming。
4. embeddings route。
5. audio input。
6. bounded video clip input。
7. model catalog / capability probe cache。
8. per-purpose route (`plan`, `editor`, `review`)。
9. cost / token budget。
10. concurrency limit。

audio/videoを追加するときも、raw mediaを直接送ることを既定にしない。既存のtranscript、
OCR、motion、sound、stillを一次観測として残し、外部送信は新しい明示opt-inとサイズ上限を
持つ二次laneとして追加する。
