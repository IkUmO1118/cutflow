# SD-T1 設計書 — `style-check`(profile→距離 assert / J→D 変換)

> Opus 設計 → Sonnet 実装 → コーディネータ実測のリレー([[opus-sonnet-relay-workflow]])。
> 母艦: `docs/programs/aesthetic-judgment-and-style-learning.md`
> (§5.1 J→D・§2.5 横断 assert・§8 不変条件・§10.0/§10.1 確定判断)。
> 前提: **SD-T0 完了**(`style-profile` が channel 直下 `style.probe/<name>.json` を書く。
> 型は `src/lib/styleProfile.ts` の `StyleProfile`)。
>
> 体裁は精度母艦と同じ **4 部形式(背景 / 変更 / 検証 / リスク)**。コードは書かない。
> 実装は Sonnet が本書の粒度どおりに行う。

---

## 1. 背景

### 1.1 SD-T1 は §5.1 J→D 変換の「測定面」

母艦 §5.1 は「プロファイルが目標値を供給すると、審美眼の多くの **J 次元(主観)が
D 次元(決定論)へ落ちる**」と述べる。SD-T0 は目標値を供給する側(profile 抽出)を作った。
**SD-T1 はそれを消費する側** — ある収録の**現在の編集(候補)**の観測統計が、profile の
**学習分散帯からどれだけ逸脱しているか**を決定論で測り、**warn(exit 0)で報告する
「距離 assert」**を作る。母艦 §2.5「valid だが profile の学習帯を外れる」を捕まえる
新しい横断 assert 面がこれである。

### 1.2 cold-start で測れる意義(SD-T2 との差)

母艦 §5.2/§10.0 は、hold-out agreement harness(SD-T2)を**承認済み自信作が ≥2〜3 本に
なるまで保留**とした(leave-one-out は N=1 で訓練 0/テスト 1 になり不成立)。
その空白を埋めるのが SD-T1 である。

| | SD-T1(本書) | SD-T2(保留) |
|---|---|---|
| 測るもの | 候補の観測統計 vs profile の**学習帯**の距離 | hold-out 正解 keep 集合との**agreement** |
| 必要データ | profile 1 個(**N=1 でも可**) | 承認済み **≥2〜3 本** |
| 決定性 | **決定論**(実行ごとにブレない) | K 回分布(非決定を分布で吸収) |
| 出力 | warn/info(学習帯逸脱) | 一貫性スコア(非常線+相対比較) |

SD-T1 の測定面は **N=1 の cold-start でも実行ごとにブレず測れる**(profile も候補も
決定論集約)。これが「測定先行の背骨を、agreement ではなく決定論 distance-to-profile が
担う」(母艦 §5.2 末尾・§10.0)の実体。

### 1.3 能力境界(§3 の再確認)

profile は *rate/placement 統計*(どのくらい/どこに)を教えるが *instance semantics*
(この 1 文を切れ)は教えない(母艦 §3)。SD-T1 が測れるのは前者だけ — 「ペースが速すぎる/
遅すぎる」「caption が薄い/位置が違う」「ラウドネスがずれる」までで、「この重複テイクの
綺麗な方を選べたか」は測れない(残る真の J・§5.1)。この境界を finding の文言でも偽らない。

---

## 2. 変更(揺れない粒度)

### 2.1 新規/変更ファイル完全一覧

| 種別 | パス | 内容 |
|---|---|---|
| 新規 | `src/lib/styleCheck.ts` | 距離計算の純関数・型・module 定数(IO ゼロ・決定論)。**SD-T1 の核** |
| 新規 | `src/stages/styleCheck.ts` | orchestrator(薄い殻)。read → 純関数 → `style-check.json` 書き出し + `formatStyleCheckReport` |
| 変更 | `src/cli.ts` | `style-check <dir>` コマンド登録(import + `.command`) |
| 変更 | `src/lib/files.ts` | `GENERATED_FILES` に `"style-check.json"` を追加 |
| 新規 | `test/styleCheck.test.ts` | 純関数のユニットテスト(§3.4 のケース一覧) |
| 変更 | `test/files.test.ts` | `EXPECTED_GENERATED_FILES` に `"style-check.json"` を追加(1 ケース増) |
| 変更 | `AGENTS_CONTRACT.md` | コマンド表に `style-check` 行 + 生成物一覧に `style-check.json`(**agentsMd.test.ts が全数照合**) |
| 変更 | `docs/usage.md` | `style-check` の節を追加 |
| 変更 | `CLAUDE.md` | コマンド一覧 + 中間生成物一覧 + 知覚節に追記 |
| 変更 | 母艦 `docs/programs/aesthetic-judgment-and-style-learning.md` | §2/§5.1 の次元表を「D 化した/残る J」で再分類(§2.9 の追記テキスト)+ §10.1 SD-T1 を「完了」へ |

**触らない**: `src/types.ts`(型は styleCheck.ts に閉じる)/ `src/stages/validate.ts`
(style-check.json は生成物レポート=検査対象の編集ファイルではない)/ `schemas/*`
(生成物は schema を持たない=effect-check.json/bgm-fit.json と同格。`schema.test.ts` の
全単射を壊さない)/ `src/lib/styleProfile.ts`(`observeOwnProject`・`mergeObservations`・
`observeBareVideo` は既に export 済み=**export 変更すら不要**。確認済み)。

### 2.2 核心の再利用: 候補を profile と同じ形に畳む

候補は**収録 1 本**。profile は集約された section(avgShotSec 等)を持つ。両者を比べるには
**候補自身の集約統計を、profile と同じ集約経路で作る**のが最短:

```
observeOwnProject(候補)  →  ProjectObservation 1 本
mergeObservations("_candidate", [obs])  →  StyleProfile(候補)
```

`mergeObservations([1本])` は avgShotSec/coverageRatio/positionHint/cutAggressiveness ラベル
などを **profile と同一の関数で**算出する。ゆえに距離計算は「reference: StyleProfile と
candidate: StyleProfile を section ごとに突き合わせる」だけになり、**統計・ラベル写像の
再実装がゼロ**。av.probe 欠落(2026-07-10)も `observeOwnProject(sound=null)` が audio を
null に落とし、`mergeObservations` が audio 値=null・confidence=0 にするので、距離側は
「候補に測定値なし → skipped」を自然に扱える。

> **なぜ candidate も mergeObservations に通すのか**: avgShotSec は「keep durationSec の
> プール平均」、coverageRatio は「区間 union ÷ 出力尺」、positionHint は
> 「histogram → 多数決ラベル」で、いずれも SD-T0 の純関数が唯一の出所。候補側で
> 手計算すると二重実装 = 継ぎ目バグ([[stage-orchestrator-bug-classes]])を生む。

### 2.3 `src/lib/styleCheck.ts` — 型・シグネチャ・定数・算出式

#### 2.3.1 finding 型(§重要論点A の finding 構造)

```ts
/** style-check.json のスキーマ版。破壊的変更で +1 */
export const STYLE_CHECK_SCHEMA_VERSION = 1;

/** T1 v1 が距離を測る section(profile v1 scope = cut/caption/audio に閉じる。
 *  structure/effect密度/BGM cadence/素材 は §2.8 で defer) */
export type CheckSection = "cutDensity" | "captions" | "audio";

export type FindingKind =
  | "deviation"  // 数値が学習帯の外(outer band 超過)
  | "borderline" // 数値が inner..outer の margin 帯(confidence の広げ分でだけ許容)
  | "mismatch"   // カテゴリ/boolean ラベルの不一致
  | "skipped";   // profile 側 or 候補側に測定値が無い(欠測)

export type Severity = "warn" | "info";

/** 数値帯(numeric metric のみ。categorical/skipped は null) */
export interface Band {
  lo: number;
  hi: number;
}

export interface StyleFinding {
  kind: FindingKind;
  section: CheckSection;
  metric: string;                       // "avgShotSec" / "coverageRatio" / "positionHint" 等
  observed: number | string | null;     // 候補の値(カテゴリはラベル文字列)
  expected: number | string | null;     // profile の値/ラベル
  band: Band | null;                     // 数値の許容帯(confidence-widened outer)。categorical/skipped は null
  innerBand: Band | null;                // 広げる前の帯(監査用。categorical/skipped は null)
  confidence: number;                    // 参照 section の confidence(帯幅と severity の根拠)
  severity: Severity;                    // 常に warn|info(**fail は無い**=母艦 §10.0/§8 不変条件3)
  message: string;                       // 日本語の人間可読
}

export interface StyleCheckReport {
  schemaVersion: number;
  profileName: string;
  provenance: string;                    // reference profile の provenance(監査可視化)
  findings: StyleFinding[];
  counts: { warn: number; info: number; skipped: number };
}
```

#### 2.3.2 module 定数(閾値。config 化せず module 定数=SD-T0 前例に倣う)

```ts
/** confidence で outer band を広げる傾き。widen(conf)=1+(1-conf)*SLOPE */
const BAND_WIDEN_SLOPE = 2.0;
/** relative metric の基準相対トレランス(±30%) */
const BAND_REL_TOL = 0.30;
/** カテゴリ/boolean 不一致を warn に上げる confidence 下限。未満は info */
const CATEGORICAL_TRUST_CONF = 0.35;

/** metric ごとの帯モードと基準トレランス。ここが「算出式」の唯一の出所 */
type ToleranceMode = "relative" | "absolute" | "learned-percentile";
interface MetricSpec {
  section: CheckSection;
  metric: string;
  mode: ToleranceMode;
  tol: number;                 // relative=比率 / absolute=同単位の幅 / learned-percentile=fallback 用の相対比率
}
const NUMERIC_SPECS: MetricSpec[] = [
  // cut(ペース): 学習 p10/p90 帯。p10/p90 が null なら avgShotSec±30% にフォールバック
  { section: "cutDensity", metric: "avgShotSec",        mode: "learned-percentile", tol: BAND_REL_TOL },
  { section: "cutDensity", metric: "medianShotSec",     mode: "learned-percentile", tol: BAND_REL_TOL },
  { section: "cutDensity", metric: "sceneChangesPerMin",mode: "relative",           tol: BAND_REL_TOL },
  // caption: 比率は絶対幅(0..1 に相対%を掛けると小値で潰れる)、表示秒は相対
  { section: "captions",   metric: "coverageRatio",     mode: "absolute",           tol: 0.15 },
  { section: "captions",   metric: "avgDisplaySec",     mode: "relative",           tol: BAND_REL_TOL },
  // audio: dB 系は絶対幅(log 尺に相対%は不適)、silenceRatio は絶対
  { section: "audio",      metric: "integratedLufs",    mode: "absolute",           tol: 3.0 },
  { section: "audio",      metric: "truePeakDbtp",      mode: "absolute",           tol: 3.0 },
  { section: "audio",      metric: "silenceRatio",      mode: "absolute",           tol: 0.10 },
];

/** カテゴリ/boolean metric(ラベル一致で判定) */
interface CategoricalSpec { section: CheckSection; metric: string; }
const CATEGORICAL_SPECS: CategoricalSpec[] = [
  { section: "cutDensity", metric: "cutAggressiveness" },
  { section: "captions",   metric: "density" },
  { section: "captions",   metric: "positionHint" },
  { section: "audio",      metric: "bgmLikely" },
];
```

`avgShotSec` の学習帯は reference の `shotSecP10`/`shotSecP90`(SD-T0 が既に格納)を使う。
**これが重要論点A のペース確定形**: v1 は full 分布配列を profile に足さず、`[p10,p90]` を
「学習された分布の幅そのもの」として帯に使う(**KS 距離は full 分布保存が要る profile v2 の
拡張点**。schema を今は変えない)。`medianShotSec` も同じ shot 長帯で判定する。

#### 2.3.3 帯とトレランスの算出式(重要論点A の確定形)

**二層帯(inner/outer)モデル**を採る。`confidence` は**帯幅**を制御し、別途の
severity floor は数値に設けない(cold-start の過剰 warn は「広い outer 帯」が吸収する)。

```ts
function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

/** confidence が低いほど帯を広げる倍率(>=1)。widen(1)=1, widen(0)=1+SLOPE */
export function widen(confidence: number): number {
  return 1 + (1 - clamp01(confidence)) * BAND_WIDEN_SLOPE;
}

/** inner(広げる前)と outer(confidence 広げ後)の帯を返す。
 *  expected が null なら {inner:null, outer:null}(→ skipped) */
export function numericBands(args: {
  expected: number | null;
  spec: MetricSpec;
  confidence: number;
  pctLo: number | null;   // learned-percentile 用(reference.shotSecP10)
  pctHi: number | null;   // 同 shotSecP90
}): { inner: Band | null; outer: Band | null } {
  const { expected, spec, confidence, pctLo, pctHi } = args;
  if (expected === null) return { inner: null, outer: null };
  const w = widen(confidence);

  if (spec.mode === "learned-percentile" && pctLo !== null && pctHi !== null) {
    const inner: Band = { lo: pctLo, hi: pctHi };
    // p10===p90(単一keep等の退化帯)では幅由来の margin が 0 に潰れ、confidence を
    // 広げても outer===inner の点帯になり borderline が到達不能→過剰 warn になる
    // (実装レビュー指摘・§4.1 追記)。expected の相対トレランス由来のフロアと max を
    // 取ることで退化帯でも confidence 分だけ outer が広がる(正常帯では従来どおり
    // 幅由来の margin が支配的なので挙動不変)。
    const spreadMargin = (pctHi - pctLo) * (w - 1) * 0.5;   // 幅の (w-1) 半分を左右へ
    const floorMargin = Math.abs(expected) * spec.tol * (w - 1) * 0.5;
    const margin = Math.max(spreadMargin, floorMargin);
    const outer: Band = { lo: pctLo - margin, hi: pctHi + margin };
    return { inner, outer };
  }
  // relative / absolute /(percentile だが p10/p90 欠落)の共通式
  const hw = spec.mode === "relative"
    ? Math.abs(expected) * spec.tol            // 相対
    : spec.mode === "absolute"
      ? spec.tol                                // 絶対(同単位)
      : Math.abs(expected) * spec.tol;          // percentile fallback = 相対
  const inner: Band = { lo: expected - hw, hi: expected + hw };
  const outer: Band = { lo: expected - hw * w, hi: expected + hw * w };
  return { inner, outer };
}
```

**判定規則**(1 数値 metric あたり):

| 候補の観測値 | 帯との関係 | finding |
|---|---|---|
| expected/observed のどちらか null | 測定不能 | `kind:"skipped"`, `severity:"info"` |
| inner 帯の内側 | 学習帯に収まる | **finding なし** |
| inner の外 ∧ outer の内 | confidence の広げ分でだけ許容 | `kind:"borderline"`, `severity:"info"` |
| outer 帯の外 | 不確実性マージンを超えた実逸脱 | `kind:"deviation"`, `severity:"warn"` |

**カテゴリ/boolean metric**:

| 状態 | finding |
|---|---|
| どちらか null | `kind:"skipped"`, `severity:"info"` |
| `positionHint` で片方が `"mixed"` | mixed が吸収 → **finding なし** |
| ラベル一致 | **finding なし** |
| ラベル不一致 ∧ 参照 confidence ≥ `CATEGORICAL_TRUST_CONF` | `kind:"mismatch"`, `severity:"warn"` |
| ラベル不一致 ∧ 参照 confidence < `CATEGORICAL_TRUST_CONF` | `kind:"mismatch"`, `severity:"info"` |

> **なぜ二層帯にしたか(cold-start の実データで確定)**: reference `default.json` は N=1 で
> **全 section の confidence が 0.25〜0.33**(cutDensity 0.28 / captions 0.27 / audio 0.25 /
> structure 0.33)。ここに「confidence<floor は一律 info」の単純 floor を置くと、
> **2026-07-10 の avgShot=114s(単一 114 秒無カット keep)という桁違いの逸脱も info に
> 潰れて**しまい、母艦の「逸脱検出」意図に反する。二層帯なら、cutDensity 帯
> inner=[2.09,10]・outer≈[-3.6,15.7](widen(0.28)=2.44)に対し **114 は outer をはるかに
> 超える→ warn**。一方 avg が p90 を少し超える程度(例 11s)の**軽い逸脱は borderline=info**に
> 収まり、cold-start の過剰 warn を防ぐ。**confidence は「帯の広さ」に効かせるのが
> 正直**で、severity を magnitude 非依存に潰さない。これが重要論点A の最終確定。

#### 2.3.4 距離計算のトップ関数(純関数)

```ts
/** reference(profile)と candidate(mergeObservations で畳んだ候補 StyleProfile)を
 *  section ごとに突き合わせ、逸脱 finding を返す。IO ゼロ・決定論。
 *  reference の各 section.meta.confidence が帯幅と severity の根拠 */
export function compareProfiles(
  reference: StyleProfile,
  candidate: StyleProfile,
): StyleFinding[];
```

内部は `NUMERIC_SPECS` と `CATEGORICAL_SPECS` を回し、reference/candidate の該当 section から
値を取り出して上表の規則で finding を積む。`avgShotSec`/`medianShotSec` の
`pctLo/pctHi` は reference `cutDensity.shotSecP10/shotSecP90` を渡す。confidence は
`reference[section].meta.confidence`。message は日本語で「ペースが学習帯 [2.1s,10.0s] より
遅い(候補 avgShot 114.0s)」のように observed/expected/band を埋める。

```ts
/** findings → counts 集計(orchestrator が report に載せる) */
export function summarizeFindings(findings: StyleFinding[]): StyleCheckReport["counts"];
```

補助 export(テストが直叩きする単位): `widen`・`numericBands`・
`classifyNumeric(observed, inner, outer, confidence): FindingKind|null`・
`classifyCategorical(observed, expected, confidence): "warn"|"info"|null`。

### 2.4 `src/stages/styleCheck.ts` — orchestrator 擬似コード

`bgmFit.ts`/`effectCheck.ts` と同型の薄い殻。**前提エラーだけ throw(→ exit 1)、
逸脱報告自体は常に exit 0**。

```ts
export const STYLE_CHECK_FILE = "style-check.json";

export interface StyleCheckResult {
  report: StyleCheckReport;
  reportPath: string;
}

export function styleCheck(
  dir: string,
  opts: { profile?: string },   // --profile。省略時 "default"。--short は v1 未対応(§2.8)
  cfg: Config,
): StyleCheckResult {
  const name = (opts.profile ?? "default").trim() || "default";

  // 1) reference profile を channel(dir の親)から読む。無ければ前提エラー(exit 1)
  const channel = dirname(resolve(dir));
  const profilePath = join(channel, STYLE_PROBE_DIR, `${name}.json`);   // STYLE_PROBE_DIR は styleProfile.ts から import
  if (!existsSync(profilePath)) {
    throw new Error(
      `${profilePath} がありません。先に \`node src/cli.ts style-profile --from ${dir}` +
        `${name !== "default" ? ` --name ${name}` : ""}\` を実行してください`,
    );
  }
  const reference = JSON.parse(readFileSync(profilePath, "utf8")) as StyleProfile;

  // 2) 候補を SD-T0 の集約経路で畳む(§2.2 の再利用)
  const proj = describeJson(dir, cfg);
  const sound = readJsonOpt<SoundReport>(join(dir, AV_DIR, SOUND_FILE));   // 欠落可(→ audio skipped)
  const motion = readJsonOpt<MotionReport>(join(dir, AV_DIR, "motion.json"));
  const bgmPresent =
    existsSync(join(dir, "bgm.json")) ||
    ["bgm.mp3", "bgm.m4a", "bgm.wav"].some((f) => existsSync(join(dir, f)));
  const candObs = observeOwnProject({ path: dir, proj, sound, motion, planRaw: null, bgmPresent });
  const candidate = mergeObservations("_candidate", [candObs]);

  // 3) 距離計算(純関数)
  const findings = compareProfiles(reference, candidate);
  const report: StyleCheckReport = {
    schemaVersion: STYLE_CHECK_SCHEMA_VERSION,
    profileName: reference.name,
    provenance: reference.provenance,
    findings,
    counts: summarizeFindings(findings),
  };

  // 4) 収録フォルダ直下 <dir>/style-check.json に書く(編集ファイルは1バイトも書かない)
  const reportPath = join(dir, STYLE_CHECK_FILE);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath };
}
```

- `planRaw: null` を渡す(補正デルタは距離に不要)。
- `describeJson` は本編射影(av 非依存)。候補が own-project でない(manifest/cutplan 欠落)
  ケースは describeJson が投げる前提のまま(style-check の対象は編集途中の収録=own-project)。
- **候補側の av.probe 欠落は throw しない**(bgm-fit と違い前提にしない)。sound=null →
  audio section が skipped(info)へ優雅に劣化する。これが av 欠落時の劣化経路。

### 2.5 stdout 整形(`formatStyleCheckReport`)

`bgmFit`/`effectCheck` の `formatXxxReport` と同型(`string[]` を返し CLI が 1 行ずつ出す)。

```
style-check: profile=default (own-project) / warn 1 info 2 skipped 1
[warn] cutDensity.avgShotSec: ペースが学習帯 [2.1s,10.0s] より遅い(候補 114.0s, conf 0.28)
[info] captions.positionHint: 位置ラベル不一致 bottom→top(参照 conf 0.27 で情報レベル)
[info] audio: 測定値なし(候補に av.probe/sound.json が無い。先に `av <dir>`)
距離 assert はすべて warn(exit 0)。逸脱は学習帯からのズレであって不正ではありません。
検出結果を /…/2026-07-10/style-check.json に書きました。
```

- findings 0 件 → `距離 assert: profile の学習帯内(逸脱なし)`。
- 常に **exit 0**(逸脱の有無で終了コードを変えない)。severity は行頭ラベル `[warn]`/`[info]` で表す。
- 末尾に「warn は逸脱=不正ではない」を 1 行添える(母艦 §10.0 warn 主義の明示)。

### 2.6 CLI 登録(`src/cli.ts`)

`bgm-fit` の直後あたりに追加。import は `style-check` の 2 つ。

```ts
import { styleCheck, formatStyleCheckReport } from "./stages/styleCheck.ts";
// …
program
  .command("style-check <dir>")
  .description(
    "収録の現在の編集(候補)の観測統計が style profile の学習分散帯からどれだけ逸脱しているかを" +
      "決定論で測り、warn/info(常に exit 0)で報告する。要 `style-profile --from <dir>` の事前実行。" +
      "profile が持つ軸(cut/caption/audio)に閉じる。編集ファイルは1バイトも書かず style-check.json だけを書く",
  )
  .option("--profile <name>", "参照する profile 名(style.probe/<name>.json)。省略時 default")
  .action((dir: string, opts: { profile?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = styleCheck(abs, { profile: opts.profile }, cfg);
    for (const line of formatStyleCheckReport(abs, result)) console.log(line);
  });
```

`style-check <dir>` は位置引数 `<dir>` を持つ(`style-profile` が `--from` 主義なのと対照。
style-check は「この 1 収録を profile に照らす」ので `<dir>` が自然)。profile 不在時の throw は
`program.parseAsync().catch(...)`(cli.ts 末尾)が exit 1 で捕まえる。逸脱報告自体は exit 0。

### 2.7 `src/lib/files.ts` と 5 点セットの差分

- **files.ts**: `GENERATED_FILES` 配列に `"style-check.json"` を 1 要素追加
  (`bgm-fit.json` の並び付近)。`style.probe/` は既に `GENERATED_DIRS` にあるため channel 側は
  変更不要。style-check.json は**収録フォルダ直下**の固定名生成物なので `GENERATED_FILES` が正しい家
  (effect-check.json/bgm-fit.json と同じ)。
- **types.ts**: 触らない(型は styleCheck.ts)。
- **validate.ts**: 触らない(生成物レポート)。
- **schemas/**: 触らない(生成物は schema 無し。`schema.test.ts` の全単射不変)。
- **docs/usage.md**: `bgm-fit`/`effect-check` の節の近くに `style-check` 節を追加
  (何を測るか=cut/caption/audio の学習帯距離・warn/info の意味・二層帯と confidence の関係・
  `--profile`・前提=先に `style-profile`・出力 `style-check.json`・編集ファイル不変)。
- **AGENTS_CONTRACT.md**: (a) コマンド表に 1 行、(b) 生成物一覧に `style-check.json` の説明。
  両方 `test/agentsMd.test.ts` が照合(コマンド名 `| \`style-check` と、GENERATED_FILES の
  各要素文字列の包含)。**この 2 箇所を落とすと `npm test` が落ちる**。
  - コマンド表(§CLI table)追加行(英語):
    `| \`style-check <dir>\` | Measure how far the recording's current edit (candidate) deviates from a learned style profile's variance bands (cut pace via the profile's shot-length [p10,p90] band, caption coverage/density/position, loudness/silence), and report deviations as warn/info — always exit 0. Requires \`style-profile --from <dir>\` first; a two-tier band widened by each section's confidence keeps a cold-start (N=1) profile from over-warning. Scoped to cut/caption/audio (profile v1). Writes \`style-check.json\`; never writes editable files |`
  - 生成物一覧(§GENERATED/deny 節)追加文:
    `\`style-check.json\` (the machine-readable report written by \`style-check\`: cut/caption/audio deviation findings against a \`style.probe/<name>.json\` profile, each with observed/expected/band/confidence/severity; warn/info only, never fail)`
- **CLAUDE.md**: (a) 「コマンド」節に
  `node src/cli.ts style-check <dir>  # 候補の編集が style profile の学習帯からどれだけ逸脱するかを測る(warn/info・exit 0。要 style-profile 事前実行)` の 1 行、
  (b) 中間生成物一覧(files.test.ts が CLAUDE.md 一致を前提にしているコメントあり)に `style-check.json` を追記、
  (c) 「動画の中身を知る方法」節に `style-check` を 1 項足す(profile 逸脱の測定面)。

### 2.8 重要論点C の reconcile — profile v1 scope に閉じる(effect 密度 / BGM cadence / structure / 素材の defer)

母艦 §10.0 は T1 assert に「演出密度・BGM 切替 cadence」も挙げるが、**profile v1 schema
(`StyleProfile`)は effect/bgm policy を格納しない**(§7 骨子 = cutDensity/captions/audio/structure)。
整合を明記する:

- **T1 v1 の距離 assert は profile が実際に値を持つ軸 = cut / caption / audio に閉じる**
  (要件 5・§10.0)。素材配置(§2.4)・演出**座標**(§2.2)は profile v2 = スコープ外。
- **演出"密度"**: effect-check に既に密度ガードがあるが、それは **config 固定閾値**
  (`resolveEffectCheckCfg`)であって「学習値」ではない。母艦 §5.1「閾値をプロファイル
  学習値へ」は **profile v2 が effect policy(章あたり演出本数の学習分布)を格納してから**
  T1 に合流する拡張点。v1 では**着手しない**(config 固定の effect-check と二重化させない)。
- **BGM 切替 cadence**: profile v1 は `audio.bgmLikely`(boolean)までで、章あたり切替回数を
  持たない。同じく **profile v2(bgm policy 格納)待ちの拡張点**として明示 defer。v1 の
  audio 距離は integratedLufs/truePeakDbtp/silenceRatio/bgmLikely に閉じる。
- **structure**: profile v1 は structure(hookSec/chapterCount/ctaLikely/segments)を**持つ**が、
  T1 v1 の名指しスコープ(cut/caption/audio・§10.0)に入っていないため **v1 assert からは外す**。
  profile が値を持つので v1.1 で足すのは軽い(ctaLikely=categorical・hookSec/chapterCount=scalar)。
  ただし **merge 時 segments=null**(異収録の timeline を混ぜられない)ので segment 整合の
  意味論を決めてからにする。本書は「structure は profile にあるが T1 v1 では測らない」を
  明示的な scope 外として記す(母艦 §7「素材/演出座標を採点次元に挙げつつ profile が値を
  持たない状態を明示的に scope 外とする」の structure 版)。

**要するに v1 の可動域 = cut/caption/audio の 3 section。** effect 密度・BGM cadence・structure・
素材は「profile v2 or v1.1 で該当 policy を持ってから T1 に合流」と本書で defer を確定する。

### 2.9 母艦 §2/§5.1 の次元表 再分類(実装時に母艦を編集する追記テキスト)

要件 3・§5.1 末尾「profile 導入後 §2 の次元表を D/J で再分類」。Sonnet は実装時に母艦へ
以下を反映する(**確定した文言**):

**(a) §2.1 カット表**: 「ペース」行の種別を `J→D` から **`D(SD-T1)`** に更新し、
測り方欄に「profile の shot 長 [p10,p90] 学習帯からの距離(SD-T1 `style-check`)」を追記。

**(b) §2.3 BGM 表**: 「ラウドネス」行の測り方に「目標 LUFS は profile.audio.integratedLufs、
`style-check` が ±絶対帯(confidence 広げ)で距離判定(SD-T1)」を追記(種別は D のまま)。

**(c) §5.1 J→D 表**: 各行に「SD-T1 実装状況」を注記する:
  - ペース → **`D`(SD-T1 実装済。KS ではなく [p10,p90] 帯近似。full 分布 KS は profile v2)**
  - caption 密度/位置 → **`D`(SD-T1 実装済。coverage=絶対帯・density/positionHint=カテゴリ一致)**
  - BGM loudness/切替頻度 → **loudness は `D`(SD-T1 実装済)/ 切替頻度は profile v2 待ち(未)**
  - 演出密度 → **v1 は config 固定のまま(学習値化は profile v2 待ち。未)**
  - 構成 → **profile は値を持つが T1 v1 scope 外(v1.1。未)**

**(d) §2.5 横断 assert 面**: 「プロファイルの学習帯からの逸脱も、ここに合流する新しい
assert 面」に **「= SD-T1 `style-check`(cut/caption/audio。warn/info・exit 0)。実装済。」** を追記。

**(e) §10.1 SD ロードマップ表**: SD-T1 の状態を「着手中」→ **「完了(PR #NN・2026-07-12)」**
へ更新し、§11 に実装ログを追記(SD-T0 のログと同型: コマンド `style-check`・生成物
`style-check.json`・二層帯/confidence 広げの確定・cold-start 実測=自己一致 warn 0/
2026-07-10 で pace warn の確認)。

---

## 3. 検証(コーディネータ実測・必須)

cold-start でも決定論で測れることを実データで示す。channel = `/Users/19mo/Movies/cutflow`。
テスト収録 = `2026-07-02`(av.probe 生成済み・承認済み)・`2026-07-10`(av.probe 未生成・
単一 114 秒無カット keep)。

### 3.1 前提のセットアップ

```sh
cd /tmp   # 中立 cwd([[llm-command-verify-neutral-cwd]])。ただし describe/av は LLM 非依存なので厳密には repo 直下でも可
node /Users/19mo/dev/tools/cutflow/src/cli.ts style-profile --from /Users/19mo/Movies/cutflow/2026-07-02
# → channel の style.probe/default.json を(再)生成。SD-T0 実測値: avgShot 5.46 / p10 2.09 / p90 10 /
#   cut conf 0.28・cap conf 0.27・audio conf 0.25。既存があれば内容が同じことを確認
```

### 3.2 自己一致(距離ほぼ 0・warn なし)

```sh
node …/src/cli.ts style-check /Users/19mo/Movies/cutflow/2026-07-02
```
期待: 候補=profile 元と同一収録なので **cut/caption/audio とも inner 帯内 → finding 0 件
(または誤差丸めで borderline=info が数件)。warn は 0**。exit 0。
`style-check.json` が `2026-07-02/` 直下に生成される。**自己整合の確認**。

### 3.3 異収録の逸脱検出(pace で warn)

```sh
node …/src/cli.ts style-check /Users/19mo/Movies/cutflow/2026-07-10
```
期待:
- **cutDensity.avgShotSec / medianShotSec**: 候補 ≈ **114s**(単一無カット keep)。reference 帯
  inner=[2.09,10]・outer≈[-3.6,15.7]。114 ≫ outer → **`kind:"deviation"`, `severity:"warn"`**。
  → **逸脱検出の主眼がここで出る**(母艦「ペース等で warn」)。
- **audio**: 2026-07-10 に av.probe/sound.json が無い → 候補 audio=null → **`skipped`(info)**。
  「先に `av`」を message に含む。→ **av 欠落時の優雅な劣化の確認**。
- **captions**: 2026-07-10 の caption 状況次第(無カット素材で caption 希薄なら coverage 逸脱 or
  captionCount 0 で skipped)。surfaced されること自体を確認(warn/info どちらでも可)。
- exit 0(逸脱があっても)。counts に warn≥1 が立つ。

### 3.4 profile 不在時(前提エラーのみ exit 1)

```sh
node …/src/cli.ts style-check /Users/19mo/Movies/cutflow/2026-07-10 --profile nonexistent
```
期待: `style.probe/nonexistent.json` が無い → **throw → exit 1** + 「先に `style-profile --from …
--name nonexistent`」の案内。**逸脱報告自体は exit 0・前提エラーだけ exit 1** の切り分け確認。

### 3.5 ユニットテスト `test/styleCheck.test.ts`(realistic 値で固定)

母艦 §6.1「D 次元は関数直叩き」。純関数 `compareProfiles`/`widen`/`numericBands`/
`classifyNumeric`/`classifyCategorical`/`summarizeFindings` を IO ゼロで固定する。
StyleProfile は手組みの最小値(styleProfile.test.ts と同じ流儀)。

| # | ケース | 期待 |
|---|---|---|
| 1 | 自己一致: reference === candidate(全 section 同値) | findings は warn 0(borderline も 0 か info のみ)。**自己整合を関数レベルで固定** |
| 2 | pace 桁違い逸脱・高 conf: ref avg=5.46 p10=2.09 p90=10 conf=0.7、cand avg=114 | `deviation`/`warn`(outer 超過) |
| 3 | pace 帯内: 同 ref、cand avg=6.0 | finding なし(inner [2.09,10] 内) |
| 4a | 軽い逸脱 + 低 conf で outer が広がり borderline に収まる: ref conf=0.28、cand avg=11 | `borderline`/`info`(inner 外・outer 内) |
| 4b | 桁違い逸脱 + 低 conf でも warn は消えない: ref conf=0.28、cand avg=114 | `deviation`/`warn`(**floor で潰れないことの固定**) |
| 5 | カテゴリ一致: positionHint bottom==bottom | finding なし |
| 6 | カテゴリ不一致・高 conf: positionHint bottom→top、ref conf=0.7 | `mismatch`/`warn` |
| 6' | カテゴリ不一致・低 conf: 同 top、ref conf=0.27 | `mismatch`/`info`(CATEGORICAL_TRUST_CONF 未満) |
| 7 | mixed 吸収: ref positionHint=mixed(or cand=mixed) | finding なし |
| 8 | 欠測: ref.audio.integratedLufs=null(or cand=null) | `skipped`/`info` |
| 9 | percentile 帯: cand median が [p10,p90] 内/外 | 内=なし・外=deviation |
| 10 | `widen` 単調性: widen(0.9) < widen(0.3) かつ widen(1)=1 | 数値固定 |
| 11 | dB 絶対帯: integratedLufs ref=-14 tol=3、cand=-15→内 / cand=-22→outer 外 | 内=なし / warn |
| 12 | coverageRatio 絶対帯: ref=0.8 tol=0.15、cand=0.7→内 / cand=0.4→外 | 内=なし / deviation |
| 13 | 全 finding が warn|info のみ(fail が絶対出ない)を型・値で assert | severity ∈ {warn,info} |

### 3.6 green・編集ファイル不変

- `npx tsc --noEmit`(= `npm run typecheck`)green。
- `npm test` green(既存 + 新規 styleCheck.test.ts + files.test.ts の 1 ケース増 +
  agentsMd.test.ts がコマンド表/生成物一覧を自動照合)。
- **編集ファイルは 1 バイトも書かない**(§8 不変条件2)。実測: style-check 実行後に
  `git status`(収録は別リポだが)/ 収録フォルダの cutplan.json 等の mtime 不変を確認。
  書かれるのは **`<dir>/style-check.json` のみ**。

---

## 4. リスク

1. **cold-start の帯設計の脆さ(最大リスク)**: N=1 では confidence が 0.25〜0.33 と一様に低く、
   「学習分散」は 1 本の内部ばらつき(shot 長 p10/p90)しか無い。二層帯はこれを
   「広い outer 帯で mild 逸脱を吸収・桁違いだけ warn」で凌ぐが、**帯の絶対的な妥当性は
   N が増えるまで検証しきれない**。N≥2 になれば cross-project 実分散へ置換する拡張点
   (§2.3 の learned-percentile を profile の実分布配列 or section 分散に差し替え)。
   `BAND_WIDEN_SLOPE`/`BAND_REL_TOL`/`CATEGORICAL_TRUST_CONF` は module 定数=後で調整可。
2. **過剰 warn / 過少 warn のチューニング**: tol/slope の初期値は §2.3 の実データ 1 点
   (2026-07-02 profile)からの当て。過少側(桁違いしか warn しない)に倒しているのは
   cold-start の正直さを優先したため。実運用で「もっと拾いたい/静かにしたい」は定数調整で
   吸収する設計(config 化は将来。v1 は SD-T0 同様 module 定数=config 不要)。
3. **profile v1 scope の割り切り(§2.8)**: effect 密度・BGM 切替 cadence は母艦 §10.0 が T1 に
   挙げるが profile v1 が値を持たないため **defer**。effect-check の密度ガード(config 固定)と
   混同されると「T1 が演出も測っている」と誤読される恐れ→ usage/CLAUDE の文言で「cut/caption/
   audio に閉じる」を明示する。structure は profile が値を持つのに測らない(v1.1)ことも同様に明記。
4. **av 欠落時の audio 距離の劣化**: 候補に av.probe が無い(2026-07-10)と audio section が
   丸ごと skipped(info)になる。これは仕様(前提にしない=優雅劣化)だが、**「audio が
   静かなのは測れていないから」なのか「実際に一致しているから」なのかを混同しない**よう、
   skipped は必ず info + 「先に `av`」を message に出す(母艦 §6.3 カバレッジ併記の精神)。
   reference 側 audio が null(bare-video profile 等)でも同様に skipped。
5. **5 点セットのテストピン留め**:
   - `test/agentsMd.test.ts` が **CLI の全 `.command` 名を AGENTS_CONTRACT.md 照合**+
     **GENERATED_FILES 全要素の文字列包含**を要求 → `style-check` コマンド行と
     `style-check.json` 生成物文の**両方**を AGENTS_CONTRACT に入れないと落ちる(**必須**)。
   - `test/files.test.ts` の `EXPECTED_GENERATED_FILES` を更新しないと `deepEqual` が落ちる。
   - `schemas/` は**足さない**(足すと `schema.test.ts` の examples 全単射が壊れる)。
     style-check.json が schema を持たないことは effect-check.json/bgm-fit.json の前例で正当。
   - `src/types.ts` を触らないので `test/schema.test.ts`(types↔schema ピン)には無影響。
6. **候補集約経路の継ぎ目**: candidate を `mergeObservations([1本])` に通す設計は SD-T0 の
   集約と完全に同経路なので単位/ラベルの継ぎ目は生じにくいが、**describeJson の keep
   durationSec は出力(カット後)秒**である点に注意([[stage-orchestrator-bug-classes]] の
   source÷output 単位継ぎ目)。profile 側も同じ出力秒で作られているので整合するが、
   ユニットテストで avgShotSec の単位が両側同一(出力秒)であることを固定する。
