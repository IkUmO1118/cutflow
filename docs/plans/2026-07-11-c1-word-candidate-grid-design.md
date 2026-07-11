# 実装設計書 SD2: C1(+C7/C8)— words で候補格子を細分化(番号選択のまま)

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§7 の SD2。
> 前提設計書: `docs/plans/2026-07-11-d7-w0-implementation-design.md`(SD1=D7+W0)。
> 本書はその **C1 + C7 + C8** を、実装担当(弱いモデル想定)がそのまま着手できる
> 粒度まで落とした設計書。**この3施策だけが対象**。C2・H1/H2・H6 は含めない。
>
> **前提となる確定方針(母艦 §6):** アーキ=ハイブリッド(**本書ではまだ apply 分割は
> しない**=番号選択のまま候補を増やすだけ)/ スコープ=cut に集中 / 順序=W0→**C1**→H。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **C1**: `plan` の候補格子を、無音境界(`detect` の `cuts.auto.json`)だけでなく
  **語タイムスタンプ(`transcript.words`)由来の語境界でも分割**する。0.7 秒未満の
  微小ポーズ・フィラーの境界を候補に足し、LLM が「候補を丸ごと選ぶ」方式のまま
  **より細かい単位で cut/keep を選べる**ようにする(R0 の天井を上げる)。
- **C7**: 分割点を**語境界(語間ギャップの中)**に置く=カット境界が語の途中に落ちない。
  `detect` の `padSec` 固定余白の弱点を、少なくとも内部分割点については解消する。
- **C8**: 候補の表示テキストを、その候補内に実際に**残る語**だけにする
  (現状 `numberSegments` は overlap した whisper チャンクの**全文**を出しており、
  境界をまたぐと「実際には残らない語」が候補テキストに混ざる=母艦 §3.4.2c)。

**本書でやらないこと(混同禁止):**
- **番号選択方式は維持する。** LLM 出力は今と同じ `cuts: [{id, reason}]`。**候補を
  増やすだけ**で、LLM に時刻を書かせない/apply もさせない。R0 を「直接」越える
  apply 分割(H6)は **SD5**。
- **C2(重複テイク検出)は含めない。** C1 は「言い直しが始まりやすい境界」を候補に
  足すだけ。near-duplicate の検出・ペア提示は C2(別設計書)。
- **H1(pull 型知覚=判断LLMに tool を握らせる)/ H2 は含めない**(SD4)。本書は
  `plan` の**入力(候補格子とテキスト)**を変えるだけで、LLM 呼び出しは単発 completion のまま。
- `detect.ts` は**触らない**(無音のみの決定論処理のまま。細分化は plan 側で行う。理由は §2)。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **タイル性(最重要)**: 1つの keep 候補を分割した sub-candidate 群は、元の keep を
   **隙間なく・重なりなく・完全に覆う**([keep.start, keep.end] を連続分割)。隙間を作ると
   その時間が暗黙に cut される。分割は「内部分割点 t1<t2<…<tk を選び、
   `[start,t1],[t1,t2],…,[tk,end]` を作る」だけ。
2. **分割しても切らなければ出力は不変**: 隣接する同速 keep は describe/render で
   `mergeIntervals`(`timeline.ts:154`)/`playbackSegmentsOf` が繋ぐ。よって
   **sub-candidate を全部 keep したままなら、最終出力は分割前と完全に同一**。C1 が
   出力を変えるのは LLM が実際に sub-candidate を cut したときだけ。これが安全性の核。
3. **opt-in / バイト等価**: 新設 `candidates.enabled`(既定 **false**)。false のときは
   `numberSegments`(`plan.ts:85`)の呼び出しも含め**現状と完全にバイト等価**。有効化した
   ときだけ細分化+語ベーステキストに切り替わる(measurement は回帰基準線で flag on 比較)。
4. **words 不在への優雅な劣化**: words を持たない収録(SD1 の W0 前に撮った素材等)では
   分割点が作れず**候補は分割されない**(=実質 disabled 相当)。例外は投げない。
   W0 の validate 警告が「re-transcribe せよ」を既に伝えている。
5. **番号選択の維持**: buildCutplan(`plan.ts:128`)は今のまま numbered→keep/cut の 1:1。
   細分化しても「存在しない id は無視」の安全網はそのまま効く。

## 2. なぜ detect ではなく plan 側で分割するか(設計判断)

母艦 backlog は「detect を無音のみ→words 併用」と書くが、`detect.ts` は現状
manifest+micWav だけを読む決定論ステージで、**transcript を読まない**。detect に
transcript 依存を足すとステージ順序(transcribe→detect)の制約が増える。一方 `plan.ts`
は既に `cuts.auto.json` と `transcript.json` の**両方**を読んでいる(`plan.ts:290-297`)。
よって細分化は **plan の入力整形**として plan 側の純関数で行い、`detect.ts` と
`cuts.auto.json`(中間生成物)は不変に保つ。これが最小侵襲で不変条件も守りやすい。

## 3. 変更点の全体像(新規1 + 変更2 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/candidates.ts`(新規) | 細分化の純関数群 + 語ベーステキスト |
| B | `src/lib/config.ts` | `candidates` 設定型 + `resolveCandidatesCfg`(既定 disabled) |
| C | `src/stages/plan.ts:297` | enabled 時だけ「細分化→語ベース番号付け」に差し替え |
| D | `config.yaml` | `candidates:` ブロック追記(コメント付き・既定 false) |
| E | `docs/usage.md` | `candidates` 設定の説明を追記 |
| F | テスト | `test/candidates.test.ts` 新規 + plan 経路の enabled/disabled 等価確認 |

**5点セット判断**: cutplan.json / cuts.auto.json のスキーマは**不変**(NumberedSegment は
内部型、cutplan は従来どおり keep/cut)。よって `schemas/*.schema.json` /
`AGENTS_CONTRACT.md` / `types.ts` のスキーマコメントは**変更不要**。触るのは config と
docs/usage.md のみ。

### A. `src/lib/candidates.ts`(新規)

```ts
import type { Interval, Transcript, WordTiming } from "../types.ts";

export interface CandidatesCfg {
  /** 細分化+語ベーステキストの有効化。false=現状とバイト等価 */
  enabled: boolean;
  /** これ以上長い keep だけを分割対象にする(短い候補は割らない) */
  splitOnlyLongerThanSec: number;
  /** 語間ギャップがこの秒以上なら分割点候補にする(通常 detect の
   *  minSilenceSec 未満。無音検出が拾わない微小ポーズを拾う) */
  minSplitGapSec: number;
  /** 分割後の各 sub-candidate の最小尺。これ未満になる分割はしない/隣へ併合 */
  minCandidateSec: number;
  /** フィラー語(単独の候補として切り出せるようにする)。表記そのまま前方一致 */
  fillers: string[];
}

/** transcript の全 words を時系列で集める(発話 segment のみ。章テロップ等 words 無しは自然に除外)。 */
export function collectWords(transcript: Transcript): WordTiming[] {
  return transcript.segments
    .flatMap((s) => s.words ?? [])
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

/** 1つの keep [start,end] に対する内部分割点(昇順・両端は含まない)を返す純関数。
 *  規則:
 *   1. keep 内に落ちる words を拾う。
 *   2. 連続する語の間の gap(prev.end→next.start)が minSplitGapSec 以上なら
 *      その gap の中点を分割点候補にする(C7=語境界に置く)。
 *   3. フィラー語 w は、その前後(w.start と w.end)を分割点候補にして
 *      「フィラー単体の sub-candidate」を作れるようにする。
 *   4. すべての分割点で切ったときに、どの sub-candidate も minCandidateSec 以上に
 *      なるよう、近すぎる分割点は間引く(貪欲: 直前の確定境界から minCandidateSec
 *      未満の分割点は捨てる)。end 側も同様に、末尾片が minCandidateSec 未満なら
 *      最後の分割点を捨てる。 */
export function splitPointsForKeep(
  keep: Interval,
  words: WordTiming[],
  cfg: CandidatesCfg,
): number[] {
  // 実装ヒント:
  // - inKeep = words.filter(w => w.start >= keep.start - 1e-6 && w.end <= keep.end + 1e-6)
  // - gap 中点: (prev.end + next.start) / 2
  // - フィラー判定: cfg.fillers.some(f => w.text.trim().startsWith(f))
  // - 間引きは分割点を昇順に走査し、直前の確定境界(初期値 keep.start)から
  //   minCandidateSec 以上離れているものだけ採用。最後に keep.end との差も確認。
  // - 返すのは keep.start < p < keep.end を満たす点だけ。
  return []; // ← 実装する
}

/** keep 群を語境界で細分化して、タイル性を保った Interval[] を返す純関数。
 *  - cfg.enabled=false または words 皆無 → 入力をそのまま返す(恒等)。
 *  - 各 keep について、尺 <= splitOnlyLongerThanSec なら分割せずそのまま。
 *  - 分割点 p1<...<pk があれば [start,p1],[p1,p2],...,[pk,end] を出力(丸め済み)。 */
export function subdivideCandidates(
  keeps: Interval[],
  transcript: Transcript,
  cfg: CandidatesCfg,
): Interval[] {
  if (!cfg.enabled) return keeps;
  const words = collectWords(transcript);
  if (words.length === 0) return keeps;
  const out: Interval[] = [];
  for (const k of keeps) {
    if (k.end - k.start <= cfg.splitOnlyLongerThanSec) { out.push(k); continue; }
    const pts = splitPointsForKeep(k, words, cfg);
    let cursor = k.start;
    for (const p of pts) { out.push({ start: round2(cursor), end: round2(p) }); cursor = p; }
    out.push({ start: round2(cursor), end: round2(k.end) });
  }
  return out;
}

/** 候補 [start,end] に「実際に残る語」だけを連結したテキストを返す(C8)。
 *  語の中点が候補区間に入るものを採用(境界の重複表示を防ぐ)。
 *  words が全く無ければ null を返し、呼び出し側は従来の numberSegments にフォールバック。 */
export function candidateText(
  seg: Interval,
  words: WordTiming[],
): string | null {
  if (words.length === 0) return null;
  const mid = (w: WordTiming) => (w.start + w.end) / 2;
  const inside = words.filter((w) => mid(w) >= seg.start && mid(w) < seg.end);
  return inside.map((w) => w.text.trim()).filter((t) => t.length > 0).join(" ");
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
```

> **NumberedSegment を作る所(C8 の配線)**: `plan.ts` に、enabled 時専用の
> `numberSegmentsWords(grid, transcript)` を足す(下記 C)。中身は既存
> `numberSegments`(plan.ts:85)と同型だが、各候補の text を `candidateText(seg, words)`
> で作り、null(words 皆無)なら既存の overlap 全文にフォールバックする。**既存
> `numberSegments` は一切変更しない**(disabled 経路・remeta・plan-shorts をバイト等価に保つため)。

### B. `src/lib/config.ts`

- `Config` の型に任意フィールドを追加(既存 `resolvePerceptionCfg` の並びに倣う):
  ```ts
  candidates?: {
    enabled?: boolean;
    splitOnlyLongerThanSec?: number;
    minSplitGapSec?: number;
    minCandidateSec?: number;
    fillers?: string[];
  };
  ```
- `resolveCandidatesCfg(cfg: Config): CandidatesCfg` を追加。既定値:
  `enabled=false / splitOnlyLongerThanSec=6 / minSplitGapSec=0.3 / minCandidateSec=0.5 /
  fillers=["えー","えっと","あの","あのー","まあ","その","なんか"]`。
  `resolvePerceptionCfg` と同じ「未指定は既定へ」パターン。**enabled 既定 false** は
  バイト等価のため必須。

### C. `src/stages/plan.ts`(細分化の配線)

`plan.ts:297` の
```ts
const numbered = numberSegments(auto.keepSegments, transcript);
```
を、enabled 分岐に差し替える:
```ts
const cc = resolveCandidatesCfg(cfg);
const numbered = cc.enabled
  ? numberSegmentsWords(subdivideCandidates(auto.keepSegments, transcript, cc), transcript)
  : numberSegments(auto.keepSegments, transcript);
```
- `numberSegmentsWords` は本ファイルに新設(§A の注記どおり。`collectWords` を1回呼び、
  各候補 text は `candidateText` → null フォールバックで `numberSegments` 相当)。
- **`opts.cutsOnly` 経路(`generateCutsOnce` / `runCutsLoop`)も同じ `numbered` を使う**
  ため、この1箇所の差し替えで cuts-only / loop / full plan すべてに効く(numbered は
  `plan()` 冒頭で1回作られ全経路へ渡る=`plan.ts:297` が単一の出所)。
- **remeta は変更しない**(remeta の numberSegments は「完成 keep の章・タイトル用文脈」で
  あり cut 候補ではない=細分化不要)。plan-shorts も本書では触らない。

### D. `config.yaml`

`plan:` セクション付近に、既定 false・コメント付きで追記:
```yaml
candidates:
  enabled: false            # 語境界で候補を細分化(C1)。要 whisper.wordTimestamps。
                            # false=無音境界のみ(従来とバイト等価)。回帰基準線で on 比較してから既定化を検討
  splitOnlyLongerThanSec: 6 # これより長い候補だけを分割
  minSplitGapSec: 0.3       # 語間ギャップがこの秒以上なら分割点(無音検出が拾わない微小ポーズ)
  minCandidateSec: 0.5      # 分割後の最小尺(これ未満の断片は作らない)
  fillers: ["えー", "えっと", "あの", "あのー", "まあ", "その", "なんか"]
```

### E. `docs/usage.md`

`candidates` 設定の意味と、**words(whisper.wordTimestamps)前提**であること、既定 false・
回帰で on 比較してから既定化を検討する運用を1段落追記。

## 4. テスト(`test/candidates.test.ts` 新規)

純関数中心に固定する:
- **タイル性**: 任意の keep + words で `subdivideCandidates` の出力が、各元 keep を
  隙間・重なりなく完全被覆する(sub の start が前の end と一致、先頭=keep.start、
  末尾=keep.end)。
- **恒等**: `enabled=false` → 入力配列と同一。`words 皆無` → 同一。
- **splitOnlyLongerThanSec**: 閾値以下の keep は分割されない。
- **minCandidateSec**: 近接分割点が間引かれ、どの sub も minCandidateSec 以上。
- **語境界(C7)**: 分割点が語間ギャップの中(前語 end < p < 次語 start)に来る。
- **フィラー**: フィラー語が単独 sub-candidate として切り出せる(前後に分割点)。
- **candidateText(C8)**: 境界をまたぐ whisper チャンクがあっても、候補テキストは
  「中点がその候補に入る語」だけ=隣候補と重複しない。words 皆無で null。
- **plan 経路の等価**: `resolveCandidatesCfg` 既定で enabled=false を確認。
  可能なら `numberSegmentsWords` の words フォールバックが `numberSegments` と一致することも。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(W0 済みの words 付き収録1本):
  1. `config.yaml` の `candidates.enabled: false` のまま `plan --cuts-only` → 生成結果が
     enabled 導入前と一致(バイト等価)。
  2. `enabled: true` に変え `detect` 済み前提で `plan --cuts-only` → `cutplan.json` の
     segments 数が増え、境界が語間に来ることを `describe --json` で確認。**どの keep も
     切らなければ出力尺は不変**(不変条件2)を、全 keep のケースで確認。
  3. `after-c1` スナップショット(SD1 Part A)を取り `baseline`/`after-w0` と diff。
- **完了報告は実測ログ付き**(母艦の運用: 完了報告は必ず実測検証)。

## 6. 受け入れ基準

- `subdivideCandidates` がタイル性を常に満たす(テストで固定)。
- `enabled=false` で plan 出力が導入前とバイト等価。
- `enabled=true` かつ words ありで候補数が増え、分割点が語境界に乗る。
- 全 sub-candidate を keep した場合の最終出力(describe の keeps・render 尺)が分割前と同一。
- words 無し収録では例外なく分割スキップ(劣化)。
- `npx tsc --noEmit` と `npm test` が通る。

## 7. 次フェーズへの引き継ぎ(本書の外)

- C1 で「細かい候補格子」が手に入る。次は **SD3(X4=balanced 既定)** で積極度を上げ、
  C1 と**別に**効果測定する(格子と積極度を混ぜない)。
- その後 **SD4(H1 pull 型知覚 + H2 検証主経路化)** で、この細かい格子の上に
  判断 LLM の tool ループを載せる。**本書はまだ単発 completion のまま**である点に注意。
- R0 を「直接」越える apply 分割は **SD5(H6)**。C1 は番号選択の枠内で格子を細かくする
  ところまで(=天井を上げるが、越えはしない)。
