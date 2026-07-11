# 実装設計書 SD4: H1 + H2 — pull 型知覚 + 検証主経路化(単発 completion を脱する)

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§7 の SD4。
> 関連: SD2(`2026-07-11-c1-word-candidate-grid-design.md`・実装済み)/ SD3(`2026-07-11-x4-editing-aggressiveness-design.md`・実装済み)。
> 本書は **H1(知覚を pull 型に)+ H2(検証を主経路へ)= 母艦 §4「ハーネス」** を、実装担当(弱いモデル想定)が
> 着手できる粒度まで落とした設計書。**H1+H2 だけが対象**。H6(apply による R0 突破)は **含めない**(=SD5)。
>
> **前提となる確定方針(母艦 §3.5・§6 D6):** 良い格子(SD2/C1)が入った後、判断 LLM に **tool を握らせ**、
> **検証をループの主役**にする。ここで初めて cut 判断が「単発 structured completion」から
> 「tool + ループ + 検証」のエージェントになる。ただし **既定化はしない**(§3.5 の限界: agentic を
> 既定にすると再現性が崩れる)。`plan.perception` と同じく **opt-in / sticky / off 時バイト等価**。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **判断 LLM に read-only の知覚 tool を握らせる(H1)。** 現状 `perception.ts` が事前計算して
  プロンプトへ**焼き込む push 型・一律・長尺偏り・中点1枚**(母艦 §3.4.2d / §3.5)をやめ、
  判断 LLM が**迷った候補にだけ自分で** `describe` / `frames`(実画像)/ `av` / `materials` / `ocr` を
  引けるようにする。tool は既存の知覚コマンド関数の薄いラッパ。
- **検証を判断ループの主役にする(H2)。** `assert`(決定論)+ describe 射影 + VLM 二次観測を、
  LLM が**能動的に叩ける tool**にし(pull)、かつ書き込み後の観測を次ターンへ戻す(push-back)。
  現状の `runCutsLoop`(opt-in・push のみ・構造観測のみ・二次観測は受動)を、tool 接地の
  「生成→検証→再判断」ループへ格上げする。
- **エージェント本体を1つの新モジュールに閉じ込める。** 既存のアダプタ(`registry.ts`)は触らず、
  新規 `src/lib/ai/agenticCut.ts` に**有界の tool-use ループ**を実装する。参照実装は
  `anthropic` アダプタの `/v1/messages` tool_use プロトコル1本(§3-B)。
- **opt-in ゲート `plan.harness`(既定 off)。** off のとき、既存の単発 / push ループ経路と
  **バイト等価**(§1-1)。

**本書でやらないこと(混同禁止 — 誤って踏むと R0 や再現性を壊す):**
- **番号選択方式は維持する。** LLM の**最終出力は今と同じ** `cuts: [{id, reason}]`。tool は全て
  **read-only**(`apply` / 任意区間書き込みは**渡さない**)。よって `buildCutplan` の 1:1 写像=
  **R0(非分割の壁)はそのまま**。R0 を越える apply 分割は **SD5(H6)**。SD4 は行動空間を
  広げも狭めもせず、**同じ行動空間の中で判断品質を上げる**だけ(母艦 §3.5 の**軸 B**)。
- **既定化しない。** 母艦 §3.5「限界(正直に)」の通り agentic 既定は再現性を壊す。
  H2 の「主経路へ」は **「有効時に検証がループの主役になる」意味**であって
  **「既定 on」ではない**(§1-2。SD3 が balanced を既定にしたのと**逆**なので混同しない)。
- **アダプタを増やさない・全プロバイダ対応にしない。** 参照実装は1プロバイダ(`anthropic`)。
  tool 非対応アダプタでは **警告して既存の単発/push 経路へフォールバック**(§1-4・OCR の
  macOS 依存フォールバックと同じ思想)。
- **知覚ロジックを作り直さない。** tool 実装は `describeJson` / `renderFrames` / `av` / `materials` /
  `computeSegmentOcr` / `assert` の**薄いラッパ**。新しい知覚計算は書かない。
- **プロンプト文言(editMode=SD3・perception=既存)を作り直さない。** editMode ブロックは
  agentic ループの**方針入力としてそのまま生きる**(§3-D)。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **`plan.harness` off でバイト等価(最重要の逃げ道):** `plan.harness.agentic` が未設定/false の
   とき、`plan --cuts-only`(および `plan`)の経路・生成プロンプト・`cutplan.json` は
   **導入前と1バイトも変わらない**。agentic コードは**分岐の中だけ**で走り、off のときは一切
   呼ばれない。これが回帰基準線(`baseline`/`after-w0`/`after-c1`/`after-x4`)を SD4 導入後も
   再現できる根拠。**agentic の効果は別スナップショット `after-h1h2` で測る**(SD1 Part A)。
2. **「主経路化」≠「既定 on」(SD3 と逆):** H2 は**有効時に**検証(assert+観測)を判断の主役に
   するが、**機能全体は opt-in/sticky** を守る。SD3(X4)は既定を balanced に**変えた**が、
   SD4 は既定を**変えない**。ここを取り違えて agentic を既定 on にしない。
3. **番号選択・R0 維持(ハルシネーション耐性):** LLM 最終出力は `cuts:[{id,reason}]` のみ。
   存在しない候補 id は**既存の検査で拒否**(番号選択の安全網はそのまま)。tool は read-only で、
   LLM は timeline を直接書けない。**候補内部分割は起こらない**(R0 は SD5 まで不変)。
4. **未対応環境は安全側へ劣化:** 設定プロファイルのアダプタが tool-use 非対応、または
   agentic 実行中に回復不能エラーのとき、**警告して既存の単発/push 経路へフォールバック**し
   `cutplan.json` は必ず生成する(例外で plan 全体を落とさない)。frames/OCR が macOS 依存で
   劣化するとき frame tool は**空結果+警告**を返し、ループは続行する。
5. **有界(コスト・レイテンシの天井):** ツール呼び出し総数 `maxToolCalls` と生成反復
   `maxIterations`(既存 loop と共有)で**必ず上限**を持つ。上限到達時はその時点の最良 cuts で
   確定する(母艦 §3.5 の正直なコスト限界=「候補ごと frames 撮影ループはローカルで遅い」への歯止め)。
6. **決定性の範囲を明示:** agentic 経路は LLM の tool 選択に依存するため**バイト等価は保証しない**
   (§1-1 は off 時のみ)。ただし tool 実装(describe/frames/av/…)自体は決定論で、
   **同じ tool 呼び出し引数には同じ結果**を返す(キャッシュ層 `av.probe`/`materials.probe` を再利用)。
7. **中間生成物の分類を守る:** agentic のトレース(tool 呼び出し・結果ダイジェスト)は
   `plan.loop.json` を拡張して残す(**中間生成物・再実行で上書き**。手編集対象外)。
   `cutplan.json` 以外の**編集ファイルは書かない**。`approvals.json` には**一切触れない**。

## 2. ハーネスの形(tool セットとループ — 実装の実体)

### 2.1 tool セット(全て read-only。H1=知覚 / H2=検証)

| tool 名 | 役割 | 実装(既存関数の薄いラッパ) | 返す型 |
|---|---|---|---|
| `describe_timeline` | 現在の暫定 cutplan の keep/cut・発話・元秒⇔出力秒を読む(H1) | `describeJson(dir, cfg)`(`stages/describe.ts:917`) | JSON(DescribeProjection の要約) |
| `get_frames` | 指定時刻の**最終合成の実画像**を見る(H1・push では不可能だった高帯域) | `renderFrames(...)`(`stages/frames.ts:121`) | **画像パート配列**(vision route) |
| `probe_av` | 出力レンジの motion/sound(無音・freeze・被り)を読む(H1) | `av(dir, {range,...}, cfg)`(`stages/av.ts:99`) | JSON(`formatAvSummary` 相当) |
| `probe_materials` | 素材メタ(尺・参照・未使用/dangling)を読む(H1) | `materials(dir, ...)`(`stages/materials.ts:98`) | JSON(index 要約) |
| `ocr_screen` | 指定時刻の画面内テキストを読む(H1) | `computeSegmentOcr(...)`(既存・plan.ts:339 で使用中) | JSON(text/lines) |
| `set_cuts` | 暫定カット選択を書いて観測を得る(H2 の心臓) | `buildCutplan` → `cutplan.json` 書込 → `assert(dir)` + describe 観測 | JSON(assert 結果+出力尺+観測) |
| `run_assert` | 明示的に決定論アサーションだけ再評価(H2) | `assert(dir, opts)`(`stages/assert.ts:420`) | JSON(AssertOutcome[]) |

> **`set_cuts` が H2 の主経路化の実体**: LLM は「候補 id を選ぶ→書く→**その場で assert と出力尺と
> 観測が返る**→直す」を tool 越しに回す。現状 `runCutsLoop` が固定手順でやっていた
> 「生成→観測→再生成」を、LLM が**能動的に**駆動する形へ移す(=検証がループの主役)。
> **`set_cuts` は cutplan.json しか書かず、任意区間は書けない**(候補 id 選択のみ=R0 維持)。

### 2.2 ループ契約(有界エージェント)

1. 初回システム/ユーザーメッセージ = 既存の `plan-cuts.md` プロンプト(候補一覧・editMode ブロック
   ・perception は**最小限**に。H1 の pull があるので push perception は縮小してよいが、**縮小は
   off 経路に影響しない**よう agentic 経路だけで差し替える)+ tool 使用のガイド(「迷った候補だけ
   frames/av/ocr を引け」「確定前に set_cuts で検証しろ」)。
2. LLM が tool を呼ぶ → ラッパ実行 → tool_result を返す → 繰り返し(`maxToolCalls` まで)。
3. LLM が最終回答(`cuts:[{id,reason}]`)を **`CUTS_RESPONSE_SCHEMA` で構造化**して返す
   (既存 `completeStructuredCuts` と同じスキーマ=パーサ再利用)。
4. 停止条件は既存 `shouldStop`(assertions-pass / fixpoint / max-iterations)を**共有**し、
   `set_cuts` の観測を跨いで判定する。上限到達時は最後に `set_cuts` した cuts で確定。

## 3. 変更点の全体像(新規2 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/ai/agenticCut.ts`(新規) | 有界 tool-use ループ本体・tool レジストリ(read-only)・最終 cuts 抽出 |
| B | `src/lib/ai/registry.ts`(+ `types.ts`) | `anthropic` アダプタに **tool_use マルチターン** を足す(`complete` は不変、新 `completeAgentic` を追加) |
| C | `src/lib/config.ts` | `plan.harness` 設定型 + `resolvePlanHarnessCfg` + `plan` の `unknownKeys` に `"harness"` 追加(既定 off) |
| D | `src/stages/plan.ts` | `plan.harness.agentic` on のとき `runCutsLoop` の per-iteration `complete` を agentic ターンへ差し替える分岐 |
| E | `config.yaml` + `docs/usage.md` + `AGENTS_CONTRACT.md` | `plan.harness` 追記・opt-in/バイト等価の明記・`plan.loop.json` 拡張の記載 |
| F | テスト | `test/agenticCut.test.ts`(tool ループを fake アダプタで駆動)+ off 時バイト等価の固定 |

**5点セット判断**: 収録フォルダの JSON スキーマ(cutplan 等)は**不変**(番号選択のまま)。
`plan.loop.json` は**中間生成物**でトレース欄を足すだけ(スキーマ検査対象外)。よって
`schemas/*.schema.json` は**変更不要**。ただし **`AGENTS_CONTRACT.md` は要確認**:
CLI コマンド名・ファイル分類は増えない(`plan` のまま・新ファイルは生成物 `plan.loop.json` 内)
ので `test/agentsMd.test.ts` は落ちない見込みだが、`config.yaml` に `plan.harness` を足す点だけ
docs へ反映する(契約テストが config キーを固定していないことを実装時に確認)。

### A. `src/lib/ai/agenticCut.ts`(新規・骨子)

> **フル実装をここに書き下さない**(anthropic tool ループは長い)。**契約と各 tool の
> ラップ先を確定**するので、実装担当は既存関数を呼ぶだけにする。**新しい知覚計算は書かない。**

```ts
import type { Config } from "../config.ts";
import type { NumberedSegment } from "../../stages/plan.ts"; // 既存の型
import type { LoopCut } from "../planLoop.ts";

/** read-only 知覚 + 検証 tool の JSON-Schema 定義(anthropic tools 形式)。
 *  §2.1 の7 tool。各 handler は既存関数の薄いラッパで、副作用は set_cuts の
 *  cutplan.json 書込だけ(任意区間は書けない=候補 id 選択のみ)。 */
export interface CutTool {
  name: string;
  description: string;
  inputSchema: object;
  // 返り値は text か 画像パート。frames だけ画像を返す。
  handle(args: unknown, ctx: AgenticCtx): Promise<{ text?: string; images?: AiImagePart[] }>;
}

export interface AgenticCtx {
  dir: string;
  cfg: Config;
  numbered: NumberedSegment[];
  idCtx?: { used: Set<string>; existingCutplanSegments: unknown[] };
  budget: { maxToolCalls: number; used: number };
  warn: (msg: string) => void;
  trace: AgenticTraceEntry[]; // plan.loop.json に載せる
}

export interface AgenticTraceEntry {
  tool: string;
  argsDigest: string;   // 引数の短い要約(生 args は載せない)
  resultDigest: string; // 結果の短い要約 or 画像枚数
}

export interface AgenticResult {
  cuts: LoopCut[];        // 最終 cuts(番号選択・buildCutplan がそのまま食える)
  trace: AgenticTraceEntry[];
  raw: string;            // 最終構造化応答(plan.raw.txt 用)
  degraded: null | string; // フォールバックした理由(あれば)。null=agentic 完走
}

/** 1回の「生成ターン」= tool を使いながら最終 cuts を1つ得る。
 *  runCutsLoop の per-iteration complete() を置き換える単位。
 *  - firstPrompt: plan-cuts.md 展開済み(editMode ブロック込み)
 *  - 最終回答は CUTS_RESPONSE_SCHEMA で強制し、既存パーサで cuts を取る
 *  - budget 超過 / tool_use 非対応 / 回復不能エラー → degraded を立てて
 *    「tool 無しの単発 complete 結果」を cuts に入れて返す(§1-4 フォールバック) */
export async function agenticCutTurn(args: {
  firstPrompt: string;
  ctx: AgenticCtx;
}): Promise<AgenticResult> { /* ... anthropic tool_use ループ ... */ }
```

**tool のラップ先(実装時にこの関数を呼ぶだけ・新規計算禁止):**
- `describe_timeline` → `describeJson(dir, cfg)`(`stages/describe.ts:917`)。要約して text で返す。
- `get_frames` → `renderFrames(...)`(`stages/frames.ts:121`)。生成 PNG を `AiImagePart[]` で返す。
  **時刻は候補内へスナップ**(既存 frames の挙動)。macOS 非対応や insert 無映像は空+警告(§1-4)。
- `probe_av` → `av(dir, {range,...}, cfg)`(`stages/av.ts:99`)+ `formatAvSummary`。
- `probe_materials` → `materials(dir, {...})`(`stages/materials.ts:98`)。index 要約。
- `ocr_screen` → `computeSegmentOcr(...)`(plan.ts:339 で既に呼んでいる関数を再利用)。
- `set_cuts` → `buildCutplan(numbered, cuts, idCtx)` → `cutplan.json` 書込 → `assert(dir)` +
  `describeJson` の出力尺/keep 数を text で返す。**cuts は候補 id 配列のみ受理**(範囲外 id は
  拒否メッセージを返し書かない=番号選択の安全網)。
- `run_assert` → `assert(dir, opts)`(`stages/assert.ts:420`)。

### B. `src/lib/ai/registry.ts`(anthropic に tool_use マルチターン)

- **既存 `anthropicAdapter.complete` は変更しない**(structured_output の forced tool は現状のまま)。
- **新規** `anthropicAdapter.completeAgentic?(request, tools, profile, context)` を追加(任意メソッド)。
  `/v1/messages` を **tool_use が消えるまでループ**で叩く:
  1. `tools` に §2.1 の CutTool を JSON-Schema で載せる。
  2. 応答に `tool_use` があれば handler を実行 → `tool_result`(画像は image ブロック)を
     messages に足して再送。
  3. `stop_reason` が `end_turn`(または最終 `structured_output` forced tool)になったら
     最終 cuts を取り出す。
  4. `context.signal` で中断可能・`maxToolCalls` で有界。
- `AiAdapter` 型(`ai/types.ts`)に `completeAgentic?` を**任意**で足す。持たないアダプタは
  **capability 無し**=フォールバック対象(§1-4)。
- 他アダプタ(openai/codex/openai-compatible/claude-code)には**足さない**(参照実装は anthropic 1本)。

> **なぜ `claude -p` + `mcp <dir>` を使わないか(採らなかった代替・実装者が迷わないため):**
> 既存の `mcp <dir>` サーバ + `claude -p` にツール駆動を委ねる手もあるが、(1)`mcp` は `apply` を
> 露出する=SD4 で禁止の任意区間書込(R0/SD5 領分)を防げない、(2)Claude Code セッションから
> **最終 `cuts` を構造化で強制・抽出しにくい**、(3)決定論・テスト容易性が落ちる。よって
> **read-only tool を明示レジストリで持つ自前の有界ループ**(anthropic)を採る。

### C. `src/lib/config.ts`

- `Config["plan"]` に任意フィールド追加(`loop` の並びの近く):
  ```ts
  /** cut 判断を tool + 検証ループのエージェントにする(H1/H2)。opt-in。
   *  省略/agentic=false のとき従来の単発/push ループとバイト等価(SD4 §1-1)。 */
  harness?: {
    agentic?: boolean;        // 既定 false
    maxToolCalls?: number;    // 既定 16(有界。§1-5)
    tools?: {                 // 個別 tool の on/off(既定は全 on)
      frames?: boolean; av?: boolean; materials?: boolean; ocr?: boolean;
    };
  };
  ```
- `resolvePlanHarnessCfg(cfg)` を追加(`resolvePlanLoopCfg` の隣)。既定を埋めて返す純関数。
- **`plan` 直下の `unknownKeys` 許可に `"harness"` を追加**(SD3 で `editMode`、SD2 で `candidates`
  を足したのと同じ場所。**足し忘れると validate が落ちる**)。
- `planHarnessEnabled(cfg): boolean` を足す(`planLoopEnabled` と同型)。agentic かつ
  対象プロファイルのアダプタが `completeAgentic` を持つときだけ true(持たなければ false=off 経路)。

### D. `src/stages/plan.ts`(分岐の配線)

- `runCutsLoop` の中、per-iteration の `raw = await args.complete(prompt, cfg)`(`plan.ts:502`)を、
  **`planHarnessEnabled(cfg)` の時だけ** `agenticCutTurn({firstPrompt: prompt, ctx})` に差し替える。
  agentic の返す `cuts` をそのまま `buildCutplan` へ流す(以降の観測・stop・plan.loop.json は既存流用)。
- **agentic は cuts-only 経路(`plan --cuts-only`)だけに入れる**(full `plan` の章/タイトル同時
  生成には入れない=cut 判断への集中。母艦 D5/C14 の思想)。full `plan` 経路と remeta/plan-shorts は**不変**。
- `planHarnessEnabled` が false のときは**現在のコードのまま**(§1-1 バイト等価)。1行の分岐で挟む。
- agentic の `trace` を `plan.loop.json` の各 iteration に `agenticTrace?: AgenticTraceEntry[]` として
  足す(**中間生成物**・既存 `PlanLoopLogEntry` を拡張。§1-7)。
- **`plan.harness.agentic` on だが `loop` 未設定のとき**: agentic は最低 `maxIterations>=2` の
  ループを要するので、`resolvePlanLoopCfg` の既定を「harness on なら maxIterations=2 以上」に
  昇格させる(harness を on にしたのにループが1ショットで agentic の検証が回らない事故を防ぐ)。

### E. `config.yaml` + `docs/usage.md` + `AGENTS_CONTRACT.md`

- `config.yaml` の `plan:` に**コメントで**追記(**既定 off を明示**):
  ```yaml
  plan:
    # harness:
    #   agentic: false      # cut 判断を tool+検証ループのエージェントにする(H1/H2)。
    #                       # 既定 false=従来の単発/push ループとバイト等価。要 ai.provider=anthropic。
    #   maxToolCalls: 16    # 1生成あたりの tool 呼び出し上限(コスト/レイテンシの天井)
  ```
- `docs/usage.md`: 「plan のエージェント化(plan.harness・H1/H2)」節を新設。opt-in・要 anthropic・
  read-only tool(frames/describe/av/materials/ocr/assert)・**番号選択と R0 は維持(任意区間は
  書けない)**・off 時バイト等価・`plan.loop.json` にトレースが載ることを記す。
- `AGENTS_CONTRACT.md`: ファイル分類・CLI コマンドは**増えない**が、`config.yaml` の `plan.harness`
  キーを反映(契約テストが落ちないことを `npm test` で確認)。

## 4. テスト(`test/agenticCut.test.ts` 新規)

**LLM を実際に叩かない。** fake アダプタ(スクリプト化した tool_use 列を返す)でループを駆動する:
- **off 時バイト等価(最重要)**: `plan.harness` 無し / `agentic:false` で `runCutsLoop` 相当を
  走らせ、生成プロンプト・`cutplan.json` が**導入前と一致**(agentic 分岐に入らない)。
- **tool ループの往復**: fake が `get_frames`→`set_cuts`→最終 `cuts` を返す台本で、
  各 handler が正しい既存関数を呼び(モック)、最終 `cuts` が `buildCutplan` に渡ることを確認。
- **番号選択の安全網**: `set_cuts` に**存在しない候補 id** を渡す台本 → 書き込まれず拒否メッセージが
  tool_result に入る(R0/ハルシネーション検査が agentic 経路でも効く)。
- **有界**: `maxToolCalls` を 2 に設定し、fake が延々 tool を呼ぶ台本 → 上限で打ち切り、
  最後の `set_cuts` の cuts で確定する。
- **フォールバック**: アダプタが `completeAgentic` を持たない(claude-code 等)設定 →
  `planHarnessEnabled` が false になり、単発経路の cutplan が出る(警告付き・例外なし)。
- **トレース**: `plan.loop.json` の iteration に `agenticTrace` が載り、生 args を含まない
  (ダイジェストのみ)ことを確認。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```

- 実測(**要 `ai.provider=anthropic`**・W0 済み words 付き収録1本・中立 cwd から絶対パス=
  `memory/llm-command-verify-neutral-cwd.md`):
  1. `plan.harness` 無しで `plan --cuts-only`(loop 有効時)→ **導入前と同一**(off 経路=§1-1)。
  2. `plan.harness.agentic: true` で `plan --cuts-only --force`(手編集無い前提)→
     `plan.loop.json` に `agenticTrace`(frames/av/ocr/set_cuts の往復)が載ること、
     `cutplan.json` が **候補 id のみ**で構成されること(任意区間が無い=R0 維持)を確認。
  3. tool 非対応プロバイダ(例 openai)で agentic on → **警告してフォールバック**し
     cutplan が出る(落ちない)ことを確認(§1-4)。
  4. `after-h1h2` スナップショット(SD1 Part A)を取り、`after-x4` と diff。
     **agentic の効果は他施策と分けて評価**(格子・積極度は固定、ハーネスだけ切り替えた差分)。
- **完了報告は実測ログ付き**(母艦の運用: 完了報告は必ず実測検証)。

## 6. 受け入れ基準

- `plan.harness` off で `plan --cuts-only` が導入前と**バイト等価**(生成プロンプト・cutplan)。
- agentic on(anthropic)で、判断 LLM が read-only tool(frames/describe/av/materials/ocr/assert/set_cuts)を
  往復し、`plan.loop.json` にトレースが残る。
- 最終出力は `cuts:[{id,reason}]` のみ。**存在しない id は拒否**され、cutplan に任意区間が
  混ざらない(R0・番号選択が agentic 経路でも保たれる)。
- tool 非対応アダプタ / 回復不能エラーで**例外を投げず**単発経路へフォールバックし cutplan を出す。
- `maxToolCalls` / `maxIterations` で有界(無限ループ・青天井コストなし)。
- `plan.harness.agentic` は**既定 off**(既定を変えていない)。
- `npx tsc --noEmit` と `npm test`(off 時バイト等価テスト含む)が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- SD4 で cut 判断は**エージェント**になった(pull 知覚 + 検証ループ)。ただし出力はまだ
  **番号選択**で、**R0(候補内部を割れない)は残っている**。行動空間はそのまま=軸 B の施策。
- 次は **SD5(H6・apply ハイブリッド)**: 確信の高い区間だけ `set_cuts` を **`apply`+validate/assert**
  に差し替え、**候補内部を語境界で分割**して書けるようにする(番号選択を安全網に残しつつ R0 を
  **直接**突破 = 確定方針 D1)。SD4 の有界ループ・tool レジストリ・トレース・フォールバックは
  そのまま SD5 の土台になる(`set_cuts` を書き込み権限付きへ拡張する一点差)。
- 証拠接地の出力(H3・母艦 X2/X3)は SD4 の `trace`(見たフレーム・引いた assert)を
  各 cut の `reason` へ紐づければ自然に揃う。SD4 完了後に小さく足せる。
