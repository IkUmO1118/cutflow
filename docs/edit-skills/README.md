# edit-skills — cut-recipes(状況分類)

> 母艦: [`../programs/edit-knowledge-assets-program.md`](../programs/edit-knowledge-assets-program.md)。
> 実装設計の正本: [`../plans/2026-07-20-cut-knowledge-p1-p2-design.md`](../plans/2026-07-20-cut-knowledge-p1-p2-design.md)。
> 本書と `recipes/*.md` は **P1(コード変更ゼロ)** の成果物。id 集合はここで確定する。
> 翻案元の書きぶり・索引の作り方は HyperFrames skills 棚卸し
> ([`../hyperframes-skills/README.md`](../hyperframes-skills/README.md) /
> [`../hyperframes-skills/recipes/INDEX.md`](../hyperframes-skills/recipes/INDEX.md))を踏襲する。

## これは何か

カット編集(`plan` / `plan --cuts-only` が候補を keep/cut に振り分ける判断)の
**状況分類**。HyperFrames(HF)の recipe が「積む部品(コード骨子)」であるのに
対し、こちらは**見分ける型**である——判断の正しさを検査する機械ゲートは無い
(カットの良し悪しは主観)ので、各分類は「この候補は何を根拠にどちらへ倒すか」
という**判定シグナル**を中心に書く。

id 集合の単一の出所は(P2 で実装される)`src/lib/reasonIds.ts` の
`CUT_REASON_IDS` になる予定。P1 時点ではこの README と `recipes/*.md` の
ファイル名一覧が id の正である。

## 13分類

`docs/edit-skills/recipes/<id>.md`。id は kebab-case・`^[a-z][a-z0-9-]*$`。

### 系: 切る(7)

| id | 一行定義 | 接地 |
|---|---|---|
| [`restatement`](recipes/restatement.md) | 同内容を後でうまく言い直しているときの、収束前の版(未完成の言いかけを含む) | 実データ(2026-07-12) |
| [`stumble`](recipes/stumble.md) | 内容を1つも運んでいないフィラー単独(えー/あの/まあ/なんか)・言い淀みの反復 | 実データ(言い淀み系に同居) |
| [`duplicate-tail`](recipes/duplicate-tail.md) | 完成版を言い切った直後に残った末尾・遷移句の反復 | 実データ(2026-07-12) |
| [`gap-trim`](recipes/gap-trim.md) | keep された発話と発話のあいだの短い無音を詰める(テンポ調整) | 実データ(2026-07-12) |
| [`dead-air`](recipes/dead-air.md) | 本編内で、発話も画面の新情報もない長めの間(段取り・思考・移動) | 実データ(2026-07-12) + rules.md |
| [`tangent`](recipes/tangent.md) | 本題と無関係な脱線・独り言・視聴者に向いていない発話 | 想定(実データ0件) |
| [`slate`](recipes/slate.md) | 収録の頭/尻の段取り。本編の外(カメラ操作・締め挨拶より後の残り) | 実データ(2026-07-12) |

### 系: 残す(4)

| id | 一行定義 | 接地 |
|---|---|---|
| [`demo-wait`](recipes/demo-wait.md) | 画面が語っている無言(実行結果の待ち・出力を読ませている数秒・結果が出る瞬間) | 実データ(反転keep) + rules.md |
| [`failure-and-fix`](recipes/failure-and-fix.md) | エラー・失敗とその解決(セットで残す。片方だけ残さない) | 想定(実データ0件) |
| [`hook`](recipes/hook.md) | 冒頭のフック(課題提示・つかみ)。テンポ調整の対象にしない | 実データ(2026-07-12) + rules.md |
| [`greeting`](recipes/greeting.md) | 挨拶・お礼・締め。尺の都合で切らない | 実データ(反転keep) + rules.md |

### 系: 境界(2)

| id | 一行定義 | 接地 |
|---|---|---|
| [`tail-clip`](recipes/tail-clip.md) | カット境界が語尾を食う。切らずに余白を残す側へ倒す | rules.md |
| [`reference-orphan`](recipes/reference-orphan.md) | ここを切ると後続の指示語・接続が宙に浮く | 想定 + rules.md(ズーム節) |

## 粒度の基準(この4条を満たさない分類は作らない・残さない)

設計書 §1 で確定した基準。13分類はこの4条でふるいにかけられている。

| # | 基準 | 意図 |
|---|---|---|
| **G1** | **処置が同じ かつ 判定シグナルが同じなら統合する** | 同義分類が並ぶと番号選択が濁る。例: `false-start` は `restatement` に、`setup-silence` は `dead-air` に、`reveal` は `demo-wait` に統合済み |
| **G2** | **処置が正反対なら、シグナルが似ていても必ず分ける** | `dead-air`(切る)と `demo-wait`(残す)は「無言」という同じ表層を持つ。対比ペアとして隣接させる方が選択は鋭くなる |
| **G3** | **LLM が実行できない区別は分類にしない** | LLM は候補 id を選ぶだけで区間を分割できない。「候補の一部だけ切る」は分類ではなく人間側の GUI 操作。recipe の反例節へ回す |
| **G4** | **実データか `rules.md` に接地がある分類を優先する。想定由来のものは接地を明記する** | 承認済み収録が N=1。想定の分類は「後で統廃合する前提」であることを doc 自身に書く |

この基準に落ちた案(`split-keep` / `misspeak` / `reveal` を独立分類として残す 等)は
設計書 §1「却下案」を参照。

## recipe 1本の型(固定節構成)

各 `recipes/<id>.md` は次の見出しをこの順に**全て**持つ(P2 で機械検査される。
見出し文字列は一字一句このとおり):

```
# <id>

> 系: 切る | 残す | 境界 · 既定の処置: cut | keep | boundary
> 接地: 実データ(2026-07-12, N件) | rules.md | 想定

## 一行定義
## 判定シグナル
### 語彙(transcript)
### 時間・格子(候補の形)
### 音(plan.perception.audio)
### 画面(plan.perception.ocr / frames)
## 既定の処置
## 反例(この分類を当てない場合)
## 紛らわしい隣
## worked example
```

HF recipe の「用途 / 構造 / **コード骨子** / 注意点 / 値の目安」に対し、
「コード骨子」を「判定シグナル」に置換し、「紛らわしい隣」を新設したもの
(カット判断に「積む部品」は存在しないため)。

### 判定シグナルの4軸

抽象語(「冗長」「テンポが悪い」)は**禁止**。LLM が入力として**実際に受け取って
いるもの**だけを、次の4軸に分けて書く。各シグナルには **`決定的`**(1本で
分類を決めてよい)または **`補助`**(単独では使わない)のラベルを必ず付ける。
`決定的` シグナルを1つも持たない分類は書かない。

| 軸 | 書いてよいもの | 書き方の規則 |
|---|---|---|
| **語彙** | 候補テキストに現れる実際の文字列、候補間の文字列関係(次候補が本候補を包含する等) | 具体語を列挙する。カテゴリ名だけで済ませない |
| **時間・格子** | 候補の尺、隣接候補との gap 秒、動画全体の中の位置 | 実測の帯を書く。根拠のない数値を書かない |
| **音** | `plan.perception.audio`(既定オフ)が注記する無音長・間の位置 | 注記が無いとき(既定オフ環境)でも判定できる代替を併記する |
| **画面** | `plan.perception.ocr`(既定オフ)の候補代表フレーム OCR、直前候補からの差分 | 劣化時に何に倒すか(`dead-air`/`demo-wait` は残す側)を書く |

### 各節の中身の規則

- **既定の処置**: `cut` / `keep` / `boundary`。`boundary` 系は「切るか残すか」
  ではなく**境界をどちらへずらすか**を書く(`tail-clip` = 後ろへ、
  `reference-orphan` = 前へ)
- **反例**: 下記フェンス規約に従う。「この分類に見えるが当てない場合」を
  最低2件
- **紛らわしい隣**: 必ず他分類の id を1つ以上書き、弁別子を1行で書く
  (例: `dead-air` — 弁別子は画面の変化の有無)。13本の「紛らわしい隣」を
  合わせたとき、全ての id が少なくとも1回は他分類から参照される(孤立
  ノードを作らない。相互参照が片方向で終わらない)
- **worked example**: 実収録から起こす。元収録の秒 + 候補 id + 実テキストを
  ` ```text ` で示し、判断だけを ` ```json ` で書く。接地の無い想定分類
  (`tangent` / `failure-and-fix` / `reference-orphan`)は worked example を
  空にせず「接地なし」と明記した合成例を置く

## フェンス規約(P2 の機械検査が前提にする規約。厳守)

HF の「正例は ` ```html `、悪い例は ` ```text `」に構造的に対応させる。
こちらの機械検査が抽出するのは**判断 JSON** なので、フェンスの割り当ては:

| 種別 | フェンス | 機械検査 |
|---|---|---|
| **正例(worked example の判断)** | ` ```json ` | 抽出対象。`reasonId` が13分類の id 集合に閉じること・キーが `{id, reasonId, reason}` であることを検査する予定(P2) |
| **入力側の素材**(候補テキスト・時刻) | ` ```text ` | 抽出されない |
| **反例**(この分類を当てない例・過去の失敗) | ` ```text ` **のみ** | 抽出されない。**判断 JSON の形を持たせない** |

### 規約(3条)

1. **反例節に ` ```json ` フェンスを置いてはならない。** 反例は「区間テキスト +
   なぜ当てないか」の散文で書く。判断を示したいときは JSON ではなく
   `→ この区間は demo-wait(切らない)` のように**散文の矢印**で書く
2. **反例節の見出しは固定文字列 `## 反例(この分類を当てない場合)`。** 機械
   検査はこの見出しから次の `##` までを反例ブロックとして切り出し、その中に
   ` ```json ` フェンスが1つも無いことを検査する(正例フェンスに悪い例が
   紛れる方向ではなく、**逆向き**——反例ブロックに判断 JSON の形が紛れ込んで
   いないか——を機械化する)
3. **反例のうち「実際に起きた失敗」には出典を書く。** `rules.md` の3件
   (デモ中の無言の大量カット / 締め挨拶の消失 / 語尾食い)と、
   `~/Movies/cutflow/2026-07-12` の実データで確認できる「AI が cut と判断した
   候補を人間が GUI で keep に戻した」痕跡は、それぞれ対応する分類の反例節に
   **元秒つき**で書く

## `rules.md` との線引き

`rules.md`(チャンネルの親ディレクトリ直下、または収録フォルダ直下)は
**チャンネル固有の資産**で、分類学(この `docs/edit-skills/`)とは役割が違う:

- **分類学(このディレクトリ)**: 「状況の名前」を与える。どのチャンネルでも
  真であることを目指す、リポジトリ同梱・channel 非依存の一般知識
  (例: `demo-wait` = 「画面が語っている無言」という状況そのもの)
- **`rules.md`**: 「その状況でこのチャンネルはどうするか」という**強度**を
  上書きする、人間が育てる channel 固有資産(例: `~/Movies/cutflow/rules.md`
  の「デモ・画面操作中の無言は『待ち時間』ではなく見せ場」という**このチャン
  ネルの温度感**)

**`rules.md` の内容を分類学へ吸い上げてはならない。** 逆に、分類学が
`rules.md` の記述を**接地(根拠)として引用する**のは問題ない(実際、
`demo-wait` / `greeting` / `hook` / `tail-clip` / `reference-orphan` は
`rules.md` を接地の一部にしている)。吸い上げてはいけないのは「このチャンネル
だけの強度・数値・許容度」であって、`rules.md` に**記録された失敗の事実**
(反例の出典)を分類学側の反例節が参照することは、この線引きの対象外——
反例は「一般的にこの分類を誤ると何が起きるか」の記録であり、チャンネル固有の
強度設定ではない。

## 収録タイプ(patterns)

13分類のうち「どれを重点的に注入するか」は収録の性質(収録タイプ)によって
変わる。この選択注入の機構と id 一覧は [`patterns.md`](patterns.md) を見る
(id 集合の単一の出所は `src/lib/cutPatterns.ts` の `CUT_PATTERN_IDS`)。
選ぶ主体は LLM ではなく人間(`config.yaml` の `plan.reasonIds.pattern`)。
本書(README・recipes 本文)は収録タイプに依存しない一般知識のままで、
`patterns.md` はその**部分集合+重み付け**を宣言するだけの薄い層。

収録タイプにはさらに、判断中の候補が動画のどの位置にあるかという文脈を
与える **blueprint**(アーク)が最大1本紐づく。[`blueprints.md`](blueprints.md)
を見る(`general` は blueprint 無し)。

## examples(実収録の判断記録)

`docs/edit-skills/examples/*.md` は、実収録1本ぶんの判断を抜粋した記録
(1ファイル = 1収録)。recipes が「一般に見分ける型」を書くのに対し、
examples は「その型を実際にどう当てたか」の具象(K1)——特に**人間が
GUI で反転させた判断**(AI が切ろうとして人間が戻した箇所)は、この
プログラム最大の一次資料になる。最初の記録は
[`examples/2026-07-12-tool-demo.md`](examples/2026-07-12-tool-demo.md)。

## 索引

切る: [`restatement`](recipes/restatement.md) ·
[`stumble`](recipes/stumble.md) ·
[`duplicate-tail`](recipes/duplicate-tail.md) ·
[`gap-trim`](recipes/gap-trim.md) ·
[`dead-air`](recipes/dead-air.md) ·
[`tangent`](recipes/tangent.md) ·
[`slate`](recipes/slate.md)

残す: [`demo-wait`](recipes/demo-wait.md) ·
[`failure-and-fix`](recipes/failure-and-fix.md) ·
[`hook`](recipes/hook.md) ·
[`greeting`](recipes/greeting.md)

境界: [`tail-clip`](recipes/tail-clip.md) ·
[`reference-orphan`](recipes/reference-orphan.md)
