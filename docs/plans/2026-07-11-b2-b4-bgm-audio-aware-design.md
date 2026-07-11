# 実装設計書 SD-B2: B2(無音/被り回避の配置)+ B4(fallback 検出)— av.probe を見た BGM 調整

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§4「BGM」/ §7。
> 前段: **SD-B1**(`2026-07-11-b1-b3-bgm-placement-candidates-design.md`)= 「どの区間にどの曲」を作る。
> 本書はその続きで、**音を実測して(av.probe)BGM の音量/duck/切替を調整**し、**全編1曲 fallback が
> 精度不足に見えるケースを検出**する。実装担当(弱いモデル想定)がそのまま着手できる粒度に落とす。
> **B2(無音/被り回避)+ B4(fallback 検出)が対象**。
>
> **前提となる確定方針(母艦 §2 原則4):** 調整値は**av.probe の実測からの算術**で出す。音量・duck 量を
> LLM に書かせない。B2/B4 は基本**決定論**で、LLM はほぼ使わない(母艦の非決定性の壁を避ける)。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **B2(無音/被り回避の音量・duck・切替調整)= 決定論**: `av.probe/sound.json`(`av <dir>`)の
  - **silences**(keep 後タイムラインの無音区間)→「ここは BGM を下げるべき/むしろ BGM だけが映える」箇所。
  - **tracks.samples**(mic/system の RMS と `louder`)→ BGM が発話に被っている区間。
  - **mix**(統合 LUFS・short-term 包絡)→ 全体の音の大きさ。
  を突き合わせ、既存 `bgm.json` の各トラックへ **`volumeDb` の補正 / `fadeInSec`/`fadeOutSec` の付与 /
  発話被り区間での減衰(duck 相当を volumeDb で近似)** の候補を出す。出力は **`apply` パッチ下書き**。
- **B4(BGM なし/単調 fallback の検出)= 決定論**: `bgm.json` が無く**全編1曲 fallback**(収録直下 `bgm.*`)
  で流れている、または `bgm.json` が1トラックで全編を薄く覆っているだけ、を検出し、「章が複数あるのに
  BGM が単調」等の**精度不足サイン**を警告して **`plan-bgm`(SD-B1)へ誘導**する。
- 出力は**検出レポート**(stdout + `bgm-fit.json`)と **`apply` パッチ下書き**(`bgm-fit.suggested.json`)。
  収録フォルダの編集ファイルには**書かない**(補正は人間が `apply` で当てる)。

**本書でやらないこと(混同禁止):**
- **BGM 区間や選曲を作らない**(それは SD-B1)。本書は**既存 BGM の音量/duck/切替を調整**し、単調 fallback を
  **検出して SD-B1 を指す**まで。
- **自動で `apply` を実行しない。** 下書きパッチを書くだけ(適用は人間)。
- **render の duck 実装を変えない。** render は既に duck を解析的に併記する(`src/lib/duck.ts`、
  av の sound.json に `bgm.duckSpans`)。本書はその**配置意図**(どの区間をどれだけ下げるか)を
  `volumeDb` 補正として提案するだけで、レンダラの duck ロジックには触らない。
- **時刻・音量を LLM に生成させない。** 調整値は av.probe の RMS/LUFS からの算術。v1 は LLM を使わない。
- **cut / cutplan.json / approvals.json を触らない。**

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **収録フォルダへ直接書かない**: 本コマンドが書くのは `bgm-fit.json`(検出結果)+ `bgm-fit.suggested.json`
   (apply パッチ下書き。使い捨て)+ stdout。編集ファイル(bgm.json)の変更は**必ず `apply` を経由**。
2. **調整値は実測からの算術**: `volumeDb` の補正量は「被り区間で発話 RMS を N dB 上回らないよう BGM を下げる」等の
   av.probe 値からの計算。LLM/人手の勘で数値を入れない(母艦 原則4)。
3. **パッチは @id 宛先の `ops`**: bgm トラックの `volumeDb`/`fadeInSec` 補正は `apply` の `set`(要 `@id`)。
   トラックに id が無ければ狙えない → 「先に `id-stamp <dir>`」と告げて exit 1(SD-M2 と同じ優雅な拒否)。
   `Bgm.tracks[].id` は `MaterialRef`(materials.ts)や buildReferences で既に拾える形。
4. **av.probe の欠如は優雅に拒否**: `av.probe/sound.json` が無い/古いときは例外を投げず「先に `av <dir>` を
   実行せよ」と告げて exit 1。keep 集合・設定が変わって陳腐化しているときも同様(av の key で判定)。
5. **cut / 承認不変**: cutplan.json / approvals.json を読まない・書かない。bgm 編集は承認スコープ外なので、
   生成パッチを人間が `apply` しても承認 hash は生きたまま。
6. **fallback 検出は誘導まで**: B4 は「単調」を**検出して SD-B1 を指す**だけ。本書で区間割り・選曲をしない
   (SD-B1 の責務。重複実装禁止)。

## 2. 設計判断(なぜこの形か)

- **なぜ B2 が決定論か**: 「発話に BGM が被る」「無音区間で BGM が浮く」は av.probe の RMS/silence から機械的に
  判定でき、補正量も算術で出る。LLM を挟むと非決定 + garbage-in。決定論なので snapshot/diff で測れる
  (`memory/precision-measurement-nondeterminism-wall.md`)。
- **なぜ音量調整を `volumeDb` 補正 + `apply` パッチにするか**: 既存 bgm トラックの**修正**なので、SD-M2 と同じく
  `apply`(検査・backup・approved 保護)に委ねるのが最小で安全。render の duck ロジックを書き換えるより、
  「被り区間だけ volumeDb を下げる短いトラックに分割する / その区間の volumeDb を下げる」提案の方が、
  人間が bgm.json 上で理解・調整しやすい。
- **なぜ duck を volumeDb 近似にするか**: render は既に duck を持つ(duck.ts)。本書が render の duck を
  いじると二重制御になる。B2 は「配置意図」を bgm.json の volumeDb/区間で表し、レンダラの duck はそのまま
  効かせる(av の sound.json は duck を解析併記しているので、提案が duck と衝突しないか裏取りできる)。
- **なぜ B4 が誘導止まりか**: 単調の解消 = 章×テンションの区間割り = SD-B1 そのもの。ここで再実装すると
  二重管理。B4 は「単調」を検出して SD-B1 の `plan-bgm` を指すのが正しい分業。

## 3. 変更点の全体像(新規2 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/bgmFit.ts`(新規・純関数) | 被り/無音区間の検出 / volumeDb・fade 補正の算術 / 単調 fallback 判定 / 補正 `EditOp[]` 生成 |
| B | `src/stages/bgmFit.ts`(新規) | av.probe/sound.json・bgm.json を読み、A を呼び、`bgm-fit.json` と `bgm-fit.suggested.json` を書く(fs 側) |
| C | `src/cli.ts` | `bgm-fit <dir>` コマンド登録(av.probe 前提・id-stamp 前提の告知含む) |
| D | `src/lib/config.ts` + `config.yaml` | `bgmFit` 設定(被り判定の dB マージン・duck 目標・単調判定のしきい値) |
| E | `docs/usage.md` + `AGENTS_CONTRACT.md` | 新コマンド・`bgm-fit.json`/`bgm-fit.suggested.json` を GENERATED_FILES へ |
| F | テスト | `test/bgmFit.test.ts`(純関数:被り検出・補正算術・単調判定・補正 op) |

**5点セット判断**: `bgm.json` の**スキーマは不変**(既存 `volumeDb`/`fadeInSec` 等しか触らない)。
`ApplyPatch`/`EditOp` も既存。`types.ts`/`schemas/*` は変更不要。**CLI コマンドが増える**ので
`AGENTS_CONTRACT.md` のコマンド一覧 + `bgm-fit.json`/`bgm-fit.suggested.json`(GENERATED_FILES)+
`test/agentsMd.test.ts` を更新。

### A. `src/lib/bgmFit.ts`(新規・純関数)

`av.ts` の `SoundReport`(av.ts:64)を入力に取る。fs 非依存。

```ts
import type { Bgm, EditOp } from "../types.ts";
import type { SoundReport } from "../stages/av.ts";

/** BGM 調整の1件。ref は対象トラックの @id。suggested は補正(適用は apply)。 */
export interface BgmFitFinding {
  refId: string;                 // 対象トラックの @id
  kind: "speech-overlap" | "silence-float" | "loud" | "no-fade";
  startOutSec: number;           // 出力(カット後)秒
  endOutSec: number;
  currentVolumeDb: number;       // 現在の実効 volumeDb(省略時は config 既定を解決した値)
  suggestion: EditOp;            // apply の set op
  reason: string;
}

/** SoundReport(silences / tracks.samples / mix / bgm.spans/duckSpans)と bgm.tracks を
 *  突き合わせて調整候補を出す純関数。
 *  - speech-overlap: tracks.samples で louder==="system" or mic RMS と BGM が近接 → 被り。
 *      発話区間の BGM を「発話 RMS を cfg.speechHeadroomDb 下回る」ところまで下げる volumeDb を提案。
 *      av の bgm.duckSpans で既に下がっているなら二重に下げない(裏取り)。
 *  - silence-float: silences 区間に BGM が原音量で乗る → 浮く。cfg.silenceDuckDb 下げる or fade を提案。
 *  - loud: mix.integratedLufs が cfg.targetLufs を大きく超え、BGM 寄与が主因 → 全体 volumeDb 減を提案。
 *  - no-fade: 区間端(特に末尾)に fade が無い → fadeOutSec 付与を提案。 */
export function detectBgmFit(sound: SoundReport, bgm: Bgm, cfg: BgmFitCfg): BgmFitFinding[] {
  return []; // ← 実装する
}

/** B4: 単調 fallback 判定。
 *  - fallbackActive: bgm.json が無く収録直下 bgm.* で全編1曲(呼び出し側が bool で渡す)。
 *  - monotone: bgm.tracks が1本で総尺の cfg.monotoneCoverRatio 超を単一 file で覆っている。
 *  かつ chapterCount >= cfg.minChaptersForVariety のとき「章が複数なのに BGM 単調」と警告。 */
export function detectMonotone(args: {
  fallbackActive: boolean;
  bgm: Bgm | null;
  totalOutSec: number;
  chapterCount: number;
  cfg: BgmFitCfg;
}): { monotone: boolean; message: string } {
  return { monotone: false, message: "" }; // ← 実装する
}

/** suggestion を持つ finding を apply パッチ(ops)へ束ねる。 */
export function buildBgmFitPatch(findings: BgmFitFinding[]): { ops: EditOp[] } { return { ops: [] }; }

export interface BgmFitCfg {
  speechHeadroomDb: number;     // 発話 RMS を BGM がこの dB 下回るまで下げる(既定 8)
  silenceDuckDb: number;        // 無音区間で BGM を下げる量(既定 3)
  targetLufs: number;           // 全体ラウドネス目標(既定 -14。超過で loud 判定)
  minFadeSec: number;           // no-fade 判定で付ける fade 秒(既定 1.0)
  monotoneCoverRatio: number;   // 単一 file が総尺のこの割合超で monotone(既定 0.9)
  minChaptersForVariety: number;// 章がこの数以上あると BGM 単調を警告(既定 3)
}
```

**補正 op の最小形**(`apply` の `set`):

```ts
{ op: "set", target: "@bg_a1b2c3", field: "volumeDb", value: -10 }     // 被り区間の減衰
{ op: "set", target: "@bg_a1b2c3", field: "fadeOutSec", value: 1.5 }   // 末尾フェード付与
```

- 被り区間だけを下げたいが1トラックが広く覆っている場合、`set volumeDb` はトラック全体に効く。区間だけ下げるには
  **トラック分割が要る**が、`apply` の `set`/`remove`/`add` は分割(1トラックを3本へ)を直接表せない
  (docs/usage.md: split は `replace` の脱出ハッチ)。v1 は「トラック全体の volumeDb を被りに合わせて下げる」
  提案に留め、区間限定の分割は §7(replace で表す拡張)。この割り切りを stdout と reason に明記する。

### B. `src/stages/bgmFit.ts`(新規)

1. `av.probe/sound.json` を読む(無ければ §1-4 に従い「先に av」で exit 1)。`bgm.json` を読む
   (無ければ fallback 判定へ=B4。編集対象トラックは無い)。
2. **bgm トラックに id が1つも無いなら**(かつ B2 補正が出る見込みのとき)「先に `id-stamp <dir>`」で exit 1
   (ops の宛先に @id が要る)。
3. `detectBgmFit`(B2)と `detectMonotone`(B4)を呼ぶ。B4 の `fallbackActive` は「bgm.json 無し ∧ 収録直下
   bgm.* あり」で判定、`chapterCount` は chapters.json から。
4. `buildBgmFitPatch` で `{ ops }` を組み、`bgm-fit.suggested.json`(ApplyPatch 互換 JSON)を書く。
   検出結果全体を `bgm-fit.json`(機械可読)へ。
5. stdout に人間向けレポート:
   - B2: 被り/無音/大音量/no-fade の各 finding(区間・現状 volumeDb・提案・reason)。
   - B4: 単調/fallback のとき「`plan-bgm <dir>` で章×テンションの区間割りを作れる」と誘導。
   - 末尾に `apply --patch bgm-fit.suggested.json` の手順を1行。
6. **編集ファイルを1バイトも書かない**(検出結果とパッチ下書きだけ)。

> **中間生成物の登録**: `bgm-fit.json`(検出結果)・`bgm-fit.suggested.json`(パッチ下書き。使い捨て)を
> `GENERATED_FILES` に追加。

### C. `src/cli.ts`

`bgm-fit <dir>`(LLM を使わないので `--force`/backup 不要=収録ファイルを書かない):
- av.probe 未生成・id 未採番の exit 1 告知は B-1/B-2。

### D. `src/lib/config.ts` + `config.yaml`

```yaml
# BGM の音量/被り/単調の検出と調整提案(bgm-fit)。要 av <dir> の事前実行。
# 出力は apply パッチ下書き(bgm-fit.suggested.json)で、適用は人間が apply で行う。
bgmFit:
  speechHeadroomDb: 8      # 発話 RMS を BGM がこの dB 下回るまで下げる(被り回避)
  silenceDuckDb: 3         # 無音区間で BGM を下げる量
  targetLufs: -14          # 全体ラウドネス目標(超過で loud 判定)
  minFadeSec: 1.0          # no-fade 判定で付ける fade 秒
  monotoneCoverRatio: 0.9  # 単一 file が総尺のこの割合超で monotone
  minChaptersForVariety: 3 # 章がこの数以上あると BGM 単調を警告
```

### E. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: `bgm-fit` の使い方(前提 = `av` と(補正時)`id-stamp`、出力 = apply パッチ下書き、
  適用は人間の `apply`、B4 は `plan-bgm` へ誘導、render の duck には触らない、cut/承認非干渉)を1節。
- `AGENTS_CONTRACT.md`: コマンド一覧に `bgm-fit`、中間生成物へ `bgm-fit.json`/`bgm-fit.suggested.json`。
  **`test/agentsMd.test.ts` がピン留めするので揃える**。

## 4. テスト(`test/bgmFit.test.ts` 新規)

- **detectBgmFit**:
  - speech-overlap: samples で louder==="system"(BGM 側が発話に勝つ)区間に volumeDb 減の set / 既に
    duckSpans で下がっている区間は二重に下げない。
  - silence-float: silences 区間の BGM に silenceDuckDb 減 or fade。
  - loud: mix.integratedLufs > targetLufs で全体 volumeDb 減。
  - no-fade: 末尾区間に fade 無し→ fadeOutSec 付与。
  - 補正値が av.probe 値からの算術(固定入力で決定論・同入力同出力)。
- **detectMonotone**: 1トラックが総尺の monotoneCoverRatio 超 ∧ chapterCount ≥ minChaptersForVariety → monotone /
  章が少なければ monotone にしない / fallbackActive(bgm.json 無し + bgm.*)で警告。
- **buildBgmFitPatch**: findings が apply の EditOp 形(set は field/value)/ suggestion 無しは ops に入らない。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(BGM と発話が被る収録1本。bgm.json にトラックあり、id 済み):
  1. `node src/cli.ts av <dir>` で sound.json を作る(発話と BGM の被りが出る素材)。
  2. `node src/cli.ts bgm-fit <dir>` が speech-overlap を検出し `bgm-fit.suggested.json` に volumeDb 減の set を書く。
  3. `node src/cli.ts apply <dir> --patch bgm-fit.suggested.json --dry-run` が「volumeDb: 旧→新」を出し validate を通る。
     適用後 `av <dir>` を撮り直し、被り区間の BGM RMS が下がることを確認。
  4. bgm.json を消し収録直下 bgm.mp3 だけにする + 章を3つ以上→ `bgm-fit` が monotone/fallback を警告し `plan-bgm` へ誘導。
  5. av.probe 未生成→「先に av」で exit 1。id 未採番→「先に id-stamp」で exit 1(例外でない)。
- **完了報告は実測ログ付き**。
- **測定の注意**: B2/B4 は**決定論**なので snapshot/diff で正しく測れる(関数直叩きで確定。
  `memory/precision-measurement-nondeterminism-wall.md`)。補正の**聴感上の当否**(下げすぎ/足りない)は
  人間が preview で聴いて `bgm-mismatch` タグで scorecard に記録。

## 6. 受け入れ基準

- 収録フォルダの編集ファイルを1バイトも書かない(出力は `bgm-fit.json`/`bgm-fit.suggested.json` と stdout)。
- 補正値がすべて av.probe 値からの算術で、LLM/勘の数値を含まない。
- 生成パッチが `apply --patch` で検査を通り、当てると被り区間の BGM が下がる(av 再取得で裏取り)。
- 既に duckSpans で下がっている区間を二重に下げない。
- B4 が単調/fallback を検出して `plan-bgm` へ誘導する(区間割り・選曲は本書で作らない)。
- av.probe 未生成/id 未採番で例外を投げず告知して停止。
- render の duck ロジックに触らない。cutplan.json / approvals.json を読まない・書かない。
- `AGENTS_CONTRACT.md` にコマンド・中間生成物追加、`npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **区間限定の減衰(トラック分割)**: v1 はトラック全体の volumeDb を下げる。被り区間だけ下げるには1トラックを
  3本(前・被り・後)へ分割する必要があり、`apply` の `set`/`add`/`remove` では表せない(split は `replace` の
  脱出ハッチ=docs/usage.md)。分割提案は `replace` パッチを組む拡張として起こす。
- **render duck との一本化**: 本書は volumeDb 近似で duck 意図を表し、レンダラ duck はそのまま効かせる。将来
  「配置意図(bgm.json)とレンダラ duck の責務境界」を整理して二重制御を無くす検討余地。
- **B2 の LLM 化の誘惑を断つ**: 音量調整は決定論に留める。「どのくらい下げると気持ちいいか」の主観は人間の
  preview で決め、機械は「被っている/浮いている」の事実と算術補正だけを出す(母艦 原則4)。
- **SD-B1 との往復**: B4 が単調を検出 → SD-B1 で区間割りを作り直す → B2 で音量を整える、の往復が BGM の
  基本ループ。E7(検品ループ戻し)の骨を使えば、bgm-fit の警告を plan-bgm の観測へ戻せる(演出と同じ横展開)。
</content>
