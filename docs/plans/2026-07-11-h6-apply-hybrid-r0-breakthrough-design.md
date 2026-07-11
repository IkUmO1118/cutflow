# 実装設計書 SD5: H6 — apply ハイブリッドで候補内部を語境界分割(R0 を直接突破)

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§7 の SD5。
> 前提: SD4(`2026-07-11-h1-h2-agentic-perception-loop-design.md`・**実装済み**)の有界 agentic ループ。
> 関連: SD2(`2026-07-11-c1-word-candidate-grid-design.md`・実装済み=語境界の**決定論**細分化)。
> 本書は **H6(確信区間だけ `apply`+validate/assert を安全網に候補内部分割を書く)= 母艦 §4「ハーネス」の
> 唯一 R0 を直接崩す施策** を、実装担当(弱いモデル想定)が着手できる粒度へ落とした設計書。**H6 だけが対象**。
>
> **前提となる確定方針(母艦 §6 D1 / §3.5):** アーキ=**ハイブリッド**。**番号選択方式を安全網に保ちつつ**、
> 確信の高い区間だけ候補内部分割を許す。番号選択の完全放棄(apply 全面移行)は**採らない**。R0 を
> **安全に部分突破**する。これまでの SD1〜SD4 は全て R0 を**保存**してきたが、**本書は R0 を意図的に崩す
> 最初の設計書**である。ただし崩し方は「LLM に自由な時刻を書かせる」ではなく「**語という既存アンカーを
> 選ばせ、apply+検査で書く**」= 番号選択の思想は語粒度へ拡張されるだけで放棄されない。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **agentic ループに候補内部分割の書き込み tool を1つ足す(H6)。** SD4 の `set_cuts`(候補 id 単位・R0 保存)は
  そのまま残し、その隣に **`split_candidate`**(1つの候補を**語境界**で割り、内部の一部だけを cut にする)を足す。
  これが **R0(非分割の壁=`buildCutplan` の 1:1 写像)を初めて直接崩す**経路。40 秒ほぼ連続で喋る中央の
  1文だけを消す、といった「候補が丸ごと1つで all-or-nothing」だった編集を可能にする(母艦 §3.4.2a R0)。
- **番号選択を語粒度へ拡張する(ハルシネーション耐性を保ったまま R0 を崩す核心)。** LLM は**時刻を生成しない**。
  対象候補の中の**語を index で選ぶ**(`list_words` で index 付き語リストを見て、`split_candidate` で
  「候補 #N の語 i〜j を cut」と指す)。分割境界は必ず **`transcript.words` の語境界時刻へスナップ**され、
  LLM が秒をでっち上げる余地は無い。存在しない語 index は**機械的に拒否**(候補 id の安全網と同型)。
- **apply の検査を安全網にする(D1 の実体)。** 分割を書く前に**試作 cutplan で `validate`+`assert` を必ず走らせ**、
  1つでも error なら**書かずにロールバック**(apply の「全部 valid→全書込 / 1つでもエラー→ゼロ書込」契約と同じ)。
  番号選択方式が担っていた「候補格子=安全網」を、`apply`+validate/assert という別の安全網に**置き換える**
  (母艦 §3.5「番号選択方式自体がハーネス設計上の安全策で、apply+検査に替えれば解像度を犠牲にせず塞げる」)。
- **確信の高い区間だけに限定する(D1「apply 全面移行は不採用」)。** 分割は **入れ子の opt-in 副ゲート
  `plan.harness.applySplit`(既定 false・agentic on でも既定 off)** + **1ターン `maxSplits` 上限** +
  **各 sub-segment が `minCandidateSec` 以上** + **validate/assert 通過**の4重ゲートを全て満たすときだけ通る。
- **分割ロジックを1つの純関数へ閉じ込める。** 新規 `src/lib/candidateSplit.ts` に
  `splitSegmentAtWords(seg, words, cutWordRanges, cfg)` を置く。SD2 の `candidates.ts`(語→境界スナップ)の
  規約を再利用し、新しい時刻計算は書かない。

**本書でやらないこと(混同禁止 — 誤って踏むと再現性やハルシネーション耐性を壊す):**
- **`set_cuts`(候補 id 単位)は残す・置き換えない。** 分割は候補レベル選択の**上に載る精密化**であって、
  番号選択の代替ではない(D1=ハイブリッド)。最終 cutplan = `buildCutplan(候補 cuts)` **の後に**
  確定済み分割を適用する(§2.4)。
- **自由時刻・任意区間書き込みは足さない。** `apply <dir>` の汎用 @id オペレーションや MCP の `apply` tool は
  **露出しない**。書けるのは「候補内を語境界で割る」1形だけ(語という既存アンカー選択に閉じる)。
- **applySplit を既定 on にしない。** agentic(SD4)自体が opt-in/off 時バイト等価。applySplit は**さらにその内側**の
  opt-in で、agentic を on にしても既定 off(§1-2)。SD3(X4)が既定を変えたのとは**逆**。
- **detect / candidates(C1)の決定論細分化は触らない。** C1 は生成時に `≥minSplitGapSec` で**一律・盲目的に**
  事前分割する(LLM が見る前)。H6 は LLM が**必要な候補だけ・任意の語境界で(sub-minSilenceSec の
  微小ポーズを含む)・判断付きで**割る。**両者は補完**(C1=良い既定格子 / H6=残った候補内の精密化)。§2.1。
- **cutplan 以外の編集ファイル・`approvals.json` を書かない。** 分割は keep 集合を変えるので承認 hash は
  **自動失効**する(§1-6。設計どおり=古い承認で render されない)。`approvals.json` には**一切触れない**(第3カテゴリ)。
- **schema/CLI/ファイル分類を増やさない。** cutplan.json は PlanSegment がもともと任意 start/end を許すので**不変**。§3 の5点セット判断参照。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **`applySplit` off でバイト等価(逃げ道):** `plan.harness.applySplit` が未設定/false のとき、agentic 経路の
   tool セットに `split_candidate`/`list_words` は**現れず**、`set_cuts` 単位(R0 保存)の SD4 と**完全に一致**する。
   さらに **agentic 自体が off** なら SD4 の §1-1 により導入前とバイト等価。**入れ子の二重 opt-in**
   (agentic → applySplit)で、回帰基準線 `baseline`/`after-w0`/`after-c1`/`after-x4`/`after-h1h2` は**全て再現可能**。
   H6 の効果は独立スナップショット **`after-h6`** で測る(SD1 Part A)。
2. **applySplit on ≠ 既定 on(入れ子 opt-in):** applySplit は agentic を on にした上で**さらに**明示的に on に
   したときだけ効く。既定は false。ここを取り違えて既定 on にしない。
3. **R0 は意図的に崩すが、番号選択は語粒度で保つ(本書の核心):** LLM は**時刻を生成しない**。分割は
   `transcript.words` の**語 index 選択**で表現し、境界時刻は必ず既存語境界へスナップする。存在しない語 index /
   語の無い候補への分割は**拒否**(候補 id の安全網と同型)。**LLM が秒を書く経路は一切増えない**。
4. **apply の検査が唯一の書込みゲート(D1 の安全網):** `split_candidate` は分割後の segments で**試作 cutplan を作り、
   `validate`+`assert` を走らせてから**しか書かない。error があれば**ロールバック**(直前の cutplan.json を復元)し、
   LLM へ拒否理由を返す。**部分書き込みを残さない**(apply の all-or-nothing)。
5. **確信区間のみ・有界(D1「全面移行しない」):** 4重ゲート(applySplit opt-in / `maxSplits` 上限 /
   各 sub-segment ≥ `minCandidateSec` / validate+assert 通過)を**全て**満たす分割だけが通る。1ターンの分割数は
   `maxSplits`(既定 4)で**必ず上限**。tool 呼び出し総数は SD4 の `maxToolCalls` に**引き続き**従う。
6. **承認の自動失効を尊重する:** 候補内部分割は keep 集合(=承認 hash の対象)を変えるので、既存の
   `approvals.json` レコードは hash 不一致で**自動失効**する(母艦の strict ゲート)。これは**正しい挙動**
   (分割後の内容を人間が再確認するまで render は通らない)。SD5 は `approvals.json` を**読みも書きもしない**。
7. **W0(語タイムスタンプ)前提・不在時は安全に劣化:** 分割は `transcript.words` が要る。対象候補に words が
   無ければ `split_candidate` は**割らずに拒否**(候補丸ごとの keep/cut にフォールバック)。words 皆無の収録では
   `list_words`/`split_candidate` は実質無効化され、SD4(候補単位)と同じ結果になる(静かな誤分割を作らない)。
8. **中間生成物の分類を守る:** 分割の trace(対象候補・語 index・validate/assert 結果ダイジェスト)は
   `plan.loop.json` を拡張して残す(**中間生成物・再実行で上書き**)。`cutplan.json` 以外の編集ファイルは書かない。

## 2. 分割の仕組み(R0 突破の実体)

### 2.1 C1(決定論・生成時)と H6(判断・実行時)の関係

| | C1 / SD2(`subdivideCandidates`) | H6 / SD5(`split_candidate`) |
|---|---|---|
| いつ | detect 直後・**LLM が候補を見る前** | agentic ループ中・**LLM の判断で** |
| どこを | 全候補を**一律**(尺 > `splitOnlyLongerThanSec`) | LLM が選んだ**特定候補だけ** |
| 何を基準に | 語間 gap **≥ `minSplitGapSec`**(盲目的しきい値) | **任意の語境界**(sub-minSilenceSec の微小ポーズ・言い直し境界も) |
| 誰が cut を決めるか | 分割後に LLM が候補単位で選ぶ(R0 保存) | LLM が分割**と** cut を同時に指す(**R0 突破**) |
| 安全網 | 候補格子(番号選択) | 語 index 選択 + **apply(validate/assert)** |

→ **C1 は良い既定格子を用意し、H6 はその格子でも1つに残った候補の内部を精密化する。**補完関係(母艦 §3.5)。
40 秒連続発話で `minSplitGapSec` 未満のポーズしか無く C1 が割れなかった候補でも、H6 は「語 i〜j が言い直しの
前半」と判断して**語境界で**割れる(R0 の天井を実測で越える)。

### 2.2 語 index 選択(ハルシネーションを保ったまま R0 を崩す)

新しい read tool **`list_words {id}`** が、候補 #id 内に落ちる語を **1始まり index 付き**で返す:

```
#12 の語(全 18 語):
  1 "じゃあ" [12.30-12.55]   2 "これ" [12.55-12.78]  ...  9 "えーと" [15.10-15.42]
  10 "もう一回" [15.42-15.90]  ...  18 "です" [19.80-20.05]
```

書込み tool **`split_candidate {id, cutWordRanges:[[i,j],...], reason}`** = 「候補 #id の中で、語 i〜j(両端含む)の
sub-span を cut にする」。`cutWordRanges` は複数指定可(候補内に複数の cut 塊)。**LLM は index しか書かない**
= 秒は一切生成しない。境界時刻は tool 側が §2.3 の規約で語境界へスナップする。

- **index が範囲外**(< 1 or > 語数)/ 逆順(i > j)/ **候補に words 無し** → **拒否**(§1-3・書かない)。
- 分割後の sub-segment が `minCandidateSec` 未満になる分割 → **拒否**(細かすぎ=不確信とみなす。§1-5)。

### 2.3 語 index → tile する PlanSegment[](純関数 `splitSegmentAtWords`)

`src/lib/candidateSplit.ts`(新規)の純関数。SD2 `candidates.ts` の語→境界スナップ規約を**再利用**する:

- 候補 `seg=[start,end]` と、その内部の語群 `words`(`collectWords` を `[start,end]` で filter)と、
  `cutWordRanges`(語 index の組)を受け取る。
- 各 cut range `[i,j]` の境界:
  - **前境界** `b_before` = 語 i が候補先頭語なら `seg.start`、そうでなければ `midpoint(words[i-1].end, words[i].start)`
    (SD2 `splitPointsForKeep` と同じ gap 中点規約)。
  - **後境界** `b_after` = 語 j が候補末尾語なら `seg.end`、そうでなければ `midpoint(words[j].end, words[j+1].start)`。
- 全境界(各 range の前後)を昇順に並べ、`[start, ..., end]` を**隙間なく tile** する `PlanSegment[]` を返す。
  cut range に入る sub-span は `action:"cut"`(reason 付き)、それ以外は `action:"keep"`。**候補の span 合計は不変**
  (`[start,end]` を過不足なく覆う=validate の時系列・非重なり不変条件を構造的に満たす。§2.5)。
- **丸めは SD2 と同じ `round2`。** ゼロ長 sub-span は落とす。cut range 同士が隣接/重複するときは併合。
- `words` 皆無 → **null を返す**(呼び出し側は分割せず候補丸ごとを維持)。

```ts
// src/lib/candidateSplit.ts(新規・骨子)
import type { Interval, PlanSegment, WordTiming } from "../types.ts";

export interface CandidateSplitCfg { minCandidateSec: number; }

/** 候補 seg を語 index 範囲 cutWordRanges で分割した PlanSegment[] を返す純関数。
 *  - words は seg 内に落ちる語(呼び出し側で filter 済みでも内部 filter でも可)。
 *  - 返す segments は seg.[start,end] を隙間なく tile し、時系列順・非重なり。
 *  - 分割不能(words 皆無 / index 範囲外 / sub-segment < minCandidateSec)は
 *    Error 情報を返す(呼び出し側=tool が LLM へ拒否理由を返す)。 */
export function splitSegmentAtWords(
  seg: Interval & { id?: string },
  words: WordTiming[],
  cutWordRanges: { i: number; j: number; reason: string }[],
  cfg: CandidateSplitCfg,
): { segments: PlanSegment[] } | { error: string } { /* ... */ }
```

### 2.4 最終 cutplan の組み立て(分割を候補選択の上に載せる)

分割は候補レベル選択の**精密化**なので、最終 cutplan は **2段**で作る(D1=ハイブリッド):

```
base = buildCutplan(numbered, 候補cuts, idCtx)          // 従来どおり(R0 保存の 1:1)
final = applyCandidateSplits(base, 確定済みsplits, words) // 該当候補の segment を sub-segments へ置換
```

- `applyCandidateSplits`(`candidateSplit.ts`)は base の segments を走査し、**分割対象候補の span に一致する
  segment を `splitSegmentAtWords` の結果で置換**、他はそのまま。span 不一致(候補が消えた等)の split は**捨てる**
  (再実行耐性)。id は置換後の sub-segment に**新採番**(span が変わるので `carryIds` は運ばない=既存 ensureIds 挙動)。
- **`set_cuts` と `split_candidate` の相互作用(必ず実装する不変条件):** ループ中 LLM が `set_cuts` を**後から**
  呼んで候補を全 cut にした場合、その候補の split は無意味になる。よって `set_cuts`/`split_candidate` の
  書込みは**常に** `applyCandidateSplits(buildCutplan(...現在のcuts), ctx.splits, words)` で cutplan.json を
  組み直す(=単一の権威ある再構築。last-write-wins の脆さを避ける)。ターン確定時の最終 cutplan も同じ式。

### 2.5 apply の検査 = 唯一の安全網(書込み前に必ず)

`split_candidate` handler の順序(**この順を崩さない**):
1. `list_words` と同じ語解決で `cutWordRanges` を検証(index 範囲・words 有無)。NG → 書かず拒否。
2. `splitSegmentAtWords` で試作 segments を得る。`minCandidateSec` 違反・error → 書かず拒否。
3. **試作 cutplan を組み(§2.4 の式)、一度メモリ上に持つ。現在の cutplan.json は退避しておく。**
4. 試作を cutplan.json へ書く → **`validate(dir)` と `assert(dir)` を走らせる**。
5. どちらかに **error があれば退避した cutplan.json を復元(ロールバック)** し、LLM へ「分割は却下:<検査メッセージ>」を返す。
   error 無しなら分割を `ctx.splits` へ確定追加し、観測(出力尺・keep 数・assert 結果)を返す。

> **これが D1 の実体**: 番号選択の「候補格子」安全網を、`apply`+validate/assert の安全網へ置換。LLM が語境界を
> でっち上げても(index は valid でも意味的に変でも)、**語途中切れ・keep 空・時系列崩れは validate/assert が捕まえて
> ロールバック**する。解像度(R0 突破)を得つつ、壊れた cutplan は 1 バイトも残らない。

## 3. 変更点の全体像(新規1 + 変更3 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/candidateSplit.ts`(新規) | `splitSegmentAtWords`(§2.3)+ `applyCandidateSplits`(§2.4)の純関数2つ |
| B | `src/lib/ai/agenticCut.ts` | read tool `list_words` + write tool `split_candidate` を追加(`applySplit` on のときだけレジストリに載る)。`AgenticCtx` に `applySplit`/`maxSplits`/`splits[]`/`words` を追加。`AgenticResult` に `splits` を追加 |
| C | `src/lib/config.ts` | `plan.harness.applySplit?`(既定 false)+ `maxSplits?`(既定 4)+ `resolvePlanHarnessCfg` 拡張 |
| D | `src/stages/plan.ts` | `runCutsLoop` で `AgenticCtx` に `applySplit`/`maxSplits`/`splits`/`words` を渡す。ターン確定時 `applyCandidateSplits` で splits を反映。`plan.loop.json` の trace に split 記録 |
| E | `config.yaml` + `docs/usage.md` + `AGENTS_CONTRACT.md` | `plan.harness.applySplit`/`maxSplits` 追記・R0 突破と番号選択維持の明記 |
| F | テスト | `test/candidateSplit.test.ts`(純関数)+ `test/agenticCut.test.ts` へ split 往復/拒否/ロールバック追加 |

**5点セット判断**: cutplan.json スキーマは**不変**(PlanSegment はもともと任意 start/end・keep/cut を許す。分割は
segments が増えるだけ)。`plan.loop.json` は中間生成物でトレース欄を足すだけ。よって **`schemas/*.schema.json` は
変更不要**。`AGENTS_CONTRACT.md` は CLI/ファイル分類が増えない(`plan` のまま・書けるのは cutplan.json のまま)ので
`test/agentsMd.test.ts` は落ちない見込み。`config.yaml` の `plan.harness.applySplit`/`maxSplits` キーだけ docs へ反映
(SD4 で `plan.harness` を足したのと同じ扱い。契約テストが config キーを固定していないことを `npm test` で確認)。

### A. `src/lib/candidateSplit.ts`(新規)

- `splitSegmentAtWords(seg, words, cutWordRanges, cfg)`(§2.3): 語 index → tile する PlanSegment[](or error)。
  境界スナップは `candidates.ts` の gap 中点規約(`(prev.end+next.start)/2`)と `round2` を**そのまま流用**
  (import して使う or 同一実装をコメントで参照)。**新しい時刻計算は書かない。**
- `applyCandidateSplits(base, splits, transcript)`(§2.4): base cutplan の segments を、span 一致する分割対象だけ
  `splitSegmentAtWords` の結果へ置換して新 `CutPlan` を返す純関数。span 不一致 split は捨てる。id 採番は既存
  `ensureIds`(span 変化=新 id)。**`base.approved` は必ず false のまま**(承認は別行為)。
- 両関数とも副作用なし(fs を触らない)。fs 書込み・validate/assert は tool 側(B)が行う。

### B. `src/lib/ai/agenticCut.ts`(tool 2つ追加)

- **`AgenticCtx` に追加**: `applySplit: boolean`、`maxSplits: number`、`splits: SplitOp[]`(確定済み・ターンを跨ぐ)、
  `words: WordTiming[]`(`collectWords(transcript)` を plan.ts で1回作って渡す)。`SplitOp` は
  `{ candidateId: number; cutWordRanges: {i,j,reason}[] }`(トレース・再構築用)。
- **`list_words` tool**(read・§2.2): `{id}` → 候補 #id 内の語を index 付き text で返す。words 無し候補は
  「語タイムスタンプがありません(この候補は分割できません)」を返す。id 範囲外は拒否。
- **`split_candidate` tool**(write・§2.5): 上の5手順を実装。`ctx.splits.length >= ctx.maxSplits` なら
  「分割上限に達しました」を返す(§1-5)。書込みは**必ず** `applyCandidateSplits(buildCutplan(現在cuts), ctx.splits, ...)`
  経由(§2.4 相互作用)。ロールバック用に書込み前の cutplan.json 文字列を退避 → validate/assert error 時に復元。
- **`buildToolRegistry` を分岐**: `ctx.applySplit` が true のときだけ `list_words`/`split_candidate` を push。
  false なら SD4 と**完全に同じ tool セット**(§1-1)。
- **`set_cuts` handler も §2.4 の式へ寄せる**: 現在は `buildCutplan` 直書き(agenticCut.ts:271)。これを
  `applyCandidateSplits(buildCutplan(...), ctx.splits, ...)` に変える。**ただし `ctx.splits` が空**(applySplit off)
  なら `applyCandidateSplits` は base をそのまま返す純粋恒等でなければならない(§1-1 バイト等価の要)。
- **`AgenticResult` に `splits: SplitOp[]` を追加**。`agenticCutTurn` は確定済み `ctx.splits` を返す。
  フォールバック経路(adapter 非対応・エラー)では `splits: []`(=SD4 と同じ候補単位)。

### C. `src/lib/config.ts`

- `Config["plan"]["harness"]` に追加:
  ```ts
  harness?: {
    agentic?: boolean;        // 既定 false(SD4)
    maxToolCalls?: number;    // 既定 16(SD4)
    applySplit?: boolean;     // 既定 false。候補内部を語境界分割(H6・R0 突破)。要 agentic:true + words
    maxSplits?: number;       // 既定 4。1ターンの分割上限(確信区間のみ=有界)
    tools?: { frames?: boolean; av?: boolean; materials?: boolean; ocr?: boolean };
  };
  ```
- `resolvePlanHarnessCfg(cfg)` に `applySplit`(既定 false)/`maxSplits`(既定 4)の解決を足す。
- **`planHarnessEnabled` は変更しない**(agentic の可否のみ判定)。applySplit は agentic が true の**内側**で効く
  副フラグなので、`resolvePlanHarnessCfg` の返り値として持ち回り、`buildToolRegistry` が参照する。
- `plan` 直下の `unknownKeys` 許可は SD4 で `"harness"` を足済み。**harness 内部キーの許可**(applySplit/maxSplits)を
  harness の許可キー集合へ足す(SD4 が agentic/maxToolCalls/tools を足したのと同じ場所。**足し忘れると validate が落ちる**)。

### D. `src/stages/plan.ts`(配線)

- `runCutsLoop` 内、`AgenticCtx` を作る箇所(plan.ts:507 付近)へ `applySplit`/`maxSplits`/`splits: []`/
  `words: collectWords(transcript)` を渡す(`transcript` は plan 冒頭で読み済み。`collectWords` は `candidates.ts` から import 済み)。
- `agenticCutTurn` が返す `result.splits` を保持し、ターン確定時の cutplan 書込みを
  `applyCandidateSplits(buildCutplan(numbered, result.cuts, idCtx), result.splits, transcript)` に変える
  (SD4 は `buildCutplan` 直後に書いていた。splits 空なら恒等=バイト等価)。
- `plan.loop.json` の `PlanLoopLogEntry` に `splitOps?: {candidateId:number; wordRanges:string; accepted:boolean; check?:string}[]`
  を足す(**中間生成物**・ダイジェストのみ・生 args 不可。§1-8)。`applySplit` off のときは undefined(キーを書かない=バイト等価)。
- **`applySplit` on だが agentic off / words 皆無**のとき: agentic off なら applySplit は無視(警告)。words 皆無なら
  `list_words`/`split_candidate` は個別に「分割不可」を返し、ループは候補単位で完走(§1-7)。

### E. `config.yaml` + `docs/usage.md` + `AGENTS_CONTRACT.md`

- `config.yaml` の `plan.harness` コメントへ追記(**既定 off を明示**):
  ```yaml
  plan:
    # harness:
    #   agentic: false       # SD4: cut 判断を tool+検証ループのエージェントに(要 ai.provider=anthropic)
    #   applySplit: false    # SD5(H6): 確信区間だけ候補内部を語境界で分割(R0 突破)。要 agentic:true + wordTimestamps。
    #                        # 既定 false=候補単位(SD4)とバイト等価。分割は apply+validate/assert が安全網。
    #   maxSplits: 4         # 1ターンの分割上限(確信区間のみ=全面 apply 移行はしない)
  ```
- `docs/usage.md`「plan のエージェント化(plan.harness)」節へ H6 を追記: applySplit は agentic の内側の opt-in・
  要 words・**LLM は語 index を選ぶだけで時刻を書かない**・分割は validate/assert 通過時のみ書かれロールバックされる・
  **候補内部分割で承認 hash は自動失効する**・`plan.loop.json` に splitOps トレースが載ることを記す。
- `AGENTS_CONTRACT.md`: ファイル分類・CLI コマンドは**増えない**が、`config.yaml` の `plan.harness.applySplit`/`maxSplits`
  を反映(契約テストが落ちないことを `npm test` で確認)。**cutplan.json が「候補格子に縛られない segments を持ちうる」
  ようになった旨**を、cutplan の説明(番号選択の記述)へ一文足す(H6 経路のときだけ・apply+検査が安全網である点)。

## 4. テスト

**`test/candidateSplit.test.ts`(新規・純関数):**
- **tile 不変**: `splitSegmentAtWords` の返す segments が `seg.[start,end]` を隙間なく覆い、時系列順・非重なり
  (validate の不変条件を構造的に満たす)。
- **語境界スナップ**: cut range の境界が `transcript.words` の gap 中点/端に一致し、任意の中間秒が出ない。
- **拒否系**: index 範囲外 / i>j / words 皆無 → error(書込みに進まない)。sub-segment < `minCandidateSec` → error。
- **`applyCandidateSplits` 恒等**: `splits: []` で base をそのまま返す(**§1-1 バイト等価の要**)。
- **span 不一致 split は捨てる**: 対象候補が base に無い split を渡しても base が壊れない(再実行耐性)。

**`test/agenticCut.test.ts`(追加。fake アダプタで駆動・LLM は叩かない):**
- **applySplit off でツールセット不変(最重要)**: `applySplit:false` で tool レジストリに `list_words`/`split_candidate`
  が**現れず**、SD4 と一致(`ctx.splits` 常に空・`set_cuts` の cutplan が候補単位)。
- **split 往復**: fake が `list_words`→`split_candidate`(valid range)→最終 cuts を返す台本で、cutplan.json に
  **候補内部の cut sub-segment が現れ**、`result.splits` に確定 op が入る(R0 突破の実証)。
- **語 index 安全網**: 存在しない語 index の `split_candidate` → 書かれず拒否メッセージ(番号選択が語粒度でも効く)。
- **apply ロールバック**: `assert` が fail する分割(モックで keepAt 違反等)を台本で渡す → cutplan.json が
  **分割前の内容へ復元**され、LLM へ却下理由が返る(§2.5・部分書き込みが残らない)。
- **有界**: `maxSplits:1` で2回目の `split_candidate` が「上限」で拒否される。
- **words 皆無フォールバック**: transcript に words が無い設定 → `split_candidate` が全て「分割不可」を返し、
  候補単位の cutplan が完走(§1-7)。
- **トレース**: `plan.loop.json` に `splitOps`(候補 id・語 range・accepted・生 args 無し)が載る。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```

- 実測(**要 `ai.provider=anthropic` + `whisper.wordTimestamps:true` の words 付き収録1本**・中立 cwd から
  絶対パス=`memory/llm-command-verify-neutral-cwd.md`):
  1. `plan.harness.applySplit` 無し(agentic のみ on)で `plan --cuts-only` → **SD4 と同一**(applySplit off 経路=§1-1)。
  2. `applySplit: true` で `plan --cuts-only --force`(手編集無い前提)→ `plan.loop.json` に `splitOps` が載り、
     `cutplan.json` に**候補格子に無い語境界の cut sub-segment**が現れること(R0 突破の実証)、
     境界が全て `transcript.words` の語境界へスナップしていること(自由時刻が無い)を確認。
  3. わざと不正な分割を誘発する収録(短い候補ばかり等)で、**却下がロールバックされ cutplan が壊れない**ことを確認(§2.5)。
  4. 分割後に `validate` が「approved:true だが承認レコード無し/陳腐化」を出さないこと(=承認は自動失効し、
     人間の再承認待ちになる正しい状態。§1-6)。
  5. `after-h6` スナップショット(SD1 Part A)を取り、`after-h1h2` と diff。**H6 の効果(候補内部分割による
     テンポ改善)を他施策と分けて評価**(格子・積極度・ハーネスは固定、applySplit だけ切り替えた差分)。
- **完了報告は実測ログ付き**(母艦の運用: 完了報告は必ず実測検証)。

## 6. 受け入れ基準

- `plan.harness.applySplit` off(agentic on/off 双方)で、tool セット・cutplan が **SD4 / 導入前とバイト等価**。
- applySplit on(anthropic + words)で、LLM が `list_words`→`split_candidate` を往復し、**候補格子に無い語境界で
  候補内部が分割**され(R0 突破)、`plan.loop.json` に `splitOps` が残る。
- **LLM は時刻を生成しない**。分割は語 index 選択で表現され、境界は `transcript.words` へスナップ。**存在しない
  語 index は拒否**され cutplan に自由時刻が混ざらない(番号選択が語粒度で保たれる)。
- 分割は **validate+assert 通過時のみ書かれ、失敗はロールバック**(部分書き込みが残らない=apply の安全網)。
- `maxSplits` で有界。words 皆無・agentic 非対応・回復不能エラーで**例外を投げず**候補単位へフォールバック。
- 候補内部分割で **承認 hash が自動失効**し、`approvals.json` には**一切触れない**。
- `plan.harness.applySplit` は**既定 off**(SD4 の agentic の内側の入れ子 opt-in)。
- `npx tsc --noEmit` と `npm test`(off 時バイト等価・tile 不変・ロールバックテスト含む)が通る。

## 7. 引き継ぎと母艦への含意(本書の外)

- SD5 で cut 判断は **R0 を越えた**。行動空間が「候補丸ごと keep/cut」から「候補内を語境界で割る」へ広がり、
  番号選択(=語アンカー選択)+ apply 検査で安全に閉じた。**母艦 §7 の cut 系実装設計書(SD1〜SD5)はこれで一巡**
  (W0→C1→X4→H1/H2→H6)。cut の骨格は設計上そろった。
- **残る cut 系施策は「格子内でより良く選ぶ / 検証を厚くする」**(C2 重複テイク・C6 自己検証既定化・C10 継続性・
  C13 perception 偏り補正等)で、いずれも R0 を動かさない軸 B の上積み。基準線(`after-h6`)が安定してから優先度を再評価。
- **次に設計書を起こす対象は D5 で parked の 素材(M)/ BGM(B)/ 演出(E)**(母艦 §7 の parked 行)。cut 精度が
  `after-h6` で基準線として安定したことを確認してから、M1/E1/B1 の候補生成(いずれも番号選択方式=同じ思想)を起こす。
- 証拠接地(H3・母艦 X2/X3)は SD4 の `trace` + SD5 の `splitOps`(どの語を根拠に割ったか)を各 cut/split の
  `reason` へ紐づければ自然に揃う。cut 骨格の完成後に小さく足せる。
