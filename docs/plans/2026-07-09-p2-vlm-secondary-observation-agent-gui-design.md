# P2 VLM 二次観測の agent loop / GUI AI workflow 拡張 実装設計書

*2026-07-09 / 実装担当: gpt-5.4 想定*

対象:

- `docs/reviews/2026-07-06-ai-native-nle-diagnosis-2026-07-08-update.html`
  の P2「VLM を agent loop や GUI AI workflow の二次観測へ広げる」
- 現行の P1 Optional VLM Review
- 現行の cuts-only plan loop、GUI AI proposal review、MCP editing workflow

この文書は、実装者が追加の製品判断をせず、上から順に小さい PR へ分けて実装できる
ことを優先する。型、責務境界、状態遷移、上限、失敗時挙動、変更ファイル、テストを
固定する。

関連設計:

- `docs/plans/2026-07-09-p1-ai-workflow-observation-retrieval-design.md`
- `docs/plans/2026-07-09-p1-implementation-slices.md`
- `docs/plans/2026-07-09-p2-byo-ai-multimodal-provider-design.md`
- `docs/plans/2026-07-07-agent-loop-design.md`
- `docs/plans/2026-07-08-editor-ai-command-proposal-review-design.md`

---

## 0. 結論

P2 は新しい「VLM 編集機能」を作らない。P1 の `reviewEdit()` 内に埋まっている
VLM 呼び出しを、再利用可能な **二次観測 provider** として切り出し、次の3経路から
明示的に利用できるようにする。

1. **GUI proposal refinement**
   ユーザーが before/after review を見た後、「AI に観測を渡して再調整」を1回ずつ
   実行する。再調整後も proposal diff に戻り、人間が hunk を選ぶ。自動適用しない。

2. **MCP agent loop**
   `cutflow_review` に明示的な `secondaryObservation` option を追加する。外部 agent は
   deterministic observation と VLM note を同じ `ReviewBundle` で受け取り、自分の
   次の `cutflow_edit(dryRun:true)` を組み立てる。cutflow server は自動反復しない。

3. **Internal cuts-only plan loop**
   `plan.loop.secondaryObservation` を opt-in で追加し、各反復の candidate から最大2枚の
   still を生成して次の critique prompt に補足する。ただし停止条件と assertion 判定は
   従来どおり deterministic lane だけで決める。

全経路で共通する原則:

- deterministic observation が一次、VLM は二次。
- VLM は `pass` / `fail`、patch、座標、approval 判断を返さない。
- VLM failure は warning であり、workflow failure ではない。
- 画像外部送信は config と、その実行ごとの明示 opt-in の二重条件にする。
- 1操作の画像枚数、反復回数、response量を硬い上限で制限する。
- GUI と内部 loop は同じ `SecondaryObservationProvider` を使う。

---

## 1. 現状

### 1.1 既に実装済み

- `src/stages/review.ts`
  - immutableな base/candidate snapshot の before/after still
  - structure/motion/sound/OCR の deterministic observation
  - opt-in VLM review
  - `ReviewBundle.vlm` と `ReviewBundle.vlmProvider`
- `src/lib/ai/`
  - route別 provider
  - `vision` route
  - image input capability
  - structured output
  - timeout、retry、response上限、sanitized error
- `editor/server.ts`
  - proposal store
  - `/api/ai/propose`
  - `/api/ai/review`
  - proposal freshness check
- `editor/client/App.tsx`
  - proposal diff review
  - VLM toggle
  - deterministic observation と VLM note の分離表示
- `src/lib/planLoop.ts`
  - deterministic observation
  - assertion pass、fixpoint、max iteration による停止
- `src/mcp/tools.ts`
  - `cutflow_edit`
  - `cutflow_review`
  - `cutflow_apply`

### 1.2 現行の不足

1. VLM処理が `src/stages/review.ts` のprivate関数であり、他workflowから再利用できない。
2. `VlmReviewResult` は表示用で、次のAI requestへ安全に渡す正規化関数がない。
3. GUIはVLM noteを表示するだけで、観測を使ったproposalの再調整経路がない。
4. GUIの「再提案」は最初からやり直すため、base proposal、採否、観測の関係が消える。
5. MCP `cutflow_review` はVLM実行を要求できない。
6. plan loopの `ObservationInput.av?: unknown` は拡張点として弱く、視覚観測の出所と
   trust levelを表せない。
7. VLMの同じ結果がGUI、MCP、loopで異なるprompt形式へ雑に埋め込まれる危険がある。
8. 反復単位の画像送信数と累積回数を一元管理する仕組みがない。

---

## 2. スコープ

### 2.1 実装する

- 共通 `SecondaryObservation` 型
- 共通 `SecondaryObservationProvider`
- P1 VLM処理の `src/lib/vlmObservation.ts` への切り出し
- VLM結果のruntime validationとprompt用の決定論的整形
- GUI proposal refinement APIと状態遷移
- GUIでの「観測を渡して再調整」操作
- MCP `cutflow_review` の明示opt-in
- cuts-only plan loopへの限定接続
- request単位とsession単位のbudget
- provenance、provider情報、warning
- stale proposal、concurrent edit、provider failureへの安全な処理
- unit / server / MCP / integration test

### 2.2 実装しない

- VLMが直接 `ApplyPatch` を返す処理
- VLMが提案hunkを自動採用・拒否する処理
- VLMだけを根拠にloopを停止・継続する処理
- VLMによるapproval、render開始、save
- browserからAI providerを直接呼ぶ処理
- 動画fileや音声fileのmodel直接入力
- realtime streaming、chat history、永続conversation
- backgroundでの自動VLM実行
- provider間のfallback
- 全frame走査、物体追跡、pixel精密座標の生成
- VLM responseのartifact外への長期記憶
- P2 keyframe/speed changeの自動調整
- cloudへの画像送信をconfigだけで暗黙に有効化する処理

---

## 3. 不変条件

### 3.1 一次観測と二次観測

`ReviewBundle.observation` が一次観測である。次は必ず一次観測だけで決める。

- candidate JSONのvalidity
- assertion outcome
- loop停止条件
- proposal stale判定
- save可否
- approval可否
- render可否

`SecondaryObservation` は次だけに使える。

- 人間への補足表示
- 次のtext/structured modelへ渡すcritique材料
- agentが次のdry-run editを考える材料

一次観測とVLMが矛盾した場合、一次観測を採用し、VLM側へ
`conflictsWithPrimary: true` を立てる。一次観測の値をVLM結果で上書きしない。

### 3.2 書き込み

- `observeSecondary()` はeditable JSONを書かない。
- GUI refinementはproposal store内のcandidateだけを更新する。
- refinement後もlive editor stateとdiskは変更しない。
- MCP reviewはread-only。
- plan loop以外は観測中に `cutplan.json` を書かない。
- plan loopは既存仕様どおりcandidate観測のためにcutplanを更新できるが、VLM処理自身は
  書き込まない。
- `approvals.json` は全経路から書かない。

### 3.3 外部送信

画像送信には両方が必要。

1. configで対象workflowが有効。
2. GUI request、MCP tool argument、CLI optionのいずれかで今回の実行を明示。

`editor.aiReview.vlm: true` だけで自動送信してはいけない。plan loopも
`plan.loop.secondaryObservation.enabled: true` だけでは不足し、CLIで
`--with-vlm` を指定したときだけ送る。

### 3.4 failure

- vision route未設定: deterministic結果 + warning
- capability不足: deterministic結果 + warning
- credential不足: deterministic結果 + warning
- timeout / 429 / 5xx: deterministic結果 + warning
- invalid JSON/schema: deterministic結果 + warning
- response内の不正frame参照: 該当itemを捨てwarning
- 全itemが不正: `secondaryObservation` を付けずwarning

GUI refinementだけは、二次観測が得られなかった場合に再調整AIを呼ばず、409ではなく
422 `SECONDARY_OBSERVATION_UNAVAILABLE` を返す。元proposalとreviewは保持する。

---

## 4. 共通データ契約

### 4.1 新規ファイル

`src/lib/vlmObservation.ts` を追加する。ここにはAI adapterに依存する実行コードと、
fs非依存のvalidation/整形を置く。reviewのrender処理は置かない。

```ts
export type SecondaryObservationKind = "vlm";

export interface SecondaryObservationItem {
  frameId: string;
  side: "before" | "after";
  severity: "info" | "warn";
  category:
    | "layout"
    | "readability"
    | "occlusion"
    | "continuity"
    | "content";
  message: string;
  conflictsWithPrimary: boolean;
}

export interface SecondaryObservation {
  schemaVersion: 1;
  kind: "vlm";
  summary: string[];
  items: SecondaryObservationItem[];
  uncertainties: string[];
  confidence: "low" | "medium" | "high";
  provenance: {
    profile: string;
    adapter: string;
    model: string;
    requestId?: string;
    observedAt: string;
    imageCount: number;
    inputDigest: string;
  };
}
```

P1の `VlmReviewResult.observations[].frame: number` は廃止し、stableな `frameId` と
`side` を使う。`frameId` はreview stillの順序に依存させない。

```ts
export function reviewFrameId(args: {
  side: "before" | "after";
  sourceSec: number | null;
  outSec: number;
  reason: string;
}): string;
```

実装は `sha256(stableCanonicalize(args)).slice(0, 16)` とする。接頭辞は `rf_`。

### 4.2 provider input

```ts
export interface SecondaryObservationFrame {
  frameId: string;
  side: "before" | "after";
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sourceSec: number | null;
  outputSec: number;
  reason: string;
}

export interface SecondaryObservationRequest {
  frames: SecondaryObservationFrame[];
  primary: DeterministicReviewObservation;
  task: {
    instruction?: string;
    proposalTitle?: string;
    proposalSummary?: string[];
  };
  budget: {
    maxImages: number;
    maxOutputTokens: number;
  };
}

export interface SecondaryObservationProvider {
  observe(
    request: SecondaryObservationRequest,
    cfg: Config,
  ): Promise<SecondaryObservation>;
}
```

production実装:

```ts
export class VlmSecondaryObservationProvider
  implements SecondaryObservationProvider
```

テストではproviderをDIする。unit testからnetworkを呼ばない。

### 4.3 VLM raw response schema

modelへ要求するJSONは次に固定する。

```json
{
  "summary": ["string"],
  "items": [
    {
      "frameId": "rf_0123456789abcdef",
      "side": "after",
      "severity": "warn",
      "category": "readability",
      "message": "字幕と背景のコントラストが低い"
    }
  ],
  "uncertainties": ["string"],
  "confidence": "medium"
}
```

制約:

- `additionalProperties: false`
- `summary`: 最大4件、各240文字
- `items`: 最大12件、message各400文字
- `uncertainties`: 最大4件、各240文字
- frameIdはrequestに含まれるものだけ
- sideは該当frameIdのsideと一致必須
- severityは `info | warn`
- confidenceは `low | medium | high`

schema対応providerでもruntime validationを必ず行う。長すぎる文字列は切らずにresponse
全体をinvalidにする。弱い実装モデルが独自の寛容処理を加えてはいけない。

### 4.4 primary conflict判定

v1では意味的な完全照合をしない。次の機械的規則だけを実装する。

```ts
export function markPrimaryConflicts(
  raw: ValidatedVlmPayload,
  primary: DeterministicReviewObservation,
): SecondaryObservationItem[];
```

- primaryにcandidate validation errorがあり、VLMが問題なしとsummaryに書いても
  itemは追加生成しない。GUIはprimary errorを常に先に表示する。
- category `readability` でOCRがunsupported/failedなら
  `conflictsWithPrimary = false`。uncertaintyとして扱う。
- VLMがOCR文字列と異なる具体的な文字列を断定した場合の自然言語比較はしない。
- v1の `conflictsWithPrimary` は、同一frameについてprimary checkが明示的にpassなのに
  VLM itemが同じcategoryをwarnにした場合だけtrue。
- 対応するprimary categoryが無ければfalse。

高度なsemantic contradiction判定は実装しない。

### 4.5 prompt用整形

```ts
export function summarizeSecondaryObservation(
  observation: SecondaryObservation,
): string;
```

出力順を固定する。

```text
## 画像モデルによる二次観測
注意: 機械検査が一次情報です。以下は補足であり、座標・合否・承認判断ではありません。
- provider: <profile> / <model>
- confidence: medium
- [warn][readability][after][rf_...] 字幕と背景のコントラストが低い
- uncertainty: 画面右端は画像外のため確認不能
```

providerのorigin、API key、request body、local absolute pathは含めない。最大4,000文字。
超過時はitemsを末尾から落とし、最後に `- truncated: true` を付ける。

---

## 5. 画像選択とbudget

### 5.1 選択規則

共通純関数を追加する。

```ts
export function selectSecondaryObservationFrames(
  stills: readonly ReviewStill[],
  maxImages: number,
): SecondaryObservationFrame[];
```

選択順:

1. 各requested frameのafterを1枚ずつ、時刻昇順
2. 残枠があれば同じframeのbefore
3. 先頭だけに偏らないよう、frame数が枠を超える場合は等間隔sample
4. unresolved (`sourceSec === null`) はafter候補から除外しwarning
5. 同一file digestは重複送信しない

P1実装の `selected.slice(0, pairLimited)` は廃止する。

### 5.2 上限

共通定数:

```ts
export const MAX_SECONDARY_IMAGES_PER_CALL = 4;
export const MAX_SECONDARY_OUTPUT_TOKENS = 1_200;
export const MAX_GUI_REFINEMENTS = 3;
export const MAX_PLAN_VLM_CALLS = 2;
export const MAX_SECONDARY_PROMPT_CHARS = 12_000;
```

config値はこれらを超えられない。小さくすることだけ許可する。

GUI session累積:

- 初回review VLM: 1 call
- refinement 1回ごと: review VLM 1 call + structured refinement 1 call
- refinement最大3回
- 同一candidate digestとspec digestならVLM結果をsession内reuse

plan loop:

- VLM callは最大2回
- iteration 0と、deterministic observationが前回から変化した最終候補を優先
- `maxIterations` が何回でも2回を超えない

---

## 6. P2-A: P1 VLM処理の切り出し

### 6.1 `src/stages/review.ts`

変更:

- `VlmReviewResult` を削除
- private `runVlmReview()` を削除
- `ReviewBundle.vlm` / `vlmProvider` を削除
- `ReviewBundle.secondaryObservation?: SecondaryObservation` を追加
- `ReviewOptions.provider?: SecondaryObservationProvider` を追加
- VLM実行条件、warning fallbackは維持
- resizeした一時画像の生成はprovider側へ移す

互換について:

このrepositoryは未リリースの内部schemaなので、artifactを二重形式で書かない。
Editor clientを同じPRで更新する。古い `review.probe/index.json` はreplace-on-run generated
artifactなのでmigrationしない。

### 6.2 `src/lib/vlmObservation.ts`

処理順:

1. requestを検査
2. `selectSecondaryObservationFrames` 済みframeを受け取る
3. temp dir作成
4. ffmpegで長辺最大1600pxへ縮小
5. labelへframeId / side / source / output / reasonを入れる
6. primary checks/deltaをpromptへ入れる
7. `completeAi({ route: "vision", purpose: "vision-review" })`
8. JSON parse
9. runtime validation
10. frameId/side照合
11. conflict mark
12. provenance付与
13. temp dirを`finally`で削除

`inputDigest`:

```ts
sha256(stableCanonicalize({
  frames: frames.map(({ frameId, side, sourceSec, outputSec, reason }) => ...),
  primary,
  task,
  profile: resolvedProfile.name,
  model: resolvedProfile.model,
}))
```

画像binary自体のdigestも各frameへ含める。absolute pathは含めない。

### 6.3 完了条件

- P1 GUI reviewの見た目とopt-in条件が維持される。
- deterministic-only reviewのartifactはVLM未設定でも生成される。
- VLM testがDIで完結する。
- `src/stages/review.ts` が `completeAi` を直接importしない。

---

## 7. P2-B: GUI proposal refinement

### 7.1 UX

proposal review modalへ次を追加する。

- primary observation
- secondary observation
- `AI に観測を渡して再調整` button
- refinement回数 `1 / 3`
- 実行前の送信先profile、origin、画像枚数

button有効条件:

- proposal sessionがstaleでない
- review bundle生成済み
- secondary observation成功済み
- config `editor.aiReview.vlm === true`
- request時のVLM toggleがon
- refinement回数が3未満
- heavy job実行中でない

button押下で既存proposalをsave/applyしない。新proposalを生成し、diff reviewを置換する。
旧proposalへ戻るundoはv1では作らない。ただし旧proposal recordはsession内に保持し、
server testでlineageを検査可能にする。

### 7.2 server API

新規:

```http
POST /api/ai/refine
Content-Type: application/json
```

request:

```ts
export interface AiRefineRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  reviewKey: {
    candidateHash: string;
    specHash: string;
    acceptedLabelsHash: string;
  };
}
```

追加propertyは拒否する。clientからinstruction、candidate docs、VLM textを受け取らない。
serverのproposal storeと `review.probe/index.json` を正とする。

response:

```ts
export interface AiRefineResponse {
  proposalId: string;
  proposal: EditorAiProposal;
  refinement: {
    iteration: number;
    parentProposalId: string;
  };
}
```

error:

- 400 malformed
- 409 `PROPOSAL_STALE`
- 409 `REVIEW_STALE`
- 409 `HEAVY_JOB_RUNNING`
- 410 `PROPOSAL_EXPIRED`
- 422 `SECONDARY_OBSERVATION_UNAVAILABLE`
- 422 `REFINEMENT_LIMIT_REACHED`
- 502 structured AI failure

### 7.3 proposal store

`StoredProposal`へ追加:

```ts
interface StoredProposal {
  // existing fields
  instruction: string;
  parentProposalId: string | null;
  refinementIteration: number;
  lastReview?: {
    key: ReviewKey;
    acceptedHunkLabels: string[];
    primary: DeterministicReviewObservation;
    secondary: SecondaryObservation;
  };
}
```

`/api/ai/review` 成功時、bundleをartifactへ書くだけでなく、key一致を確認して
`record.lastReview` へ保持する。secondary observationがない場合はprimaryだけ保持し、
refine不可。

proposal TTLは子proposal生成時に延長しない。session起点のexpiresAtを全lineageで共有する。
proposal store最大件数の計算ではlineage内の各proposalも1件と数える。

### 7.4 refinement prompt

`src/stages/editorAi.ts` に追加:

```ts
export interface RefineEditorAiInput {
  originalInstruction: string;
  base: ReviewDocs;
  previousProposal: EditorAiProposal;
  acceptedHunkLabels: string[];
  primaryObservation: DeterministicReviewObservation;
  secondaryObservation: SecondaryObservation;
  refinementIteration: number;
}

export async function refineEditorAi(
  dir: string,
  cfg: Config,
  input: RefineEditorAiInput,
): Promise<EditorAiProposal>;
```

prompt順:

1. 元instruction
2. selection context
3. baseの機械可読summary
4. 前proposalのpatchと採用予定hunk
5. primary observation
6. `summarizeSecondaryObservation()`
7. 制約
8. response schema

制約文を固定する。

```text
機械検査が一次情報です。画像モデルの観測は補足です。
観測を根拠に必要最小限だけ修正してください。
画像モデルが座標を推測しても使用しないでください。
approved、approvals.json、render、saveを変更・実行しないでください。
前提案と同じpatchを返すより、変更不要ならpatchを空にしてください。
```

返却後は初回proposalと同じ `planApply()`、candidate validation、review spec validationを
通す。空patchは成功扱いにせず422 `NO_REFINEMENT` とする。

### 7.5 client状態

既存状態へ `refining` を追加する。

```text
reviewing
  -> reviewing-observation
  -> refining
  -> reviewing (new proposal)
  -> failed (old proposal remains visible)
```

refine failureでmodalを閉じない。旧proposal、採否、review bundleを保持してinline errorを
表示する。再試行は同じrequest keyを使い、server heavy-job dedupe対象にする。

### 7.6 cache key

```ts
sha256(stableCanonicalize({
  parentProposalId,
  acceptedLabelsHash,
  reviewKey,
  secondaryInputDigest,
  refinementIteration,
  structuredProfile,
  structuredModel,
}))
```

prompt本文やVLM messageをlogへ出さない。

---

## 8. P2-C: MCP agent loop

### 8.1 tool schema変更

`cutflow_review` inputへ追加:

```json
{
  "secondaryObservation": {
    "type": "string",
    "enum": ["none", "vlm"],
    "default": "none"
  }
}
```

booleanにしない。将来別種の二次観測を追加しても意味を保つためである。
省略時は現行どおり `none`。

handler:

```ts
const secondary = args.secondaryObservation === "vlm";
const bundle = await reviewEdit(..., { vlm: secondary });
```

実装時は `ReviewOptions.vlm` も名称変更し、
`secondaryObservation?: "none" | "vlm"` とする。

### 8.2 MCP response

structured contentは完全な `ReviewBundle` を返す。human textは次だけにする。

```text
review: 3 stills
primary: 1 warn / 4 pass
secondary: vlm medium / 2 observations
```

VLM failureでもtool-level `isError` はfalse。`bundle.warnings` に理由を入れる。
candidate validation errorなど従来のprimary error semanticsは変えない。

### 8.3 agent向け利用順

MCP tool descriptionへ次を明記する。

1. `cutflow_describe`
2. `cutflow_edit` with `dryRun:true`
3. `cutflow_review` with candidate and explicit `secondaryObservation:"vlm"`
4. primary observationを先に評価
5. 必要なら別の `cutflow_edit` dry-run
6. 人間の指示がある場合だけwrite

VLM結果から直接 `cutflow_apply` を呼ぶよう誘導しない。

### 8.4 security

- MCP clientへprovider originを返さない。
- profile、adapter、model、requestIdは返してよい。
- image absolute pathは返さず、既存のrecording相対artifact pathだけ返す。
- API key、Authorization header、raw provider error bodyは返さない。

---

## 9. P2-D: cuts-only plan loop

### 9.1 なぜ限定接続か

現行loopは固定spanのkeep/cutを再選択するだけである。VLMが有効なのは、字幕被り、
画面状態、切断前後の視覚的連続性の補足であり、尺やassertion判定の代替ではない。
全iterationへ無条件接続するとcostとlatencyだけが増えるため、最大2回に制限する。

### 9.2 config

```yaml
plan:
  loop:
    maxIterations: 3
    secondaryObservation:
      enabled: false
      maxCalls: 2
      maxImages: 2
```

runtime:

```ts
export interface PlanSecondaryObservationCfg {
  enabled: boolean;
  maxCalls: number;  // 0..2
  maxImages: number; // 1..2
}
```

既定は全て無効。`enabled:true` でもCLI `plan --cuts-only --with-vlm` が無ければ実行しない。
`remeta`、full plan、plan-shorts、runへは接続しない。

### 9.3 observation contract

`ObservationInput.av?: unknown` を次へ置換する。

```ts
export interface ObservationInput {
  proj: DescribeProjection;
  outcomes: AssertOutcome[];
  secondary?: SecondaryObservation;
  warnings: string[];
}
```

`StructuralObservationProvider` は `secondary` を返さない。新規wrapper:

```ts
export class VisualSecondaryPlanObservationProvider
  implements ObservationProvider
```

処理:

1. structural providerを呼ぶ
2. candidate cut boundaryからreview frameを最大2箇所選ぶ
3. `frames`またはsnapshot review helperでstill生成
4. VLM providerを呼ぶ
5. secondaryを付けて返す
6. failure時はwarningsだけ追加

### 9.4 frame選択

純関数:

```ts
export function selectPlanLoopReviewTimes(args: {
  projection: DescribeProjection;
  previousProjection: DescribeProjection | null;
  limit: number;
}): number[];
```

優先順:

1. 前iterationからkeep/cutが変化した境界の直後 `boundary + 0.1`
2. 変化した境界の直前 `boundary - 0.1`
3. assertion failが特定時刻を持つ場合その時刻
4. 重複を0.2秒以内で除去
5. source durationへclamp

尺超過だけで時刻が無い場合、VLMを呼ばない。視覚モデルは尺問題を改善できないためである。

### 9.5 critique prompt

既存 `summarizeObservation()` の出力後へ
`summarizeSecondaryObservation()` を追加する。secondaryが無ければ何も追加しない。

VLM noteから新しいcut IDを作らない。LLMが選べるのは従来どおりnumbered segmentsだけ。

### 9.6 停止条件

`shouldStop()` を変更しない。

- assertions-passはprimary outcomeのみ
- fixpointはcut setのみ
- max-iterationsはiterationのみ
- VLM confidenceやwarning数は停止条件に入れない

### 9.7 loop log

`plan.loop.json` の各iterationへ追加:

```ts
secondaryObservation?: {
  kind: "vlm";
  confidence: "low" | "medium" | "high";
  itemCount: number;
  inputDigest: string;
  profile: string;
  model: string;
}
secondaryWarnings?: string[];
```

VLMの自由文全文と画像base64は保存しない。全文は一時的なprompt inputにだけ使う。

---

## 10. Config変更

`src/lib/config.ts`:

```ts
editor?: {
  aiReview?: {
    vlm?: boolean;       // existing
    maxImages?: number;  // existing, clamp 1..4
    maxRefinements?: number; // new, default 2, max 3
  };
};

plan?: {
  loop?: {
    // existing
    secondaryObservation?: {
      enabled?: boolean; // default false
      maxCalls?: number; // default 1, max 2
      maxImages?: number; // default 2, max 2
    };
  };
};
```

validation:

- unknown keyを拒否
- integer以外を拒否
- 範囲外を拒否し、黙ってclampしない
- runtime resolverは欠落値だけdefault補完

GUI settings:

- `editor.aiReview.vlm`
- `editor.aiReview.maxImages`
- `editor.aiReview.maxRefinements`

plan loop secondary configはv1 GUI settingsへ追加しない。CLI利用者がconfigを編集する。

---

## 11. CLI変更

`plan --cuts-only` にだけ追加:

```text
--with-vlm  VLM二次観測を明示的に有効化
```

拒否条件:

- `--with-vlm` かつ `--cuts-only` なし: usage error
- config `secondaryObservation.enabled !== true`: usage error
- vision routeなし: usage error
- imageInput capabilityなし: usage error
- credential不足: usage error

GUI/MCPはfallback warningを返すが、CLIはユーザーが明示optionを指定しているため事前条件の
不足をexit 1にする。iteration途中のprovider failureだけはwarningでloopを継続する。

実行前にstderrへ次を表示する。

```text
VLM二次観測: profile=<name> origin=<origin> 最大2回 / 各2枚
```

API keyは表示しない。

---

## 12. 実装順

順序を変えない。各sliceを独立PRにできる。

### Slice 1: 共通型と純関数

変更:

- add `src/lib/vlmObservation.ts`
- add `test/vlmObservation.test.ts`

実装:

- types
- frame ID
- frame selection
- runtime validation
- conflict marker
- prompt summary
- constants

完了:

- network/fsなしのunit testが通る
- invalid frameId、side mismatch、oversize responseを拒否

### Slice 2: provider切り出し

変更:

- `src/stages/review.ts`
- `src/lib/vlmObservation.ts`
- `test/review.test.ts`

実装:

- `VlmSecondaryObservationProvider`
- `ReviewBundle.secondaryObservation`
- DI
- P1 behavior維持

完了:

- VLM off/unsupported/failureでもdeterministic bundle生成
- temp dirが成功/失敗の両方で消える

### Slice 3: MCP

変更:

- `src/mcp/tools.ts`
- `test/mcpTools.test.ts`
- `AGENTS_CONTRACT.md`
- `docs/usage.md`

実装:

- `secondaryObservation` enum
- tool description
- structured response

完了:

- default `none`がproviderを呼ばない
- `vlm`だけがproviderを呼ぶ
- failureがtool errorにならない

### Slice 4: GUI refine server

変更:

- `editor/server.ts`
- `src/stages/editorAi.ts`
- `editor/client/apiTypes.ts`
- `test/editorServer.test.ts`
- `test/editorAi.test.ts`

実装:

- proposal lineage
- lastReview
- `/api/ai/refine`
- strict request validation
- stale/limit/dedupe
- `refineEditorAi`

完了:

- serverがclient由来のVLM text/candidateを受けない
- planApplyを迂回しない
- refineでdiskが変わらない

### Slice 5: GUI refine client

変更:

- `editor/client/App.tsx`
- `editor/client/DiffReview.tsx`
- `editor/client/widgets.tsx`
- `editor/client/apiTypes.ts`
- editor CSS

実装:

- `refining` state
- button / count / provider disclosure
- success時のproposal置換
- failure時の旧review保持

完了:

- browserからproviderへ直接通信しない
- save/applyは既存buttonだけ
- max到達後button disabled

### Slice 6: plan loop

変更:

- `src/lib/config.ts`
- `src/lib/planLoop.ts`
- `src/stages/plan.ts`
- `src/cli.ts`
- `test/config.test.ts`
- `test/planLoop.test.ts`
- `test/plan.test.ts`
- CLI test

実装:

- config
- CLI opt-in
- wrapper provider
- frame time selection
- prompt injection
- 2-call budget
- summary-only loop log

完了:

- optionなしのlegacy pathがバイト等価
- `shouldStop` testが無変更で通る
- VLM failureでもstructural loopが完走

### Slice 7: docsと全体回帰

変更:

- `docs/usage.md`
- `docs/getting-started.md`
- `AGENTS_CONTRACT.md`

実行:

```sh
npm run typecheck
npm test
```

必要ならGUIの手動確認:

1. VLM offでproposal/review
2. VLM onで送信先表示
3. review生成
4. refine
5. new diff確認
6. hunk採否
7. save前にdisk不変確認

---

## 13. テスト仕様

### 13.1 純関数

- frame IDは同じinputで同じ値
- reason/side/timeが変わるとIDが変わる
- after優先、残枠before
- 等間隔sample
- unresolved除外
- duplicate digest除外
- response unknown property拒否
- summary 5件拒否
- item 13件拒否
- unknown frameId拒否
- frameId/side mismatch拒否
- summary整形が4,000文字以下
- absolute pathとoriginをsummaryへ含めない

### 13.2 review provider

- exact image count
- max 1600px resize args
- `purpose: "vision-review"`
- `route: "vision"`
- `maxOutputTokens: 1200`
- primary checks/deltaをpromptへ含む
- patch/coordinate/pass/fail禁止文を含む
- request ID/provenance保持
- raw provider error body非露出
- finally cleanup

### 13.3 GUI server

- refine request追加property拒否
- missing proposal 410
- stale editable docs 409
- review key mismatch 409
- secondaryなし422
- refinement上限422
- parent ID/iteration更新
- same request dedupe
- accepted labels違いは別key
- structured profile/model違いは別key
- refine responseもplanApply検査
- empty patch 422
- disk hash before/after一致
- approval file before/after一致

### 13.4 GUI client

- secondary成功時だけbutton有効
- primary-only時disabled理由表示
- refining中二重submit不可
- failure後も旧bundle表示
- success後iteration増加
- success後accepted labels reset
- max到達後disabled
- VLM provider disclosure表示

### 13.5 MCP

- option省略でVLMなし
- `none`でVLMなし
- `vlm`でVLMあり
- unknown enum拒否
- config offでwarning
- provider failureで`isError:false`
- responseにsecret/absolute temp pathなし

### 13.6 plan loop

- `--with-vlm`なしでprovider call 0
- config disabled + optionでexit 1
- full plan + optionでexit 1
- max call 2
- timeを持たない尺failだけならcall 0
- changed boundary優先
- provider failure後も次iteration
- VLM内容でassertion passにならない
- VLM内容でfixpoint判定が変わらない
- loop logに自由文全文を保存しない
- legacy configの生成物がfixtureと一致

---

## 14. 受け入れ条件

全て満たしたらP2完了とする。

1. VLM処理がreview stageのprivate実装ではなく共通providerになっている。
2. GUIでreview後に観測を使ったproposal再調整を最大3回できる。
3. 再調整は必ず新しいdiff proposalになり、自動save/applyしない。
4. MCP agentが明示optionで二次観測を取得できる。
5. cuts-only loopが明示opt-in時だけVLM補足をcritiqueへ渡せる。
6. deterministic observationだけがvalidation/assertion/stopを決める。
7. configだけでは画像を外部送信しない。
8. 全経路に画像枚数、call回数、response量の上限がある。
9. provider failure時もdeterministic workflowが失われない。
10. API key、画像base64、absolute temp path、raw provider errorをartifact/logへ残さない。
11. VLMなしの既存workflowが後方互換である。
12. `npm run typecheck` と `npm test` が通る。

---

## 15. 実装者向け禁止事項

gpt-5.4実装担当は、簡略化のためでも次を行ってはいけない。

- `VlmReviewResult` をそのまま各所へimportして依存を増やす。
- GUI request bodyからVLM response本文を信用する。
- refinement時にcandidate docsをbrowserから受け取る。
- VLMにpatchを生成させ、そのまま `applyEdits()` へ渡す。
- VLM warning数をloop停止条件へ追加する。
- config有効だけで画像を送る。
- provider failureをdeterministic review failureへ変換する。
- max image/call/token上限をconfigで無制限にする。
- catchで全errorを握り潰す。必ずsanitized warningを残す。
- testを通すためにruntime validationを緩める。
- proposal freshness checkを省略する。
- review artifactをeditable fileとして扱う。
- `approvals.json` を直接編集する。
- P2と同時にchat history、auto apply、keyframe、speed changeを実装する。

この禁止事項と不変条件が実装の正本である。既存コードが実装を難しくしている場合も、
安全境界を緩めず、sliceをさらに小さく分ける。
