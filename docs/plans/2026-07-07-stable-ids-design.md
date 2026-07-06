# 安定 ID / @-mention を全セグメントに付与 — 設計

*2026-07-07 / 診断レビュー「B. AI の行動インターフェース」項目の設計。実装は別担当(Sonnet)。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ B「AI の行動インターフェース」/ 項目
> 「**安定 ID / @-mention が無い** — segment に永続 id が無く指示が全て曖昧
> アドレス。diff・差分適用・rules の共通基盤」= severity **major** / effort **M**。

---

## 背景とギャップ

現状、編集ファイルの各要素を指す手段は**位置アドレス**しか無い:

- 人間/AI が「この区間」「このテロップ」と言うと `cutplan.segments[3]` /
  `transcript.segments[12]` のような**配列添字**でしか特定できない。
- 添字は編集で簡単にずれる。segment を1つ挿入/削除すれば以降の全添字が動く。
  「segments[3] をカットに」という指示は、その後1回でも並びが変われば別物を指す。
- `plan.ts` の `numberSegments` が振る `id`(1始まりの連番)は **plan 実行ごとに
  振り直される一時的な番号**で、cutplan.json にも残らない(LLM 入力専用)。永続 id は
  どのファイルにも無い。

この「安定した宛先が無い」状態が、後続機能すべての土台を欠けさせている:

- **差分適用(Feature 4 の id 指定パッチ)**: 「`@cap_7x2f` の text をこう変えろ」という
  アトミックなパッチを当てるには、編集をまたいで不変な宛先が要る。
- **GUI 差分レビュー**: 外部/AI が JSON を書き換えたとき、要素単位で「これは変更・これは
  追加・これは削除」と対応付けるには要素の同一性(=id)が要る。今は「全再読込 or 全上書き」の
  二値しか無い(診断 GUI 節)。
- **rules の対象特定**: 「このトラックのテロップはこうする」を機械可読に書くにも宛先が要る。

**ゴール**: 編集ファイルの各「指せる要素」に、**編集をまたいで安定な永続 id** を付け、
`@id` 形式で「どのファイルのどの要素か」に解決できる純関数を用意する。**未使用時
(id 無しの既存プロジェクト)は全コマンドがバイト等価**で動く。

---

## スコープ

**やること(今回)**

- 各「指せる要素」の interface に**任意の `id?: string`** を足す(`src/types.ts`)。
- id 生成・採番・引き継ぎの**純関数**(`src/lib/ids.ts`)。
- **`id-stamp <dir>` コマンド**: 既存プロジェクトに一括採番(冪等・opt-in・移行の唯一経路)。
- 生成ステージ(`plan` / `transcribe` / `plan-shorts`)と editor 保存が、
  **id 有効なプロジェクトでのみ**新規要素へ採番し既存 id を保つ配線。
- **`@id` 解決の純関数**(`src/lib/mention.ts`)。Feature 4 が使うアドレッシング基盤。
- `validate` に id の形式・重複・欠落の**警告**を追加(エラーは一切増やさない)。
- `describe --json`(完全射影)に id を露出(条件付きフィールド=id 無しならバイト不変)。

**やらないこと(スコープ外)**

- **検査付きアトミック適用(id 指定パッチ)本体 = Feature 4。** 今回は「id を付ける・
  参照解決する・検査する」まで。`resolveMention` 純関数は用意するが、それを使って
  編集を書き戻す CLI/MCP は作らない(境界は本ドキュメント §スコープ境界に明記)。
- **GUI 差分レビュー UI 本体**(別機能)。id はその土台を提供するだけ。
- **散文 `describe` への id 露出**(golden バイト固定のため。§論点4 で不採用を明記)。
- **id によるレンダー挙動の変更**。id は AI/人間のアドレッシング専用で、`render` /
  `preview` / `frames` / 承認 hash には一切効かない(§不変条件で明記)。

---

## 中核原則:**ID は opt-in・sticky**

本設計全体を貫く1つの規律。これがバイト等価の不変条件を airtight にする:

> **プロジェクトに1つでも `id` があれば「id 有効」。** id 有効なプロジェクトでのみ、
> 生成ステージ(plan/transcribe/plan-shorts)と editor 保存が新規要素へ採番し、
> 既存 id を保つ。**id が1つも無い(=未 stamp の従来プロジェクト)では、
> すべてのコマンドが本機能導入前とバイト等価**。`id-stamp` が唯一の
> 「id 無し → 有効」への遷移(人間/AI が明示実行)。

帰結:

- 従来プロジェクト(未 stamp): `plan` / `transcribe` を**再実行しても**出力は
  id 無しのまま=導入前とバイト等価。`validate` / `describe`(散文)/ `render` も不変。
- 一度 `id-stamp` を通したプロジェクト: 以後の生成・保存が id を維持・密にする。
- 判定 `isIdEnabled(dir)`: 編集ファイル群を読み、いずれかの要素に `id` があれば true。
  cheap(既に読んでいる docs を見るだけ)。

この gate により「未使用時バイト等価」は**「id が1つも無ければ触らない」**という
1条件に還元され、テストも fixture に id を入れない1系統で全コマンドを固定できる。

---

## 論点と決定

### 論点1:id の格納場所と形式 → **決定: 各要素に任意 `id?: string`。型接頭辞つき短い base36 乱数。採番済みは不変・欠落だけ採番**

**格納場所**

各 interface に `id?: string` を1つ足す(要素と同じオブジェクトの中)。別マップ
(id→要素の外部テーブル)にしない理由:

| 案 | 判断 |
|---|---|
| **要素内 `id?` フィールド(採用)** | grep/diff で要素と id が同じ行群に見える(video-as-code の核)。要素を移動/コピーしても id が付いてくる。JSON の1キー追加だけ。**id 無しなら省略=バイト不変** |
| 外部 id テーブル(`ids.json` に id→パス) | 位置アドレスを別ファイルに持つのと同じで、編集で即座に陳腐化する。二重管理。却下 |

**形式**

| 案 | 安定性 | 可読性 | 衝突 | 判断 |
|---|---|---|---|---|
| 連番(`seg1`, `seg2`…) | ✗ 挿入で番号の意味がずれる/振り直し圧力 | ○ | ファイル間で衝突 | **却下**。位置アドレス問題の再来 |
| 内容ハッシュ由来 | ✗ 内容が変われば id も変わる(安定の逆) | △ | ○ | **却下**。「内容は変わるが id は不変」が要件 |
| **型接頭辞つき短い base36 乱数(採用)** | ○ 一度振れば内容・位置と無関係に不変 | ○ 接頭辞で種別が分かる | 乱数長で回避 | **採用** |

**id の文法**: `<prefix>_<base36>`。

- `prefix` = 要素の**種別**(下表)。要素の種別は生涯不変なので接頭辞も不変=安定を壊さない。
  接頭辞で `@id` から「どのファイルのどの配列か」を絞れる(解決が O(1) に近づく)。
  grep `cap_` で全テロップ参照を洗える。
- `base36` = `[0-9a-z]` の乱数**6文字**(≈ 20億通り)。1収録あたり要素は多くて数千なので
  衝突確率は無視できる小ささ。採番時に既存 id 集合と衝突したら振り直す(§ids.ts)。
- 全体正規表現: `^[a-z]{2,3}_[0-9a-z]{6}$`。

**接頭辞の割り当て**(種別 → 接頭辞。src/lib/ids.ts の単一の出所):

| 接頭辞 | 対象要素 |
|---|---|
| `seg` | `cutplan.segments[]`(keep/cut セグメント) |
| `cap` | `transcript.segments[]`(テロップ) |
| `mat` | `overlays.overlays[]`(素材。LayerId の `ov<N>` と混同しないため `mat`) |
| `ins` | `overlays.inserts[]`(挿入クリップ) |
| `zm`  | `overlays.zooms[]` |
| `bl`  | `overlays.blurs[]` |
| `wf`  | `overlays.wipeFull[]` |
| `hc`  | `overlays.hideCaption[]` |
| `ct`  | `overlays.captionTracks[]` および各 short の `captionTracks[]` |
| `ch`  | `chapters.chapters[]` |
| `bg`  | `bgm.tracks[]` |
| `rg`  | 各 short の `ranges[]` |
| `tx`  | `thumbnail.texts[]` |

**shorts は例外**: `Short` は既に `name`(`[a-z0-9_-]+`・収録内一意・人間可読)を持ち、
これが事実上の安定 id。`@<name>` でそのまま指せるので**別の id フィールドは足さない**。
mention 解決は short を name で引く(§論点4)。

**「一度振ったら不変」の担保**: 採番は必ず「**既存 id はそのまま保ち、id が無い要素にだけ
新規採番する**」`ensureIds`(§ids.ts)経由。乱数なので再生成のたびに変わることは無い
(乱数を「新規のときだけ」引くから)。生成ステージが配列を作り直すときは、後述の
`carryIds`(span 一致で旧 id を運ぶ)→ `ensureIds`(残りを採番)の順で通す。

---

### 論点2:どのファイル・どの要素に id を付けるか → **決定: 全「指せる配列」に一律で付ける(shorts は name を流用)**

@-mention の**主対象**は診断どおり `cutplan.segments` と `transcript.segments` だが、
**アドレッシングモデルを一部だけにすると Feature 4(diff/patch/rules)が
「id がある要素/無い要素」を特殊分岐しなければならず、共通基盤という目的を損なう**。

要素の追加コストを見ると、一律採用が安い:

- id 採番・引き継ぎは**単一ヘルパ `ensureIds`/`carryIds` を各配列に適用するだけ**。
- 演出配列(materials/inserts/zooms/blurs/…)・bgm.tracks・thumbnail.texts は
  **生成ステージが作り直さない**(純粋な手編集対象)ので、id 引き継ぎの難所が無い。
  型に `id?` を足して stamp/validate/resolve に載せるだけ。
- 難所(生成による作り直し)は `cutplan.segments` / `transcript.segments`(章トラック) /
  `chapters` の3つだけに集中する(§論点6)。

したがって**全配列に一律**で付ける。ただし優先度は次のとおりで、タスク分解も主対象を先に置く:

1. **主対象(必須)**: `cutplan.segments`, `transcript.segments`。
2. **演出・章・BGM・サムネ**: `overlays.*`, `chapters.chapters`, `bgm.tracks`, `thumbnail.texts`。
   手編集のみ=採番+検査+解決を足すだけ。
3. **shorts**: `name` 流用(新フィールド無し)。`ranges` / `captionTracks` は `rg`/`ct`。

---

### 論点3:採番のタイミング/経路 → **決定: `id-stamp` を唯一の「無効→有効」遷移とし、生成ステージ・editor 保存は「id 有効時のみ」採番。従来プロジェクトは触らない**

4案の組み合わせを、中核原則(opt-in・sticky)に沿って配線する:

| 経路 | 役割 | 採番するか |
|---|---|---|
| **(c) `id-stamp <dir>` コマンド** | **opt-in / 既存プロジェクト移行の唯一経路** | 常に採番(冪等)。id 無し→有効の遷移はここだけ |
| **(a) 生成ステージ**(plan/transcribe/plan-shorts) | 新規要素を作る所 | **id 有効時のみ**採番+既存 id 引き継ぎ。無効時は id 無し出力=導入前と等価 |
| **(d) editor 保存** | 手編集・GUI 生成 | **id 有効時のみ**採番。常に既存 id を保持(round-trip) |
| (b) validate 自動採番 | — | **採用しない**。validate は読み取り専用の契約。書き込むとバイト等価が壊れる(§論点5) |

**(b) を却下する理由**: `validate` は現状ディスクを一切書かない(CLI と editor `/api/save` が
共有する純検査)。ここで自動採番するとファイルを書き換えることになり、「読むだけの検査」の
契約と「未使用時バイト等価」を両方壊す。id 欠落は**警告**でだけ知らせ(§論点5)、採番は
明示コマンド(`id-stamp`)か生成/保存に委ねる。

**後方互換**: 従来の id 無し JSON は、`id-stamp` を一度も通さない限り id 無しのまま。
`validate` は警告を1本出すだけ(id 無しなら**その警告も出さない**=完全不変)。`describe`
散文・`render`・`preview`・`frames` は id を一切見ない。

**`run`(初回一括)との関係**: `run` は ingest→transcribe→detect→plan→… を通す。今回、
`run` の末尾で `id-stamp` を1回呼び、初回から id 有効で生まれるようにする(新規収録の
UX)。これは中核原則に反しない(`run` は新規生成なので、その成果物が id を持つのは
「未使用時バイト等価」の対象外=生成物であって既存 id 無しファイルではない)。既存
プロジェクトへ後から `run --force` する場合も、`--force` は既に backups/ へ退避する経路
なので id 付与が混ざっても事故にならない。**ただし `run` への配線はタスクの最後に置き、
主対象(id-stamp 単体)が完結してから足す**(段階導入)。

---

### 論点4:@-mention の解決経路 → **決定: `src/lib/mention.ts` の純関数。id は `describe --json` にだけ露出(散文=golden 不変)**

**解決の純関数**(`src/lib/mention.ts`):

```ts
export interface MentionTarget {
  file: string;          // "transcript.json" など
  kind: string;          // "caption" | "cutSegment" | "material" | ... | "short"
  path: string;          // "segments[12]" のような人間可読パス(表示・ログ用)
  index: number;         // 配列添字(short は shorts[] の添字)
}
/** 収録の全編集ファイル(パース済み docs)から id→所在の索引を作る純関数 */
export function collectIds(docs: LoadedDocs): Map<string, MentionTarget>;
/** "@cap_7x2f" / "cap_7x2f" を所在に解決(無ければ null) */
export function resolveMention(ref: string, index: Map<string, MentionTarget>): MentionTarget | null;
```

- 入力は `validate` の `LoadedDocs`(既にある共有型)。fs 非依存の純関数=単体テスト可能。
- 接頭辞で対象配列を絞り、その配列を走査して id 一致を返す。short は `name` を鍵に引く
  (`@intro` / `@short:intro` の両方を受ける)。
- **`collectIds` を `validate` の重複検査でも使う**(§論点5)=mention.ts に今回から実在の
  消費者ができ、dead code にならない。

**id の露出先**:

| 出力 | id を出すか | 理由 |
|---|---|---|
| `describe`(散文・既定) | **出さない** | `test/fixtures/describe.golden.txt` がバイト固定。散文に id を混ぜると golden 更新が必要になり、id 無しプロジェクトの散文も変わってしまう(=バイト等価を割る)。**却下** |
| `describe --json`(完全射影) | **出す(条件付き)** | 射影は既に「元ファイルに在るフィールドだけ載せる」規則C(`describe.ts` §論点2 の実装)。`id` が在れば載せ、無ければ載せない=id 無し fixture では射影も**バイト不変**。AI の id 発見はここを読む(機械可読) |

`describeJson` の各 `*Entry` は既に `...(x !== undefined ? { x } : {})` パターンなので、
`...(s.id !== undefined ? { id: s.id } : {})` を各要素に足すだけ。id はキー順の**先頭**に置く
(index の次)。**@mention の発見手段は `describe --json`**(散文には出ない)と usage に明記する。

---

### 論点5:validate の追加検査 → **決定: すべて警告(エラーは1つも増やさない)。id 無しプロジェクトでは新たな警告も出さない**

id は**レンダーに一切影響しない**(アドレッシング専用)。既存の検査方針
「エラー=レンダーが壊れる / 警告=動くが意図と違う」に照らすと、id の不備は
どれも render を壊さない=**すべて警告**が正しい。これはバイト等価にも効く
(新たな error を増やさない=exit code・エラー件数が不変)。

追加する警告(すべて `warn`、id 有効なプロジェクトでのみ):

1. **重複 id**: 収録内で同じ id が2箇所以上 → 警告。`collectIds` を作る過程で検出
   (最初に見た所在を残し、2件目以降を「`@id` が重複(既出: <file> <path>)」と警告)。
2. **形式不正**: `^[a-z]{2,3}_[0-9a-z]{6}$` に合わない id → 警告(解決が壊れうる)。
3. **接頭辞ミスマッチ**: 配列の期待接頭辞と違う id(例 cutplan.segments に `cap_…`)→ 警告
   (コピペ由来の取り違え検出。任意=実装余力があれば)。
4. **id 欠落(密度)**: id 有効なのに id を持たない要素があれば、**1本の集約警告**
   「N 個の要素に id がありません(`id-stamp` で採番できます)」。**per-要素では出さない**
   (ノイズ抑制)。**id 無効なプロジェクトでは出さない**(=未使用時完全不変)。

置き場所: `validateDocs`(純関数)内。`collectIds`(mention.ts)を呼んで重複・形式を見る。
既存の各配列ループに寄せず、**末尾に id 専用ブロックを1つ足す**(既存検査に触れず、
diff を局所化=既存の警告/エラー順を1バイトも動かさない)。

> **重要**: id 検査ブロックは、**docs に id が1つも無ければ丸ごと no-op**(何も push しない)。
> これで id 無し fixture に対する `validate` 出力は完全に不変になる(golden/警告件数が動かない)。

---

### 論点6:id の安定性を壊さない編集規約 → **決定: 生成は `carryIds`(span 一致で旧 id を運ぶ)→ `ensureIds`。editor は round-trip 保持。承認 hash は id を含まない(確認済み)**

**前提(確認済み・load-bearing)**: 承認 hash(`src/lib/approval.ts` の
`cutplanApprovalHash` / `shortApprovalHash`)は keep 集合を `[start,end]` タプルに
正規化した値だけを sha256 する。**id も reason もハッシュ対象外**。したがって
**id を stamp しても承認は失効しない**(cut 内容が変わらない限り)。これは「承認スコープは
cut 決定のみ」という既存規約(CLAUDE.md)と完全に整合する。→ 実装時、approval.ts は
**一切変更しない**(id を混ぜない)。

各経路の規約:

- **`plan`(buildCutplan)**: `numberSegments` は detect の `keepSegments` から作る=毎回同じ
  span が出る(無音検出は決定的)。id 有効なら、**既存 cutplan.json を読み**、新 `PlanSegment[]`
  の各要素に、旧セグメントで `(start,end)` が一致するものの id を `carryIds` で運び、残りを
  `ensureIds` で採番。span が変われば新 id で可(要件どおり)。id 無効なら従来どおり id 無し。
- **`plan` / `remeta`(writeChaptersAndMeta / writeChapterTelops)**: chapters は title 一致で
  `carryIds`。章トラックのテロップ(transcript に書く `cap`)は、既存の章テロップから
  title 一致で id を運ぶ。**非章トラックのテロップは `...transcript.segments.filter(...)` で
  スプレッドされるため id はそのまま生き残る**(既存挙動)。
- **`transcribe`**: 全 transcript を whisper から作り直す。id 有効時は、既存 transcript.json が
  あれば `(start,end,text)` 完全一致で id を運び、残りを採番(冪等な再 transcribe では id 維持)。
  一致しない再分割は新 id(再文字起こしは内容の作り直しなので許容)。id 無効時は id 無し。
- **`plan-shorts`**: shorts は name が id。`ranges`/`captionTracks` は id 有効時に採番。
- **editor 保存(`saveProject`)**: **常に既存 id を保持**(クライアントが round-trip)。
  id 有効なプロジェクトなら、書き込む docs に `ensureIds` を通して**GUI 生成の新要素にも採番**。
  id 無効なら pass-through(=従来どおり id 無し保存でバイト等価)。
  - **分割(⌘K)規約**: keep/テロップを2つに割ったら、**左(先行)側が元 id を保持**し、右側は
    新規要素(`ensureIds` が採番)。approval を失効させない「境界維持の分割」と同じ精神。
  - **クライアント側の必須要件**: `editor/client/model.ts` のパース→編集→シリアライズで
    **`id` を落とさない**こと。配列要素を新オブジェクトに詰め直す箇所があれば `id` を
    明示的に運ぶ(spread で温存 or 明示コピー)。これがこの機能の editor 側最大の落とし穴。

---

## スキーマ案(`src/types.ts`)

各 interface に**先頭フィールド**として `id?` を足す(コメント文案込み)。既存フィールドの
順序・型は不変。**`id?` は任意**なので、省略された JSON は現状と1バイトも変わらない。

```ts
/** 編集をまたいで安定な永続 id(例 "seg_a1b2c3")。`@id` で人間/AI がこの要素を
 * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
 * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
 * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
 * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
 * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
id?: string;
```

足す先(接頭辞は §論点1 の表):

- `PlanSegment`(`seg`)
- `TranscriptSegment`(`cap`)
- `Overlays.overlays[]` の要素(`mat`)/ `Overlays.inserts[]`(`ins`)
- `Zoom`(`zm`)/ `BlurRegion`(`bl`)
- `Overlays.wipeFull[]` は `Interval` を使っている。**専用の型に昇格**するか、`Interval` に
  `id?` を足すかは実装判断。`Interval` は多用途(承認・timeline)なので、**`wipeFull` /
  `hideCaption` は `Interval & { id?: string }` のインライン型**にして `Interval` 自体は
  汚さない(承認・timeline の `Interval` に id が漏れない)。
- `CaptionTrackDef`(`ct`)
- `Chapters.chapters[]` の要素(`ch`)
- `Bgm.tracks[]` の要素(`bg`)
- `Short.ranges[]`: `Interval & { id?: string }`(`rg`)。`Short` 自体は `name` が id=足さない。
- `ThumbnailText`(`tx`)

**規約どおり**、`src/types.ts` のコメント・`src/stages/validate.ts`・`docs/usage.md` の
「どのファイルが何を決めるか」表を揃えて更新する(スキーマ変更3点セット)。

---

## `src/lib/ids.ts`(新規・純ロジック)

```ts
/** 種別 → 接頭辞の単一の出所。types.ts のコメントと validate の期待接頭辞が参照 */
export const ID_PREFIX = {
  cutSegment: "seg", caption: "cap", material: "mat", insert: "ins",
  zoom: "zm", blur: "bl", wipeFull: "wf", hideCaption: "hc",
  captionTrack: "ct", chapter: "ch", bgmTrack: "bg", range: "rg", thumbnailText: "tx",
} as const;

export const ID_RE = /^[a-z]{2,3}_[0-9a-z]{6}$/;

/** 新規 id を1つ作る(既存集合と衝突したら振り直す)。乱数は crypto でなく
 * Math.random で十分(衝突は used で回避、暗号強度は不要) */
export function newId(prefix: string, used: Set<string>): string;

/** 配列の各要素に、id が無いものだけ採番(既存 id は不変)。used は
 * 収録全体の id 集合(ファイル間の衝突も防ぐ)。破壊的でなく新配列を返す純関数 */
export function ensureIds<T extends { id?: string }>(arr: T[], prefix: string, used: Set<string>): T[];

/** 生成ステージ用: 旧配列の id を、keyFn が一致する新要素へ運ぶ(採番はしない)。
 * plan は keyFn=(x)=>`${start}:${end}`、chapters は title、transcribe は start:end:text */
export function carryIds<T extends { id?: string }>(oldArr: T[], newArr: T[], keyFn: (x: T) => string): T[];

/** docs 全体を stamp(id-stamp コマンド・生成・保存が共有)。id が1つでもあれば
 * それを used に含め、全「指せる配列」へ ensureIds を適用した新 docs を返す純関数 */
export function stampDocs(docs: EditableDocs): EditableDocs;

/** docs のいずれかの指せる要素が id を持つか(opt-in gate) */
export function hasAnyId(docs: EditableDocs): boolean;
```

- すべて**純関数**(fs 非依存)。CLI/editor/生成ステージから呼ぶ薄いラッパだけが fs を触る。
- `stampDocs` は「id 有効化の1関数」。`id-stamp` はこれを呼んで**変わったファイルだけ**書く。

---

## スコープ境界(Feature 4 との線引き)

| 今回(安定 ID) | Feature 4(検査付きアトミック適用) |
|---|---|
| id を**付ける**(types/ids/stamp/生成/保存) | id を宛先に**編集を書き戻す**(パッチ適用) |
| `@id` を**解決する**純関数(`resolveMention`) | `resolveMention` を**使って**「@id の text をこう」を適用する CLI/MCP |
| id の**検査**(validate 警告) | パッチ適用後に validate ゲート(GUI `/api/save` 相当を CLI/MCP へ) |
| `describe --json` に id 露出(発見手段) | id 指定 diff・accept/reject の GUI |

**今回は `resolveMention` を作るが、それを消費して編集を変える経路は作らない。**
唯一の実消費者は `validate`(重複検査)と `describe --json`(露出)。パッチ本体は別機能。

---

## タスク分解(1タスク=1コミット)

先行機能マージで行番号はずれるため、**シンボル名で特定**する。各タスクは
`npx tsc --noEmit` と `npm test` が緑を必須とする。

### タスク1: 型に `id?` を足す(`src/types.ts`)

- 触る: `PlanSegment` / `TranscriptSegment` / `Overlays`(`overlays`/`inserts`/`wipeFull`/
  `hideCaption` の要素)/ `Zoom` / `BlurRegion` / `CaptionTrackDef` / `Chapters.chapters` 要素 /
  `Bgm.tracks` 要素 / `ThumbnailText` / `Short.ranges` 要素。`Interval` 本体は**汚さない**
  (wipeFull/hideCaption/ranges はインライン `Interval & { id?: string }`)。
- コメント: §スキーマ案の文案を先頭 id フィールドに付す。
- テスト方針: 型だけなので専用テスト不要。`tsc --noEmit` が通ること。
- 壊してはいけない: 既存フィールドの順序・型・コメント。`id?` は任意=既存の
  `types.test.ts`(captionStyleOf 等)は無改変で緑。

### タスク2: `src/lib/ids.ts` + `test/ids.test.ts`(純ロジック)

- 触る: 新規 `src/lib/ids.ts`(`ID_PREFIX` / `ID_RE` / `newId` / `ensureIds` / `carryIds` /
  `stampDocs` / `hasAnyId`)。
- テスト方針(`node:test`、`plan.test.ts` / `types.test.ts` の書き方を踏襲):
  - `ensureIds`: 既存 id は不変・欠落だけ採番・返り値の id は `ID_RE` に一致・`used` に
    既存 id を渡すと衝突しない。
  - `carryIds`: key 一致で旧 id を運ぶ・不一致は id 無しのまま(採番しない)。
  - `stampDocs`: 冪等(2回通して deepEqual)・ファイル間で id 一意・空 docs で no-op。
  - `hasAnyId`: 全 id 無しで false、1つでも有れば true。
- 壊してはいけない: 純関数=副作用ゼロ(入力 docs を破壊せず新オブジェクトを返す)。

### タスク3: `src/lib/mention.ts` + `test/mention.test.ts`

- 触る: 新規 `src/lib/mention.ts`(`collectIds` / `resolveMention` / `MentionTarget`)。
  `LoadedDocs`(validate の型)を入力に取る。
- テスト方針: id 索引が全ファイルを網羅・`@cap_…` と `cap_…` の両方を解決・short は
  name で解決・重複 id は最初の所在を返し検出できる形にする・未知 id は null。
- 壊してはいけない: fs 非依存の純関数(validate/describe から呼べる)。

### タスク4: `validate` に id 検査(`src/stages/validate.ts` + `test/validate.test.ts`)

- 触る: `validateDocs` の**末尾**に id 専用ブロックを1つ追加(`collectIds` を利用)。
  重複・形式・(任意で接頭辞ミスマッチ)・欠落集約を**すべて `warn`**。
  **docs に id が1つも無ければブロック全体を no-op**。
- テスト方針: (a) id 無し docs → 警告・エラー件数が従来と**完全一致**(既存 validate.test の
  想定を1件も動かさない)。(b) 重複 id → 警告1件。(c) 不正形式 → 警告。(d) id 有効かつ
  一部欠落 → 集約警告1件。(e) すべて正しい id → 追加警告ゼロ。
- 壊してはいけない: **既存の error/warning の順序・件数・文面が id 無しで不変**。
  新規は必ず末尾・warn のみ。error は1つも増やさない。

### タスク5: `id-stamp` コマンド(`src/cli.ts` + `test/idStamp.test.ts`)

- 触る: `src/cli.ts` に `program.command("id-stamp <dir>")` を追加(`describe`/`validate`
  コマンドの配線を踏襲)。読み込み→`stampDocs`→`validate`→**変わったファイルだけ書く**
  薄いラッパ(fs)。冪等。
- テスト方針: 一時ディレクトリに id 無し JSON を置き、`id-stamp` 相当のラッパ関数を呼んで
  (1)全要素に `ID_RE` id が付く (2)2回目は無変更(mtime/内容不変)(3)既存 id は保持。
  ラッパは fs を触るので、`ingest.test.ts` 等の tmpdir パターンを踏襲。
- 壊してはいけない: 書くのは**変わったファイルだけ**(全ファイル touch しない)。
  approvals.json は触らない。

### タスク6: 生成ステージの採番配線(`src/stages/plan.ts` / `transcribe.ts` / `planShorts.ts`)

- 触る:
  - `plan.ts`: `buildCutplan` の後段で、id 有効時に既存 cutplan を読んで `carryIds`(span)→
    `ensureIds`。`writeChaptersAndMeta`/`writeChapterTelops` で chapters(title)・章テロップの
    id 引き継ぎ。**id 無効時は従来どおり**(分岐は `hasAnyId`/`isIdEnabled`)。
  - `transcribe.ts`: id 有効時のみ、既存 transcript を `(start,end,text)` で `carryIds`→
    `ensureIds`。
  - `planShorts.ts`: id 有効時に ranges/captionTracks を `ensureIds`(name はそのまま)。
- テスト方針: `plan.test.ts` 系の純関数テストに寄せる。`buildCutplan` を id 引き継ぎ対応の
  形にできるなら、旧 id 配列 + 新 span で id が運ばれること/span 変化で新採番を単体テスト。
  transcribe は `buildWords` と同様、id 付与部分を純関数に切り出してテスト。
- 壊してはいけない: **id 無効プロジェクトでは plan/transcribe/plan-shorts の出力が
  導入前とバイト等価**(既存 `plan.test.ts` / `transcribe.test.ts` を、id 無し入力に対して
  無改変で緑に保つ)。承認 hash に触れない(approval.ts 不変)。

### タスク7: editor 保存の id 保持・採番(`editor/server.ts` + `editor/client/model.ts`)

- 触る:
  - `editor/client/model.ts`(および必要なら `App.tsx`/`Inspector.tsx` の配列書き戻し):
    パース→編集→保存 payload 構築で **`id` を落とさない**。分割は左が id 保持・右は新規。
  - `editor/server.ts` `saveProject`: 書き込む docs に、id 有効時のみ `stampDocs` 相当を通して
    GUI 生成の新要素へ採番(既存 id は `ensureIds` が保つ)。id 無効時は pass-through。
    **`selfWroteAt` の自己イベント除外**は従来どおり(id 付与で書いても外部変更通知を誤発火
    しない)。
- テスト方針: editor はブラウザ実測が必要な部分が多いので、**サーバ側の純ロジック**
  (saveProject が呼ぶ stamp 判定)を切り出してユニット化。client の round-trip は
  `model.ts` にパース/シリアライズの純関数があればそこを固定(id 温存の1ケース)。
  実 UI(分割・新規テロップ作成で id が付く/保持される)は人間の GUI 実測に委ねる旨を明記。
- 壊してはいけない: id 無効プロジェクトを GUI 保存しても id が湧かない(バイト等価)。
  保存前 `validate` ゲート・承認レコード mint(`writeCutplanApproval`)は不変。

### タスク8: `describe --json` に id 露出 + `docs/usage.md`(+ `test/describeJson.test.ts`)

- 触る: `src/stages/describe.ts` `buildProjection` の各 `*Entry` 構築に
  `...(x.id !== undefined ? { id: x.id } : {})` を index の次に足す。散文 `describe` は**不変**。
  `docs/usage.md` の「どのファイルが何を決めるか」表に id 列/`@id` の説明・`id-stamp`
  コマンド・「@mention の発見は `describe --json`」を追記。
- テスト方針: `describeJson.test.ts` に (a) id 無し fixture → 射影に `id` キーが**現れない**
  (=既存アサーション不変)(b) id 付き要素 → 射影に `id` が載る、を追加。
  `describe.test.ts`(散文 golden)は**無改変で緑**。
- 壊してはいけない: **散文 golden(`test/fixtures/describe.golden.txt`)が1バイトも動かない**。
  id 無し射影がバイト不変(規則C)。

### タスク9(任意・最後): `run` 末尾で `id-stamp`(`src/cli.ts` の `run` action)

- 触る: `run` の最後で stamp を1回呼び、新規収録を初回から id 有効にする。
- テスト方針: run は重い統合なので、stamp 呼び出しが末尾に入ること(順序)を配線レベルで確認。
- 壊してはいけない: `run` の既存段(ingest→…→plan)の順序・生成物。`--force`/backups の挙動。

---

## 不変条件(実装で必ず守る)

1. **未使用時バイト等価(最重要)**: 収録フォルダのどの編集ファイルにも `id` が1つも
   無ければ、**全コマンド**(`validate` / `describe`(散文・--json) / `plan` / `transcribe` /
   `plan-shorts` / `render` / `preview` / `frames` / editor 保存)の出力・書き込みバイトが
   本機能導入前と**完全一致**。テストは「id 無し fixture を全経路に通して現行と一致」で固定。
2. **describe 散文 golden 不変**: `test/fixtures/describe.golden.txt` は1バイトも動かさない
   (id は散文に出さない)。
3. **validate の既存エラー/警告不変**: id 検査は末尾・warn のみ・id 無しで no-op。
   既存の error/warning の順序・件数・文面が動かない。error は1つも増やさない。
4. **承認 hash に id が混ざらない**: `approval.ts` は無改変。id を stamp しても
   cutplan/short の承認は失効しない(hash は `[start,end]` のみ)。
5. **id は一度振ったら不変**: 採番は `ensureIds`(欠落のみ)/ 生成は `carryIds`→`ensureIds`。
   再生成・保存で既存 id が変わらない・落ちない。
6. **id はレンダーに無影響**: `renderProps` / remotion / timeline は id を読まない。
7. **`approvals.json` を触らない**: `id-stamp` / stamp 経路は承認レコードを書かない。

---

## 検証(実装後に人間/実測で確認)

- 中立 cwd + tmpdir で `id-stamp` → `validate`(警告ゼロ)→ `describe --json`(全要素に id)→
  もう一度 `id-stamp`(無変更)を通し、冪等と密度を実測。
- id 無し fixture で `describe`(散文)・`validate` の出力を導入前と `diff`(バイト一致)。
- GUI: 新規テロップ作成・⌘K 分割で id が付与/左に保持されること、外部で id 付き JSON を
  書き換えても保存で id が落ちないことを実機で確認(editor はバンドル再起動が必要=MEMORY)。
- `plan --cuts-only` 再実行(--force)で、span 不変の keep セグメントの `seg_…` が維持されること。
