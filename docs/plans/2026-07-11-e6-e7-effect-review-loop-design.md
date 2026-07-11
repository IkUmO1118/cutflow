# 実装設計書 SD-E3: E6(レビューイベント化)+ E7(検品観点を提案ループへ戻す)— 演出の検品を閉じる

> 親ドキュメント: `docs/plans/2026-07-11-edit-precision-program.md`(母艦)§4「演出トラック」/ §7。
> 前段: **SD-E2**(`2026-07-11-e3-e4-e5-effect-visual-verification-design.md`)= 演出を**検品する**
> (`effect-check.json` に警告・still を出す)。本書はその続きで、検品結果を**人間 UI と提案ループへ
> 閉じる**。実装担当(弱いモデル想定)がそのまま着手できる粒度に落とす。**E6 + E7 が対象**。
>
> **前提となる現状(母艦 §3.4.1-5「検品情報が判断へ戻りきっていない」):** `reviewEvents` には
> zoom/blur/annotation の検品観点があるが**主に人間表示用**で、提案前の候補生成や plan の再調整に
> 必ず戻るわけではない。VLM secondary も「観測」止まりでパッチの正規ソースでない。本書はこの
> 「戻りきっていない」を塞ぐ。

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **E6(レビューイベント化)**: SD-E2 が出した `effect-check.json` の演出警告と still を、既存の
  `ReviewEvent`(`src/lib/reviewEvents.ts`)へ**演出イベントとして流し込む**。`ReviewEventKind` は既に
  `zoom`/`blur`/`annotation` を持つ(reviewEvents.ts:4-16)。本書は effect-check の警告を、該当イベントの
  `warnings[]` / `checkPoints[]` / `reviewFrameReasons[]` に載せ、「何秒に何を寄る/隠す/指す」+ 撮った
  still/clip とセットで検品できるようにする(母艦 E6)。
- **E7(検品観点を提案ループへ戻す)**: `reviewEvents` の `checkPoints` / `warnings` を人間表示だけで
  終わらせず、**次の生成の入力へ戻す**2経路:
  - **warning-fix 経路**: 「blur が zoom でズレる」等の warning に対応する `apply` パッチ下書き
    (SD-E2 の `effect-fix.suggested.json`)を、レビューイベントから直接指せるようにする。
  - **観測戻し経路**: 演出警告を `planLoop`(`src/lib/planLoop.ts`)/ SD-E1 の `plan-effects` 再実行の
    **観測(observation)** として渡し、「前回この演出は密度過剰と判定された」を次の候補生成が読めるようにする。
- 出力は**レビュー用の構造化データ**(既存 `ReviewEvent` 拡張)+ 観測ブロック。編集ファイルは書かない。

**本書でやらないこと(混同禁止):**
- **演出を生成・検品しない**(SD-E1/SD-E2)。本書は**検品結果を運ぶ**配線だけ。
- **自動でパッチを当てない。** warning-fix は下書きを指すだけ(適用は人間の `apply`)。
- **cut/meta のレビューイベント全体を作り直さない。** 既存 `buildReviewEvents` に**演出ソースを足す**だけで、
  cut/caption/insert 等の既存イベントは不変。
- **plan(cut 判断)の主経路を変えない。** 観測戻しは `plan-effects` と `planLoop` の opt-in 経路に限定し、
  既定挙動をバイト等価に保つ(母艦「opt-in/sticky でバイト等価」)。
- **approvals.json を触らない。** 演出は承認スコープ外。

## 1. 中核となる不変条件(必ず守る・レビューの要)

1. **既存 ReviewEvent を壊さない**: `buildReviewEvents`(reviewEvents.ts:41)の hunk グルーピングと
   cut/caption/insert 等の既存イベントは不変。演出警告は**追加入力**として `applyWarnings?` と同じ経路で
   該当イベントへ載せる(新 kind を増やさない=zoom/blur/annotation は既にある)。
2. **戻しは観測であって命令でない**: E7 の観測戻しは「前回こう判定された」の**参考情報**を次の生成へ渡す
   だけ。LLM に「必ず直せ」と強制しない(過補正で新しい事故を生む)。番号選択の枠も変えない。
3. **opt-in / バイト等価**: 観測戻しを有効化するのは config フラグ(既定 off)。off なら `plan-effects` /
   `planLoop` は本機能導入前とバイト等価。`plan.perception` / `plan.harness` と同じ思想。
4. **編集ファイルへ直接書かない**: 本書が書くのはレビュー用データと観測ブロックだけ。warning-fix の適用は
   `apply` 経由(SD-E2 の下書きを指す)。
5. **cut / 承認不変**: cutplan.json / approvals.json を読まない・書かない。
6. **検品情報の欠如は優雅に劣化**: `effect-check.json` が無い(未検品)ときは演出レビューイベントを
   足さないだけで、既存レビューは通常どおり出す(告知はするが例外は投げない)。

## 2. 設計判断(なぜこの形か)

- **なぜ既存 `reviewEvents` に相乗りか**: `ReviewEvent` は既に `zoom`/`blur`/`annotation` kind・
  `warnings`/`checkPoints`/`reviewFrameReasons` フィールドを持つ(reviewEvents.ts)。演出検品の受け皿は
  **既にある**ので、新しいレビュー機構を作らず effect-check の出力をこの器へ**写像**するのが最小実装。
- **なぜ E7 を観測(observation)にするか**: 母艦 §3.4.5「検品情報が判断へ戻りきっていない」の核心は
  「気づきが次の生成に届かない」こと。`planLoop` は既に `warnings` を持つ観測構造(planLoop.ts:23)。
  演出警告を同じ観測へ足せば、SD-E1 の再生成が「前回の失敗」を読める。命令でなく観測にするのは、
  番号選択の安全網と過補正回避のため。
- **なぜ warning-fix を下書き止まりか**: SD-E2 が既に決定論の補正パッチ(`effect-fix.suggested.json`)を
  出している。本書はそれを**レビューイベントから指せるようにする**だけ。自動適用は承認モデルと相性が悪い
  (人間の `apply` を通す)。
- **なぜ opt-in か**: 観測戻しを既定にすると `plan-effects` の出力が過去の検品に依存して非決定的になり、
  測定が濁る。既定 off・sticky でバイト等価を守り、効果は on/off の対比で測る。

## 3. 変更点の全体像(新規1 + 変更4 + テスト)

| # | ファイル | 変更 |
|---|---|---|
| A | `src/lib/effectReview.ts`(新規・純関数) | `effect-check.json` の警告 → `ReviewEvent` へ載せる写像 / 観測ブロック生成 |
| B | `src/lib/reviewEvents.ts`(追記) | `buildReviewEvents` の引数に `effectWarnings?`(effect-check 由来)を追加し、該当 zoom/blur/annotation イベントへ merge |
| C | `src/lib/planLoop.ts`(追記) | 観測 `warnings` に演出観測を差し込む口(opt-in) |
| D | `src/stages/planEffects.ts`(SD-E1)+ `src/cli.ts` | `plan-effects --observe`(前回 effect-check を観測として読み込む・既定 off) |
| E | `src/lib/config.ts` + `config.yaml` | `effectReview.observe`(観測戻しの opt-in フラグ) |
| F | `docs/usage.md` + `AGENTS_CONTRACT.md` | E6/E7 の説明追記 |
| G | テスト | `test/effectReview.test.ts`(写像の純関数)+ reviewEvents の merge テスト |

**5点セット判断**: `overlays.json` 等のスキーマ不変。`ReviewEvent` は内部型で `schemas/*` 対象外だが、
`test/reviewEvents*.test.ts`(あれば)を追随。CLI の**新コマンドは増えない**(既存 `plan-effects` に
`--observe` フラグを足すだけ)ので、`AGENTS_CONTRACT.md` のコマンド一覧変更は**不要**(フラグは
コマンド名ではない)。ただしフラグの挙動を `docs/usage.md` に足す。

### A. `src/lib/effectReview.ts`(新規・純関数)

```ts
import type { ReviewEvent } from "./reviewEvents.ts";
import type { EffectWarning } from "./effectCheck.ts"; // SD-E2

/** effect-check の警告を、種別ごとの ReviewEvent 追記材料へ変換する純関数。
 *  戻り値は「どのイベント(kind+時間帯)へ何を足すか」の指示。 */
export interface EffectReviewPatch {
  kind: "zoom" | "blur" | "annotation";
  startSec: number;
  endSec: number;
  warnings: string[];          // event.warnings へ push
  checkPoints: string[];       // event.checkPoints へ push(「秘匿箇所を覆えているか」等)
  reviewFrameReasons: string[];// event.reviewFrameReasons へ push(撮る/見るべき理由)
  fixRef?: string;             // effect-fix.suggested.json 内の対応 op を指すキー(warning-fix 経路)
}

export function effectWarningsToReviewPatches(warnings: EffectWarning[]): EffectReviewPatch[] {
  // 実装ヒント: warning.kind を zoom/blur/annotation の器へ振り分け、message を warnings へ、
  // 種別ごとの定型 checkPoint(zoom=見せたい所が中心か / blur=覆えているか / annotation=指す先が合うか)を
  // checkPoints へ、suggestion があれば fixRef を立てる。
  return []; // ← 実装する
}

/** E7 観測: 演出警告を planLoop / plan-effects が読む観測テキストへ整形する純関数。
 *  「前回 N 件の演出警告(密度2・zoom追従1…)。同じ轍を避けよ」程度の要約。命令ではない。 */
export function effectWarningsToObservation(warnings: EffectWarning[]): string {
  return ""; // ← 実装する
}
```

### B. `src/lib/reviewEvents.ts`(追記)

`buildReviewEvents(args)` の `args` に `effectWarnings?: EffectWarning[]` を足し、
`effectWarningsToReviewPatches` の結果を、時間帯と kind が一致する既存イベントへ merge する
(一致するイベントが無ければ、その演出の独立イベントを1つ作る)。**既存の cut/caption/insert イベントや
`applyWarnings` 経路は不変**。`warningSummary`(reviewEvents.ts:81)は演出 kind を既に集計できるので、
merge した警告が自然に検品サマリへ反映される。

### C. `src/lib/planLoop.ts`(追記)

`planLoop` の観測 `warnings: string[]`(planLoop.ts:23)へ、`effectWarningsToObservation` の1行を
**opt-in で**差し込む口を足す。cut の planLoop に演出観測を混ぜるのが過剰なら、SD-E1 の `plan-effects` 側に
同型の軽い再生成ループを持たせて観測を渡す形でもよい(実装者判断。どちらも「前回警告を次入力へ」の同じ骨)。

### D. `src/stages/planEffects.ts`(SD-E1)+ `src/cli.ts`

- `plan-effects <dir> --observe`: 実行時に `effect-check.json` があれば `effectWarningsToObservation` を
  プロンプトへ1ブロック足す(SD-E1 の `renderEffectsPrompt` に `{{observation}}` を追加。無ければ空文字で
  バイト等価)。**`--observe` を付けない限り SD-E1 とバイト等価**。
- フラグなので `AGENTS_CONTRACT.md` のコマンド一覧は変えない(フラグの説明は usage.md)。

### E. `src/lib/config.ts` + `config.yaml`

```yaml
# 演出検品の提案ループ戻し(E7)。既定 off=バイト等価。on で plan-effects --observe /
# planLoop が前回 effect-check の警告を観測として読む(命令ではなく参考)。
effectReview:
  observe: false
```

### F. `docs/usage.md` + `AGENTS_CONTRACT.md`

- `docs/usage.md`: E6(effect-check の警告が review イベントに載って still とセットで検品できる)/
  E7(`plan-effects --observe` と `effectReview.observe` で前回警告を次生成へ戻す・opt-in・命令でない)を
  演出/レビュー節へ追記。
- `AGENTS_CONTRACT.md`: **新コマンドは無い**ので変更不要(フラグ追加のみ)。念のため `test/agentsMd.test.ts` が
  落ちないことを確認(コマンド一覧・GENERATED_FILES を増やしていないので通るはず)。

## 4. テスト(`test/effectReview.test.ts` 新規 + reviewEvents 追記)

- **effectWarningsToReviewPatches**: 各警告 kind が正しい器(zoom/blur/annotation)へ振り分く /
  suggestion 付き警告に fixRef が立つ / checkPoint に種別定型文が入る。
- **effectWarningsToObservation**: 警告0件→空文字(=バイト等価) / 複数件→件数要約の1ブロック /
  命令調でなく観測調(受け入れは文字列の存在と件数で固定)。
- **reviewEvents merge**: `effectWarnings` を渡すと該当 zoom/blur/annotation イベントの warnings/checkPoints が
  増える / 渡さない(undefined)と既存挙動とバイト等価(cut/caption イベントが1件も変わらない) /
  `warningSummary` の演出 kind 件数が merge を反映。

## 5. 検証手順(完了報告前に必ず)

```sh
npx tsc --noEmit
npm test
```
- 実測(SD-E1/SD-E2 を通した演出付き収録1本):
  1. `effect-check <dir>`(SD-E2)で `effect-check.json` を作る(密度警告等を含む状態にする)。
  2. `review` 相当(reviewEvents を組む経路)で、zoom/blur/annotation イベントに effect-check の警告・
     checkPoint が載り、still 理由が付くことを確認。
  3. `plan-effects <dir> --observe`(config `effectReview.observe: true` or フラグ)→ プロンプトに前回警告の
     観測ブロックが入る(`plan-effects.raw.txt` で確認)。**`--observe` 無し**では入らない(バイト等価)。
  4. `effectReview.observe: false`(既定)で `plan-effects` が導入前とバイト等価(観測ブロックが空)。
- **完了報告は実測ログ付き**。
- **測定の注意**: 写像・merge は決定論なのでテストで固定。観測戻しが「演出品質を上げたか」は非決定的なので、
  on/off の複数回比較 or 人間の `effect-mismatch` タグで scorecard に記録(`memory/precision-measurement-nondeterminism-wall.md`)。

## 6. 受け入れ基準

- effect-check の演出警告が既存 `ReviewEvent` の zoom/blur/annotation イベントへ載り、still/checkPoint と
  セットで検品できる(E6)。
- `effectWarnings` を渡さないとき reviewEvents が既存挙動とバイト等価(cut/caption 等が不変)。
- `plan-effects --observe` / `effectReview.observe: true` のときだけ前回警告が次生成の観測に入る。
  既定(off)ではバイト等価。
- 観測は参考情報であって命令でない(プロンプト文言・テストで固定)。番号選択の枠を変えない。
- warning-fix はパッチ下書き(SD-E2)を指すだけで自動適用しない。
- cutplan.json / approvals.json を読まない・書かない。
- `npx tsc --noEmit` と `npm test` が通る(`test/agentsMd.test.ts` を含む)。

## 7. 次フェーズへの引き継ぎ(本書の外)

- **cut/material/BGM への横展開**: 観測戻しの骨(検品警告→次生成の観測)は演出専用ではない。cut の C6/C10、
  素材の material-fit、BGM の bgm-fit(SD-B2)の警告も同じ `...ToObservation` で戻せる。E7 で型を固めてから
  横へ広げる。
- **H2(検証を主経路へ)との統合**: 母艦 H2 は「plan-loop + assert + VLM を既定ループ化」。本書の観測戻しは
  その演出版の opt-in 実験。H2 が既定化されるときに、演出観測も同じループへ吸収する。
- **X5(レビューを映像イベント中心に)との合流**: 本書は警告を review イベントへ載せるところまで。
  before/after clip を主表示にする X5 が入ると、演出イベントの検品 UX がさらに上がる。
- **観測の要約品質**: v1 は件数要約。将来は「どのアンカーがなぜ失敗したか」の構造化観測にすると、
  次生成がピンポイントで避けられる(ただし過補正に注意)。
</content>
