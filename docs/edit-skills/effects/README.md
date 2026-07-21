# edit-skills — effect-recipes(状況分類)

> 母艦: [`../../programs/edit-knowledge-assets-program.md`](../../programs/edit-knowledge-assets-program.md)。
> 実装設計の正本: [`../../plans/2026-07-21-effect-knowledge-p1-design.md`](../../plans/2026-07-21-effect-knowledge-p1-design.md)。
> 本書と `recipes/*.md` は EP1(コード変更ゼロ)の成果物。id 集合はここで確定する。

## これは何か

`plan-effects` が演出アンカーごとに `zoom` / `blur` / `annotation` / `none` を
選ぶための**状況分類**。座標・時刻・色は知覚とコードが決め、LLM はアンカー番号・
型・その理由だけを選ぶ。recipe は「なぜその型か」を、入力に接地した判定
シグナルで説明する。配置後の衝突・密度・caption 重なりは `effect-check` の
決定論検査であり、recipe の分類には含めない。

id 集合の単一の出所は `src/lib/effectReasonIds.ts` の `EFFECT_REASON_IDS`。
README・recipes・schema・validate・プロンプト注入はこの集合へ閉じる。

## 7分類

| 系(型) | id | 一行定義 | 接地 |
|---|---|---|---|
| 見せる(`zoom`) | [`tiny-target`](recipes/tiny-target.md) | 小さくて読めない具体物を話者が指示語で指す | 実データ(4件) + rules.md + craft |
| 見せる(`zoom`) | [`focus-shift`](recipes/focus-shift.md) | 説明対象が画面内を移り、隣接ズームで追う | 実データ(連鎖1組) + rules.md + craft |
| 隠す(`blur`) | [`secret-exposure`](recipes/secret-exposure.md) | 秘匿情報が画面に映る | 想定 + craft |
| 指す(`annotation`) | [`attention-scatter`](recipes/attention-scatter.md) | 対象が一点に収まらず、囲み・矢印で注視を導く | 想定 + craft |
| 何もしない(`none`) | [`already-legible`](recipes/already-legible.md) | 画面が既に十分読める | 実データ(反転) + craft |
| 何もしない(`none`) | [`concept-talk`](recipes/concept-talk.md) | 概念・導入のトークで具体物を指していない | 実データ + rules.md + craft |
| 何もしない(`none`) | [`motion-carries`](recipes/motion-carries.md) | 画面の動き自体が注意を導く | 想定 + craft |

## 粒度とG2対比

- 同じ処置・同じシグナルは統合し、LLM が実行できない幾何の差は分類しない。
- `tiny-target` ↔ `already-legible`: OCR 文字がある表層は同じ。今の解像度で
  読めず、発話がその具体物を指しているときだけ前者へ倒す。
- `attention-scatter` ↔ `motion-carries`: motion アンカーの表層は同じ。動きが
  注意を散らすなら前者、動き自体が注視先を明らかにするなら後者へ倒す。
- `secret-exposure` は公開後に回復できないため、迷ったら安全側の `blur` へ倒す。

## recipe の固定構造とフェンス

全 recipe は設計書 §5 の固定見出し順を使う。判定シグナルは `決定的` / `補助`、
craft 由来はさらに `(craft)` を付ける。入力素材と反例は `text`、worked example
の判断だけは `json` とし、`effectReasonId` は上記7 id のいずれかに閉じる。
反例節には判断 JSON を置かない。

接地行は `実データ(…)` / `rules.md` / `想定` / `craft` / `観測: …` の許可語彙だけを
使う。実データの無い recipe は worked example に**接地なし(合成例)**と明記する。

## 共有層と今後の配線

収録タイプは [`../patterns.md`](../patterns.md)、アークは
[`../blueprints.md`](../blueprints.md)を cut と共有する。effectReasonId のスキーマ・
プロンプト注入は EP2 で実装済み。pattern 選択注入は EP3、実収録 example・doc
機械検査・測定配線は EP4 の担当であり、EP1 ではコードを変更しない。

## 索引

見せる: [`tiny-target`](recipes/tiny-target.md) · [`focus-shift`](recipes/focus-shift.md)

隠す: [`secret-exposure`](recipes/secret-exposure.md)

指す: [`attention-scatter`](recipes/attention-scatter.md)

何もしない: [`already-legible`](recipes/already-legible.md) ·
[`concept-talk`](recipes/concept-talk.md) · [`motion-carries`](recipes/motion-carries.md)
