# edit-skills — 編集判断の知識資産(傘)

> 母艦: [`../programs/edit-knowledge-assets-program.md`](../programs/edit-knowledge-assets-program.md)。
> このディレクトリは「AI が編集判断を良くするための知識資産」を**判断トラック
> ごと**に束ねる傘。HyperFrames skills 棚卸し
> ([`../hyperframes-skills/README.md`](../hyperframes-skills/README.md))の成功構造
> (K1〜K7)をカット判断へ移植したのが出発点で、以後トラックを足していく。

## これは何か

CutFlow の編集判断(何を残すか・どこを見せるか・何を隠すか …)ごとに、LLM が
**見分ける型**(状況分類=recipes)と、その当て方の**具象**(判断記録=examples)を
置く。判断の正しさを検査する機械ゲートは無い(編集の良し悪しは主観)ので、各分類は
「この候補は何を根拠にどちらへ倒すか」という判定シグナルを中心に書く。

id 集合・注入・doc の全単射検査はすべて `src/lib/` の単一の出所
(`reasonIds.ts` / `cutPatterns.ts` / `effectReasonIds.ts` / `effectPatterns.ts`)から
派生する。md 側はその**説明**であって、注入の実体そのものではない。

## 4層モデルと「棲み分け」

知識資産を「何ごとの性質か」で分けると、2層は**判断トラックごと**、2層は
**収録ごと(=トラック横断で共有)**になる。これがこのディレクトリのレイアウトを決める:

| 層 | 何ごとの性質か | 置き場 |
|---|---|---|
| **recipes**(状況分類) | **判断トラック**の見分け方 | 各トラック直下(`cut/recipes/` · `effects/recipes/` …) |
| **examples**(判断記録) | **判断トラック**の当て方 | 各トラック直下(`cut/examples/` · `effects/examples/` …) |
| **patterns**(収録タイプ) | **収録**の性質(何を撮ったか) | **傘直下で共有**([`patterns.md`](patterns.md)) |
| **blueprints**(アーク) | **収録**の尺の割り方 | **傘直下で共有**([`blueprints.md`](blueprints.md)) |

`patterns` / `blueprints` は収録の事実(`tool-demo` という収録タイプ・
`tool-demo-arc` というアーク)なので、cut でも effects でも**同じ収録の同じ事実**を
指す。だからトラックごとに複製せず傘直下に1つ置き、注入内容(どの recipe をどう
重み付けるか)だけをトラックごとに分ける(`CUT_PATTERN_INJECTION` /
`EFFECT_PATTERN_INJECTION`)。

## 判断トラック

| トラック | 状態 | 中身 | 設計 |
|---|---|---|---|
| [`cut/`](cut/README.md) | **実装済み**(P1〜P6) | カット判断(keep/cut)の13分類 + reasonId 注入 + 測定配線 | [P1P2](../plans/2026-07-20-cut-knowledge-p1-p2-design.md) 他 |
| [`effects/`](effects/README.md) | **EP1〜EP4 完了** | 演出判断の7分類 + effectReasonId schema/選択注入 + 実例/初版測定 | [設計](../plans/2026-07-21-effect-knowledge-p1-design.md) |
| `materials/` | 未着手(effects の後) | 素材(B-roll)配置の分類学 | — |
| `bgm/` | 未着手(effects の後) | BGM 配置の分類学 | — |

**トラックの独立性**: 各トラックの `recipes/` は id が別 namespace で、id 集合の
単一の出所も別ファイル(`CUT_REASON_IDS` / `EFFECT_REASON_IDS`)。混線しない。
共有層(`patterns.md` / `blueprints.md`)だけが両トラックから参照される。

## 共有層(patterns / blueprints)

- [`patterns.md`](patterns.md) — 収録タイプ(`general` / `tool-demo`)。id 集合の
  単一の出所は `src/lib/cutPatterns.ts` の `CUT_PATTERN_IDS`。選ぶ主体は LLM では
  なく人間(`config.yaml` の `plan.reasonIds.pattern`)。
- [`blueprints.md`](blueprints.md) — アーク(`tool-demo-arc`)。収録の尺の割り方の
  スケルトン。同じアークを cut は「優勢な分類」列で、effects は
  「優勢な演出」列で読む。

## チャンネル固有資産との線引き(全トラック共通)

- **このディレクトリ(分類学)**: 「状況の名前」を与える、リポジトリ同梱・channel
  非依存の一般知識(どのチャンネルでも真であることを目指す)。
- **`rules.md`**(channel 直下 / 収録直下): 「その状況でこのチャンネルはどうするか」
  という**強度**を上書きする、人間が育てる channel 固有資産。

**`rules.md` の内容を分類学へ吸い上げない。** 逆に、分類学が `rules.md` の記述を
接地(根拠)として引用するのは問題ない(cut の `demo-wait` / `greeting`、effects の
`tiny-target` / `concept-talk` 等)。
