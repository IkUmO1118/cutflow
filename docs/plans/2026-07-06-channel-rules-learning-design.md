# 設計: チャンネル rules + 修正からの学習

*2026-07-06 / 診断レビュー Now-3「★ チャンネル rules + 修正からの学習」(運用 / effort S・安い勝ち)の実装設計*

対象実装者: Sonnet エージェント。この 1 ファイルだけを読めば着手できるよう自己完結で書く。**コードはまだ書かない**——これは設計。

---

## 0. ゴールと effort S の線引き

チャンネル(シリーズ)固有の恒久的な編集方針——テロップ様式・声色/トーン・禁止語・
ペーシング等——を平文 Markdown の `rules.md` に書き、LLM 生成(`plan` /
`plan --cuts-only` / `remeta` / `plan-shorts`)のプロンプトへ注入する。さらに
「人間が LLM の生成物をどう直したか」を材料に**次回のための rules 追記案を LLM に
書かせる**(`learn` コマンド)。追記案は人間が読んで採用する(自動では channel の
rules を書き換えない)。

`.cursor/rules` の動画版。「一発生成ボタン」に、動画をまたいで“自分の色”を保つ薄い
記憶層を足す。

### やること(MVP)

1. `{{rules}}` プレースホルダを `renderPrompt` に足し、4 テンプレートへ注入口を開ける。
2. rules ファイルを 2 階層(チャンネル + 収録)で読んでマージする。
3. `learn` コマンド: 直前の LLM 生成(`plan.raw.txt`)と人間が仕上げた現状
   (`describe` 要約 + `meta.json`)を LLM に見せ、rules 追記案を
   `rules.suggested.md` に**下書き**として書く。channel rules は触らない。

### やらないこと(effort S を守るため意図的に外す)

- **機械的 diff からの学習(候補 C)はやらない。** `backups/` の退避ファイルや
  cutplan の id 対応を突き合わせて「LLM が切ったが人間が残した区間」を機械抽出する
  案は、id 母集合の再構築(cuts.auto.json 依存)と差分ロジックで effort が M〜L に
  膨らむ。MVP は LLM に生成物 vs 完成品を丸ごと見せて要約させる 1 ショットで足りる。
- **channel rules への自動追記はしない。** 「AI は自分で承認しない」原則。追記案は
  必ず別ファイル(`rules.suggested.md`)止まりで、収録フォルダの外(channel 直下の
  `rules.md`)を書き換えるのは人間の手作業。
- **rules の場所/ファイル名を config 化しない。** 既存 `brief.md` がファイル名を
  `plan.ts` 内でハードコードしている先例(276 行目 `join(dir, "brief.md")`)に
  合わせ、`rules.md` / `rules.suggested.md` もハードコード。channel の場所は
  「収録フォルダの親ディレクトリ」で決まる(後述)ので config 追加はゼロ。
- **rules のスキーマ化・構造化はしない。** 自由散文 Markdown。LLM がそのまま読む。
- **エージェントループ化・複数ラウンドの学習はしない。** `complete()` は 1 回だけ。

---

## 1. rules ファイルの置き場所と粒度

### 結論: (c) チャンネル rules + 収録固有 rules をマージ。ただし channel を主役に。

| 案 | 内容 | 評価 |
|---|---|---|
| (a) channel のみ | `<channel>/rules.md` 1 枚を全収録共通で注入 | 主用途はこれ。だが「この回だけの例外」を書けない |
| (b) 収録のみ | `<dir>/rules.md` 1 枚 | チャンネル横断の“自分の色”が保てない。学習の意味が薄い |
| **(c) 両方マージ** | channel(汎用)+ 収録(この回の上書き/追加)を連結 | **採用**。実装は「2 ファイル読んで連結」で +数行。柔軟 |

(c) の追加コストは「もう 1 ファイル読んで連結」だけ。effort S を壊さない。

### channel ディレクトリの決め方: `dirname(dir)`(収録フォルダの親)

`renderPrompt` は既に収録フォルダの絶対パス `dir` を持っている。その親
`dirname(dir)` を channel ディレクトリとみなす。

- 収録が `~/Movies/cutflow/2026-07-02-xxx/` なら親は `~/Movies/cutflow/` =
  ちょうど `recordingsDir`。診断の言う「channel = recordingsDir 単位」に一致。
- サブグルーピング `~/Movies/cutflow/series-a/2026-.../` なら親は `series-a/`。
  グループ単位で `rules.md` を置ける(「あるいはサブグルーピング」に自然対応)。
- **利点:** `renderPrompt` に `cfg` / `recordingsDir` を新規に渡す必要がない
  (`dirname(dir)` で無料で取れる)。引数追加ゼロ = 最小改修。相対パス・symlink で
  渡されても「その収録の親」で一貫する。

> 注意(落とし穴): 複数チャンネルを 1 つの `recordingsDir` 直下にサブフォルダ無しで
> 平置きすると、`recordingsDir/rules.md` は全収録に効いてしまう。チャンネルを分けたい
> なら**サブグルーピングのフォルダを切って**そこに `rules.md` を置く運用を docs に明記。

### ファイル名とフォーマット

- channel rules: `<dirname(dir)>/rules.md`
- 収録 rules: `<dir>/rules.md`
- フォーマット: **自由散文の Markdown**(スキーマ無し)。LLM がそのまま読む。

### `brief.md` との役割分担(プロンプトにも明記する)

| ファイル | 何を書くか | 粒度 | 既存/新規 |
|---|---|---|---|
| `brief.md` | **この回**の見せ場・狙い・絶対に切らない内容 | 収録ごと | 既存 |
| `rules.md` | **恒久的な様式**: テロップ表記ルール・トーン/声色・禁止語・ペーシング・章の付け方・タイトルの型 | チャンネル(+ 収録上書き) | 新規 |

brief = 「今回の中身」、rules = 「毎回守る型」。プロンプト上も別セクションに分ける。

### `rules.md` サンプル(docs に載せる例)

```markdown
# このチャンネルの編集ルール

## トーン・声色
- ですます調。初学者に語りかける柔らかさ。煽り・過度な誇張はしない。

## テロップ様式
- 専門用語は初出でカッコ書きの短い補足を付ける(例: 「ホットリロード(保存で即反映)」)。
- 章タイトルは体言止めで 12 文字以内。

## 禁止語・言い換え
- 「めっちゃ」「ヤバい」は使わない → 「かなり」「大きく」に。
- 視聴者を「お前」呼ばわりしない。

## ペーシング・カット
- 沈黙の“ため”は 1 秒までは残す(考えている間も味)。切りすぎない。
- コードを書いている手元は多少冗長でも残す(過程が価値)。

## タイトル・概要欄
- タイトルは「〜する方法」より「〜してみた/〜でハマった」の実況型を優先。
```

---

## 2. 注入方法(`{{rules}}` プレースホルダ)

### 2.1 最重要不変条件: **rules 不在時はプロンプト文字列が現状とバイト単位で一致**

これを壊すと既存の生成挙動が変わる。テンプレへの `{{rules}}` の差し込みは
「既存の空行を `{{rules}}` の行で置き換える」形にし、rules が空文字なら空行に戻る
ようにする。

現状(`plan.md`)の該当箇所は:

```
{{brief}}
<空行>
## カットの判断基準
```

= 文字列 `{{brief}}\n\n## カットの判断基準`。これを:

```
{{brief}}
{{rules}}
## カットの判断基準
```

= `{{brief}}\n{{rules}}\n## カットの判断基準` に変える。

- rules 不在(`{{rules}}` → `""`): `{{brief}}\n\n## カットの判断基準` → **元と完全一致** ✅
- rules あり(先頭 `\n`・末尾 `\n` 付きブロックを注入): 見出し + 本文が正しく挟まる。

### 2.2 rules ブロックの生成(純関数 + 読み込み)

**純関数**(テスト対象・ディスク非依存)を新設して `plan.ts` から export する:

```
// channel/recording の rules 本文(無ければ null)を受け、注入する 1 ブロックを返す。
// どちらも無ければ "" を返す(= プロンプトは現状と完全一致)。
export function renderRulesBlock(
  channel: string | null,
  recording: string | null,
): string
```

仕様:

- 両方 `null`/空 → `""` を返す(不変条件の要)。
- あるものだけを見出し付きで連結。返り値は **先頭 `\n`・末尾 `\n`** を必ず付ける:

  ```
  \n## チャンネル方針(このシリーズの恒久的な編集ルール)\n\n
  ### 全収録共通のルール\n\n<channel 本文>\n
  ### この収録だけのルール\n\n<recording 本文>\n
  ```

  - channel のみのときは「### 全収録共通のルール」小見出しは省いて本文直付けでもよい
    (どちらでも可。両方あるときだけ 2 つの小見出しで precedence を明示)。
  - 「収録固有が共通より優先」と 1 行添える(例: 「※ 収録固有の指示が共通ルールと
    矛盾する場合は収録固有を優先」)。

**読み込み**(非純粋・薄いラッパ):

```
function readRules(dir: string): string {
  const channelPath = join(dirname(dir), "rules.md");
  const recordingPath = join(dir, "rules.md");
  const channel = existsSync(channelPath) ? readFileSync(channelPath, "utf8").trim() : null;
  const recording = existsSync(recordingPath) ? readFileSync(recordingPath, "utf8").trim() : null;
  return renderRulesBlock(channel || null, recording || null);
}
```

> エッジ: 収録が `recordingsDir` 直下だと `dirname(dir)` は `recordingsDir`、
> `<dir>/rules.md` と別ファイルなので二重読みにはならない。もし将来 `dirname(dir)`
> と `dir` が同一になる呼び方(想定外)があっても、trim 後同一内容なら 2 回出るだけで
> 害は無いが、気になるなら同一パスチェックを 1 行入れてよい(MVP は不要)。

### 2.3 `renderPrompt` の改修

`src/stages/plan.ts` 283–287 行目の置換チェインに 1 行足すだけ:

```
const rules = readRules(dir);
return template
  .replaceAll("{{segments}}", () => segmentLines)
  .replaceAll("{{duration}}", () => durationSec.toFixed(0))
  .replaceAll("{{brief}}", () => brief)
  .replaceAll("{{rules}}", () => rules);   // ← 追加
```

**必ず `brief` と同じ「関数形式の replaceAll」**にすること。理由は既存コメント
(281–282 行)どおり: 文字列指定の `replace` は 1 箇所しか置換されず、rules 本文に
`$&` / `$1` 等が混じると置換パターンとして誤解釈される。関数形式なら生文字列として入る。

`renderPrompt` の**シグネチャは変更しない**(`dir` から `dirname(dir)` を取るので
`cfg` を渡す必要が無い)。`planShorts.ts` の呼び出しも無改修で `{{rules}}` が効く。

### 2.4 テンプレート改修(4 ファイル)

いずれも「`{{brief}}`(または plan-shorts は `{{duration}}` 行)直後の空行を
`{{rules}}` の行に置換」する。**空行を消して `{{rules}}` を足す**(行を増やさない)。

- `prompts/plan.md`: 17 行 `{{brief}}` の次の空行 → `{{rules}}`
- `prompts/plan-cuts.md`: 18 行 `{{brief}}` の次の空行 → `{{rules}}`
- `prompts/meta.md`: 20 行 `{{brief}}` の次の空行 → `{{rules}}`
- `prompts/plan-shorts.md`: 15 行 `元の収録は {{duration}} 秒です。` の次の空行 → `{{rules}}`
  (plan-shorts に `{{brief}}` は無い。`## ショートの選び方` の直前に入る)

**置く位置の判断**: 見せ場(brief)の直後・判断基準/選び方の**直前**。理由: rules は
「様式・恒久方針」で、モデルが具体的な判断基準を適用する前に読ませたい上位の枠。
brief(今回の中身)→ rules(毎回の型)→ 判断基準(汎用ルール)の順で、具体から
恒久・汎用へ。各テンプレ冒頭コメントの「# … の各プレースホルダーが置換される」にも
`rules` を書き足す。

---

## 3. 「修正からの学習」= `learn` コマンド(候補 A・MVP)

### 3.1 なぜ A か

| 候補 | 内容 | 判定 |
|---|---|---|
| A `learn` コマンド | 直前生成 vs 人間仕上げを LLM に見せ rules 追記案を生成、人間が採用 | **採用**。effort S・人間ゲート維持・ソロ保守向き |
| B 手書きのみ | ツールは注入だけ、rules は人間が書き溜める | 注入(第 2 章)で既に満たす。学習の“提案”が無い |
| C 機械 diff | backups と現行を機械突合し候補抽出 | id 母集合再構築で effort M〜L。MVP から外す |

B は第 2 章で自動的に達成される(rules.md を手で書けば効く)。A はその上に「何を
rules 化すべきか LLM に下書きさせる」提案層を薄く足すもの。C は将来。

### 3.2 入出力

**コマンド:** `node src/cli.ts learn <dir>`

**入力(すべて読むだけ・書き換えない):**

| 材料 | 取得元 | 用途 |
|---|---|---|
| 直前の LLM 生成 | `<dir>/plan.raw.txt` | LLM が最初に出した判断・章・タイトル・概要欄(生応答) |
| 人間仕上げの現状 | `describe(dir)` の出力文字列 | keep/カット・発言・章・演出の完成状態(既存 stage を再利用) |
| メタの現状 | `<dir>/meta.json` | 人間が直した/採用したタイトル・概要欄 |
| 既存 channel rules | `<dirname(dir)>/rules.md`(あれば) | 既にルール化済みのことを繰り返させない |

`plan.raw.txt` が無ければ「先に plan か run を実行してください」でエラー終了
(既存 `readStageJson` と同じ作法)。`describe` は `src/stages/describe.ts` の
`describe()` を import して呼ぶ(cutplan/transcript 等が揃っている前提。無ければ
`describe` 側が投げる既存挙動に委ねる)。

**出力:** `<dir>/rules.suggested.md` に LLM 生応答をそのまま書く(自由 Markdown。
JSON パース不要)。**`rules.md`(channel も収録も)には一切書かない。**

**標準出力メッセージ**(既存コマンドの日本語トーンに合わせる)例:

```
learn 完了: rules 追記案を書き出しました: <dir>/rules.suggested.md
内容を確認し、採用したい項目を手で <channel>/rules.md に追記してください
(このファイルは下書きです。次回の learn で上書きされます)。
```

### 3.3 承認境界(論点 4 の結論)

**結論: 別ファイル `rules.suggested.md` に出す。channel rules は人間が手で採用。**

- `learn` が書くのは収録フォルダ内の `rules.suggested.md` だけ。channel の `rules.md`
  を機械が書き換えることは一切無い → 「AI は自分で承認しない」原則と完全整合。
- `rules.suggested.md` は使い捨ての下書き(`.editor-draft.json` に近い位置づけ)。
  既存があれば黙って上書きしてよいが、上書きした旨をログに出す。backups への退避は
  不要(正のデータではない)。
- 収録フォルダ内に置く理由: その収録の生成物(`plan.raw.txt`)から導いた提案なので
  収録にひも付く。channel 直下に出すと複数収録の learn が互いを上書きし、かつ本物の
  `rules.md` の隣に紛らわしく並ぶ。収録内なら安全にスコープされる。

### 3.4 `prompts/learn.md`(骨子)

新規テンプレート。プレースホルダは `{{existingRules}}` `{{priorGeneration}}`
`{{finalEdit}}` `{{finalMeta}}`。置換は `renderPrompt` と同じ**関数形式 replaceAll**
で行う(専用の小さな組み立て関数 `buildLearnPrompt` を作り、純粋にして export
→ unit テスト可能に)。骨子:

```markdown
# learn ステージ用プロンプト
# existingRules / priorGeneration / finalEdit / finalMeta が置換される

あなたは開発系 YouTube チャンネルの編集アシスタントです。AI が最初に生成した
編集案と、人間が最終的に仕上げた結果を見比べ、「次回このチャンネルで同じ判断を
自動でできるようにするための恒久ルール」を短い Markdown で提案します。

## 既にあるチャンネルルール(これと重複しない差分だけ提案する)
{{existingRules}}

## AI が最初に出した編集案(生成直後)
{{priorGeneration}}

## 人間が仕上げた最終状態(タイムライン要約)
{{finalEdit}}

## 人間が仕上げたタイトル・概要欄
{{finalMeta}}

## 出力
- 人間の修正から読み取れる「恒久的な様式・方針」だけを、rules.md に追記する
  Markdown として出力してください(この回限りの内容・見せ場そのものは書かない)。
- 既存ルールと重複するものは書かない。新しく気づいた差分だけ。
- 断定できないもの・1 回きりの偶然は書かない。確度の高い 3〜6 項目に絞る。
- 見出し + 箇条書きの Markdown のみ。前置き・後書きの説明文は不要。
```

`{{existingRules}}` が無いときの既定文: 「(まだチャンネルルールはありません)」。

### 3.5 実装配置

- `src/stages/learn.ts` を新設(`plan.ts` を肥大させない)。中身は read →
  `buildLearnPrompt`(純関数)→ `complete()` → `writeFileSync(rules.suggested.md)`
  の薄い殻。`describe` と `complete` を import。
- `buildLearnPrompt(template, {existingRules, priorGeneration, finalEdit, finalMeta})`
  を純関数として export(関数形式 replaceAll)。

---

## 4. config / CLI 表面(論点 5)

### config: 追加なし

`brief.md` 先例に倣いファイル名はハードコード。channel の場所は `dirname(dir)` で
決まる。**config.yaml への追加キーは無し**(「ハードコードしない方針」は挙動パラメータ
の話で、規約ファイル名は既に brief.md がハードコード済み。ここを config 化するのは
YAGNI で effort を上げるだけ)。

### CLI: `learn` コマンドを 1 つ追加

`src/cli.ts` に既存 `remeta` / `plan-shorts` と同じ体裁で追加:

```
program
  .command("learn <dir>")
  .description(
    "直前の生成案と人間の仕上げを見比べ、次回用のチャンネルルール追記案を生成" +
      "(rules.suggested.md に下書き。channel の rules.md は人間が手で採用)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    console.log("learn 実行中(LLM でルール追記案を生成)...");
    const out = await learn(abs, cfg);
    console.log(`learn 完了: ${out}`);
    console.log(
      "内容を確認し、採用する項目を手で channel の rules.md に追記してください。",
    );
  });
```

`guardRerun` は不要(channel の正データを上書きしないため。`rules.suggested.md` は
下書きで、上書き前提)。

---

## 5. 検証方針(論点 6)

### 5.1 unit(第一級・非決定性に依存しない)

**rules 注入が効く/効かないをプロンプト文字列で固定する。** LLM は叩かない。

1. `renderRulesBlock`(純関数)の網羅テスト:
   - `(null, null)` → `""`(不変条件の核)。
   - channel のみ → channel 本文を含み、先頭/末尾 `\n` を持つ。
   - recording のみ → recording 本文を含む。
   - 両方 → 両本文が **channel → recording の順**で並び、precedence 注記を含む。
2. `renderPrompt` の配線テスト(temp dir 使用、`node:os` の `tmpdir` + `mkdtemp`):
   - rules ファイル無しの収録 dir → 出力に「チャンネル方針」見出しが**無い**こと、
     かつ `{{brief}}` 既定文と「## カットの判断基準」が**隣接**(間に注入が無い)こと
     を assert = 現状バイト等価の回帰ガード。
   - `<parent>/rules.md` を置く → 出力にその本文が含まれること。
   - `<dir>/rules.md` も置く → 両方含まれること。
3. `buildLearnPrompt`(純関数)テスト: 4 プレースホルダが埋まり、rules 本文に `$&`
   等が入っても壊れない(関数形式 replaceAll の回帰)。

テストは既存 `test/plan.test.ts` に追記するか、`test/rules.test.ts` を新設。
`node --test`・`assert/strict`、日本語 test 名で既存作法に合わせる。

### 5.2 実データ検証(`~/Movies/cutflow/2026-07-02-whisper-bench`)

**LLM を叩く検証は必ず中立 cwd(`cd /tmp`)から絶対パスで実行**(既知の落とし穴:
repo 直下だと `claude -p` が CLAUDE.md やセッション文脈を読んで散文化・挙動変化)。

**原状復帰の徹底: 検証で作ったファイルは消す。既存ファイルは壊さない。**

手順案:

1. プロンプト注入の差分確認(LLM 不要・最も確実):
   - 一時スクリプトで `renderPrompt(dir, "plan.md", numbered, dur)` を呼び、
     **rules 無し**の出力を保存。
   - `~/Movies/cutflow/rules.md`(= whisper-bench の親 = recordingsDir)に一時的に
     サンプル rules を置き、再度 `renderPrompt` を呼んで出力を保存。
   - 2 つを `diff`。rules ブロックだけが増え、他が不変であることを目視。
   - **検証後 `~/Movies/cutflow/rules.md` を必ず削除**(channel 全体に効くファイルを
     残さない)。whisper-bench 直下には何も置かない。
2. `learn` の実測(LLM を叩く。中立 cwd):
   - `cd /tmp && node <repo>/src/cli.ts learn ~/Movies/cutflow/2026-07-02-whisper-bench`
   - `plan.raw.txt` は既にある(git status で確認済み)。`rules.suggested.md` が
     生成され、恒久ルール“だけ”の Markdown になっているかを目視。
   - **検証後 `rules.suggested.md` を削除**(収録フォルダを収録前の状態へ戻す)。
   - whisper-bench には `.bak` 系や既存生成物があるので、`git status` 相当の before/
     after 目視で新規ファイルだけを消す。既存 JSON には触れない。

---

## 6. タスク分解(1 タスク = 1 コミット・依存順)

### タスク 1: rules 注入(`{{rules}}`)

- **変更ファイル:**
  - `src/stages/plan.ts`: `renderRulesBlock`(export・純関数)+ `readRules` を追加、
    `renderPrompt` の置換チェインに `{{rules}}` を 1 行追加(シグネチャ不変)。
  - `prompts/plan.md` / `plan-cuts.md` / `meta.md` / `plan-shorts.md`: `{{brief}}`
    (plan-shorts は `{{duration}}` 行)直後の空行を `{{rules}}` 行に置換 + 冒頭
    コメントに `rules` を追記。
  - `test/rules.test.ts`(新規)または `test/plan.test.ts` に 5.1 の 1・2 を追加。
- **テスト方針:** unit = `renderRulesBlock` の網羅 + `renderPrompt` の temp dir 配線。
  実データ = 5.2 の手順 1(rules 有/無の renderPrompt 差分)。
- **壊してはいけない挙動:** **rules 不在時、4 テンプレの `renderPrompt` 出力が現状と
  完全一致**(空行 → `{{rules}}` 行の置換で行数を増やさないこと)。`brief` と同じ
  関数形式 replaceAll を使うこと。`planShorts.ts` は無改修で動くこと。
- **依存:** なし(先頭)。

### タスク 2: `learn` コマンド

- **変更ファイル:**
  - `prompts/learn.md`(新規)。
  - `src/stages/learn.ts`(新規): `buildLearnPrompt`(export・純関数)+ `learn(dir, cfg)`
    (read → complete → write `rules.suggested.md`)。
  - `src/cli.ts`: `learn` コマンド追加(import 追加、第 4 章の体裁)。
  - `test/learn.test.ts`(新規): `buildLearnPrompt` の置換テスト(5.1 の 3)。
- **テスト方針:** unit = `buildLearnPrompt` 純関数。実データ = 5.2 の手順 2(中立 cwd)。
- **壊してはいけない挙動:** channel の `rules.md` を絶対に書かない(書き込み先は
  `<dir>/rules.suggested.md` のみ)。`plan.raw.txt` 欠如時は明示エラーで停止
  (既存 stage の欠如エラー作法に合わせる)。既存コマンドの挙動は不変。
- **依存:** タスク 1 の後(rules の概念・`renderRulesBlock` の存在後にドキュメントと
  概念が揃う。厳密なコード依存は無いが順序は 1 → 2)。

### タスク 3: ドキュメント同期

- **変更ファイル:**
  - `docs/usage.md`: `rules.md` / `rules.suggested.md` の説明・`learn` コマンド・
    サブグルーピングでのチャンネル分割の注意を追記。
  - `CLAUDE.md`: 「どのファイルが何を決めるか」表に `rules.md`(恒久様式)を追加、
    コマンド一覧に `learn` を追加、`brief.md` と `rules.md` の役割分担、
    `rules.suggested.md` を「中間生成物(触らない/上書きされる下書き)」側に明記。
  - `src/types.ts` はスキーマ変更が無い(rules は自由 Markdown で型無し)ため触らない。
- **テスト方針:** なし(ドキュメント)。`npm run typecheck` / `npm test` が緑のままを確認。
- **依存:** タスク 1・2 の後。

各タスク後に `npx tsc --noEmit` と `npm test` を通す。

---

## 7. 落とし穴チェックリスト

1. **バイト等価:** テンプレの空行を「削って `{{rules}}` を足す」——**行を増やさない**。
   増やすと rules 不在でもプロンプトが変わり既存挙動が崩れる。unit で必ず固定。
2. **関数形式 replaceAll 必須:** rules / suggested 本文にユーザーが `$&` `$1` 等を
   書き得る。文字列形式 `replace` は使わない(既存 281–282 行コメント参照)。
3. **中立 cwd で LLM 検証:** repo 直下で `claude -p` を叩くと CLAUDE.md を読み込み
   挙動が変わる。`cd /tmp` して repo と収録を絶対パスで。
4. **channel rules は全収録に効く:** `recordingsDir` 直下に平置きした複数チャンネルが
   ある場合、`recordingsDir/rules.md` は全部に効く。分けるならサブフォルダ運用を docs に。
5. **`rules.suggested.md` を正データと誤認させない:** 下書き。中間生成物側(触らない)
   として CLAUDE.md/docs に明記。git 管理外にしたいなら実装者判断で `.gitignore` 追記
   (収録フォルダは repo 外なので通常は無関係)。
6. **`learn` は channel rules を書かない:** 書き込み先を `<dir>/rules.suggested.md` に
   ハードコードで固定。テストでも「rules.md に書かないこと」を担保。
7. **rules の肥大 = トークン増:** MVP では上限を設けないが、rules.md は短く保つ旨を
   docs に一言。将来必要なら文字数警告を足す(今はやらない)。
8. **`describe` 依存:** `learn` は `describe(dir)` を使うので cutplan/transcript 等が
   必要。無ければ `describe` の既存エラーに委ね、`learn` 独自の握りつぶしはしない。
9. **`dirname(dir)` は絶対パス前提:** CLI は `resolveDir`(= `resolve`)で絶対化済み。
   `renderPrompt` に渡る `dir` が絶対であることを前提にしてよい(既存 `plan()` 経路で保証)。

---

## 付録: 変更しないと明言するもの

- `renderPrompt` のシグネチャ(引数追加なし)。
- `config.yaml` / `Config` 型(キー追加なし)。
- `src/types.ts`(rules は型無しの自由 Markdown)。
- `numberSegments` / cutplan 生成 / 承認ゲート等のパイプライン本体。
- `plan.raw.txt` ほか中間生成物の生成(`learn` は読むだけ)。
</content>
</invoke>
