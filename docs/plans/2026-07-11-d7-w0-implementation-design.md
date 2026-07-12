# 実装設計書: D7(回帰基準線)→ W0(語タイムスタンプ既定資産化)

> 親ドキュメント: `docs/programs/edit-precision-program.md`(母艦)。
> 本書はその **D7 → W0** を、実装担当(弱いモデル想定)がそのまま着手できる
> 粒度まで落とした設計書。**この2ステップだけが対象**。C1・H1/H2 は含めない。
>
> **前提となる確定方針(母艦 §6・2026-07-11 ユーザー判断):**
> - アーキ = ハイブリッド(番号選択を安全網に保つ。apply 全面移行はしない)
> - 既定積極度 = balanced(本書では扱わない=X4 は別ステップ)
> - スコープ = cut に集中
> - 順序 = **D7 → W0 → C1 →(その後 H1/H2)**

## 0. スコープと非スコープ(最初に読む)

**本書でやること:**
- **D7**: cut 精度施策の効果を測る「回帰基準線」の仕組みを作る。
- **W0**: `whisper.wordTimestamps` を既定 true にし、語タイムスタンプ(`transcript.words`)を
  既定資産にする。words 不在を**静かに劣化させず検出して知らせる**。

**本書でやらないこと(混同禁止):**
- **C1**(候補生成を words で意味化)= 次ステップ。W0 は「words を持つ状態にする」だけで、
  `detect`/`plan` はまだ words を消費しない。
- **H1(知覚を pull 型に=判断LLMに tool を握らせる)/ H2(検証を主経路化)= 後フェーズ。**
  本書には**含まれない**。W0 は transcribe 段の変更で、LLM のハーネス(単発 completion の
  まま)には一切触れない。※ユーザー確認事項「pull 型知覚は含まれるか」への回答は **No**。

**不変条件(必ず守る):**
- W0 で変わるのは transcribe の出力に `words[]` が既定で付くこと**だけ**。segment の
  `start/end/text` の算出は**一切変えない**(`transcribe.ts:107-124` の既存ロジックは不変。
  `-ojf` は `-oj` の上位互換で segment 同一=コメント `transcribe.ts:9-10` に実測記録あり)。
- opt-in/sticky・バイト等価の哲学(母艦 D3)は堅持。ただし D2(既定 true 化)は
  **意図的な既定変更**なので、「既定を変えた」ことをテスト・docs・スキーマに明記して行う
  (黙って変えない)。

---

## Part A — D7: 回帰基準線

### A.1 目的

W0/C1/balanced 化などの施策が「本当に効いたか」を主観でなく比較で判断するための
基準線。**施策を1つ入れるたびに、同じ収録で before/after を機械 diff + 人手採点**する。

### A.2 成果物

1. **回帰サンプル台帳** `docs/plans/regression/README.md`
   - 代表収録を **3〜5本**固定する(選定は人間=ユーザーが行う。実装担当は雛形だけ作る)。
   - 各収録に一意な短い ID(例 `sample-a`)と、収録フォルダ絶対パス、特徴
     (長さ・話速・画面主体か喋り主体か・既知の弱点)をメモする。
   - **注意**: 収録フォルダ自体はリポジトリに入れない(サイズ・秘匿)。台帳はパスと
     メタだけを持つ。
2. **スナップショット取得スクリプト** `scripts/regression-snapshot.ts`
   - 引数: 収録フォルダ・ラベル(例 `baseline` / `after-w0`)。
   - 動作: `describe <dir> --json` を**中立 cwd から**実行し(理由は
     `memory/llm-command-verify-neutral-cwd.md` と同じ趣旨=repo 直下の文脈汚染回避。
     ただし describe は LLM 非依存なので主目的は「安定した純 JSON を得る」)、
     結果を `docs/plans/regression/snapshots/<sampleId>.<label>.json` に保存する。
   - 実装は既存の `describeJson`(`src/stages/describe.ts` の export)を呼ぶ薄いラッパで良い。
     CLI を spawn せず関数直呼びで可(その方が安定)。
3. **比較スクリプト** `scripts/regression-diff.ts`
   - 引数: 同一 sampleId の2ラベル(例 `baseline` と `after-w0`)。
   - 出力: keep 数・cut 数・出力尺・カット境界の増減・cut された発話の増減を要約表示。
     まずは「何が増減したか」の粗い diff で良い(完全一致比較ではなく編集差の可視化)。
4. **採点・分類テンプレ** `docs/plans/regression/scorecard.md`(雛形)
   - サンプルごとに施策前後で **1〜5 の人手評価**を記録する表。
   - 人間が直した箇所を母艦 §5 の分類語(`boundary / duplicate / visual-miss /
     context-break / effect-mismatch / material-mismatch / bgm-mismatch / review-unclear`)で
     タグ付けする欄(= X1 の母集団)。

### A.3 実装担当がやること / ユーザーがやること

- **実装担当(弱いモデル)**: A.2 の 2〜4 のスクリプトと雛形ファイルを作る。
  `describeJson` の引数・戻り値は `src/stages/describe.ts` を読んで合わせる。
- **ユーザー**: A.2 の 1 で実際の代表収録を選び、パスを台帳に書く。
  各サンプルで `baseline` スナップショットを1回取る(= W0 着手前の記録)。

### A.4 受け入れ基準

- `node scripts/regression-snapshot.ts <dir> baseline` が
  `docs/plans/regression/snapshots/<id>.baseline.json` を書く。
- `node scripts/regression-diff.ts <id> baseline after-w0` が keep/cut/尺の差を表示する。
- `npx tsc --noEmit` が通る。

---

## Part B — W0: 語タイムスタンプの既定資産化

### B.1 変更点の全体像(4ファイル + テスト)

| # | ファイル | 変更 |
|---|---|---|
| B1 | `config.yaml` | `whisper.wordTimestamps: false` → `true`(コメントも更新) |
| B2 | `src/lib/config.ts:924` | `cfg.whisper.wordTimestamps ??= false;` → `??= true;` |
| B3 | `src/stages/transcribe.ts` | **変更不要**(既に true で `-ojf`+words を出す)。確認のみ |
| B4 | `src/lib/perception.ts` or 新規 `src/lib/words.ts` | 純関数 `transcriptHasWords(transcript)` を追加 |
| B5 | `src/stages/validate.ts` | words 不在時の**警告**(exit 0)を追加 |
| B6 | `docs/usage.md` | whisper 設定表の既定値を true に更新・再transcribe 注記 |
| B7 | テスト | `test/config.test.ts:316` の更新 + `transcriptHasWords` の単体テスト追加 |

### B2. config 既定の反転(B1/B2)

- `config.yaml`:
  ```yaml
  wordTimestamps: true # 語単位タイムスタンプ(-ojf)。karaoke/語境界カットの前提資産。
                       # 既存収録は words を持たないため再 transcribe が要る(validate が警告)
  ```
- `src/lib/config.ts:924`: `cfg.whisper.wordTimestamps ??= true;`
- **注意(必読)**: これは**意図的な既定変更**。`??=` なので、config.yaml で明示的に
  `false` を書けば従来どおり無効化できる(逃げ道は残す)。

### B3. transcribe は変更不要(確認のみ)

`transcribe.ts:98` は `cfg.whisper.wordTimestamps ? "-ojf" : "-oj"`、`:118-124` で
words を組み立てる。既定 true になれば自動で words が付く。**このファイルは触らない。**
唯一の確認事項: 既定 true 化で `-ojf` が常用になるが、segment の `start/end/text` は
`transcription[].offsets/text` から算出しており(`:107-113`)`-ojf`/`-oj` で同一。よって
**既存の transcript の可視フィールドはバイト等価**(words[] が増えるだけ)。

### B4. 不在検出の純関数(B4)

`src/lib/words.ts` を新規作成(または `perception.ts` に追加):

```ts
import type { Transcript } from "../types.ts";

/** transcript が語タイムスタンプ(words[])を1つでも持つか。
 * 章テロップ等の合成 segment は words を持たないので、
 * 「発話 segment のどれかが words を持つ」を基準にする(緩め=false positive を避ける)。 */
export function transcriptHasWords(transcript: Transcript): boolean {
  return transcript.segments.some(
    (s) => Array.isArray(s.words) && s.words.length > 0,
  );
}
```

### B5. validate の警告(B5)

`src/stages/validate.ts` に、**構造検査を通した上での警告**(exit 0)を追加する。
既存の warn 経路を使う(`validate.ts:341` 付近の karaoke 警告と同じ書き方に合わせる)。

- 条件: transcript.json は存在し segment がある が `transcriptHasWords()` が false。
- 文言例:
  `「transcript.json に語タイムスタンプ(words)がありません。config の
  whisper.wordTimestamps は既定 true ですが、この収録は words 無しで transcribe
  されています。語境界カット(C1)・カラオケを使うには transcribe し直してください」`
- **error ではなく warn**。既存収録を壊さない・再transcribe は重い操作なので強制しない。
- karaoke 用の既存警告(`validate.ts:336-341`)とは**別物**。あちらは
  「karaoke 指定なのに words 無し」、こちらは「words そのものが無い」。文言で区別する。
  既存警告は残す(削除・改変しない)。

### B6. docs 更新(B6)

- `docs/usage.md` の whisper 設定表: `wordTimestamps` の既定を **true** に更新。
  「既存収録は再 transcribe が要る」注記を1行足す。
- **5点セット判断**(CLAUDE.md「スキーマを変えたら5点セット」): 本変更は
  **スキーマ(types.ts の形)を変えない**(words[] は既に任意フィールドとして存在)。
  よって `schemas/*.schema.json` / `AGENTS_CONTRACT.md` の**変更は不要**。変えるのは
  「既定値」と「検査の警告」だけ。types.ts のコメントも words の定義自体は不変なので触らない。
  → 触るドキュメントは `docs/usage.md` の設定既定表のみ。

### B7. テスト

- **必ず更新**: `test/config.test.ts:316`「未指定時は false(既存挙動と完全一致)」
  → 期待値を **true** に変え、テスト名・コメントも「未指定時は true(語タイムスタンプ
  既定資産化=W0)」に更新する。`:336` の「true を指定すればそのまま通る」はそのまま有効。
  明示 false を書けば false になる**逃げ道テスト**を1件足す
  (`wordTimestamps: false` を書いた config が false になること)。
- **追加**: `transcriptHasWords` の単体テスト(words あり→true / 無し→false /
  空配列→false / 章テロップだけ→false)。`test/` に新規または既存の近い test ファイルへ。
- **回帰確認**: `test/describeJson.test.ts` `test/renderProps.test.ts` `test/validate.test.ts`
  は words を参照するが**明示 fixture** を使うため既定反転の影響は受けないはず。
  念のため `npm test` 全体を通す。

### B8. 検証手順(実装担当は完了報告前に必ず実行)

```sh
npx tsc --noEmit          # 型
npm test                  # 全テスト(config.test の更新込みで緑)
```

- 可能なら実収録1本で実測: `wordTimestamps` 既定のまま transcribe し直し、
  出力 `transcript.json` に `words[]` が付くこと、`validate <dir>` が words 警告を
  **出さない**ことを確認。words 無しの古い transcript に対しては `validate` が
  **警告を1つ出す(exit は 0)**ことを確認。
- **完了報告は必ず実測ログ付きで**(memory の相対方針: 「完了報告は必ず実測検証」)。

### B9. 受け入れ基準

- `config.yaml` 未指定 or 既定で `wordTimestamps === true`、明示 false で false。
- 既定 transcribe で `transcript.json` に `words[]` が付く。
- words 無しの transcript に `validate` が warn(exit 0)、words 有りには出さない。
- `npx tsc --noEmit` と `npm test` が通る。
- transcript の `start/end/text` は W0 前後で不変(words[] の増分のみ)。

---

## 次フェーズへの引き継ぎ(本書の外)

W0 完了時点で「words を持つ収録」が既定になる。ここで初めて **C1**(`detect`/`plan` が
words を消費して候補格子を文/節/言い直し境界で細かくする=R0 の天井上げ)に進める。
C1 の効果は Part A の回帰基準線(`after-c1` スナップショット)で `baseline` と比較する。

**そして C1 の後に H1/H2(知覚を pull 型に=判断LLMに tool を握らせる / 検証を主経路化)を
必ず行う**(ユーザー明示。母艦 §3.5・H1〜H6)。本書は H には触れていないので、
C1 完了後に H フェーズの設計書を別途起こすこと。
