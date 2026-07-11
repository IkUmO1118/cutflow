# SD-T4 設計書 — profile→判断注入(compact style policy を cut 判断 LLM の prompt へ opt-in/sticky で注入)

> Opus 設計 → Sonnet 実装 → コーディネータ実測のリレー([[opus-sonnet-relay-workflow]])。
> 母艦: `docs/plans/2026-07-11-aesthetic-judgment-and-style-learning.md`
> (§5.3 判断向上の基質・§6.2 brief 上書き・§7 compact style policy・§8 不変条件5/6・§10.0/§10.1)。
> 前提: **SD-T0 完了**(`style-profile` が channel 直下 `style.probe/<name>.json` を書く。型は
> `src/lib/styleProfile.ts` の `StyleProfile`。`STYLE_PROBE_DIR` は `src/stages/styleProfile.ts` から export)。
> **SD-T1 完了**(`style-check` が profile→距離 assert。SD-T4 の効果はこれで測る)。
>
> 体裁は精度母艦と同じ **4 部形式(背景 / 変更 / 検証 / リスク)**。コードは書かない。実装は Sonnet が
> 本書の粒度どおりに行う。

---

## 1. 背景

### 1.1 SD-T4 は §5.3「判断向上の基質」の経路1(候補スコアの事前分布)

母艦 §5.3 は、同じ profile が「判断を上げる燃料」にもなる、その注入経路を 3 つ挙げる:

1. **候補スコアリングの事前分布**(「このチャンネルは平均ショット N 秒 → そのペースへ寄せて切る重み」)。
2. **few-shot 判断例**(自コーパスから「似た過去状況ではこれを残した」を提示)。
3. **自己検証 assert の閾値**(profile が assert のパラメータになる)。

SD-T4 は **v1 で経路1 だけを実装する**。位置づけは以下で確定(§10.0 注入順・§5.3):

| 経路 | 内容 | SD-T4 v1 |
|---|---|---|
| 経路1 | compact style policy を prompt へ soft prior 注入 | **本書で実装** |
| 経路2 | few-shot 判断例(自コーパスから instance を提示) | **v2 拡張点(明示 defer)**。cold-start N=1 では few-shot の質も薄い(§5.3・§10.0) |
| 経路3 | assert 閾値化 | **SD-T1 で実装済**(`style-check`) |

経路2 が重い理由(母艦 §3/§5.3):profile(経路1)は *rate/placement 統計*(どのくらい/どこに)を
教えるが *instance semantics*(**この冗長な 1 文を切れ**)は落ちる。instance 判断は few-shot が担うが、
承認済み 1 本の cold-start では few-shot に載せる「似た過去状況」が薄い。ゆえに v1 は **統計の soft prior
(経路1)に集中**し、経路2 は自信作が溜まってから(SD-T2 agreement と同じ育つ経路)。

### 1.2 番号選択方式を壊さない(§8 不変条件5)

profile は **候補選択のバイアス(事前分布)として prompt に注入するだけ**で、LLM に精密な値・
タイムスタンプを書かせない。plan は従来どおり「どの番号区間を cut するか」を選ぶ(番号選択方式・
精度母艦 D1)。profile は「このくらいのペース・字幕密度・構成に寄せて選べ」という **ソフトな prior**。
出力スキーマ(`CUTS_RESPONSE_SCHEMA` / `PLAN_RESPONSE_SCHEMA`)は 1 バイトも変えない。

### 1.3 brief が profile を上書き(§6.2)

brief.md=今回の意図、profile=毎回の癖。衝突しうる(今回は静かにいきたいが普段はパンチ強め)。
SD-T4 は prompt 内で style policy を **「brief.md に劣後するソフトな prior」** と明記し、衝突時は
brief 優先を文言で位置づける(`CLAUDE.md` の rules vs brief と同型)。プロンプト上の配置も
`{{brief}}`(見せ場リスト)→ `{{rules}}` → `{{perception}}` → `{{styleProfile}}` の順で、prior は最後・
最弱の参考情報として置く。

### 1.4 バイト等価は perception と同じ理屈で守る(§8 不変条件6)

`plan.styleProfile` は既定 off。off のとき plan の LLM 入力・`plan.raw.txt` は導入前と **バイト等価**。
これは `plan.perception` の実装(off のとき `renderPerceptionBlock` が `""` を返し `{{perception}}` が
空に置換=出力バイト等価)を厳密に踏襲する。テンプレに `{{styleProfile}}` を足しても、off で `""` に
置換されれば出力は 1 バイトも変わらない(§2.6 で証明)。

### 1.5 v1 scope(注入先)

- **注入先 = cut 判断経路のみ**: `plan`(`prompts/plan.md`)/ `plan --cuts-only`(`prompts/plan-cuts.md`)。
- **明示 defer(v2 拡張点)**:
  - M/E/B 生成系(`plan-effects` / `plan-bgm` / `plan-materials`)への注入。
  - `remeta`(meta 生成)への注入(v1 は cut 判断に集中。`meta.md` には `{{styleProfile}}` を足さない)。
  - cuts-loop の critique 反復(`plan-cuts-critique.md`)への注入(§2.4。v1 は generate 反復のみ)。
  - profile v2 フィールド(素材配置・演出座標・BGM 切替 cadence・audio 目標)由来の policy。
- **経路2 few-shot** は §1.1 のとおり defer。

---

## 2. 変更(揺れない粒度)

### 2.1 新規/変更ファイル完全一覧

| 種別 | パス | 内容 |
|---|---|---|
| 新規 | `src/lib/styleInjection.ts` | compact style policy 導出 + ブロック整形の**純関数**・型・module 定数(IO ゼロ・決定論)。**SD-T4 の核**。`StyleProfile` を `import type` のみで取り込む |
| 新規 | `test/styleInjection.test.ts` | 純関数(導出/整形/off→空)・realistic 値 golden・renderPrompt レベル注入の固定 |
| 変更 | `src/stages/plan.ts` | ① profile 読込ヘルパ `loadStyleProfileForPlan`(channel から読む・不在で劣化)② `renderPrompt` に `styleProfile` 引数を末尾 optional で追加 ③ `plan()` で block を計算し plan.md / plan-cuts.md 経路へ配る(`generateCutsOnce` / `runCutsLoop` にも引数追加) |
| 変更 | `src/lib/config.ts` | `Config.plan.styleProfile` 型 + `resolveStyleProfileCfg` + status(`resolveStyleProfileStatus`/`formatStyleProfileStatusLines`)+ `validateWorkflowConfig` の未知キー検査 |
| 変更 | `src/cli.ts` | `printStyleProfileStatus` を追加し `plan` コマンドの action で `printPerceptionStatus` の直後に呼ぶ |
| 変更 | `prompts/plan.md` | `{{perception}}` の直後(区切り無し)に `{{styleProfile}}` を追加 |
| 変更 | `prompts/plan-cuts.md` | 同上 |
| 変更 | `test/config.test.ts` | `resolveStyleProfileCfg` / status / `validateWorkflowConfig` の追随テスト |
| 変更(docs) | `AGENTS_CONTRACT.md` / `CLAUDE.md` / `docs/usage.md` | `plan.styleProfile`(config キー・注入契約)の説明を追記(コマンド表ではない) |
| 変更(docs) | 母艦(本 md) | §5.3/§9.2 Q9 状態更新 + §10.1 SD-T4 完了化 + §11 作業ログ追記 |

**生成物の追加なし**:SD-T4 は新しい生成物を作らない(profile を読むだけ)。よって
`src/lib/files.ts`(`GENERATED_FILES`/`GENERATED_DIRS`)は**無変更**、`schemas/` は**無変更**、
`AGENTS_CONTRACT.md` の**コマンド表は無変更**(新コマンド無し)、`src/types.ts` は**無変更**
(config 型は `config.ts`)。→ `test/schema.test.ts`(schemas/types/validate の全単射)と
`test/agentsMd.test.ts`(編集ファイル一覧・`GENERATED_FILES`・**コマンド名**・`ID_PREFIX` の網羅)は
**無影響**(SD-T4 はどれも触らない。これを検証節で green 確認する)。

### 2.2 `Config.plan.styleProfile` 型と `resolveStyleProfileCfg`

`plan.perception` に厳密に倣う。`plan.styleProfile` は **object**(perception と同型。`--name` で profile を
選べる必要があるため boolean 単独にはしない。「既定 false」は `enabled` の既定を指す)。

`src/lib/config.ts` の `Config.plan` に追記(型コメントも 5 点セットの一部):

```ts
// Config.plan の中(perception / loop / harness と並ぶ)
/** SD-T0 が抽出した style profile を compact な soft prior として plan /
 *  plan --cuts-only のプロンプトへ注入する opt-in 設定。省略/enabled=false の
 *  とき plan の LLM 入力・plan.raw.txt は導入前とバイト等価(plan.perception と
 *  同型の不変条件)。番号選択方式は維持=LLM に精密な値は書かせない(§8 不変条件5)。
 *  brief.md に劣後するソフトな prior として注入される(§6.2)。
 *  §docs/plans/2026-07-12-sd-t4-style-injection-design.md */
styleProfile?: {
  /** 注入の有効化。省略時 false(バイト等価)。true で channel 直下
   *  style.probe/<profile>.json を読み compact policy を prompt に添える */
  enabled?: boolean;
  /** 読み込む profile 名(style.probe/<profile>.json)。省略時 "default"。
   *  style-profile --name と対応 */
  profile?: string;
};
```

解決関数(`resolvePerceptionCfg` の隣に置く。`loadConfig` は `cfg.plan` を書き換えない=省略=off を守る):

```ts
/** plan.styleProfile.profile 未指定時の既定 profile 名 */
export const DEFAULT_STYLE_PROFILE_NAME = "default";

/** plan.styleProfile を既定値で解決する純関数(省略時 enabled=false=バイト等価)。 */
export function resolveStyleProfileCfg(cfg: Config): { enabled: boolean; profile: string } {
  const s = cfg.plan?.styleProfile ?? {};
  const profile = (s.profile ?? DEFAULT_STYLE_PROFILE_NAME).trim() || DEFAULT_STYLE_PROFILE_NAME;
  return { enabled: s.enabled ?? false, profile };
}
```

### 2.3 status 表示(`printPerceptionStatus` と同型)

`resolvePerceptionStatus`/`formatPerceptionStatusLines`/`printPerceptionStatus` の 3 段構えに倣う。
status は **config だけを見る**(fs は読まない=profile ファイルの実在は plan 実行時に warn。perception が
`transcript.system.json` の実在を status で見ないのと同じ)。

`src/lib/config.ts`:

```ts
export interface StyleProfileStatus {
  explicit: boolean;   // cfg.plan?.styleProfile !== undefined
  enabled: boolean;
  profile: string;
  warnings: string[];
}

export function resolveStyleProfileStatus(cfg: Config): StyleProfileStatus {
  const sc = resolveStyleProfileCfg(cfg);
  const explicit = cfg.plan?.styleProfile !== undefined;
  const warnings: string[] = [];
  if (!explicit) {
    warnings.push("plan.styleProfile が config.yaml にありません。スタイル注入はオフです。");
  }
  return { explicit, ...sc, warnings };
}

export function formatStyleProfileStatusLines(status: StyleProfileStatus): string[] {
  return [
    ...status.warnings.map((w) => `警告: ${w}`),
    `plan スタイル注入: ${status.enabled ? `on(profile=${status.profile})` : "off"}`,
  ];
}
```

`src/cli.ts`(`printPerceptionStatus` の直下に追加):

```ts
function printStyleProfileStatus(cfg: Parameters<typeof resolveStyleProfileStatus>[0]): void {
  for (const line of formatStyleProfileStatusLines(resolveStyleProfileStatus(cfg))) {
    console.log(line);
  }
}
```

`plan` コマンドの action(現状 line 338 の `printPerceptionStatus(cfg);` の直後)に
`printStyleProfileStatus(cfg);` を 1 行足す。**`remeta`・`run` には足さない**(v1 は plan の cut 経路に
限定。`run` は内部で `plan()` を呼ぶので注入自体は effective だが、status の 1 行は plan コマンドだけで
足りる=変更面を最小化)。

### 2.4 `validateWorkflowConfig` の未知キー検査

`plan.loop`/`plan.harness` と同じパターンで `plan.styleProfile` を追加(未知キー・型検査)。既存の
`plan.harness` ブロックの直後に:

```ts
const planStyleProfile = cfg.plan?.styleProfile as Record<string, unknown> | undefined;
if (planStyleProfile) {
  errors.push(...unknownKeys(planStyleProfile, ["enabled", "profile"]).map((key) => `plan.styleProfile.${key} は未対応です`));
  if ("enabled" in planStyleProfile && typeof planStyleProfile.enabled !== "boolean") {
    errors.push("plan.styleProfile.enabled は boolean で指定してください");
  }
  if ("profile" in planStyleProfile && typeof planStyleProfile.profile !== "string") {
    errors.push("plan.styleProfile.profile は文字列で指定してください");
  }
}
```

> 注: 現状 `cfg.plan` 自身のトップレベル未知キー検査は存在しない(perception も loop も harness も
> トップレベル allow-list は無い)。よって `styleProfile` を `plan` 直下に足すのに allow-list 追加は
> 不要。既存踏襲。

### 2.5 `src/lib/styleInjection.ts`(純関数の核・IO ゼロ)

**責務**: `StyleProfile`(SD-T0)→ compact style policy(§7)を **決定論で導出**し(閾値→文言の写像=
数値経路に LLM を挟まない)、plan の他ブロック(perception/rules)と同じ体裁の**人間可読の日本語
ブロック**へ整形する。IO/fs/LLM に一切依存しない(`StyleProfile` は `import type` のみ)。

**重要事実(SD-T0 との分業)**: `StyleProfile` は既にラベル(`cutAggressiveness`/`density`/`positionHint`)と
section ごとの `confidence` を **決定論で計算済み**(`mergeObservations`)。ゆえに SD-T4 の「閾値→文言」で
**新たに追加する決定論写像は 2 つだけ**:
1. **confidence → prior 強度文言**(`priorStrengthLabel`。cold-start の弱さを LLM に明示)。
2. **既存ラベル/数値 → 日本語 gloss + 表示整形**(`aggressivenessGloss`/`densityGloss`/`positionGloss` +
   `avgShotSec→"X.X秒"` / `coverageRatio→"NN%"`)。
profile が持たない値(§7 例の `pauseToleranceSec` 等)は**載せない**(存在するフィールドだけ・母艦 §7)。

#### 2.5.1 module 定数(閾値・gloss)

```ts
/** confidence → prior 強度の閾値(§10.0 cold-start は 0.25〜0.33 = 弱い prior)。境界は「以上」側 */
const STYLE_PRIOR_STRONG_CONF = 0.6;
const STYLE_PRIOR_MEDIUM_CONF = 0.4;

/** cutAggressiveness ラベル → 日本語 gloss */
const AGGRESSIVENESS_GLOSS: Record<NonNullable<CutDensity["cutAggressiveness"]>, string> = {
  high: "高(テンポ最優先・短めに)",
  "medium-high": "やや高(冗長は積極的に切る)",
  medium: "標準(明確な冗長を切る)",
  low: "低(ゆったり・切りすぎない)",
};

/** captions.density ラベル → 日本語 gloss */
const DENSITY_GLOSS: Record<NonNullable<CaptionsProfile["density"]>, string> = {
  high: "多め(ほぼ全編に字幕)",
  medium: "中程度",
  low: "少なめ",
};

/** captions.positionHint ラベル → 日本語 gloss */
const POSITION_GLOSS: Record<NonNullable<CaptionsProfile["positionHint"]>, string> = {
  top: "画面上部",
  center: "画面中央",
  bottom: "画面下部",
  mixed: "位置は一定でない",
};
```

#### 2.5.2 compact style policy(中間表現・§7 の style policy に対応)

profile v1 が持つ値だけで作る。**cut / caption / structure に閉じる**。**audio policy は v1 では省略**
(判断理由: SD-T4 の注入先は cut 判断 LLM。ラウドネス/無音の目標値は「どの区間を cut するか」を
直接には動かさない。§7 例の pace 由来 `pauseToleranceSec` は profile v1 に無いので audio 経由の pacing
prior も作れない。→ audio prior は M/E/B 注入(v2)で BGM 生成系に効かせるのが筋。v1 は cut 判断に
効く 3 面だけ)。segments(章 timeline)は timeline 依存なので **scalar の hookSec/ctaLikely だけ**を surface
(母艦「segments は要約のみ or 載せない」)。

```ts
export interface StylePolicy {
  provenance: StyleProfile["provenance"];
  cut: {
    targetAvgShotSec: number | null;
    aggressiveness: CutDensity["cutAggressiveness"];  // 既存ラベル
    shotSecP10: number | null;  // 学習帯の下側(SD-T1 と同じ帯)
    shotSecP90: number | null;  // 学習帯の上側
    confidence: number;
  } | null;   // profile.cutDensity が全て null(値が取れない)なら null=行を出さない
  caption: {
    coverageRatio: number | null;
    density: CaptionsProfile["density"];
    positionHint: CaptionsProfile["positionHint"];
    styleNotes: string[];
    confidence: number;
  } | null;
  structure: {
    hookSec: number | null;
    ctaLikely: boolean | null;
    confidence: number;
  } | null;
}

/** StyleProfile → StylePolicy(決定論の抽出。値が全く取れない section は null=行を出さない) */
export function buildStylePolicy(profile: StyleProfile): StylePolicy { /* §2.5.4 導出式どおり */ }
```

#### 2.5.3 prior 強度文言

```ts
export function priorStrengthLabel(confidence: number): string {
  if (confidence >= STYLE_PRIOR_STRONG_CONF) return "強め";
  if (confidence >= STYLE_PRIOR_MEDIUM_CONF) return "中程度";
  return "弱い(cold-start・参考程度)";
}
```

#### 2.5.4 compact policy の導出式(閾値→文言・揺れない粒度)

`buildStylePolicy(profile)`:

| policy フィールド | 導出 |
|---|---|
| `provenance` | `profile.provenance` |
| `cut` | `profile.cutDensity.avgShotSec === null && profile.cutDensity.cutAggressiveness === null` なら `null`。それ以外は `{ targetAvgShotSec: cd.avgShotSec, aggressiveness: cd.cutAggressiveness, shotSecP10: cd.shotSecP10, shotSecP90: cd.shotSecP90, confidence: cd.meta.confidence }` |
| `caption` | `cap.coverageRatio === null && cap.density === null && cap.positionHint === null && cap.styleNotes.length === 0` なら `null`。それ以外は該当フィールド + `confidence: cap.meta.confidence` |
| `structure` | `st.hookSec === null && st.ctaLikely === null` なら `null`。それ以外は `{ hookSec, ctaLikely, confidence: st.meta.confidence }` |

`formatStyleProfileBlock(policy)`(§7 の「圧縮 summary を渡す・raw JSON を貼らない」):

- 先頭見出し: `## スタイル方針(候補選択のソフトな prior)`
- brief 劣後の注記(§1.3・§6.2):
  `※ これは brief.md(今回の意図)に劣後する参考情報です。番号選択の重み付けにだけ使い、精密な数値やタイムスタンプは生成しないでください。brief と矛盾する場合は brief を優先。`
- `policy.cut` があれば 1 行:
  `- カット: 目標平均ショット長 約{avgShot.toFixed(1)}秒 / 積極度={AGGRESSIVENESS_GLOSS[aggr]} / 学習帯 約{p10}〜{p90}秒 [prior:{priorStrengthLabel(conf)}]`
  (avgShot が null なら「目標平均ショット長 約?秒」部分を省き、aggressiveness だけ出す。p10/p90 が
  null なら「学習帯 …」部分を省く。null を "n/a" で埋める分岐を明記=`fmtSec`/`fmtNum` 相当のヘルパを
  この module 内に持つ。styleProfile.ts の formatStyleProfileReport と同じ null 処理思想)
- `policy.caption` があれば 1 行:
  `- 字幕: カバレッジ約{Math.round(coverage*100)}% / 密度={DENSITY_GLOSS[density]} / 位置={POSITION_GLOSS[pos]} / 強調: {styleNotes.join(", ")} [prior:{strength}]`
  (styleNotes 空なら「強調: …」を省く)
- `policy.structure` があれば 1 行:
  `- 構成: 冒頭フック約{hookSec}秒 / {ctaLikely ? "末尾にCTAあり" : "末尾CTAなし"} [prior:{strength}]`
  (hookSec が null なら省く。ctaLikely が null なら CTA 部分を省く)
- ブロックの前後に **`\n` を必ず付ける**(renderPerceptionBlock/renderRulesBlock と同じ契約)。

#### 2.5.5 トップ関数(バイト等価の核)

```ts
/** enabled=false または profile===null のとき "" を返す(バイト等価の核。
 *  renderPerceptionBlock と完全に同じ契約: "" か、前後 \n を伴う1ブロック)。
 *  それ以外は buildStylePolicy → formatStyleProfileBlock。全 section が null に
 *  畳まれた(値が何も取れない profile)ときも "" を返す(空ブロックを出さない)。 */
export function renderStyleProfileBlock(profile: StyleProfile | null, enabled: boolean): string {
  if (!enabled || profile === null) return "";
  const policy = buildStylePolicy(profile);
  if (policy.cut === null && policy.caption === null && policy.structure === null) return "";
  return `\n${formatStyleProfileBlock(policy)}\n`;  // 実装は §2.5.4 の行を \n\n で連結
}
```

### 2.6 `src/stages/plan.ts` の統合(バイト等価がどう守られるか)

#### 2.6.1 profile 読込ヘルパ(不在で優雅劣化)

`buildIdContext` の近くに追加。`STYLE_PROBE_DIR` を `./styleProfile.ts` から import(`styleCheck.ts` と
同じ経路。`styleProfile.ts`(stage)は `plan.ts` を import しない=循環無し)。

```ts
import { STYLE_PROBE_DIR } from "./styleProfile.ts";
import { renderStyleProfileBlock } from "../lib/styleInjection.ts";
import type { StyleProfile } from "../lib/styleProfile.ts";

/** channel(dir の親)の style.probe/<name>.json を読む。不在・パース失敗は
 *  warn して null(=空注入へ優雅劣化。前提エラーで plan を止めない=§5.3/§SD-T4)。
 *  styleCheck.ts の profile 読込(channel = dirname(resolve(dir)))と同じ規約 */
function loadStyleProfileForPlan(
  dir: string,
  name: string,
  warn: (msg: string) => void,
): StyleProfile | null {
  const channel = dirname(resolve(dir));
  const path = join(channel, STYLE_PROBE_DIR, `${name}.json`);
  if (!existsSync(path)) {
    warn(`style profile が見つかりません: ${path}(先に \`style-profile --from ${dir}\`)。スタイル注入はスキップします`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StyleProfile;
  } catch (e) {
    warn(`style profile を解析できません: ${path}(${(e as Error).message})。スタイル注入はスキップします`);
    return null;
  }
}
```

> schemaVersion のハードゲートは v1 では設けない(v2 profile が来ても v1 フィールドは optional/nullable=
> `buildStylePolicy` が持たない section を null に畳むだけ。将来 v2 が破壊的なら schemaVersion warn を足す
> 拡張点)。

#### 2.6.2 `plan()` での block 計算(perception と同じ位置・同じ形)

`plan()` の `const perception = renderPerceptionBlock(...)`(現 line 328)の直後に:

```ts
const spc = resolveStyleProfileCfg(cfg);
const styleProf = spc.enabled ? loadStyleProfileForPlan(dir, spc.profile, (m) => console.warn(`警告: ${m}`)) : null;
const styleProfileBlock = renderStyleProfileBlock(styleProf, spc.enabled);
```

- off(既定): `spc.enabled === false` → `loadStyleProfileForPlan` を呼ばず(fs を触らず)
  `renderStyleProfileBlock(null, false)` → `""`。**バイト等価**。
- on だが profile 不在: `loadStyleProfileForPlan` が warn + `null` → `renderStyleProfileBlock(null, true)` →
  `""`(§検証 優雅劣化)。plan は止まらない。
- on かつ profile あり: block が入る。

#### 2.6.3 block を各 renderPrompt 経路へ配る

**(a) 非 cutsOnly 経路**(現 line 375-382 の `renderPrompt(dir, templateFile, numbered, duration, perception, buildEditModeCfg(cfg))`)に第7引数 `styleProfileBlock` を足す。

**(b) cutsOnly・単発経路** `generateCutsOnce` にパラメータ `styleProfile: string = ""` を末尾追加し、内部の
`renderPrompt(dir, "plan-cuts.md", ...)` に渡す。`plan()` からの呼び出し(現 line 364-372)で
`styleProfileBlock` を渡す。

**(c) cutsOnly・ループ経路** `RunCutsLoopArgs` に `styleProfile: string` を追加、`runCutsLoop` の
**iter===0(generate)** の `renderPrompt(args.dir, "plan-cuts.md", ...)`(現 line 503-510)に渡す。
`plan()` からの `runCutsLoop({...})`(現 line 342-362)で `styleProfile: styleProfileBlock` を渡す。
**critique 反復(iter>0)は v1 では styleProfile を渡さない**(`renderCritiquePrompt` →
`plan-cuts-critique.md` に `{{styleProfile}}` プレースホルダを足さない=注入されない・§1.5 defer)。

#### 2.6.4 `renderPrompt` シグネチャ変更(既存呼び出しのバイト等価を保証)

```ts
export function renderPrompt(
  dir: string,
  templateFile: string,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string = "",
  editModeCfg: EditModeCfg = DEFAULT_EDIT_MODE_CFG,
  styleProfile: string = "",   // ← 末尾 optional で追加(§X4 の editModeCfg と同型)
): string {
  // ... 既存のまま ...
  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{perception}}", () => perception)
    .replaceAll("{{styleProfile}}", () => styleProfile)   // ← 追加
    .replaceAll("{{editMode}}", () => editModeBlock);
}
```

**既存呼び出しのバイト等価**:`renderPrompt` を第7引数無しで呼ぶ全箇所(`remeta` の `meta.md`・
`renderCritiquePrompt` の `plan-cuts-critique.md`・`planShorts` の `plan-shorts.md` 等)は
`styleProfile === ""`。かつ **`{{styleProfile}}` プレースホルダを持つのは plan.md / plan-cuts.md だけ**
なので、他テンプレでは `replaceAll("{{styleProfile}}", () => "")` は **一致対象ゼロの no-op**=完全に不変。
`replaceAll` の関数形式なので `""` に `$&` 等の副作用も無い(既存 perception と同じ安全性)。

#### 2.6.5 テンプレ変更(バイト等価の要・落とし穴)

`prompts/plan.md` と `prompts/plan-cuts.md` の該当行(両テンプレとも現状):

```
{{brief}}
{{rules}}{{perception}}
## カットの判断基準
```

を:

```
{{brief}}
{{rules}}{{perception}}{{styleProfile}}
## カットの判断基準
```

に変える(**`{{perception}}` の直後に、前後の空白・改行を一切入れず `{{styleProfile}}` を連結**)。
off のとき perception も styleProfile も `""` に置換 → `{{brief}}\n{{rules}}\n## …` となり導入前と 1 バイト
差なし。**落とし穴**: `{{styleProfile}}` の前後に空白/改行を入れると off でもバイト等価が壊れる
(§4 リスク・検証の最重要点)。`meta.md`・`plan-shorts.md`・`plan-cuts-critique.md` には**足さない**。

---

## 3. 検証(コーディネータ実測・**主に決定論**)

plan の LLM 応答は非決定(母艦 §6.1)。**SD-T4 のマージゲートは決定論部分**に置く。品質効果は SD-T1 の
`style-check` で継続測定するが、それは**マージゲートではなく運用の測定機構**(§3.7)。

### 3.1 バイト等価(最重要・マージゲート)

- `plan.styleProfile` off(既定)で `renderPrompt`(`plan.md` / `plan-cuts.md`)の出力が導入前とバイト等価。
  既存 `test/perception.test.ts` の golden(line 236「perception 省略時は brief 既定文の直後に見出しが
  隣接する」+ line 239「`{{` 残骸が無い」)が**修正なしで green のまま**であることを確認
  (`{{styleProfile}}`→`""` が既存 golden を壊さない=バイト等価の直接証明)。
- 既存の plan 関連テスト(`test/rules.test.ts` / editMode / perception / `test/plan.test.ts`)が緑のまま。

### 3.2 注入の決定論確認(マージゲート)

- `renderStyleProfileBlock(profileFixture, true)` が compact policy を含む文字列を返す(先頭/末尾 `\n`・
  見出し `スタイル方針`・brief 劣後注記を含む)。
- `renderPrompt(dir, "plan.md", numbered, dur, "", editModeCfg, block)` の出力に `block` が
  `{{perception}}` スロットと `## カットの判断基準` の間に現れる(perception 隣接の固定。既存
  perception.test line 259「perception を渡すと `{{rules}}` 直後に挿入」と同型のテストを styleProfile 版で)。
- `plan-cuts.md` でも同様。

### 3.3 policy 導出の決定論(マージゲート・realistic 値 golden)

SD-T0 の 2026-07-02 profile(§10.0 例: **avgShot 5.46 / coverage 0.78 / density high / position bottom /
4 章 / cta true**、confidence は cold-start N=1 で 0.25〜0.33)を fixture 化し、`buildStylePolicy` /
`formatStyleProfileBlock` の期待文言を固定:

- cut: `avgShotSec 5.46 → cutAggressivenessLabel = "medium"`(閾値 high≤2/mediumHigh≤4/medium≤7)→
  文言「積極度=標準(明確な冗長を切る)」/「目標平均ショット長 約5.5秒」。
- caption: `coverage 0.78 → density "high"`(閾値 <0.3 low/<0.6 medium)→「カバレッジ約78% / 密度=多め」/
  「位置=画面下部」。
- structure: 「末尾にCTAあり」/「冒頭フック約{hookSec}秒」。
- confidence 0.25〜0.33 → `priorStrengthLabel = "弱い(cold-start・参考程度)"` が各行に付く。

golden は**安定した部分文字列**でアサートする(ブロック全文の完全一致は avgShot 端数・hookSec 実値で
脆いので避ける。`assert.match` で「約5.5秒」「積極度=標準」「密度=多め」「位置=画面下部」「末尾にCTAあり」
「弱い(cold-start」を個別に固定)。

### 3.4 profile 不在の優雅劣化(マージゲート)

- `renderStyleProfileBlock(null, true) === ""`(純関数レベル)。
- `loadStyleProfileForPlan(tmpDirWithoutProfile, "default", warnSpy)` が `null` を返し `warnSpy` が
  1 回呼ばれる(tmp dir・`test/perception.test.ts` の before/after tmp パターンに倣う)。
- → on だが profile 不在で plan の prompt は styleProfile 空(=off と同じ)・plan は止まらない。

### 3.5 status 表示(マージゲート)

`test/config.test.ts` で `formatStyleProfileStatusLines`:
- 未設定(explicit=false): 警告行 +「plan スタイル注入: off」。
- `enabled:true, profile:"punchy"`: 「plan スタイル注入: on(profile=punchy)」。
- `resolveStyleProfileCfg` 既定: `{ enabled:false, profile:"default" }`。空白/空文字 profile は "default" へ。

### 3.6 config / validate(マージゲート)

- `validateWorkflowConfig` が `plan.styleProfile.foo` 未知キーを拒否・`enabled` 非 boolean を拒否・
  `profile` 非文字列を拒否(`test/config.test.ts`。`plan.harness` の未知キーテストに倣う)。
- **無変更確認**: `test/schema.test.ts`(schemas/types/validate)と `test/agentsMd.test.ts`(コマンド名・
  `GENERATED_FILES`・編集ファイル一覧)が**修正なしで green**(SD-T4 は生成物もコマンドも増やさない)。

### 3.7 品質効果は SD-T1 の運用手順(**マージゲートにしない**)

実 LLM 実行は限定。**承認済み `2026-07-02` で `plan --cuts-only` を走らせると承認済み cutplan.json を
破壊するのでやらない**(§SD-T4)。品質効果の実測は運用手順として記述するに留める:

1. `2026-07-02` を scratch へコピー(中立 cwd。[[llm-command-verify-neutral-cwd]])。
2. `plan.styleProfile.enabled: false` で K 回 `plan --cuts-only` → 各回 `style-check` で逸脱(warn 数・
   pace deviation)を記録。
3. `plan.styleProfile.enabled: true` で K 回 → 同様に記録。
4. on の方が profile 学習帯からの逸脱(特に pace)が縮む傾向を **分布**で見る(単発 diff は非決定で
   採点不能・母艦 §6.1)。

→ これは**測定機構であってマージゲートではない**。コーディネータが実測するのは §3.1〜3.6 の決定論部分
(バイト等価・注入・導出・劣化・status・無変更確認)。

### 3.8 green・書込なし

- `npx tsc --noEmit`(= `npm run typecheck`)green。
- `npm test` green(既存 + 新規 `test/styleInjection.test.ts` + `test/config.test.ts` 追随)。
- **編集ファイル・profile を 1 バイトも書かない**(SD-T4 は読むだけ=plan の prompt に足すだけ。plan 自身が
  書く cutplan.json/plan.raw.txt は SD-T4 の責務外・従来どおり)。`style.probe/*.json` は読むだけ。

---

## 4. リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | **テンプレ変更でバイト等価が壊れる**(`{{styleProfile}}` の前後に空白/改行が混入) | `{{perception}}{{styleProfile}}` を**隣接・区切り無し**で置く(§2.6.5)。既存 perception.test の golden(修正なし)+ 新規 off アサートで二重固定。レビュー時に diff で該当行の前後空白を目視 |
| R2 | **非決定性で品質効果を単発で測れない**(母艦 §6.1・[[precision-measurement-nondeterminism-wall]]) | マージゲートは決定論部分のみ(§3.1〜3.6)。品質効果は SD-T1 `style-check` の分布測定=運用手順(§3.7)。マージ条件にしない |
| R3 | **cold-start の弱い prior**(N=1・confidence 0.25〜0.33)で LLM を誤誘導する | `priorStrengthLabel` が各行に「弱い(cold-start・参考程度)」を明記(§2.5.3)。ヘッダで brief 劣後・「精密な値を生成しない」を明記。prior は最弱の最後尾ブロックに配置(§1.3) |
| R4 | **番号選択方式を壊す**(prior が値/タイムスタンプ生成を誘発) | 出力スキーマ(`CUTS_RESPONSE_SCHEMA`/`PLAN_RESPONSE_SCHEMA`)は不変。prompt 文言で「番号選択の重み付けにだけ使い精密な値は生成しない」を明記(§1.2)。policy は raw JSON を貼らず日本語圧縮 summary(§2.5) |
| R5 | **profile と brief の衝突** | §6.2 どおり brief 優先を文言で明記。配置順 brief→rules→perception→styleProfile で prior を最弱に |
| R6 | **profile 不在/破損で plan が止まる** | `loadStyleProfileForPlan` が warn + null で優雅劣化(§2.6.1)。前提エラーで plan を止めない(cut 判断は profile 無しでも回る) |
| R7 | **config.test / perception.test のピン留めがずれる** | perception.test は**修正しない**(off バイト等価の証拠として温存)。config.test は追随(resolve/status/validate)。新規は styleInjection.test に隔離。schema.test / agentsMd.test は無変更 green を確認(§3.6) |
| R8 | **lib→stage の循環 import** | `styleInjection.ts`(lib)は `StyleProfile` を **type import のみ**(実行時に消える)。profile 読込(runtime)は `plan.ts`(stage)側に置き `STYLE_PROBE_DIR` を stage から import(styleCheck.ts と同経路・循環無し) |

---

## 5. 5 点セット / docs との整合(実装時チェックリスト)

- **config 変更あり**: `config.ts` 型コメント + `resolveStyleProfileCfg` + status + `validateWorkflowConfig` +
  `test/config.test.ts` 追随。
- **プロンプトテンプレ変更**: `plan.md` / `plan-cuts.md` に `{{styleProfile}}`(`{{perception}}` 隣接)。
- **generated 追加なし**: `files.ts` / `schemas/` / `AGENTS_CONTRACT` コマンド表 / `types.ts` は**無変更**。
  `schema.test.ts` / `agentsMd.test.ts` の照合は無影響(§3.6 で green 確認)。
- **docs 追記(コマンド表ではなく config/注入の節)**:
  - `AGENTS_CONTRACT.md`: `plan.styleProfile`(opt-in・既定 off・cut 経路のみ・番号選択維持・brief 劣後)を
    config/注入の記述として追記。
  - `CLAUDE.md`: 「AI が動画を編集するときの決まり」または plan 周辺に `plan.styleProfile` の 1 段落
    (off でバイト等価・profile 不在で劣化・cut 判断だけ・M/E/B と remeta は v2)。
  - `docs/usage.md`: 「plan の知覚(config.yaml の plan.perception)」の近くに「plan のスタイル注入
    (config.yaml の plan.styleProfile)」節を新設。
- **母艦更新**:
  - §5.3 の 3 経路の状態を「経路1=SD-T4 実装済 / 経路2=v2 defer / 経路3=SD-T1 済」に更新。
  - §9.2 の Q9(スタイル注入)状態を todo → 経路1 実装済に更新。
  - §10.1 の SD-T4 行を「着手中」→「完了(PR #NN)」に、状態と実装事実を追記。
  - §11 に 2026-07-12 SD-T4 実装完了ログ(compact policy=cut/caption/structure に閉じ audio/segments は
    載せない・prior 最弱配置・cold-start 弱 prior 明示・off バイト等価・profile 不在で劣化)。
