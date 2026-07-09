# P1: AI workflow 観測強化・高水準編集・横断 retrieval・限定 VLM 設計

*2026-07-09 / 実装担当: gpt-5.4 想定*

> 元レビュー:
> `docs/reviews/2026-07-06-ai-native-nle-diagnosis-2026-07-08-update.html`
>
> 対象となる P1:
>
> 1. 高水準 editing tools
> 2. 実 A/V フィードバック(決定論的観測の第一レーン化)
> 3. selection slicer / before-after still / `review.frames` 直結
> 4. material / recording 横断 retrieval
> 5. VLM 補助の限定導入

---

## 0. 結論

P1 は、5項目を別々の機能として足さない。既存の GUI AI 一発編集を中心に、
次の4層として実装する。

1. **Review Observation**
   選択範囲を切り出し、提案適用前後の still、短い比較動画、音量・無音・動き・
   OCR などを1つの `ReviewBundle` にまとめる。

2. **Task-level Editing**
   AI が低水準の `ApplyPatch` を毎回組み立てなくてもよいように、頻出操作を
   `EditIntent` として型付きで表し、決定論的に `ApplyPatch` へコンパイルする。

3. **Local Retrieval**
   `recordingsDir` 配下の recording / material をローカルで索引化し、自然言語に近い
   query で候補を返す。P1 では read-only とし、他 recording からの自動コピーはしない。

4. **Optional VLM Review**
   `ReviewBundle` の still を対応 provider に渡し、意味的な補足を返す。
   VLM は編集の一次入力にも pass/fail 判定にも使わず、決定論的観測の注釈だけを行う。

実装順は必ず **Observation -> GUI 直結 -> Editing Tools -> Retrieval -> VLM** とする。
VLM から先に実装してはいけない。

実装時の分割単位と各 PR の完了条件は、次の文書を正本とする。

- `docs/plans/2026-07-09-p1-implementation-slices.md`

---

## 1. 現状と不足

### 1.1 既にあるもの

- `src/stages/editorAi.ts`
  - selection-aware prompt
  - structured AI response
  - `planApply` による書込前検査
  - `proposedDocs` の生成
- `editor/client/App.tsx`
  - `idle -> proposing -> reviewing -> applying/saving/verifying -> complete/failed`
  - AI proposal の hunk 単位採否
  - `review.frames` を使った保存後 still 生成
- `src/stages/frames.ts`
  - 最終合成と同じ Remotion composition による still
  - source/output time mapping
  - OCR
- `src/stages/av.ts`
  - motion strip
  - scene/freeze
  - loudness/true peak/silence
  - mic/system/BGM の決定論的レポート
- `src/stages/materials.ts`
  - material probe/frame/OCR/transcribe
- MCP
  - `describe`, `validate`, `frames`, `apply`, `id-stamp`, `materials`, `av`, `assert`

### 1.2 現在の不足

1. `review.frames` は AI が返す文字列配列で、時刻軸・理由・必要な観測種別が型付け
   されていない。
2. 「適用して確認」は保存後の after still だけで、before/after を同条件で比較できない。
3. `frames()` はディスク上の編集 JSON だけを読み、未保存の `proposedDocs` を描画できない。
4. `av()` は有用だが、GUI AI workflow と独立している。
5. AI は範囲カット時の segment 分割などを低水準 JSON として自力で組み立てる必要がある。
6. `materials.probe/index.json` は recording 単位で、他 recording の素材を検索できない。
7. 現行 `src/lib/llm.ts` は text-only abstraction で、画像入力 capability が無い。

---

## 2. スコープ

### 2.1 P1 で実装する

- 提案を保存せずに描画できる immutable edit snapshot
- source time selection を bounded review range へ変換する selection slicer
- before/after still
- optional before/after review clip
- deterministic A/V observation report
- structured `review.frames`
- GUI diff review からの review 生成・表示
- common edit intents と `ApplyPatch` compiler
- MCP の task-level edit/review/search tool
- recording/material のローカル横断 index/search
- API provider に限った optional VLM still review

### 2.2 P1 で実装しない

- キーフレーム
- 速度変更
- mask / tracking / auto reframe
- agent の自動反復
- VLM による自動 accept/reject
- VLM による座標の直接書き込み
- embedding API / vector database
- cloud index
- 他 recording からの material 自動コピー
- full video をモデルへ直接送る処理
- AI が approval を作る処理

---

## 3. 絶対に守る不変条件

1. **レビュー生成は編集 JSON を書き換えない。**
   `proposedDocs` はメモリ上の snapshot として扱う。

2. **`approvals.json` は読んでもよいが、P1 の全機能から書かない。**

3. **VLM が失敗しても deterministic review は成功扱いにできる。**

4. **VLM の結果だけを根拠に編集を適用しない。**

5. **MCP の write tool は既存 `planApply` / `applyEdits` を最終境界として使う。**

6. **横断 retrieval は P1 では read-only。**

7. **全時刻は境界で軸を明示する。**
   編集値は source seconds、生成済み clip/report 内は output seconds とする。

8. **全座標は既存どおり output pixels。**

9. **review artifact は generated。**
   人間・AIが直接編集する対象にしない。

---

## 4. 全体アーキテクチャ

```text
AI instruction
    |
    v
POST /api/ai/propose
    |
    +--> task proposal --------+
    |                          |
    +--> raw patch fallback    |
                               v
                    compile -> ApplyPatch
                               |
                               v
                         planApply()
                               |
                               v
                  proposedDocs (not written)
                               |
                               v
                         DiffReview
                               |
                    "比較を生成" action
                               |
                               v
POST /api/ai/review { candidateDocs, reviewSpec }
                               |
                +--------------+--------------+
                |                             |
        deterministic lane              optional VLM
        - structure                     - still meaning
        - before/after still             - layout comments
        - review clips                   - OCR補足
        - motion/sound/OCR                       |
                |                             |
                +--------------+--------------+
                               v
                         ReviewBundle
                               |
                               v
             human accepts/rejects hunks and saves
```

---

## 5. P1-A: Review Observation

### 5.1 新しい共通型

新規 `src/lib/review.ts` に、fs 非依存の型と純関数を置く。

```ts
export type ReviewTimeAxis = "source" | "output";

export interface ReviewRange {
  axis: ReviewTimeAxis;
  startSec: number;
  endSec: number;
}

export interface ReviewFrameRequest {
  axis: ReviewTimeAxis;
  atSec: number;
  reason: string;
  ocr?: boolean;
  fullRes?: boolean;
}

export interface ReviewClipRequest {
  range: ReviewRange;
  includeBefore?: boolean;
  includeAfter?: boolean;
}

export interface ReviewSpec {
  range?: ReviewRange;
  frames: ReviewFrameRequest[];
  clip?: ReviewClipRequest;
  observations?: {
    structure?: boolean;
    motion?: boolean;
    sound?: boolean;
    ocr?: boolean;
  };
}

export interface EditSnapshot {
  cutplan: CutPlan;
  transcript: Transcript;
  overlays: Overlays;
  bgm: Bgm | null;
  shorts: Shorts | null;
}
```

`ReviewDocs` と内容は近いが、review subsystem 側では `EditSnapshot` という名前を使う。
`ReviewDocs` は diff 用の既存名として残し、変換関数だけ追加する。

```ts
export function snapshotOfReviewDocs(docs: ReviewDocs): EditSnapshot;
export function validateReviewSpec(spec: ReviewSpec): Problem[];
export function normalizeReviewSpec(
  spec: ReviewSpec,
  context: ReviewContext,
): NormalizedReviewSpec;
```

### 5.2 上限

ローカル処理でも無制限生成は避ける。

```ts
export const MAX_REVIEW_FRAMES = 8;
export const MAX_REVIEW_CLIP_SEC = 30;
export const DEFAULT_REVIEW_PAD_SEC = 2;
export const MAX_REVIEW_RANGE_SEC = 60;
```

規則:

- frames は1〜8件。
- 同一 output frame に丸まる時刻は重複排除。
- clip は最大30秒。超えたら中心を維持して切る。
- selection range は最大60秒。超えたら warning を返し、先頭60秒ではなく
  selection 中央を中心に切る。
- `fullRes` は still のみ。clip は常に proxy を使う。
- OCR は最大4枚。5枚目以降は warning を返して無効化する。

### 5.3 Selection slicer

`src/lib/review.ts` に純関数を追加する。

```ts
export interface ReviewSelectionInput {
  scope: AiScope;
  playheadSec?: number;
  selectedRange?: { startSec: number; endSec: number };
  selectedIds?: string[];
  activeShortName?: string | null;
}

export interface SlicedReviewContext {
  sourceRange: { startSec: number; endSec: number };
  frameCandidates: {
    sourceSec: number;
    reason: "start" | "middle" | "end" | "cut-boundary" | "caption" | "selected-object";
  }[];
  warnings: string[];
}

export function sliceReviewContext(
  projection: DescribeProjection,
  selection: ReviewSelectionInput,
): SlicedReviewContext;
```

選択規則:

- selection range があればそれを第一候補にする。
- selected ID があれば対象要素の start/end の外接範囲を使う。
- playhead scope は前後6秒、合計12秒。
- global scope は AI が返した structured frame request を使う。無ければ
  output の 10%, 50%, 90% の3点。
- range の start/middle/end を基本点にする。
- cut action 変更がある場合、変更境界の前後 `0.1s` を候補に足す。
- caption/blur/annotation/material 変更は表示区間中央を足す。
- 最大8件へ優先順位付きで縮約する。

### 5.4 candidate snapshot を保存せず描画する

現行 `frames()` は JSON をディスクから読む。P1 では描画コアを次のように分離する。

`src/lib/renderSnapshot.ts` を新規追加:

```ts
export interface SnapshotRenderInput {
  dir: string;
  cfg: Config;
  snapshot: EditSnapshot;
  shortName?: string;
  fullRes?: boolean;
}

export function buildSnapshotRenderProps(input: SnapshotRenderInput): RenderProps;
```

実装方針:

- `src/stages/frames.ts` 内の manifest 読込、profile 解決、timeline 構築、
  `buildRenderProps` 呼出を `buildSnapshotRenderProps` へ寄せる。
- manifest/source/proxy/material 実在確認は recording folder から行う。
- cutplan/transcript/overlays/bgm/shorts は `snapshot` を正とする。
- candidate JSON を一時ファイルへ書かない。
- `frames()` の既存外部挙動と出力は変えない。
- `frames()` はディスクから snapshot を作り、新しい共通コアを呼ぶ薄い wrapper にする。

### 5.5 before/after still

新規 `src/stages/review.ts`:

```ts
export interface ReviewStill {
  requested: ReviewFrameRequest;
  sourceSec: number | null;
  outSec: number;
  beforeFile: string;
  afterFile: string;
  beforeOcrFile?: string;
  afterOcrFile?: string;
  notes: string[];
}

export interface ReviewBundle {
  schemaVersion: 1;
  createdAt: string;
  key: ReviewKey;
  range: {
    source?: { startSec: number; endSec: number };
    beforeOutput?: { startSec: number; endSec: number };
    afterOutput?: { startSec: number; endSec: number };
  };
  stills: ReviewStill[];
  clips?: {
    beforeFile?: string;
    afterFile?: string;
  };
  observation: DeterministicReviewObservation;
  vlm?: VlmReviewResult;
  warnings: string[];
}

export async function reviewEdit(
  dir: string,
  cfg: Config,
  base: EditSnapshot,
  candidate: EditSnapshot,
  spec: ReviewSpec,
  opts?: ReviewOptions,
): Promise<ReviewBundle>;
```

出力先:

```text
review.probe/
  index.json
  before/
    out12.30s.png
    clip.mp4
  after/
    out12.30s.png
    clip.mp4
  ocr/
    before-out12.30s.json
    after-out12.30s.json
```

`review.probe/` は実行ごとに全置換する generated directory とする。

必要な更新:

- `src/lib/files.ts` の `GENERATED_DIRS` に `review.probe` を追加。
- `AGENTS_CONTRACT.md` の generated directory に追加。
- `CLAUDE.md` / `AGENTS.md` の中間生成物一覧があれば同期。
- `test/agentsMd.test.ts` / `test/files.test.ts` を更新。

### 5.6 時刻写像

before と after で cutplan が異なるため、同じ source second が別 output second に写る。

規則:

- `ReviewFrameRequest.axis === "source"`:
  - before/after それぞれの timeline で独立に output へ写像。
  - candidate 側で cut された場合、`snapToOutput` で直後の keep へ寄せ、note に記録。
- `axis === "output"`:
  - before/after の同一 output second を比較。
  - 構成変更の比較には不向きなので、AI生成の既定は source axis。
- `ReviewStill` は requested、sourceSec、before outSec、after outSec を区別して持つ。

上記に合わせ、実際の型は次を推奨する。

```ts
export interface ReviewStillSide {
  outSec: number;
  sourceSec: number | null;
  file: string;
  ocrFile?: string;
  note?: string;
}

export interface ReviewStill {
  requested: ReviewFrameRequest;
  before: ReviewStillSide;
  after: ReviewStillSide;
}
```

### 5.7 review clip

selection slicer は「動画そのものをモデルへ送る」ためではなく、人間が差分を短時間で
再生確認するために使う。

実装:

- Remotion の同じ composition を使う。
- `renderMedia` に `frameRange` を渡して最大30秒を出力。
- before/after を別MP4にする。side-by-side 合成はP1対象外。
- 音声を含める。
- proxy をベースにし、ハードウェアアクセラレーションは既存 render 設定に従う。
- clip は diff review の「比較動画」セクションで `<video controls>` 表示する。

失敗時:

- still と observation が成功していれば bundle 全体は成功。
- `warnings` に clip 失敗を追加。
- GUI は「比較動画のみ失敗」と表示する。

### 5.8 deterministic observation

新規 `src/lib/reviewObservation.ts`:

```ts
export interface SideObservation {
  durationSec: number;
  keepCount: number;
  cutCount: number;
  captionCount: number;
  visibleCaptionTexts: string[];
  motion?: {
    sceneChanges: number;
    frozenSec: number;
    meanSceneScore: number;
  };
  sound?: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    silenceSec: number;
    clippingSamples: number;
  };
  ocr?: {
    lines: string[];
  };
}

export interface DeterministicReviewObservation {
  before: SideObservation;
  after: SideObservation;
  delta: {
    durationSec: number;
    keepCount: number;
    cutCount: number;
    captionCount: number;
    silenceSec?: number;
    truePeakDbtp?: number;
  };
  checks: ReviewCheck[];
}

export interface ReviewCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  source: "structure" | "motion" | "sound" | "ocr";
}
```

第一レーンの判定規則:

- validate error があれば `fail`。
- candidate の output duration が0なら `fail`。
- requested source time が candidate で全て cut され、snap 先も無ければ `fail`。
- true peak が `> 0 dBTP` なら `fail`。
- clipping sample が1以上なら `fail`。
- clip range の無音率が before より大幅に増えた場合は `warn`。
- 2秒以上の freeze が新規発生した場合は `warn`。
- OCR request があるのに after OCR 行が空なら `warn`。非対応環境は `skip`。
- caption text 変更時、after still の OCR だけで字幕一致を必須化しない。
  OCR 誤認識があるため、構造 projection の caption text を一次ソースにする。

`av.ts` の parser/filter は再利用するが、`av.probe/` を上書きしない。
review clip に対する解析結果は `review.probe/index.json` だけへ書く。

### 5.9 structured `review.frames`

AI response の現行:

```ts
review: {
  frames: string[];
  notes: string[];
}
```

P1:

```ts
review: {
  frames: ReviewFrameRequest[];
  range?: ReviewRange;
  clip?: boolean;
  observations?: {
    motion?: boolean;
    sound?: boolean;
    ocr?: boolean;
  };
  notes: string[];
}
```

AI prompt の規則:

- source axis を既定とする。
- frame ごとに `reason` を必須とする。
- 変更対象の表示中間点を最低1件含める。
- cut 境界を変更する場合は境界前後を含める。
- 最大8件。
- clip は selection/playhead の局所編集だけで推奨。
- global edit で30秒を超えるclipを要求しない。

後方互換:

- parser は P1移行期間だけ `string[]` も受け、source-axis request へ変換する。
- prompt schema は新形式だけを出す。
- 旧形式テストは compatibility test として残す。

### 5.10 editor API

追加:

```http
POST /api/ai/review
```

request:

```ts
export interface AiReviewRequest {
  candidateDocs: ReviewDocs;
  spec: ReviewSpec;
  activeShortName?: string | null;
  vlm?: boolean;
}
```

response:

```ts
export interface AiReviewResponse {
  bundle: ReviewBundle;
}
```

サーバ処理順:

1. body size 上限を検査。
2. disk から base docs を読む。
3. `candidateDocs` の `approved` を disk base と同値へ強制する。
4. `validateDocs`。
5. `ReviewSpec` を検査・正規化。
6. heavy job lock を取得。
7. `reviewEdit`。
8. JSON を返す。

`candidateDocs` は保存しない。

heavy job:

- `review` を `preview` / `render` と同時実行しない。
- proxy build 中なら待つ。
- 同一 key の二重要求は同じ promise を共有する。

### 5.11 GUI

`DiffReview` に次を追加:

- `比較を生成`
- before/after still grid
- before/after clip
- deterministic checks
- optional VLM notes

画面順:

1. proposal summary
2. hunk 採否
3. deterministic checks
4. still comparison
5. clips
6. VLM notes
7. 適用/保存 action

重要:

- review 生成時は、現在選択されている hunk resolution を反映した candidate を送る。
- hunk の採否を変えたら、既存 bundle に `stale` badge を付ける。
- stale bundle を見たまま保存はできるが、UI は「比較は現在の採否と一致しません」と警告。
- `適用して確認` は削除せず、内部的には
  `review生成 -> 適用して保存` のショートカットへ変更する。

---

## 6. P1-B: 高水準 editing tools

### 6.1 方針

既存 `ApplyPatch` は維持する。上に `EditIntent -> ApplyPatch` compiler を追加する。

AI proposal は次のどちらかを返せる。

```ts
export type AiEditProposal =
  | { mode: "tasks"; tasks: EditIntent[] }
  | { mode: "patch"; patch: ApplyPatch };
```

- 頻出操作は `tasks` を優先。
- compiler で表現できない場合だけ `patch`。
- server response は互換のため常に compiled `patch` を含む。

### 6.2 EditIntent

新規 `src/lib/editIntent.ts`:

```ts
export type EditIntent =
  | SetRangeActionIntent
  | TrimPausesIntent
  | SetCaptionTextIntent
  | AddBlurIntent
  | AddAnnotationIntent
  | PlaceMaterialIntent;
```

#### set-range-action

```ts
export interface SetRangeActionIntent {
  type: "set-range-action";
  range: { startSec: number; endSec: number };
  action: "keep" | "cut";
  reason: string;
}
```

動作:

- cutplan segment を range 境界で分割する。
- range と重なる部分だけ action/reason を変更。
- 隣接し、action/reason が同じ fragment は再結合。
- 完全に不変な segment は id を維持。
- 分割された fragment のうち元の start を含む1件だけ元 id を維持。
- その他は ID mode 有効時だけ新規 `seg_*` を採番。
- `approved` は変更しない。

#### trim-pauses

```ts
export interface TrimPausesIntent {
  type: "trim-pauses";
  range?: { startSec: number; endSec: number };
  minPauseSec: number;
  keepHeadSec: number;
  keepTailSec: number;
  reason: string;
}
```

動作:

- `cuts.auto.json.silences` を候補にする。
- `range` 指定時は範囲内だけ。
- silence の両端に `keepHeadSec` / `keepTailSec` を残す。
- resulting cut が0.1秒未満なら捨てる。
- `set-range-action` を複数回適用するのではなく、全cut rangeを正規化して
  cutplanを一度で再構築する。

#### set-caption-text

```ts
export interface SetCaptionTextIntent {
  type: "set-caption-text";
  target: `@cap_${string}`;
  text: string;
}
```

動作:

- `set` op へ変換。
- 空文字は禁止。
- start/end/words は変更しない。

#### add-blur

```ts
export interface AddBlurIntent {
  type: "add-blur";
  range: { startSec: number; endSec: number };
  rect: Region;
  effect?: "blur" | "mosaic";
  strength?: number;
}
```

動作:

- `overlays.blurs` へ追加。
- output bounds を compiler で検査。
- strength 既定は既存 `DEFAULT_BLUR_STRENGTH`。
- ID mode 有効時は `bl_*` を採番。

#### add-annotation

```ts
export interface AddAnnotationIntent {
  type: "add-annotation";
  range: { startSec: number; endSec: number };
  annotation:
    | { type: "arrow"; from: CaptionPos; to: CaptionPos; color?: string }
    | { type: "box"; rect: Region; color?: string; fill?: string }
    | { type: "spotlight"; rect: Region; shape?: "rect" | "ellipse" };
}
```

現行 `ApplyPatch` は annotations の add selector を持たないため、compiler は
`replace.overlays` を生成する。P1 で低水準 apply も揃えるなら、次を同時追加してよい。

- `ADD_SELECTORS["overlays.annotations"]`
- schema の add target
- annotation stable ID

ただし annotation は現行型に id が無いため、stable ID 導入は独立変更として扱う。
P1 の必須条件ではない。

#### place-material

```ts
export interface PlaceMaterialIntent {
  type: "place-material";
  file: string;
  range: { startSec: number; endSec: number };
  placement:
    | { mode: "overlay"; rect?: Region; fit?: "contain" | "cover"; track?: number }
    | { mode: "insert"; durationSec: number; startFrom?: number; fit?: "contain" | "cover" };
  audio?: { volume: number };
}
```

動作:

- file は current recording 内の実在相対パスだけ許可。
- retrieval result の他 recording path は直接指定不可。
- overlay は `overlays.overlays` add。
- insert は `overlays.inserts` add。
- duration/probe が矛盾する場合は warning。
- ID mode 有効時は適切な id を採番。

### 6.3 compiler API

```ts
export interface EditIntentPlan {
  patch: ApplyPatch;
  warnings: Problem[];
  summary: string[];
}

export function compileEditIntents(
  docs: LoadedDocs,
  intents: EditIntent[],
  context: EditIntentContext,
): EditIntentPlan;

export function planIntentEdits(
  dir: string,
  intents: EditIntent[],
): ApplyPlan & { intentPlan: EditIntentPlan };

export function applyIntentEdits(
  dir: string,
  intents: EditIntent[],
): ApplyResult & { intentPlan: EditIntentPlan };
```

compiler はfsを読まない。`planIntentEdits` が必要ファイルを読み、compiler と
`planApply` を接続する。

### 6.4 MCP

追加 tool:

```text
cutflow_edit
```

input:

```ts
{
  tasks: EditIntent[];
  dryRun: boolean;
}
```

規則:

- `dryRun` を必須にする。
- `dryRun: true` は plan のみ。
- `dryRun: false` は `applyIntentEdits`。
- approval/render/preview は引き続き露出しない。
- output は intent summary、compiled patch、apply diff、warnings/errors を含む。

既存 `cutflow_apply` は削除しない。

### 6.5 editor AI

`EDITOR_AI_RESPONSE_SCHEMA` を `mode` discriminated union に変更する。

推奨 response:

```json
{
  "title": "間を詰める",
  "summary": ["選択範囲の1秒以上の無音を短縮"],
  "edit": {
    "mode": "tasks",
    "tasks": [
      {
        "type": "trim-pauses",
        "range": { "startSec": 20, "endSec": 45 },
        "minPauseSec": 1,
        "keepHeadSec": 0.15,
        "keepTailSec": 0.15,
        "reason": "長い間を短縮"
      }
    ]
  },
  "review": {
    "frames": [],
    "clip": true,
    "observations": { "motion": true, "sound": true },
    "notes": ["カット境界と音の途切れを確認"]
  }
}
```

server:

- tasks なら compiler。
- patch なら現行処理。
- どちらも最終的に `planApply`。
- response の `patch` は常に compiled result。
- response に元 `tasks` も保持し、GUI で人間向けに表示。

---

## 7. P1-C: recording / material 横断 retrieval

### 7.1 方針

P1 は embeddings を使わない。日本語にも効く deterministic lexical index を作る。

理由:

- local-first を守れる。
- provider/API key に依存しない。
- index の再現性とテスト容易性が高い。
- P1 の目的は「過去素材を候補に出す」ことであり、意味検索の最高精度ではない。

### 7.2 index 保存先

```text
<recordingsDir>/.cutflow/
  retrieval-v1.json
```

これは各 recording folder の編集対象ではなく、再生成可能なローカル cache。

```ts
export interface RetrievalIndex {
  schemaVersion: 1;
  builtAt: string;
  root: string;
  recordings: RetrievalRecording[];
  documents: RetrievalDocument[];
}
```

### 7.3 document

```ts
export type RetrievalDocumentKind =
  | "recording"
  | "caption"
  | "meta"
  | "chapter"
  | "material"
  | "material-ocr"
  | "material-transcript";

export interface RetrievalDocument {
  id: string;
  recordingDir: string;
  kind: RetrievalDocumentKind;
  title: string;
  text: string;
  file?: string;
  sourceRange?: { startSec: number; endSec: number };
  fingerprint: string;
  tokens: string[];
}
```

入力:

- recording folder 名
- `meta.json`
- `chapters.json`
- `transcript.json`
- `materials.probe/index.json`
- material OCR preview
- material transcription preview

除外:

- raw source video の内容全量
- `rules.md` の秘密情報
- `.env`
- generated render artifacts
- hidden directories

### 7.4 tokenization

新規 `src/lib/retrieval.ts` の純関数:

```ts
export function tokenizeRetrievalText(text: string): string[];
export function scoreDocument(queryTokens: string[], doc: RetrievalDocument): number;
export function searchIndex(index: RetrievalIndex, query: RetrievalQuery): RetrievalResult[];
```

token:

- Unicode normalize NFKC。
- lowercase。
- ASCII は英数字 word。
- 日本語を含む non-ASCII run は2-gramと3-gram。
- punctuation/space は区切り。
- 重複tokenは頻度を保持。

score:

- title exact token x 4
- material filename x 3
- OCR/transcript text x 2
- recording recency は tie-break のみ
- current recording は `scope: "other"` のとき除外可能

BM25の完全実装は不要。score式は純関数としてテストで固定する。

### 7.5 index 更新

新規:

- `src/stages/retrievalIndex.ts`
- `src/stages/retrievalSearch.ts`

CLI:

```sh
node src/cli.ts index
node src/cli.ts search "ログイン画面"
node src/cli.ts search "効果音" --kind material --json
```

`index` は `cfg.recordingsDir` を使うため dir 引数を取らない。

更新規則:

- recording folder ごとに relevant file の mtime+size fingerprint を持つ。
- unchanged recording は前回 document を再利用。
- 壊れたJSONはその recording を warning にして継続。
- `materials.probe` が無ければ material filename/probeなしで索引化。
- index の atomic write は tmp+rename。

### 7.6 MCP

追加:

```text
cutflow_search
```

input:

```ts
{
  query: string;
  kind?: "recording" | "material" | "caption";
  scope?: "current" | "other" | "all";
  limit?: number;
}
```

注意:

- MCP server は1 recording に束縛されるが、search は `cfg.recordingsDir` の read-only
  index を読んでよい。
- result は絶対パスではなく recording 名、relative path、snippet、score を返す。
- current recording へ material をコピーしない。

### 7.7 GUI AIへの接続

`POST /api/ai/propose` で常に全検索しない。

明示条件:

- instruction に `素材`, `B-roll`, `過去`, `以前`, `似た`, `画像`, `動画` のいずれか。
- または AI command modal の「過去素材を検索」をオン。

promptへ渡す上限:

- top 5
- snippet 各200文字
- file/path を含める
- 「候補であり current recording から直接参照できない」と明記

GUI:

- proposal 内に retrieval suggestion card を表示。
- `Finderで表示` は可能。
- `現在の収録へコピー` はP1対象外。

---

## 8. P1-D: 限定 VLM

### 8.1 capability abstraction

`src/lib/llm.ts` に text API を壊さず追加する。

```ts
export interface ImageInput {
  file: string;
  mediaType: "image/png" | "image/jpeg";
  label: string;
}

export interface MultimodalRequest {
  prompt: string;
  images: ImageInput[];
}

export function aiCapabilities(cfg: Config): {
  structuredOutput: boolean;
  imageInput: boolean;
};

export async function completeWithImagesAndJsonSchema(
  req: MultimodalRequest,
  cfg: Config,
  format: JsonSchemaTextFormat,
): Promise<string>;
```

P1対応:

- `openai`: 対応
- `anthropic`: 対応
- `claude-code`: unsupported として deterministic lane のみ
- `codex`: unsupported として deterministic lane のみ

CLI provider の画像対応を暗黙に仮定しない。

### 8.2 VLMの入力

最大4画像:

- before/after を2時刻まで
- 画像の label に side/sourceSec/outSec/reason を含める
- OCR text、structure delta、A/V checks を同じ prompt にテキストで添える

画像サイズ:

- 長辺1600px以下へ一時縮小
- original full-res をAPIへ直接送らない
- 一時ファイルは OS temp へ置き、finally で削除

### 8.3 VLM response

```ts
export interface VlmReviewResult {
  summary: string[];
  observations: {
    frame: number;
    severity: "info" | "warn";
    category: "layout" | "readability" | "occlusion" | "continuity" | "content";
    message: string;
  }[];
  confidence: "low" | "medium" | "high";
}
```

禁止:

- `pass` / `fail`
- patch
- coordinates
- approval recommendation
- 「画像に無いもの」を断定する表現

prompt に明記:

- deterministic checks が一次ソース。
- OCRとVLMが矛盾したらOCR/structureを優先。
- 変更を適用せず、観察だけ返す。

### 8.4 config

```yaml
editor:
  aiReview:
    vlm: false
    maxImages: 4
```

既定 off。

GUI の明示 toggle:

```text
[ ] 画像もAIに確認させる
```

- provider 非対応なら disabled。
- API provider の場合だけ有効。
- 画像が外部APIへ送られることを文言で明示。

### 8.5 privacy

- VLM利用は明示 opt-in。
- local CLI providerでも画像送信可否が不明なら無効。
- request/responseに画像base64をログ出力しない。
- `review.probe/index.json` にAPI request bodyを保存しない。
- VLM resultだけ保存する。

---

## 9. ファイル変更一覧

### 新規

- `src/lib/review.ts`
- `src/lib/renderSnapshot.ts`
- `src/lib/reviewObservation.ts`
- `src/lib/editIntent.ts`
- `src/lib/retrieval.ts`
- `src/stages/review.ts`
- `src/stages/retrievalIndex.ts`
- `src/stages/retrievalSearch.ts`
- `test/review.test.ts`
- `test/renderSnapshot.test.ts`
- `test/reviewObservation.test.ts`
- `test/editIntent.test.ts`
- `test/retrieval.test.ts`

### 変更

- `src/stages/frames.ts`
- `src/stages/editorAi.ts`
- `src/stages/av.ts` または A/V parser helper
- `src/lib/llm.ts`
- `src/lib/config.ts`
- `src/lib/files.ts`
- `src/mcp/tools.ts`
- `src/cli.ts`
- `editor/server.ts`
- `editor/client/apiTypes.ts`
- `editor/client/App.tsx`
- `editor/client/DiffReview.tsx`
- `editor/client/widgets.tsx`
- `prompts/editor-ai-propose.md`
- `AGENTS_CONTRACT.md`
- `README.md`
- `docs/usage.md`
- `docs/decisions.md`

---

## 10. 実装タスク

### Phase 1: snapshot rendering

1. `EditSnapshot` と変換関数を追加。
2. `buildSnapshotRenderProps` を追加。
3. `frames.ts` を共通コアへ移行。
4. 既存 frames test の挙動を維持。
5. candidate snapshot の still test を追加。

完了条件:

- ディスク上 transcript と異なる candidate text を、JSONを書かずにPNGへ描画できる。
- 既存 `frames` command の出力が変わらない。

### Phase 2: deterministic ReviewBundle

1. `ReviewSpec` 検査・正規化。
2. selection slicer。
3. before/after still。
4. review clip。
5. deterministic observation。
6. `review.probe/index.json`。
7. generated classification 更新。

完了条件:

- cut/caption/blur変更のbefore/afterが同一APIで生成できる。
- clip失敗時もstillが返る。
- review実行でeditable filesのmtimeが変わらない。

### Phase 3: GUI

1. `/api/ai/review`。
2. review heavy job lock。
3. structured `review.frames`。
4. DiffReviewへcomparison panel。
5. hunk resolution変更時stale化。

完了条件:

- AI提案を保存前に比較できる。
- 比較後に採否を変えるとstale warningが出る。
- 保存/approval境界は既存と同じ。

### Phase 4: high-level tools

1. `EditIntent` schema。
2. compiler。
3. editor AI response union。
4. `cutflow_edit` MCP。
5. promptをtasks優先へ更新。

完了条件:

- range cutでsegment分割をAIに直接書かせない。
- trim pausesが決定論的。
- compiler結果は必ず`planApply`を通る。

### Phase 5: retrieval

1. tokenizer/scorer。
2. incremental index。
3. CLI index/search。
4. MCP search。
5. GUI promptへの限定注入。

完了条件:

- 日本語queryでmaterial OCR/transcript候補が返る。
- API keyなしで動く。
- 他recordingを変更しない。

### Phase 6: VLM

1. capability。
2. OpenAI/Anthropic adapter。
3. VLM review schema/prompt。
4. opt-in config/UI。
5. graceful fallback。

完了条件:

- provider非対応でもReviewBundleが成功。
- VLM responseにpatch/pass/failが存在しない。
- 画像送信offが既定。

---

## 11. テスト計画

### 11.1 純関数

`review.test.ts`:

- selection range + pad
- selected IDsの外接範囲
- playhead前後
- frame優先順位
- 最大件数
- clip/range clamp
- source/output axis

`editIntent.test.ts`:

- segment中央をcutして3分割
- 複数segment跨ぎ
- 隣接merge
- id維持/新規採番
- approved不変
- trim pauses
- bounds error
- material path traversal拒否

`retrieval.test.ts`:

- NFKC
- ASCII word
- 日本語2/3-gram
- title/file weighting
- kind/scope filter
- stable ordering

### 11.2 stage

`renderSnapshot.test.ts`:

- disk baseとcandidate caption差
- candidate cutplanのoutput写像
- short snapshot

`reviewObservation.test.ts`:

- duration delta
- clipping fail
- freeze warn
- OCR unsupported skip

### 11.3 server

`editorServer.test.ts`:

- `/api/ai/review` validation
- approved強制
- candidateを書かない
- max frames
- heavy job conflict
- media serving under `review.probe`

### 11.4 MCP

`mcpTools.test.ts`:

- tool一覧を更新
- `cutflow_edit` dry-run
- `cutflow_edit` write
- `cutflow_search` read-only
- forbidden tool不変

### 11.5 LLM

`editorAi.test.ts`:

- tasks response parse
- patch fallback
- compiled patch
- structured review frames
- 旧string frames compatibility
- VLM capability false fallback
- API requestに画像が入り、ログ/response schemaは守られる

### 11.6 回帰

必須:

```sh
npm test
npm run typecheck
```

実メディア fixture がある場合:

```sh
node src/cli.ts validate <dir>
node src/cli.ts frames <dir> --t 10,20
node src/cli.ts av <dir> --range 10-20
```

手動GUI:

1. caption変更を提案。
2. 保存前にbefore/after still確認。
3. hunkを不採用へ変更しstale表示確認。
4.再比較。
5.保存。
6. validation成功。

---

## 12. 受入条件

P1 完了は次をすべて満たした状態とする。

1. GUI AI提案を保存せずにbefore/after stillで比較できる。
2. selection/playheadから最大30秒のbefore/after clipを生成できる。
3. ReviewBundleにstructure/motion/sound/OCRの決定論的結果が入る。
4. `review.frames` が時刻軸・理由付きの構造化データになる。
5. range cutとtrim pausesがtask-level intentで実行できる。
6. task-level intentの結果が`planApply`を必ず通る。
7. MCPからreview/edit/searchを利用できる。
8.過去recording/materialをローカル検索できる。
9.検索はread-onlyで、他recordingを変更しない。
10. VLM off/unsupportedでも全workflowが成立する。
11. VLMは観測コメントだけを返し、patch/approval/pass/failを返さない。
12. review/retrieval artifactがgeneratedとして契約に記載される。
13. `npm test` と `npm run typecheck` が通る。

---

## 13. 実装時に避ける近道

- candidate JSON をrecording folderへ一時保存して既存framesを騙す。
- beforeだけdisk、afterだけclient stateという異なる描画経路を使う。
- `av.probe/` をreviewのたびに上書きする。
- review生成のためにproposalを先に保存する。
- VLMの文章をそのままwarning/failへ昇格する。
- retrievalのために外部embedding APIを必須化する。
- high-level toolから直接JSONを書き、`planApply`を迂回する。
- annotation ID対応を他のtaskと混ぜて巨大化する。
- clip生成失敗でstill/structure結果まで捨てる。

---

## 14. 最終的な製品フロー

```text
ユーザー:
  「この選択範囲の間を詰めて、ログインボタンを目立たせて」

AI:
  trim-pauses + add-annotation の task proposal

cutflow:
  task compiler
  -> ApplyPatch
  -> planApply
  -> diff review

ユーザー:
  「比較を生成」

cutflow:
  selection slicer
  -> before/after still
  -> before/after clip
  -> structure/motion/sound/OCR
  -> optional VLM note

ユーザー:
  hunkを採用/不採用
  -> 保存
  -> validate
  -> 人間のapproval
```

この形であれば、P1は単なるtool追加ではなく、既存のAgent-ready NLEを
「観測可能で、比較可能で、過去資産を再利用できるAI編集製品」へ進める変更になる。
