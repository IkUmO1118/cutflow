# 検査付きアトミック適用を CLI/AI へ露出 — 設計

*2026-07-07 / 診断レビュー「B. AI の行動インターフェース」項目の設計。実装は別担当(Sonnet)。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> 「**検査付きアトミック適用が AI から使えない** — GUI の `/api/save` は
> 既に validate 前置の全拒否を実装済み。同じ経路を CLI/MCP へ露出するだけ」
> = effort **M**。安定 ID / @-mention 設計(`2026-07-07-stable-ids-design.md`)が
> 名指ししていた **Feature 4** の本体。

---

## 背景とギャップ

現状、AI/CLI が編集を当てる手段は **ファイルツールでの生 JSON 手書き**しか無い:

- AI は `cutplan.json` 等を Write/Edit で丸ごと書き換える。書いた後に
  `validate` を走らせて「祈る」だけで、書き込み自体は**検査前に確定**している。
  壊れた JSON・不変条件違反(keep の重なり・収録尺超え・overlays の file 欠落等)を
  書いても、その瞬間には止まらない。preview / render で数分かけて気づくか、
  次に validate を回すまで壊れたまま残る。
- 複数ファイルにまたがる1つの編集(cutplan と transcript を同時に整合させる等)を
  当てるとき、片方だけ書けて片方が失敗すれば**中途半端な不整合状態**が残る。
  「全部通ったら全部書く / 1つでもダメなら何も書かない」という全か無かの保証が無い。
- Feature 2(安定 ID・@-mention)が直前に完了し、`@cap_7x2f` の形で
  「どのファイルのどの要素か」を編集をまたいで安定に指せる基盤(`src/lib/mention.ts`)が
  既にある。しかし**それを使って編集を書き戻す経路が無い**(mention.ts の冒頭コメントに
  「編集を書き戻す経路(Feature 4)は今回のスコープ外」と明記されている)。

一方で GUI にはこの「検査付きアトミック適用」が**既に実装済み**:
`editor/server.ts` の `saveProject`(§727)は、ディスクの現状に body の変更を
重ねた doc 集合を `validateDocs` に通し、**errors があれば全拒否(HttpError 400・
1バイトも書かない)、無ければ id 採番して書き込む**。診断が言う「同じ経路を
CLI へ露出するだけ」とはこれのこと。

**ゴール**: AI/CLI が編集を **「validate に通ったら全適用、1つでもエラーなら
何も書かない」全か無か**で当てられる `apply` コマンドを CLI に露出する。
Feature 2 の `@id` を宛先に使う**高水準オペレーション列**を第一級の入力とし、
AI が配列添字を書かず・生 JSON を組み立てず・不変条件を事後 validate に祈らずに
編集を当てられるようにする。**未使用時(apply を呼ばない既存フロー)は
`saveProject` / `validate` / 承認 hash が完全にバイト等価**で動く。

---

## スコープ

**やること(今回)**

- `@id` 指定の**高水準オペレーション列**(`set` / `remove` / `add`)の
  スキーマ定義(`src/types.ts`)と、それを `saveProject` body 形へ**コンパイルする
  純関数**(`src/lib/applyEdits.ts`)。宛先解決は Feature 2 の
  `collectIds` / `resolveMention` を再利用。
- **ファイル単位の全置換パッチ**(saveProject body と同型)も低レベル入力として受ける。
  op 列はこの全置換パッチへコンパイルされてから同じコアを通る(単一の書き込み経路)。
- **検査付きアトミック適用のコア純関数** `planApply`(読むだけ・検査だけ・書かない)/
  `applyEdits`(検査 → 全書き込み or ゼロ書き込み)を `src/lib/applyEdits.ts` に切り出す。
- `saveProject` の「ディスク現状 + body の変更を LoadedDocs へ重ねる」写像を
  **共通ヘルパへ抽出**し、CLI apply と GUI 保存が同じ merge+validate を通す(DRY)。
  **saveProject の観測可能挙動は1バイトも変えない**(承認 mint/clear・selfWroteAt・
  id 採番・bgm/shorts 削除セマンティクスは GUI 固有として残す)。
- **`apply <dir>` コマンド**: `--patch <file>` / stdin からパッチを受け、`--dry-run` で
  適用結果の要約・差分を出す(書かない)。出力・exit code は `validate` と揃える。
- `validate` と同形式(`file` / `where` / `message`)のエラー返却と、AI が読んで
  自己修正できるメッセージ。宛先未解決・op 不正・不変条件違反すべてを**書き込み前**に返す。
- ドキュメント整合(`docs/usage.md` の表・`CLAUDE.md` のコマンド節・`types.ts` コメント)。

**やらないこと(スコープ外)**

- **MCP サーバ本体**。今回は CLI 露出まで。`applyEdits(dir, patch)` を
  純粋な in→out シグネチャに保ち、将来 MCP tool から呼べる **seam** だけ残す
  (§論点7)。process.exit / console はすべて CLI ラッパ側に置く。
- **GUI 差分レビュー UI**(別機能)。id はその土台を提供するだけ。
- **承認・approved の書き換え**。apply は `approvals.json` を一切書かず、
  `approved` フィールドも変更できない(§論点6・§不変条件)。承認は `approve` /
  `unapprove` コマンドと GUI 保存の専権のまま。
- **区間 split / move / 複数要素の一括変形**などの複合 op。M に収めるため
  op は `set` / `remove` / `add` の3種に絞る(split は「`add` + 2つの `set`」か
  全置換パッチで表現でき、専用 op は作らない。§論点1)。
- **id 未採番プロジェクトへの新規採番の変更**。apply は既存の id 採番経路
  (`stampSaveBody` 相当)をそのまま通すだけで、opt-in/sticky の規約を変えない。

---

## 論点と決定

### 論点1: apply の入力形式

**選択肢**

- (A) `@id` 指定の高水準オペレーション列
  (`[{op:"set", target:"@cap_7x2f", field:"text", value:"…"}, …]`)。
- (B) ファイル単位の全置換(`{cutplan:{…}, transcript:{…}}` = saveProject body そのもの)。
- (C) 両対応。

**決定: (C) 両対応。ただし単一の書き込み経路に集約する。**
op 列(A)は**全置換パッチ(B)へコンパイルしてから**コアに入れる。
すなわち書き込みは常に「全置換パッチ 1本」に正規化され、アトミック性・検査・
書き込みは1箇所でしか起きない。op 列は AI 向けの安全・発見可能な**入力糖衣**、
全置換は low-level の脱出ハッチ、という役割分担。

- **なぜ op 列を第一級にするか**: 診断のテーマ B は「AI の行動インターフェース」。
  配列添字(`segments[3]`)は編集で簡単にずれ、生 JSON の丸ごと組み立ては
  AI が既存要素を取りこぼす/id を落とす事故の温床。`@id` op なら AI は
  「`@seg_a1b2` を cut に」「`@cap_7x2f` の text をこう」だけ書けばよく、
  Feature 2 の `resolveMention` が宛先を厳密に解決する。**位置添字を一切
  書かせない**のが安全性の核。
- **なぜ全置換も残すか**: split・要素の並べ替え・新規ファイル丸ごと生成など、
  op 3種で表せない編集の脱出ハッチ。saveProject と同型なので追加コストゼロ。
  GUI との DRY(同じ merge+validate)もこの形で担保される。

**最小で価値を出す op セット(3種に固定)**

| op | target | 追加フィールド | 意味 |
|---|---|---|---|
| `set` | `@id`(既存要素) | `field`(ドット区切りパス可)/ `value` | 指した要素の1フィールドを設定。text・reason・action(keep/cut)・start/end・pos・style.* 等をこれ1つで賄う |
| `remove` | `@id`(既存要素) | — | 指した要素を所属配列から削除 |
| `add` | コレクション選択子(`cutplan.segments` 等) | `value`(新要素オブジェクト) / `at?`(挿入位置。省略時は末尾) | コレクションへ新要素を追加。id は既存の採番経路が自動で振る |

- `cut` / `keep` は独立 op にせず `{op:"set", target:"@seg_x", field:"action", value:"cut"}` で表す
  (op を増やさない=スキーマ・テスト・ドキュメントの表面積を抑える M 規律)。
- `split` は「`add` で新 segment を足し、既存と新規の `start`/`end` を `set` で調整」か
  全置換パッチで表現。**専用 op は今回作らない**(§スコープ外に明記済み)。
- `set` の `field` はドット区切りのパス(`style.fontSizePx`・`pos.x`)を許す。
  ネストは**既存オブジェクトへの浅いマージ**ではなく**パス末端の置換**にする
  (曖昧さを消す。中間が無ければエラー=作らない)。配列添字パス(`words[0]`)は
  M ではサポート外(エラー)。
- `add` の target は `@id` ではなく**コレクション選択子**(新規要素にはまだ id が無いため)。
  許可する選択子は `applyEdits.ts` の allow-list(`cutplan.segments` / `transcript.segments` /
  `overlays.overlays` / `overlays.inserts` / `overlays.zooms` / `overlays.blurs` /
  `overlays.wipeFull` / `overlays.hideCaption` / `overlays.captionTracks` /
  `chapters.chapters` / `bgm.tracks` / `thumbnail.texts`)で門番。**shorts[] 自体の
  add と shorts 配下(ranges/captionTracks)は M では対象外**(short は name が
  事実上の id・approved 絡みで注意が要るため、全置換パッチに委ねる)。

op はファイル横断で任意本数を1パッチにまとめられ、**全 op を適用した後の
最終状態を1度だけ検査**する(op ごとの中間状態は検査しない=中間が一時的に
不整合でも最終が valid なら通す)。

---

### 論点2: アトミック性の実装

**要件**: 複数ファイルにまたがる適用を「全 validate → 全書き込み(or 何も書かない)」で保証。
書き込み途中失敗でも収録フォルダを壊さない。

**決定: 二相 + backup 前置 + temp/rename 書き込み。**

1. **相1(検査・書かない)** = `planApply`:
   ディスクの編集ファイルを読み、op 列を全置換パッチへコンパイルし、
   ディスク現状へ重ねた `LoadedDocs` を作り、`validateDocs` を通す。
   errors があれば**ここで返す。ファイルシステムには一切触れていない**。
2. **相2(書き込み)** = `applyEdits`:
   相1で errors ゼロのときだけ実行。
   - まず `backupEditableFiles(dir)` で上書き対象の現状を `backups/<日時>/` へ退避
     (`plan`/`run` の再実行と同じ復元手段)。
   - 変更のある編集ファイルだけを **`<file>.tmp` へ書いて `renameSync` で確定**する
     (同一 FS 上の rename はアトミック=**torn write(途中まで書けた壊れ JSON)を排除**)。

- **なぜ temp+rename か**: `saveProject` は現状 validate 後に順次 `writeFileSync`
  しており、単一ファイル内の途中失敗(torn write)の理論的リスクがある。CLI apply は
  同じ轍を踏まず、ファイル単位のアトミック確定を入れる(コストは小さく効果は明確)。
- **なぜ backup も前置するか**: rename はファイル内はアトミックだが、
  **複数ファイルのバッチ**(cutplan と transcript の2本)を書く途中で
  2本目の rename が例外を投げれば「1本目は新・2本目は旧」の**セット不整合**が残りうる。
  相1で全体を検査済みなので各ファイルは個別には valid だが、セットとしては
  意図せぬ組み合わせになる。backup 前置で**確実な復元点**を残す(戻し方は
  退避先を収録フォルダ直下へコピーし直すだけ=既存 backups の運用と同じ)。
- **`saveProject` は触らない**: GUI の既存書き込み(順次 writeFileSync + selfWroteAt +
  承認 mint)はそのまま。apply の temp/rename・backup 前置は **CLI apply 専用**。
  共通化するのは相1(merge+validate)だけ(§論点3)。

---

### 論点3: 共通コアの切り出し(DRY)

**決定: 「body をディスク現状へ重ねて `LoadedDocs` を作る」写像だけを共通ヘルパへ抽出する。
書き込み・承認・id 採番は各呼び出し側に残す。**

`saveProject`(§735–745)の中でインラインになっている次のロジック——
「`readDisk` で各ファイルの現状を読み、body に含まれるキーだけで上書きした
`LoadedDocs` を作る(`bgm`/`shorts` は `!== undefined` で null=削除を区別)」——を
`src/lib/applyEdits.ts` の純関数へ移す:

```ts
// body(SaveRequest 相当)をディスクの現状へ重ねた LoadedDocs を作る純関数。
// dir は各ファイルの現状読み込みにだけ使う。validateDocs の入力形を作るのが役目。
// CLI apply と editor /api/save が共有する唯一の merge。
export function mergeBodyOverDisk(dir: string, body: ApplyBody): LoadedDocs;
```

- `saveProject` の §735–745 は `const docs = mergeBodyOverDisk(dir, body);
  const { errors } = validateDocs(dir, docs);` に**置き換えるだけ**。
  読み込み順・`??` と `!== undefined` の使い分け・キー集合を**完全に保つ**
  =観測可能挙動バイト等価(§不変条件・§論点3 のテストで固定)。
- **共有しないもの**(GUI 固有として saveProject に残す): `stampSaveBody` による
  id 採番、`selfWroteAt` 記録、`writeCutplanApproval`/`clearCutplanApproval`/
  `writeShortApproval`/`clearShortApproval` の承認 mint/clear、bgm/shorts の
  削除(`rmSync`)セマンティクス。これらは**人間権威側の GUI にだけ許される行為**で、
  非対話の CLI apply には持たせない(§論点6)。

コア純関数のシグネチャ案:

```ts
// src/lib/applyEdits.ts

/** apply の入力パッチ。op 列(高水準)と全置換(low-level)の両方を表す。
 * どちらか一方、または両方(op を先に適用してから ops 外のファイル全置換を重ねる)。*/
export interface ApplyPatch {
  ops?: EditOp[];
  replace?: ApplyBody;   // SaveRequest から approved 系を除いた全置換(§論点6)
}

/** 相1: 読むだけ・検査だけ・書かない。FS へは read しかしない。*/
export function planApply(dir: string, patch: ApplyPatch): ApplyPlan;

export interface ApplyPlan {
  /** 検査を通した(まだ書いていない)最終 body。op はここでコンパイル済み。*/
  body: ApplyBody;
  /** 実際に変わる編集ファイル(相対名)。空なら no-op。*/
  changedFiles: string[];
  /** @id 単位の変更要約(--dry-run 表示・MCP 向け)。field: X→Y の列。*/
  diff: ApplyDiffEntry[];
  errors: Problem[];     // validate と同じ型。宛先未解決・op 不正・不変条件違反を含む
  warnings: Problem[];
}

/** 相2: planApply を呼び、errors があれば書かず返す。無ければ backup→temp/rename で
 * 全書き込み。approvals.json は書かない。process.exit も console も使わない(MCP seam)。*/
export function applyEdits(dir: string, patch: ApplyPatch): ApplyResult;

export interface ApplyResult {
  written: string[];     // 実際に書いたファイル(相対名)。errors 時は空
  backupDir: string | null;
  plan: ApplyPlan;       // errors・diff・warnings をそのまま持つ
}
```

op → body コンパイルは同ファイル内の純関数 `compileOps(docs, ops)` に分ける
(`collectIds`/`resolveMention` で宛先解決 → 解決先の配列要素を不変更新 →
`add` は allow-list 選択子の配列へ append → 解決失敗・op 不正・approved 触りは
`Problem[]` として返す)。`compileOps` が **Feature 2 のアドレッシング基盤の
唯一の消費者**になる。

---

### 論点4: CLI コマンド設計

**決定: `apply <dir>` / 入力は `--patch <file>` か stdin / `--dry-run` を入れる。**

```
node src/cli.ts apply <dir> --patch edit.json     # ファイルからパッチを読む
node src/cli.ts apply <dir> < edit.json           # stdin から(--patch 省略時)
node src/cli.ts apply <dir> --patch edit.json --dry-run   # 検査・要約だけ。書かない
```

- **入力経路**: `--patch <file>` があればそのファイル、無ければ stdin を読む
  (`process.stdin.isTTY` が true=パイプもファイルも無い場合は「入力がありません」と
  明示エラー)。パッチは `ApplyPatch` の JSON。
- **`--dry-run`**: `planApply` だけを呼び、**1バイトも書かず**に
  `changedFiles` と `@id` 単位の `diff`(`@cap_7x2f transcript.json: text "旧"→"新"`)、
  および validate 結果(errors/warnings)を出す。AI が「当てる前に何が変わるか」を
  Feature 2 の id 付きで確認できる。exit code は検査結果に従う(errors あれば 1)。
- **出力(成功時)**: 書いたファイル・変更要素数・backup 退避先を1行ずつ。
  `validate` の成功表示と同じトーン(`✔ 適用しました: cutplan.json, transcript.json
  (3要素変更)/ 退避: backups/…`)。
- **出力(エラー時)**: `validate` と同形式で `✖ <file> <where>: <message>` を列挙し、
  **何も書かずに** `process.exit(1)`。dry-run でも同じ。
- **exit code**: 成功 0(no-op・dry-run 成功含む)/ 検査・解決・パース・op 不正
  いずれのエラーも 1。
- **非対話ゲートは付けない**: apply は cut の**編集**であり承認ではない。
  承認(`approve`)と違い人間の対話確認を要求しない(AI が日常的に使う編集経路)。
  ただし **approved は変えられない・approvals.json は書かない**ので、AI が
  apply 経由で承認を偽装する道は塞がれている(§論点6)。

---

### 論点5: エラー時の挙動と AI 体験

**決定: 全エラーを書き込み前に `validate` と同じ `Problem`(file/where/message)で返し、
1バイトも書かず exit 1。メッセージは AI が読んで自己修正できる粒度にする。**

- **不変条件違反**(keep 重なり・尺超え・overlays の file 欠落など): `validateDocs` が
  そのまま拾う。apply は validate と**同じ検査**を通すので追加実装不要。
- **宛先未解決**(`@id` が存在しない): `compileOps` が
  `{file:"(patch)", where:"ops[2].target", message:"@cap_9z9z が見つかりません。
  describe --json か id-stamp で現在の id を確認してください"}` を返す。
- **op 不正**(未知の op・`add` の選択子が allow-list 外・`set` の field パスの
  中間が存在しない・配列添字パス): 同様に `(patch)` ファイル・`ops[i].*` where で返す。
- **approved を触る op / replace**: §論点6 のとおり専用エラー
  (「approved は apply では変更できません。承認は `approve <dir>` で」)。
- 複数エラーは**全部集めて**返す(最初の1件で止めない)。AI が1往復で
  全部直せるようにする=`validate` の既存哲学と揃える。

---

### 論点6: 承認・中間生成物の保護

**決定: apply は EDITABLE_FILES だけを対象にし、`approvals.json`・GENERATED_FILES を
書かない・触らない。`approved` フィールドは apply 経由で変更不能。**

- **ファイル門番**: apply が書けるのは `fileRole(rel) === "editable"` のファイルだけ
  (`src/lib/files.ts` の単一の出所)。`replace` に editable 以外のキーが来たら、
  あるいは `add` 選択子が editable 以外を指したらエラー。approvals.json /
  generated は物理的に書き込み対象に入らない。
- **approved を塞ぐ穴**: `set` の target が cutplan/short を指し `field` が
  `approved` のとき、および `replace` の `body.cutplan.approved`/`body.shorts[].approved`が
  **ディスク現状と異なる**ときはエラー。実装上は `ApplyBody` を
  「SaveRequest から approved を型として除いた形」にし、`compileOps`/`planApply` が
  approved の差分を検出したら拒否する。**apply は cutplan.json/shorts.json を書くとき、
  approved は必ずディスク現状の値を保つ**(op で消える心配も無い)。
- **承認 hash は既存挙動のまま自動失効**: apply が keep(cut の内容)を変えれば、
  approvals.json のハッシュが現内容と食い違い、`render` の strict ゲートが自動で
  弾く(既存の正しい挙動)。**apply 側は approvals.json に何もしない**——これで
  「古い承認のまま render される」ことは起きず、かつ apply が勝手に再承認する
  こともない。次の `validate` が「approved:true だがレコード無効」を警告する
  (`checkApprovalFreshness`)ので、AI/人間はそこで気づける。

---

### 論点7: MCP への発展余地

**決定: `applyEdits(dir, patch)` / `planApply(dir, patch)` を純粋な in→out シグネチャに
保ち、MCP tool から素直に呼べる seam だけ残す。MCP 本体は作らない。**

- コア(`src/lib/applyEdits.ts`)は `process.exit`・`console`・`commander` に
  一切依存しない。I/O(stdin 読み・出力整形・exit code)は `src/cli.ts` の
  `apply` アクション側だけが持つ。
- 将来 MCP tool `cutflow.apply` は `applyEdits(dir, patch)` を呼んで
  `ApplyResult`(written / errors / diff)をそのまま構造化レスポンスにできる。
  `--dry-run` 相当は `planApply` を呼ぶだけ。**今回はこの seam を用意するに留め、
  MCP サーバ・tool 登録は一切書かない**(スコープ外)。

---

## パッチ / オペレーションのスキーマ案(`src/types.ts` に追加)

```ts
/** apply の入力パッチ。op 列(高水準・@id 宛先)と全置換(low-level)の
 * 両方を表す。両方あるときは ops を先に適用し、その結果へ replace を重ねる。*/
export interface ApplyPatch {
  ops?: EditOp[];
  replace?: ApplyBody;
}

/** apply が書ける編集ファイルの全置換。SaveRequest と同型だが approved は
 * 型として持たない(apply では承認を変えられない=§論点6)。*/
export interface ApplyBody {
  cutplan?: CutPlan;      // approved は planApply がディスク値へ強制上書き
  transcript?: Transcript;
  overlays?: Overlays;
  chapters?: Chapters;
  bgm?: Bgm | null;
  shorts?: Shorts | null; // 各 short.approved も同様にディスク値へ強制
  thumbnail?: Thumbnail;
}

/** 高水準オペレーション。target は set/remove では @id、add ではコレクション選択子。*/
export type EditOp =
  | { op: "set"; target: string; field: string; value: unknown }
  | { op: "remove"; target: string }
  | { op: "add"; target: string; value: Record<string, unknown>; at?: number };
```

- `set`/`remove` の `target`: `@cap_7x2f` / `cap_7x2f` / `@short:intro` を
  `resolveMention` が解決(既存)。解決先の `MentionTarget`(file/kind/path/index)を
  使って所属配列の要素を不変更新/削除する。
- `add` の `target`: allow-list コレクション選択子の文字列(`"cutplan.segments"` 等)。
- `field`: ドット区切りパス(`"text"` / `"style.fontSizePx"` / `"pos.x"`)。
  末端の置換のみ。中間の欠落・配列添字はエラー。
- `approved` を `field` に指定するのはエラー(§論点6)。

---

## タスク分解(1タスク=1コミット)

### T1: スキーマ型 + op→body コンパイラ(純関数)

- **触るファイル**: `src/types.ts`(`ApplyPatch` / `ApplyBody` / `EditOp` を追加)、
  新規 `src/lib/applyEdits.ts`(`compileOps(docs, ops): {body, errors}` を実装。
  `src/lib/mention.ts` の `collectIds`/`resolveMention` を import して宛先解決。
  `add` 選択子の allow-list をここに定義)。
- **テスト方針**(`test/applyEdits.test.ts`, node:test):
  `set` が @id 解決先の1フィールドだけ変える / `remove` が所属配列から抜く /
  `add` が allow-list 選択子へ append(id 未採番のまま=採番は後段)/
  **未解決 @id が `(patch)` file・`ops[i].target` where のエラーになる** /
  未知 op・allow-list 外選択子・field パス中間欠落がエラー /
  **`set` で `approved` を指すとエラー**。
- **壊してはいけない既存挙動**: mention.ts / ids.ts は import のみ・無改変。

### T2: 共通 merge の抽出 + saveProject リファクタ(バイト等価)

- **触るファイル**: `src/lib/applyEdits.ts`(`mergeBodyOverDisk(dir, body): LoadedDocs`
  を追加)、`editor/server.ts`(`saveProject` §735–745 の readDisk+merge インラインを
  `mergeBodyOverDisk` 呼び出しへ置換。読み込み順・`??`/`!== undefined` の使い分け・
  キー集合を完全に保つ)。
- **テスト方針**: `test/saveProject.test.ts`(既存があれば追随)で
  **同一 body・同一ディスク状態に対し、抽出前後で書き出される JSON が
  バイト等価**であることを固定。少なくとも `mergeBodyOverDisk` の単体テスト
  (bgm/shorts の null=削除 と undefined=不介入 の区別が保たれる)。
- **壊してはいけない既存挙動**: **editor /api/save の観測可能挙動が完全に不変**
  (承認 mint/clear・selfWroteAt・id 採番・bgm/shorts 削除は saveProject に残す)。
  `validateDocs` は無改変。

### T3: アトミック適用コア(planApply / applyEdits)

- **触るファイル**: `src/lib/applyEdits.ts`(`planApply` / `applyEdits` /
  `ApplyPlan`/`ApplyResult` 型 / diff 生成)。`compileOps` → `mergeBodyOverDisk` →
  `validateDocs` の連結。書き込みは `backupEditableFiles`(`src/lib/backup.ts`)前置 +
  `<file>.tmp` → `renameSync`。approved はディスク値へ強制。既存の id 採番経路
  (`stampDocs` 相当)を通す。
- **テスト方針**(`test/applyEdits.test.ts`):
  **エラーを含むパッチで applyEdits を呼ぶと `written` が空・ディスクの全ファイルが
  1バイトも変わらない**(mtime/内容ハッシュで確認)/ 成功時は changedFiles だけが
  書かれ他は不変 / **`replace.cutplan.approved` をディスクと変えても approved は
  ディスク値のまま**(apply で承認を反転できない)/ **applyEdits は approvals.json を
  作らない・変えない** / no-op パッチは backup も書き込みも起こさない。
- **壊してはいけない既存挙動**: **承認 hash のロジック(`src/lib/approval.ts`)は
  無改変**。apply が keep を変えれば hash が自動失効するのは既存挙動に委ねる
  (apply 側は approvals.json に触れない)。

### T4: CLI `apply` コマンド配線

- **触るファイル**: `src/cli.ts`(`program.command("apply <dir>")`。
  `--patch <file>` / stdin 読み / `--dry-run` / 出力整形 / exit code。
  `applyEdits` / `planApply` を呼ぶ薄いラッパ。`validate` コマンドと同じ
  `✖ file where: message` 出力・`process.exit(1)`)。
- **テスト方針**: コアは T1–T3 の純関数テストで固定済み。CLI 層は手動/最小の
  実測(`--dry-run` が**1バイトも書かない**・stdin/`--patch` 両経路・
  エラー時 exit 1・成功時 exit 0)。中立 cwd(`/tmp`)の一時収録フォルダで実行
  (repo 直下は CLAUDE.md 文脈を引くため避ける=MEMORY の
  `llm-command-verify-neutral-cwd` に従うが、apply は LLM を呼ばないので影響は薄い。
  それでも副作用検証はサンプル収録フォルダのコピーで行う)。
- **壊してはいけない既存挙動**: 既存コマンド(validate/describe/id-stamp/approve)の
  配線・出力は無改変。

### T5: ドキュメント整合

- **触るファイル**: `docs/usage.md`(`apply` の節・入力/`--dry-run`/exit code・
  op スキーマ表を追加)、`CLAUDE.md`(コマンド節に `apply` を追記。
  「AI が編集を当てる推奨経路」として `frames`/`validate` ループに組み込む説明。
  **approved は apply で変えられない・承認は approve 専権**を明記)、
  `src/types.ts`(`ApplyPatch`/`EditOp` のコメントは T1 で入れる分の最終確認)。
- **テスト方針**: なし(ドキュメント)。`src/lib/files.ts` の分類との整合
  (apply が書くのは EDITABLE_FILES だけ)を本文で参照。
- **壊してはいけない既存挙動**: なし(文書のみ)。

> 依存順: T1 → T2 → T3 → T4 → T5。T2 は T1 と独立に着手可能だが、
> `applyEdits.ts` を1ファイルに集約するため T1 の後が素直。

---

## 不変条件(実装・レビューで必ず守る)

1. **apply は `approvals.json` を書かない・読んで判定に使わない**。承認の mint/clear は
   `approve`/`unapprove` コマンドと GUI 保存の専権のまま。
2. **apply 経由で `approved` を true(または false)にできない**。cutplan/short の
   `approved` は常にディスク現状の値を保って書き戻される。
3. **エラー時ゼロ書き込み**。宛先未解決・op 不正・不変条件違反・JSON パース失敗の
   いずれでも、収録フォルダのファイルは1バイトも変わらない(backup も作らない)。
4. **editor /api/save(saveProject)の観測可能挙動が完全に不変**。共通化は
   merge+validate だけで、承認・selfWroteAt・id 採番・bgm/shorts 削除は据え置き。
   同一入力に対し抽出前後でバイト等価。
5. **`validateDocs` / 承認 hash(`approval.ts`)/ Feature 2(mention.ts, ids.ts)は
   無改変**。apply はこれらの consumer に徹する。
6. **apply が書けるのは `fileRole === "editable"` のファイルだけ**。GENERATED_FILES /
   approvals.json は書き込み対象に入らない。
7. **apply を呼ばない既存フローはバイト等価**(このコマンド追加で他コマンドの
   出力・書き込みは一切変わらない)。

---

## スコープ境界(明記)

- **やる**: `@id` op(set/remove/add)+ 全置換の CLI `apply`、検査付き全か無か、
  `--dry-run`、共通 merge の抽出、MCP seam(純関数シグネチャ)。
- **やらない**: MCP サーバ/tool 本体、GUI 差分レビュー UI、split/move 等の複合 op、
  shorts[] 自体および ranges/captionTracks への `add`(全置換に委ねる)、
  承認・approved の書き換え、id 採番規約の変更。
