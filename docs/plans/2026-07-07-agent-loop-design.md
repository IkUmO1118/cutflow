# 内部 LLM を1ショットからエージェントループへ(観測→再調整) — 設計

*2026-07-07 / 診断レビュー NEXT・Theme B「AI の行動インターフェース」#5 の設計。実装は別担当。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ B「AI の行動インターフェース」/ 項目「**内部 LLM が1ショットで、
> エージェントループ(観測→再調整)になっていない**」= severity **major** /
> effort **L**。
>
> 現状 `plan` / `remeta` は `src/lib/llm.ts` の `complete()` を **1 回叩くだけ**の
> 盲目バッチ。生成結果を LLM 自身が観測して直す機構が無い。本設計は
> `plan --cuts-only`(カット判断)を **1 ショット completion から
> 「生成 → 観測 → 自己批評 → 再調整」の有限反復ループ**へ拡張する。
>
> **既定オフ・opt-in が絶対の制約**: `plan.loop.maxIterations` が既定 `0`(=1 と
> 同義=従来1ショット)である限り、`plan` / `remeta` の LLM 入力・出力・書き
> 込みファイルは **導入前とバイト等価**。ループは cutflow の思想(決定論の観測・
> 承認境界不可侵・依存追加ゼロ・純関数への切り出し)を1つも壊さない。

---

## 背景とギャップ

`plan --cuts-only` の現状(`src/stages/plan.ts` の `plan()`、`opts.cutsOnly`):

1. `numberSegments(auto.keepSegments, transcript)` で「`#id [開始-終了秒] 発話`」の
   番号付きリストを作る。
2. `renderPrompt(dir, "plan-cuts.md", numbered, duration, perception)` でプロンプト。
3. `complete(prompt, cfg)` を **1 回**。生応答を `plan.raw.txt` へ。
4. `parseCutsResponse(raw)` → `buildCutplan(numbered, cuts, idCtx)` → `cutplan.json`。

生成した cutplan を LLM 自身が観測しない。「出力尺は要件内か」「見せ場は残ったか」
「切りすぎ/残しすぎか」を確かめるのは人間(`preview` / エディタ)まで降りて初めて。
一方 cutflow には**観測を決定論で完全射影する既存資産**が既に揃っている:

- `describeJson(dir)`(`src/stages/describe.ts`)= 編集状態の機械可読な完全射影
  (`summary.outDurationSec` / `keepCount` / `keptSec` / `keeps[]` / `cuts[]` …)。fs
  読み取り・決定論・全環境。
- `evaluateStructural(proj, spec)`(`src/stages/assert.ts`)= `DescribeProjection` 射影
  だけを入力に、`assertions.json`(`AssertionsDoc`)の期待値を pass/fail/skip/error で
  照合する**純関数**。fs 非依存・数ミリ秒。
- `buildCutplan` / `numberSegments` / `parseCutsResponse` = カット決定の組み立てと
  パースの純関数(再利用できる)。

**「観測 → 再調整」の欠けているピースは、生成物を機械的に観測して LLM に返し、
LLM に cut 集合を修正させ、決定論的な停止条件で止める“オーケストレータ”だけ**。
新しい知覚経路も新フレームワークも要らない。

---

## スコープの1行宣言

**`plan --cuts-only`(カット決定)だけ**を、複数反復の「生成 → 観測 → 批評+再調整
→ 停止」ループに載せる。他コマンド(full `plan` / `remeta` / `plan-shorts` / `run`)は
**一切変更しない**。ループ機構はモック可能・純関数中心で、`complete` は DI 差し替え。

---

## 論点1: どのコマンドをループ化するか → **決定: `plan --cuts-only` だけ**

| 案 | 中身 | 判定 |
|---|---|---|
| **(a)** | `plan --cuts-only`(カット決定)だけをループ化。full `plan` / `remeta` は1ショットのまま | **採用** |
| (b) | full `plan`(cuts+章+タイトル+概要欄を同時生成)もループ化 | **却下**。観測面が混在する。カットは `outDuration`/`keepCount`/`timeKept` に決定論射影できるが、章割り・タイトルの「良さ」は主観で決定論観測に落ちない。1つの観測サマリに異質な指標が混じり、停止条件が曖昧になる |
| (c) | 共通ループ基盤を作り `remeta`(章/メタ)も同時に両対応 | **却下(今は)**。章/メタは「意図を満たしたか」を機械観測しにくい(尺のような硬い制約が無い)。**基盤は汎用に切り出す**(論点5 の純関数群・`ObservationProvider`)が、**配線は cuts-only 1 本に絞る**。remeta 対応は基盤が実証されてからの別テーマ |

**決定と理由**

- カット決定は「detect が出した固定スパン集合の各要素を keep/cut に振る」問題で、
  結果が `outDurationSec`(尺)・`keepCount`・`timeKept`(特定秒が残ったか)という
  **硬い決定論量**に完全射影される。ループが最も効くのはまさにこの「尺要件・
  見せ場保持を守れているか」を反復で締める工程。
- スコープを絞ることが最大の安全策(effort L を膨らませない・バイト等価の証明面を
  最小化)。cuts-only 以外の経路にはループのコードパスが一切通らない。

---

## 論点2: 観測の情報源と整形 → **決定: describeJson 射影 + `evaluateStructural`(Tier 1)を主軸。要件源は「assertions.json ∪ config の目標尺」。A/V は seam だけ**

観測は3層で構成し、**Tier 1(構造・決定論・全環境)だけをループに接続**する。

| 層 | 情報源 | ループでの扱い |
|---|---|---|
| 構造観測 | `describeJson(dir)` の `summary`(尺・keep数)+ `evaluateStructural` の pass/fail | **主軸(採用)**。決定論・数ミリ秒・全環境 |
| 要件(期待値)の宣言 | `assertions.json`(あれば)∪ config `plan.loop.targetOutDurationSec` から派生した内部アサーション | **採用**。要件が無ければ「尺が縮み過ぎ/残り過ぎていないか」の一般観測だけ返す |
| 視覚/A・V 観測 | `assert --visual`(OCR)/ F2 の実 A/V(動き+音) | **今回は非接続**。`ObservationProvider` インターフェースの seam だけ置き、F2 に委ねる(macOS 依存・低速でループの決定論・全環境性を壊すため既定では入れない) |

**観測 → LLM のテキスト整形**(critique プロンプトの新プレースホルダ `{{observation}}`):

```
## 直前の編集の観測結果(この編集が狙いを満たしているかの機械計測)

- 出力尺: 312.4 秒(目標: 300 秒以下)→ 12.4 秒 超過
- keep 区間数: 18 / カット区間数: 7
- 期待値の照合(assertions.json + 目標尺):
  - [fail] 出力尺 312.4 <= 300: 満たされていません
  - [pass] 元 0:45 は keep 内(見せ場①)
  - [fail] テロップ @cap_7x2f「結論はこうです」は本編に残っている: 満たされていません
- 現在のカット選択(id / 理由):
  #3 同じ説明の言い直し(前半) / #11 本題と無関係な脱線
```

- 出所: `summarizeObservation(proj, outcomes, loopCfg)` という**純関数**が
  `DescribeProjection` と `AssertOutcome[]` から上のテキストを組む(fs 非依存=テスト
  可能)。
- 要件源の優先: **(1) `assertions.json`(作者/AI が置いた第一級の期待値)**、
  **(2) config `plan.loop.targetOutDurationSec`(目標尺。あれば `outDuration <=` の
  内部アサーションに変換)**、**(3) `brief.md`(見せ場)** は既に generate プロンプトに
  注入済み(切ってはいけない内容として LLM が持っている)。
- `deriveLoopAssertions(loopCfg, assertionsFromDisk)` 純関数が (1)∪(2) を1つの
  `AssertionsDoc` にマージ → `evaluateStructural(describeJson(dir), merged)` で照合。
  **`assert(dir)` の fs ラッパーは通さず、既に export 済みの純評価コアを直接使う**
  (二重 fs 読みを避け、config 由来の目標を注入できる)。Tier 2(視覚)は
  `evaluateStructural` が常に skip にするのでループ観測はブレない。

**F2 の seam(インターフェース前提だけ)**: 観測入力を次の型に閉じ込める。

```ts
export interface ObservationInput {
  proj: DescribeProjection;         // 構造(必須・決定論)
  outcomes: AssertOutcome[];        // 期待値照合(必須・決定論)
  av?: unknown;                     // F2 の実 A/V 観測(任意。今回は常に undefined)
}
export interface ObservationProvider {
  observe(dir: string, cfg: Config): Promise<ObservationInput>;
}
```

今回実装する `StructuralObservationProvider` は `av` を埋めない。F2 は別プロバイダ
として `av` を足し、`summarizeObservation` にその整形を追加するだけで載る(ループ本体・
停止条件は無改変)。**F2 本体の設計には踏み込まない(インターフェース前提のみ)。**

---

## 論点3: 再調整の適用方法 → **決定: cut 集合の再出力を `buildCutplan` で組み直す(apply @id は cuts-only では採らない)**

| 案 | 中身 | 判定 |
|---|---|---|
| **(a)** | 批評 LLM に**同じ出力形式 `{cuts:[...]}` で cut 集合を再出力**させ、`buildCutplan(numbered, cuts, idCtx)` で組み直して `cutplan.json` を書く | **採用** |
| (b) | `apply` の `@id` op 列(`{op:"set", target:"@cut_x", field:"action", value:"cut"}` …)を LLM に出させ `planApply`/`applyEdits` で当てる | **却下(cuts-only では)**。cuts-only で可変なのは detect 由来の**固定スパン**各要素の keep/cut フリップと reason だけ。スパンは反復中に変わらないので「差分 op」と「cut 集合の全再出力」は**同じ決定内容**。op 経路は LLM に別フォーマット(@id 指定)を強い、id 無効プロジェクトでフォールバックが要り、複雑さだけ増える。**apply @id が本領を発揮するのは transcript/overlays など異種フィールドを跨ぐ編集**で、二値フリップには過剰 |
| (c) | 毎反復 detect からフル再生成 | **却下**。(a) が既に `buildCutplan` で「番号付きリスト(不変)+ 新 cut 集合」から組むので、detect の再計算は不要。冗長 |

**決定と理由**

- (a) は**既存の純関数 `parseCutsResponse` / `buildCutplan` をそのまま再利用**する
  (パーサもビルダも新規ゼロ)。generate と critique-adjust が**同じ入出力契約**を
  共有するので、コードもテストも1組で済む。
- **id の引き継ぎは既存の `buildCutplan` の `idCtx`(span 一致で旧 id を carry)が
  そのまま効く**。id 有効/無効の分岐が要らない(id 無効なら `idCtx=undefined` で
  従来どおり id に触れない)。→ 論点3 が求める「id 無効時フォールバック」は**分岐
  不要**という形で解決。
- `buildCutplan` の出力は構造上つねに valid(keep/cut を時系列固定スパンに振るだけ・
  重なり無し)なので、書き込み前の `validateDocs` は不要(cut フリップに不変条件違反は
  起こり得ない)。**`apply` を経由しないことで承認強制ロジック(`enforceApprovedUnchanged`)
  も通らないが、`buildCutplan` は常に `approved:false` を返すので承認は不可侵**(論点6)。

> apply @id が正解になるのは、ループを remeta や「テロップ/overlays を直す編集
> ループ」に拡げたとき。そのとき論点3 は (b) を採る。**cuts-only では (a) が
> 最小かつ十分**、という切り分け。

**観測のために毎反復 `cutplan.json` を書く**: `describeJson`/`evaluateStructural` は
dir(=ディスク上の `cutplan.json`)を読む。したがってループは各反復で候補 cutplan を
`cutplan.json` に書いてから観測する。これは現状の `plan` が最後に1回書くのと同じ経路を
N 回踏むだけ。初回書き込み前に `guardRerun`(cli.ts)が `--force` 時 `backups/` へ退避
済みなので**手編集の安全網は反復に対しても効いている**(論点6)。中間反復の書き込みは
生成物ドラフトの更新に過ぎず、各反復の内容は `plan.loop.json`(論点5)に残る。

---

## 論点4: 停止条件と反復上限 → **決定: `plan.loop.maxIterations`(既定 0=従来)+ 3 つの決定論的収束判定**

**config スキーマ案**(`plan.perception` と同じ opt-in 流儀。`resolvePerceptionCfg` に
倣った `resolvePlanLoopCfg` 純関数で既定解決):

```yaml
plan:
  # 既存の perception はそのまま
  perception: { ... }
  # 新規。省略すれば全項目既定=ループ無効=バイト等価
  loop:
    # 最大反復回数。0 または 1 = 従来の1ショット(バイト等価)。>= 2 でループ有効。
    # generate 1 回 + critique-adjust を (maxIterations-1) 回まで、の上限
    maxIterations: 0
    # 目標出力尺(秒)。指定すると観測に `outDuration <= 値` の内部アサーションを足す。
    # 省略(null)なら尺の要件は課さない(assertions.json があればそれだけを使う)
    targetOutDurationSec: null
    # assertions.json + 目標尺の照合が全 pass(fail=0 かつ error=0)になったら停止
    stopWhenAssertionsPass: true
```

```ts
// src/lib/config.ts(resolvePerceptionCfg と同型)
export const DEFAULT_PLAN_LOOP_MAX_ITERATIONS = 0;
export function resolvePlanLoopCfg(cfg: Config): {
  maxIterations: number;
  targetOutDurationSec: number | null;
  stopWhenAssertionsPass: boolean;
} {
  const l = cfg.plan?.loop ?? {};
  return {
    maxIterations: l.maxIterations ?? DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
    targetOutDurationSec: l.targetOutDurationSec ?? null,
    stopWhenAssertionsPass: l.stopWhenAssertionsPass ?? true,
  };
}
export function planLoopEnabled(cfg: Config): boolean {
  return resolvePlanLoopCfg(cfg).maxIterations >= 2; // 0 と 1 は共に1ショット
}
```

**停止条件(すべて決定論)** — `shouldStop(state): { stop: boolean; reason: string }` 純関数:

1. **反復上限**: `iteration >= maxIterations` → 停止(理由 `"max-iterations"`)。無限
   ループ・コスト暴走の硬い上限。
2. **観測充足**: `stopWhenAssertionsPass` かつ `outcomes` に fail=0 かつ error=0
   (=期待値が全部満たされた)→ 停止(理由 `"assertions-pass"`)。要件が空
   (assertions.json 無し・目標尺 null)なら pass 判定は自明に真=1 反復で止まる
   (=事実上 generate のみ)。
3. **不動点(改善頭打ち)**: 直前反復と cut 集合が同一(`cutsSetEqual(prevCuts, nextCuts)`)
   → 停止(理由 `"fixpoint"`)。LLM が「もう直すところは無い」と同じ選択を返したら
   反復を止める。

`cutsSetEqual` は cut id 集合(と reason は無視 or 含める、実装で固定)を比較する純関数。

---

## 論点5: 決定論とテスト容易性 → **決定: `complete` を DI 差し替え + ループ各段を純関数へ + 反復ログを `plan.loop.json`**

**`complete` のモック注入**: `plan()` に第4引数 `deps` を足す(既定=本物)。

```ts
export type CompleteFn = (prompt: string, cfg: Config) => Promise<string>;
export interface PlanDeps {
  complete?: CompleteFn;                  // 既定: llm.ts の complete
  observe?: ObservationProvider;          // 既定: StructuralObservationProvider
}
export async function plan(
  dir: string, cfg: Config, opts: PlanOptions = {}, deps: PlanDeps = {},
): Promise<CutPlan>
```

- `cli.ts` は `deps` を渡さない(既定=本物)ので**配線は無変更**。
- テストは**台本モック**(反復ごとの canned 応答を配列で持ち、呼ばれた順に返す
  `CompleteFn`)を渡してループ全体を決定論化。観測 fs も `deps.observe` を差し替えれば
  fs 無しで純粋にループ制御だけを固定できる。

**ループ各段を純関数へ切り出す**(`src/lib/planLoop.ts`。fs 非依存):

| 純関数 | 役割 |
|---|---|
| `deriveLoopAssertions(loopCfg, diskAssertions): AssertionsDoc` | 目標尺 + assertions.json を1つの期待値へマージ |
| `summarizeObservation(proj, outcomes, currentCuts, loopCfg): string` | `{{observation}}` テキスト整形 |
| `cutsSetEqual(a, b): boolean` | 不動点判定 |
| `shouldStop(state): { stop; reason }` | 停止判定(反復上限/充足/不動点) |

オーケストレータ `runCutsLoop(...)`(`src/stages/plan.ts`)は上の純関数 + 注入された
`complete`/`observe` を束ねるだけの薄い制御。**判定ロジックは全部純関数側**に置くので、
`node:test` で fs も LLM も触らず固定できる。

**反復ログ**: `plan.loop.json`(**新規の中間生成物**)に反復配列を書く。

```jsonc
{
  "schemaVersion": 1,
  "iterations": [
    { "iter": 0, "kind": "generate", "raw": "...", "cuts": [{ "id": 3, "reason": "..." }],
      "observation": "出力尺 312.4 秒 ...", "stop": null },
    { "iter": 1, "kind": "critique", "raw": "...", "cuts": [...],
      "observation": "...", "stop": "assertions-pass" }
  ]
}
```

- `plan.raw.txt` は**最終反復の生応答**を従来どおり書く(後方互換。既存の「パース失敗
  調査用」用途を保つ)。`plan.loop.json` は反復の全履歴(生成・観測・停止理由)。
- `plan.loop.json` を `src/lib/files.ts` の `GENERATED_FILES` に登録する。→
  `fileRole("plan.loop.json") === "generated"`。`test/files.test.ts` と
  `test/agentsMd.test.ts`(GENERATED_FILES を網羅ピン留め)の更新が要る(論点=波及、T4/T5)。
- ループ無効(maxIterations<=1)のときは `plan.loop.json` を**一切書かない**(存在しない)
  =バイト等価。

---

## 論点6: 承認・手編集の安全 → **決定: ループは approved / approvals.json を1バイトも触らない。`--force`+backups の既存規律を継承**

- **承認不可侵**: ループの書き込み経路は `buildCutplan`(常に `approved:false`)→
  `writeFileSync(cutplan.json)` のみ。`apply` を通さない(論点3)ので
  `approvals.json` にも一切触れない。ループが `approved:true` を書くコードパスは存在
  しない。
- **手編集の安全**: ループは既存の `plan --cuts-only` の**内側**で回る。cli.ts の
  `plan` コマンドは既に `guardRerun(abs, ["cutplan.json"], force, "plan")` で守られて
  いる=生成物があれば `--force` 無しでエラー停止、`--force` 時は実行前に手編集
  cutplan を `backups/<日時>/` へ退避。**ループはこの契約を1文字も変えない**。反復が
  cutplan.json を何度書いても、退避は初回の1回で足りる(元の手編集は退避済み)。
- **人間が承認済みの cutplan を再ループしない**: これも `guardRerun` が既存どおり
  ブロックする(`--force` を人間が明示しない限り走らない)。**AI が自分の判断で
  `--force` を付けない**という CLAUDE.md の規律はループ導入後も不変。
- **バイト等価の担保**: `maxIterations<=1` では critique/observe/`plan.loop.json` の
  どのコードパスにも入らず、generate 1 回 + 書き込みが現状の `plan()` cuts-only と
  同一(論点5 の `deps` 既定・prompts/plan-cuts.md 無改変)。

---

## 論点7: 予測的次アクション(Tab 相当)→ **決定: 今回スコープ外(明示的に切る)**

「予測的な次アクション(Cursor の Tab)」は **(1) 人間の次の操作を予測するモデルと
(2) それを提示・受諾する UI サーフェス**を要する。これは Theme F1(GUI 協調レイヤ・
差分 accept/reject)の領域で、カット決定ループとは直交する。**芽も残さない**
(中途半端な seam はかえって設計を曇らせる)。本テーマは「観測 → 再調整の反復」に
集中し、Tab 相当は別テーマ(GUI 協調)に委ねる、と正直に切る。

---

## アーキテクチャ(疑似コード)

```
plan(dir, cfg, { cutsOnly: true }, deps):
  # --- 前処理(現状と共通)---
  transcript = read transcript.json
  auto       = read cuts.auto.json
  numbered   = numberSegments(auto.keepSegments, transcript)   # 番号付き・不変
  idCtx      = buildIdContext(dir)                             # 既存
  perception = renderPerceptionBlock(...)                      # 既存(plan.perception)
  loopCfg    = resolvePlanLoopCfg(cfg)
  complete   = deps.complete ?? realComplete
  observe    = deps.observe  ?? StructuralObservationProvider

  # --- ループ無効(既定: maxIterations<=1)= 従来1ショットとバイト等価 ---
  if loopCfg.maxIterations < 2:
      prompt = renderPrompt(dir, "plan-cuts.md", numbered, auto.originalDurationSec, perception)
      raw    = await complete(prompt, cfg)
      write plan.raw.txt = raw
      cuts   = parseCutsResponse(raw).cuts
      cutplan = buildCutplan(numbered, cuts, idCtx?)
      write cutplan.json = cutplan
      return cutplan          # ← ここまで現状の plan() と1バイト同一

  # --- ループ有効(maxIterations>=2)---
  log = []
  prevCuts = null
  for iter in 0 .. maxIterations-1:
      if iter == 0:
          prompt = renderPrompt(dir, "plan-cuts.md", numbered, dur, perception)     # generate
      else:
          obsText = summarizeObservation(obs.proj, obs.outcomes, prevCuts, loopCfg)
          prompt  = renderCritiquePrompt(dir, "plan-cuts-critique.md",
                        numbered, dur, perception, obsText, prevCuts)                # critique+adjust
      raw   = await complete(prompt, cfg)
      cuts  = parseCutsResponse(raw).cuts
      cutplan = buildCutplan(numbered, cuts, idCtx?)
      write cutplan.json = cutplan                 # 観測のため毎反復ディスクへ

      obs   = await observe.observe(dir, cfg)       # describeJson + evaluateStructural
      spec  = deriveLoopAssertions(loopCfg, readAssertionsIfAny(dir))
      obs.outcomes = evaluateStructural(obs.proj, spec)   # 目標尺を注入した照合

      decision = shouldStop({ iter, maxIterations, loopCfg,
                              outcomes: obs.outcomes, prevCuts, cuts })
      log.push({ iter, kind: iter==0?"generate":"critique", raw, cuts,
                 observation: summarizeObservation(...), stop: decision.stop?decision.reason:null })
      prevCuts = cuts
      if decision.stop: break

  write plan.raw.txt  = last raw           # 後方互換
  write plan.loop.json = { schemaVersion:1, iterations: log }
  return last cutplan
```

**プロンプトテンプレの追加/変更**:

- `prompts/plan-cuts.md`(generate)= **無改変**。`{{observation}}` は入れない。
- `prompts/plan-cuts-critique.md`(新規)= plan-cuts.md をベースに、次を足す:
  - `{{observation}}` … 観測サマリ(論点2)。
  - `{{currentCuts}}` … 現在の cut 選択(id / reason)。
  - 指示文「観測結果を踏まえ、狙い(見せ場保持・目標尺)を満たすよう **cut 集合を
    修正**して同じ JSON 形式で再出力せよ。自信のある判断は維持し、観測が示す問題
    (尺超過・消えた見せ場)だけを直せ」。
  - **出力形式は `{cuts:[...]}` で plan-cuts.md と同一**(`parseCutsResponse` を共有)。
- `renderCritiquePrompt` は既存 `renderPrompt` に `{{observation}}` / `{{currentCuts}}`
  の2プレースホルダ置換を足した薄い拡張(または `renderPrompt` に任意の追加
  プレースホルダ辞書引数を1つ足す。既存呼び出しは無改変=バイト等価)。

---

## タスク分解(1タスク=1コミット)

### T1: config スキーマ + `resolvePlanLoopCfg` 純関数

- **触るファイル**: `src/lib/config.ts`(`Config.plan.loop` 型追加・
  `resolvePlanLoopCfg` / `planLoopEnabled` / `DEFAULT_PLAN_LOOP_MAX_ITERATIONS`
  export)、`config.yaml`(`plan.loop` の**コメントのみ**追記=既定値を書かず、
  書いても `maxIterations: 0`)。
- **テスト方針**: `test/config.test.ts` に `resolvePlanLoopCfg` の既定解決(未指定→
  maxIterations=0 / target=null / stopWhenAssertionsPass=true)と明示値の解決を固定。
- **壊してはいけない既存挙動**: この時点で `resolvePlanLoopCfg` を**誰も呼ばない**
  =挙動ゼロ変化。`config.yaml` に実値を書かない限り既存の全コマンドはバイト等価。
  既存 `config.test.ts` は無改変で緑。

### T2: 観測整形・停止判定の純関数群(`src/lib/planLoop.ts`)

- **触るファイル**: `src/lib/planLoop.ts`(新規)= `deriveLoopAssertions` /
  `summarizeObservation` / `cutsSetEqual` / `shouldStop` / `ObservationInput` /
  `ObservationProvider` の型。`src/stages/assert.ts` の `evaluateStructural`、
  `src/stages/describe.ts` の `DescribeProjection`、`src/types.ts` の
  `AssertionsDoc`/`Assertion` を import(いずれも export 済み・**無改変**)。
- **テスト方針**: `test/planLoop.test.ts` に、手組みの `DescribeProjection` と
  `AssertOutcome[]` で各純関数を固定(fs も LLM も触らない)。`deriveLoopAssertions`
  が目標尺を `outDuration <=` に変換・assertions.json とマージすること、
  `summarizeObservation` の文言、`shouldStop` の3条件(反復上限/充足/不動点)を
  分岐網羅。
- **壊してはいけない既存挙動**: 新規ファイルのみ・どこからも呼ばれない=挙動ゼロ変化。
  既存テスト全緑のまま。

### T3: `complete` 注入 seam + generate 段のヘルパ抽出(リファクタ)

- **触るファイル**: `src/stages/plan.ts`(`PlanDeps`/`CompleteFn` 型追加、`plan()` に
  第4引数 `deps` を足し既定=本物 `complete`。cuts-only の generate を
  `generateCutsOnce(...)` へ抽出=同じプロンプト・同じパース・同じ書き込み)。
- **テスト方針**: `test/plan.test.ts` に「`deps.complete` にモックを渡し、
  `maxIterations` 未設定(=0)で `plan(dir,cfg,{cutsOnly:true},{complete:mock})` が
  書く `cutplan.json` が、モック応答から `buildCutplan` した期待値とバイト一致」を
  temp-dir fixture で追加。`cli.ts` は `deps` を渡さない(無変更)。
- **壊してはいけない既存挙動**: `deps` 省略時のコードパスは抽出前と**同一の
  `complete`→`parseCutsResponse`→`buildCutplan`→`writeFileSync`**(プロンプトは
  plan-cuts.md 無改変)。既存の `test/plan.test.ts`(純関数 `parseCutsResponse`/
  `buildCutplan`)は無改変で緑。`plan.raw.txt`・`cutplan.json` の出力は不変。

### T4: ループ本体の配線 + critique テンプレ + 反復ログ + files.ts 登録

- **触るファイル**:
  - `src/stages/plan.ts`(`runCutsLoop` オーケストレータ、`plan()` で
    `planLoopEnabled(cfg)` かつ cuts-only のときだけループ、それ以外は T3 の
    `generateCutsOnce` 経路。`renderCritiquePrompt`。`plan.loop.json` 書き込み。
    `StructuralObservationProvider`=`describeJson`+`evaluateStructural` を束ねる観測)。
  - `prompts/plan-cuts-critique.md`(新規)。
  - `src/lib/files.ts`(`GENERATED_FILES` に `"plan.loop.json"` 追加)。
  - `test/files.test.ts` / `test/agentsMd.test.ts`(GENERATED_FILES ピン留めの更新)。
- **テスト方針**:
  - **決定論ユニット**(主)= temp-dir fixture(最小の transcript.json /
    cuts.auto.json / manifest.json)+ **台本モック `complete`**(反復ごとの
    canned `{cuts:[...]}` を順に返す)。検証: (1) 収束して停止、(2) `plan.loop.json`
    に反復履歴が残る、(3) 停止理由が期待どおり(assertions-pass / fixpoint /
    max-iterations)、(4) 最終 `cutplan.json` が最終 cut 集合を反映、(5)
    `cutplan.approved === false` かつ `approvals.json` が生成されない。
  - **観測 DI**= `deps.observe` にフェイクを渡し、ループ制御(停止・反復回数)を
    fs 無しで固定するケースも1本。
  - **実データスモーク**(補助)= T6 参照。
- **壊してはいけない既存挙動**: `maxIterations<=1`(既定)では `runCutsLoop` に
  入らず T3 の `generateCutsOnce` を1回=**現状の plan cuts-only とバイト等価**
  (`plan.loop.json` を書かない・critique テンプレを読まない・observe を呼ばない)。
  full `plan` / `remeta` の経路は**この関数に触れない**(loop は cuts-only 限定)ので
  無変更。`test/describe*.test.ts` / `test/assert.test.ts` は `evaluateStructural` /
  `describeJson` を無改変で使うため全緑。

### T5: ドキュメント(usage / AGENTS / CLAUDE の generated 一覧)

- **触るファイル**: `docs/usage.md`(「plan のエージェントループ(config.yaml の
  `plan.loop`)」節: opt-in・停止条件・`plan.loop.json`・決定論の限界を明記)、
  `AGENTS_CONTRACT.md`(`GENERATED_FILES` 一覧に `plan.loop.json` を追加=`test/agentsMd.test.ts`
  の網羅と整合。CLI コマンドは増えないので §コマンド表は不変)、`CLAUDE.md`(中間
  生成物の一覧に `plan.loop.json` を1行追記。任意だが一貫性のため推奨)。
- **テスト方針**: `test/agentsMd.test.ts` が AGENTS_CONTRACT.md の GENERATED_FILES 網羅を
  ピン留めしているので、T4 の files.ts 追加とこの AGENTS 追記が揃って緑になることを
  確認。
- **5点セットの適用範囲**: 本テーマは**編集ファイル(cutplan 等)のスキーマを
  変えない**(cutplan schema 不変・`config.yaml` は `schemas/` 管理外)。よって
  `schemas/*.schema.json` の更新は**不要**。5点セットのうち実際に動くのは
  「types.ts のコメント(config 型)/ validate.ts(不変)/ usage.md / AGENTS_CONTRACT.md
  (GENERATED_FILES)」で、`schemas/` は N/A。この非対称を doc に明記。

### T6: 実データスモーク検証(コミット外の検証手順)

- **手順**: **中立 cwd から**(repo 直下だと `claude -p` が CLAUDE.md/セッション
  文脈を読んで散文化する)。
  ```sh
  cd /tmp
  # 目標尺を課してループ有効化した一時 config で実行
  node /Users/19mo/dev/tools/cutflow/src/cli.ts plan \
    ~/Movies/cutflow/2026-07-02-whisper-bench --cuts-only --force \
    --config /tmp/loop-config.yaml     # plan.loop.maxIterations: 3, targetOutDurationSec を近めに
  ```
  確認: `plan.loop.json` の反復が2以上・`validate` が緑・`describe --json` の
  `summary.outDurationSec` が反復で目標へ近づく・`cutplan.approved:false`・
  `approvals.json` 不在。既定 config(loop 無し)で同収録を叩くと
  `plan.loop.json` が生成されない(バイト等価)ことも対で確認。
- **後始末**: 検証で書いた `plan.loop.json`・一時 config・退避 `backups/` は
  実収録に残さず削除(検証前に `cutplan.json` 等を退避しておき復元)。
- **位置づけ**: ループのロジック固定は **T4 の台本モックが主**。実 LLM は
  「実際に走って収束するか」のスモークのみ(非決定的な completion に依存する
  アサーションはユニットに書かない)。

---

## 先に読むべきコード

- `src/stages/plan.ts` … `plan()`(cuts-only 分岐)・`numberSegments` /
  `buildCutplan` / `parseCutsResponse` / `renderPrompt` / `buildIdContext`。ループが
  再利用/拡張する中心。
- `src/lib/llm.ts` … `complete(prompt, cfg)` の実シグネチャ(DI 差し替えの対象)。
- `src/stages/describe.ts` … `describeJson(dir, cfg?)` と `DescribeProjection` /
  `Summary`(観測の射影源)。
- `src/stages/assert.ts` … `evaluateStructural(proj, spec)`(純評価コア)・
  `AssertOutcome` / `AssertReport`・`AssertRunOptions`。観測の照合エンジン。
- `src/types.ts` … `AssertionsDoc` / `Assertion` / `AssertOp`(内部アサーション生成)、
  `CutPlan` / `PlanSegment`。
- `src/lib/config.ts` … `resolvePerceptionCfg`(倣う既定解決パターン)・`Config.plan`。
- `src/lib/files.ts` … `GENERATED_FILES` / `fileRole`(`plan.loop.json` 登録先)。
- `src/lib/applyEdits.ts` … `planApply` / `applyEdits` / `EditOp`(論点3 で
  **却下した**経路。将来 remeta 拡張時に読む)。
- `src/cli.ts`(160–212, 352–414 付近)… `plan` の `guardRerun`・`apply` の配線
  (ループが承認/backups 規律を継承する土台)。
- `test/plan.test.ts` / `test/assert.test.ts` / `test/config.test.ts` /
  `test/files.test.ts` / `test/agentsMd.test.ts` … 追随/追加するテストの型。
- `docs/plans/2026-07-07-visual-assertions-design.md` / `…-atomic-apply-design.md` /
  `…-plan-eyes-ears-design.md` … 観測・適用・opt-in の既存設計の思想(本設計はこの
  3 本の上に載る)。

---

## スコープ外(明示的にやらないこと)

1. **full `plan`(cuts+章+メタ同時)/ `remeta` / `plan-shorts` のループ化**(論点1)。
   基盤は汎用に切り出すが配線は cuts-only のみ。
2. **apply @id op 列による部分再調整**(論点3)。cuts-only では cut 集合の再出力で
   足りるため採らない。remeta/overlays 編集ループを作るときの将来仕事。
3. **F2 の実 A/V フィードバック本体**(動き+音の観測)。`ObservationProvider` /
   `ObservationInput.av` の**インターフェース前提だけ**置く。実装は F2 に委ねる。
4. **F1 の GUI 協調(差分 accept/reject・GUI からのループ起動・予測 Tab)**。論点7 の
   とおり Tab 相当は芽も残さず切る。
5. **視覚アサーション(`assert --visual` / OCR)のループ接続**。macOS 依存・低速で
   ループの決定論・全環境性を壊すため、Tier 1(構造)のみ接続。将来 `ObservationProvider`
   の別実装として足せる seam は残す。
6. **cutplan / transcript 等の編集ファイルのスキーマ変更**。本テーマは config +
   新規中間生成物(`plan.loop.json`)だけを足し、既存の平文 JSON 契約・`schemas/` を
   変えない。
7. **複数バックエンド(codex 等)対応**。`complete` の DI はテスト用モック差し替えが
   目的で、BYO-AI 拡張(Theme E)は別テーマ。
