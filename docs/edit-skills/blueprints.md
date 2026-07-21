# edit-skills — blueprints(アーク)

> 母艦: [`../programs/edit-knowledge-assets-program.md`](../programs/edit-knowledge-assets-program.md)。
> 実装設計の正本: [`../plans/2026-07-20-cut-knowledge-p3-p5-design.md`](../plans/2026-07-20-cut-knowledge-p3-p5-design.md) §3。
> 注入経路は `src/lib/cutPatterns.ts` の `CUT_PATTERN_INJECTION.<pattern>.blueprint`
> がこのファイルの `##` 見出しを1つ参照する(空文字="blueprint 注入なし")。
> この対応は機械検査(`test/editSkills.test.ts` T-m)で全単射に固定される。

## これは何か

`docs/edit-skills/recipes/*.md`(13分類)が「この候補は何か」を見分ける型
なのに対し、blueprint は「いま判断している候補が**動画のどの位置**にあるか」
という**文脈**を与える。1つの [収録タイプ(pattern)](patterns.md) には
**最大1本**の blueprint が紐づき、宣言された pattern の注入ブロック末尾に
連結される(`general` は blueprint 無し=注入ゼロ)。

**blueprint はスケルトンのみ。** 判断の根拠・具体例(worked example・反例)は
recipes と examples の仕事で、blueprint はそれらを混ぜない。書いてよいのは
区間の相対位置・優勢な分類・章の目安の3点だけ(下記)。

## 書いてよいこと・書いてはいけないこと

- **尺の秒数・目標尺は書かない。** 目標尺はすでに `{{editMode}}`
  (`targetOutDurationSec`)の責務であり、blueprint がここへ数値を足すと
  二重に圧力がかかって `editMode` の較正が壊れる(母艦 §4.3)
- **章数は「目安」と明示する。** `plan` の chapters 生成に対する硬い制約に
  しない(章分割は本文の内容から決まるべきで、blueprint が先に固定しない)
- **区間の位置は相対表現(「冒頭 ~10%」「末尾 ~5%」)で書く。** 収録尺は
  収録ごとに違うため、絶対秒を書くと別収録で意味を失う
- 1本の blueprint は**8行以内**(表形式なら見出し込みで8行)。長いアークは
  LLM を最も長い記述へ引きずる(母艦 §4.3 却下案)

## `tool-demo-arc`

[収録タイプ `tool-demo`](patterns.md#tool-demo) に紐づく。一次資料は
`rules.md` が記録する実在の型「悩み/課題のフック → 概要 → 使い方 → GUI →
設計 → おわりに」(`~/Movies/cutflow/2026-07-12` で実測)。

| 区間 | 尺の目安 | 優勢な分類 | 章 |
|---|---|---|---|
| フック | 冒頭 ~10% | `hook`(切らない) | 章にしない |
| 概要 | ~15% | `restatement` / `stumble` の削り代が最大 | 1章 |
| 実演 | ~50% | `demo-wait`(残す)が支配的。`dead-air` と取り違えない | 2〜3章 |
| 設計・裏側 | ~20% | `tangent` / `gap-trim` | 1章 |
| おわりに | 末尾 ~5% | `greeting`(切らない) | 章にしない |

区間の境目は厳密な秒数ではなく、話題の切り替わり(概要→実演の移行など)で
自然に決まる。`実演` が最大の区間を占め、この中では `demo-wait` を
`dead-air` と取り違えないこと(画面が変化しているかで弁別する)が最も重要。
