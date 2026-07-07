# GUI に AI 編集の差分レビュー / accept-reject(設計)

*2026-07-07 / 診断レビュー NEXT・Theme「AI 協調レイヤ」・severity blocker・effort XL*

> 対象: 外部プロセス(AI / CLI / `apply` / `plan` 等)が収録フォルダの JSON を
> 書き換えたとき、GUI エディタが **区間 / フィールド単位の差分を見て
> accept / reject** できるようにする。Cursor のインライン diff 承認の動画編集版。
> 現状(全か無か = 「未保存なし→黙って全再読込」/「未保存あり→読み直して自分の
> 編集を破棄 or ⌘S で相手を全上書き」)から、**選べる協調**へ。
>
> 本書は設計のみ。コードは書かない。裏取りしたコードのパスは §9 に列挙する。

---

## 0. 一番効く発見 — 「base はもう手元にある」

実コードを読んで判明した設計上の急所を先に置く。**この事実が全論点の結論を
決める**。

`editor/client/App.tsx` の状態モデルは:

- `proj: ProjectData`(`useState`)= **最後にディスクから読んだ全ドキュメント**。
  `getProject()` の戻り値をそのまま保持し、保存成功時に `setProj({...})` で
  現在編集内容へ更新される(App.tsx §2660)。dirty 判定はすべて
  `JSON.stringify(<live>) !== JSON.stringify(proj.<doc>)`(App.tsx §822–843)。
- `cutplan / overlays / transcript / bgm / shorts`(各 `useState`)= **GUI の現在
  編集内容(mine)**。

つまり **`proj` = base(GUI が最後に読んだディスク版)**、**live state = mine**、
そして外部変更検知時に `getProject()` をもう一度叩けば **theirs(新しい
ディスク版)**。3-way マージに必要な3点(base / mine / theirs)は追加の
バージョン管理を一切足さずに既に揃っている。

- **未保存が無いとき**(大多数): mine == base。すると全 hunk が「theirs だけが
  変えた」に落ち、自動採用 → **現行のサイレント全再読込とバイト等価**になる。
- **未保存があるとき**: mine≠base かつ theirs≠base が同じ宛先で起きた hunk
  だけが真の衝突。レビューはその最小集合だけを出す。

この「非衝突 hunk は自動マージ、衝突 hunk だけ人間に見せる」構造が、
**既存挙動を壊さない**保証の技術的な核になる(§論点1・7)。

---

## 1. 採用する設計判断(各論点の結論)

### 論点1 — 検知トリガと粒度: 既存 SSE をそのまま流用。粒度は「id があれば要素/フィールド、無ければ配列まるごと」

**結論**: 検知は**既存の `watch`+SSE(`/api/events`)を1バイトも変えずに流用**
する。`editor/server.ts` は既に `WATCHED_FILES`(cutplan / overlays / transcript /
shorts.json)を監視し、自己書き込みを `selfWroteAt` で除外し、200ms デバウンスで
`{files}` を SSE 配信している(server.ts §105–115)。クライアントの
`es.onmessage`(App.tsx §463–466)が唯一の分岐点。

粒度は3段の入れ子:

1. **ファイル**(`cutplan` / `overlays` / `transcript` / `bgm` / `shorts`)
2. **トップレベル配列の要素**(`segments[]` / `overlays[]` / `inserts[]` /
   `zooms[]` / `blurs[]` / `annotations[]` / `captionTracks[]` / `bgm.tracks[]` /
   `shorts[]` / `ranges[]`)
3. **要素内のフィールド**(`reason` / `style.color` / `rect.w` 等の JSON パス)

要素の対応付け(base ⇔ mine ⇔ theirs のどれが同じ要素か):

- **安定 id がある配列**(`hasAnyId` が真のプロジェクト): 要素の `id`
  (`src/lib/ids.ts` の `ID_PREFIX` / `ID_RE`)を対応キーにする。`carryIds` が
  round-trip で id を保つのと同じ原理。id が一致する要素同士をフィールド粒度で
  diff、id 集合の差を add / remove とする。
- **id が無い配列**(opt-in 未採用のプロジェクト、または id を持たない配列): その
  配列は **配列まるごと1 hunk**(要素粒度に割らない)。位置(添字)対応は要素の
  挿入・削除で全体がずれて誤差分を生むため、v1 では**採らない**。

> これは正直な設計であり、**安定 id を差分レビューの enabling feature に
> 昇格させる**(診断 NEXT の「安定 ID / @-mention」と同じ土台。id 済み
> プロジェクトほど良い協調体験になる)。id 無しでも「配列まるごと accept/reject」
> は常に成立するので、機能が破綻するプロジェクトは無い。

**却下**: フィールド単位まで常に割る案 → id が無いと要素の同一性が決められず、
「1個消したら以降全部 conflict」の誤検知を生む。却下。

### 論点2 — 3-way(2つの 2-way の合成として)

**結論**: **3-way**。ただし実装は **base を共有する2つの 2-way** として計算する:
「mine が base から何を変えたか」と「theirs が base から何を変えたか」を各宛先で
突き合わせる。

- 同じ宛先で **mine≠base かつ theirs≠base** → **conflict**(レビュー対象)。
- **theirs だけ変えた**(mine==base) → 自動で theirs 採用。
  = 現行サイレントリロードの hunk 単位版。
- **mine だけ変えた**(theirs==base) → 自動で mine 維持。

**却下**: 「現在の GUI 状態 vs 新ディスク版」の単純 2-way diff → base が無いので
「mine が編集した箇所」と「theirs が編集した箇所」を区別できず、mine の未保存編集
すべてが差分として出る(=今のバナーと同じ「全部見せる」に退化)。base=proj が
タダで手に入る以上、3-way を採らない理由が無い。却下。

### 論点3 — UI: 既存 externalChange バナーを入口に、専用レビュー**パネル**

**結論**: 現行の `HeaderBanners` の `externalChange` バナー(App.tsx §3781–3791)を
拡張する。外部変更 **かつ** conflict が1件以上あるとき、バナーに
**「差分をレビュー」**ボタンを足す。既存の「読み込み直す(未保存の編集は破棄)」も
**逃げ道として残す**(挙動不変)。

レビュー本体は **専用パネル**(`DiffReview.tsx`、モーダル風のオーバーレイ)。
インライン(タイムライン内)埋め込みは v2 送り: タイムライン / Inspector は
既に自分の描画領域を持ち、要素粒度の diff 装飾を差し込むと座標系・仮想化・
選択ロジックに広く手が入る。v1 は独立パネルで**既存 UI に触らない**。

パネルの中身(conflict hunk ごと):
- 宛先ラベル(ファイル + 要素ラベル + フィールドパス)
- mine の値 / theirs の値(スカラは並置、オブジェクトは pretty JSON)
- ラジオ: 「自分の版(mine)」/「ディスク版(theirs)」
- 一括: 「全部ディスク版」/「全部自分の版」
- 適用 / キャンセル

適用後は**マージ結果を live state へ入れるだけ**で、確認は既存タイムライン・
プレビューで行い、書き込みは**既存 ⌘S(validate ゲート)**が担う。パネルは
書き込みをしない。

### 論点4 — diff アルゴリズム: 依存ゼロの自前再帰 diff

**結論**: 外部ライブラリを**足さない**。`src/lib/docDiff.ts` に自前の構造 diff を
書く。2層:

- **配列レイヤ**: id 対応(論点1)で base/mine/theirs の要素を突き合わせ、
  add / remove / modify を出す。`carryIds` の keyFn 発想を再利用。
- **フィールドレイヤ**: modify の要素内を再帰比較し、値が違う末端(スカラ or
  配列 or サブオブジェクト)を1 hunk にする。等価判定は
  `JSON.stringify` 一致(既存の dirty 判定・`applyEdits` の diff がすべて
  この基準。整合させる)。

配列の**並べ替え**は v1 では add+remove として扱う(LCS / move 検出は v2)。
`bgm.json` は時系列でなくてよく重ねてよい配列なので、なおさら id 対応が効く。

**却下**: `jsondiffpatch` 等の導入 → CLAUDE.md「依存追加は最小に」に反する。
diff 対象は「id 付きオブジェクトの配列」という狭い形なので自前で十分。却下。

### 論点5 — 適用と保存: theirs を土台に mine を上書き → live state → 既存 save

**結論**: マージ結果 = **theirs のディープコピーを土台に、選択が mine の hunk
だけ mine の値を宛先へ書き戻す**(非衝突の「mine だけ変えた」hunk も自動で
mine を書き戻す)。

適用の副作用(App のハンドラ側):
1. `pushHistory()` を**1回**呼ぶ(マージ全体で ⌘Z 1回=元の mine へ戻る)。
2. `setCutplan/…/setShorts(merged.<doc>)` で live state を差し替える。
3. **`setProj(theirs)`**(base を theirs に更新)。以後の dirty 判定は
   merged≠theirs となり、「mine を残した hunk」だけが未保存として残る=正しい。
4. `setExternalChange(false)`、パネルを閉じる。

これで undo/redo・draft 退避・⌘S・validate ゲートは**すべて既存経路のまま**。
保存は `save()`(App.tsx §2646)→ `postSave` → `saveProject` の
`validateDocs(mergeBodyOverDisk(...))` 全拒否ゲート(server.ts §737–741)を通る。

**競合中にさらに編集したら**: v1 はパネルを**モーダル**にし、パネルを開いた瞬間の
mine / theirs / hunks を凍結する。パネルの外の編集は物理的にブロック(オーバーレイ)。
キャンセルで閉じれば凍結を捨て、externalChange バナーが残る(=元の状態)。
「レビュー中も裏で編集し続け live 再 diff」は v2。

### 論点6 — 計算場所: **クライアント**、純関数は `src/lib/docDiff.ts`

**結論**: diff / merge は**クライアントで計算**する。クライアントは既に mine と
base(=proj)を保持し、theirs は既存 `getProject()` で取れる。**サーバは1バイトも
変えない**(新エンドポイント不要=攻撃面・回帰面が増えない)。

純関数の置き場は **`src/lib/docDiff.ts`**(`applyEdits.ts` と同じ流儀。
クライアントバンドルは既に `src/types.ts` / `src/lib/*` を import しており、
`model.ts` も `src/types.ts` を引く)。node の型 stripping で動くよう enum・
namespace・パラメータプロパティは使わない(CLAUDE.md)。**fs・DOM・React に一切
依存しない**ので `node --test` で直接叩ける。

### 論点7 — スコープ: v1 は「検知→3-way→衝突 hunk のレビュー→validate 保存」

**v1(この設計の実装対象)**:
- 既存 SSE トリガ。外部変更時に theirs を取得し `threeWayDiff(base, mine, theirs)`。
- **cleanMerge(conflict 0件)なら現行サイレントリロードとバイト等価**に振る舞う
  (非 dirty は常に cleanMerge=挙動不変の証明の要)。
- conflict があればレビューパネル。要素+フィールド粒度(id 済み配列)/ 配列
  まるごと(id 無し配列)。accept-theirs / keep-mine(hunk 単位 + 一括)。
- 適用 → live state + `setProj(theirs)` → 既存 ⌘S。
- 対象は GUI が扱う5ドキュメント(cutplan / overlays / transcript / bgm / shorts)。

**v2 送り(§10 に明記)**: 語/トークン単位のテキスト diff、配列の並べ替え/move
検出、タイムライン・Inspector へのインライン diff 装飾、同一要素の非重複サブ
フィールドの自動3-wayマージ、レビュー中のライブ再 diff、chapters / meta /
thumbnail(現状 GUI 非対応)の diff、変更の出所表示(`plan` 由来か手編集か)。

---

## 2. アーキテクチャ(データフロー)

```
外部プロセス(AI / apply / plan / 手編集)が cutplan.json 等を書く
        │
        ▼
editor/server.ts  watch(dir) → selfWroteAt で自己書込除外 → 200ms デバウンス
        │  SSE /api/events  data: {files:[...]}          ★既存・無改変
        ▼
App.tsx  es.onmessage
        │
        ├─ dirtyRef.current === false  ──►  reloadFromDisk()      ★既存経路(不変)
        │                                    (= cleanMerge を人手で確定した形)
        │
        └─ dirtyRef.current === true   ──►  reviewExternalChange()   ◆新規
                 │
                 │  theirs = await getProject()          ★既存 API 流用
                 │  base   = proj                        ★既にメモリにある
                 │  mine   = {cutplan,overlays,transcript,bgm,shorts}
                 ▼
        src/lib/docDiff.ts  threeWayDiff(base, mine, theirs)   ◆純関数
                 │
                 ├─ cleanMerge(conflict 0)  ─► applyResolution(全自動) を live state へ
                 │                              + setProj(theirs)  = サイレントリロード相当
                 │
                 └─ conflicts > 0  ─► setReview({theirs, result})  ◆レビュー状態
                          │
                          ▼
              DiffReview.tsx(モーダルパネル)  ◆新規コンポーネント
                 hunk ごと accept-theirs / keep-mine + 一括
                          │  「適用」
                          ▼
        src/lib/docDiff.ts  applyResolution(theirs, result, resolution)  ◆純関数
                 │  merged: ReviewDocs
                 ▼
        App.tsx  pushHistory() → set<doc>(merged) → setProj(theirs)
                 → setExternalChange(false) → パネル閉
                          │  人間が確認(既存タイムライン/プレビュー)→ ⌘S
                          ▼
        既存 save() → postSave → saveProject → validateDocs 全拒否ゲート  ★不変
```

★ = 既存・無改変 / ◆ = 新規。**サーバ側は新規 0**。

### diff / hunk のデータ形状(TypeScript イメージ)

`src/lib/docDiff.ts`:

```ts
import type { CutPlan, Overlays, Transcript, Bgm, Shorts } from "../types.ts";

/** 差分レビューが扱う「GUI が保持する編集ドキュメントの束」。
 *  editor/client の state と 1:1(bgm/shorts は null=ファイル無し)。 */
export interface ReviewDocs {
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  bgm: Bgm | null;
  shorts: Shorts | null;
}
export type ReviewFileKey = keyof ReviewDocs;

/** hunk の宛先。人間可読ラベルは label(パネル表示・テスト表示用)。 */
export interface HunkAddress {
  file: ReviewFileKey;
  /** トップレベル配列名("segments" / "overlays" 等)。ファイル全体スカラ差分では未設定 */
  arrayKey?: string;
  /** id 対応が効いた配列のときの要素 id(ID_RE 準拠)。要素の add/remove/modify で設定 */
  elementId?: string;
  /** 要素内のフィールドパス("style.color" / "rect.w")。要素 add/remove では未設定 */
  field?: string;
  /** パネル/テストに出す一行ラベル(例 "cutplan segments seg_ab12cd .reason") */
  label: string;
}

export type HunkKind =
  | "file"           // id 無し配列/スカラ等、まるごと比較する粗い hunk(id 無し配列の逃げ道)
  | "element-add"    // theirs か mine が要素を足した
  | "element-remove" // theirs か mine が要素を消した
  | "element-modify" // 同一 id 要素のフィールド差
  | "field";         // element-modify の内訳(要素内フィールド)

/** 3-way の1 hunk。base/mine/theirs の3値を持つ(undefined = その版に無い) */
export interface Hunk {
  address: HunkAddress;
  kind: HunkKind;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  /** true = mine≠base かつ theirs≠base(要レビュー)。
   *  false = 片側だけが変えた(自動マージ対象) */
  conflict: boolean;
}

export interface ThreeWayResult {
  /** conflict / 非conflict の全 hunk(applyResolution が全部を消費する) */
  hunks: Hunk[];
  /** conflict === true のみ(パネルが出すのはこれだけ) */
  conflicts: Hunk[];
  /** conflict が0 = 「静かに theirs へ」= 現行サイレントリロードと等価 */
  cleanMerge: boolean;
}

/** 純関数: 3-way 差分。fs/DOM/React 非依存。 */
export function threeWayDiff(
  base: ReviewDocs,
  mine: ReviewDocs,
  theirs: ReviewDocs,
): ThreeWayResult;

/** 各 conflict hunk の解決。非 conflict hunk は含めない(自動で「変えた側」を採る) */
export type Resolution = Map<Hunk, "theirs" | "mine">;

/**
 * 純関数: theirs をディープコピーした土台に、
 *  - 非conflict の「mine だけ変えた」hunk → mine を宛先へ書き戻す
 *  - conflict hunk → resolution が "mine" のものだけ mine を書き戻す
 * を適用したマージ結果を返す(theirs/mine は変更しない)。
 */
export function applyResolution(
  theirs: ReviewDocs,
  result: ThreeWayResult,
  resolution: Resolution,
): ReviewDocs;
```

### 純関数の I/O 定義(不変条件)

- `threeWayDiff`: 入力3束はいずれも読むだけ(mutate しない)。
  `cleanMerge === (conflicts.length === 0)`。**mine が base と完全一致なら
  conflicts は必ず空**(= 非 dirty サイレントリロードのバイト等価保証)。
- `applyResolution`: 出力 = theirs を土台にした新オブジェクト。
  `resolution` が全 hunk "theirs" なら**出力は theirs と深く等価**
  (= 「全部ディスク版」= 現行の全上書き reload と等価)。全 hunk "mine" なら
  mine が変えた宛先はすべて mine の値になる。**approved は対象外**:
  cutplan/short の `approved` は diff に出さない(承認は `approvals.json` /
  approve コマンドの専管。`applyEdits.ts` の `enforceApprovedUnchanged` と同じ
  精神。§不変条件)。マージ結果の `approved` は常に theirs の値を採る。

---

## 3. タスク分解(1タスク=1コミット)

XL なので小さく厚く割る。各タスクは (a) 触るファイル (b) テスト方針
(c) 壊してはいけない既存挙動と証明手段、を持つ。**T1–T7 は純関数のみで UI に
未接続=この段階では既存挙動は定義上不変**、T8 以降で配線する。

### T1 — `ReviewDocs` 型 + `threeWayDiff` の骨格(スカラ/ファイル粒度のみ)

- (a) 新規 `src/lib/docDiff.ts`: `ReviewDocs` / `HunkAddress` / `Hunk` /
  `ThreeWayResult` 型、`threeWayDiff`。この段階は**各ファイルをまるごと
  (`kind:"file"`)1 hunk として** 3-way 判定する(id 対応はまだ)。
  等価は `JSON.stringify`。
- (b) 新規 `test/docDiff.test.ts`(`node --test`): mine==base → cleanMerge=true /
  conflicts=[]、theirs だけ変更 → 非 conflict 1件、mine だけ変更 → 非 conflict、
  両方が同ファイルを変更 → conflict 1件。
- (c) 壊さない: 何も配線しないので既存挙動は不変。`npm test` / `npx tsc --noEmit`
  が緑。

### T2 — `applyResolution`(ファイル粒度)+ クリーン/全採用の同値

- (a) `src/lib/docDiff.ts` に `Resolution` / `applyResolution`。
- (b) `test/docDiff.test.ts` 追加: 全 "theirs" → 出力が theirs と深く等価
  (= reload 相当)。全 "mine" → mine が変えたファイルは mine 値。
  cleanMerge のとき resolution 空 → 出力 == theirs。往復不変を固定。
- (c) 純関数のみ。既存不変。

### T3 — id 対応の要素粒度(`element-add/remove/modify`)

- (a) `src/lib/docDiff.ts`: `hasAnyId` 相当で配列が id を持つか判定
  (`src/lib/ids.ts` の `ID_RE` を import。`carryIds` の keyFn 発想で id→要素
  マップ)。id 済み配列だけ要素粒度へ割り、id 無し配列は T1 の `kind:"file"` に
  フォールバック。対象配列表は `applyEdits.ts` の `KIND_ARRAY` /
  `ADD_SELECTORS` と同じ集合を参照(cutplan.segments / transcript.segments /
  overlays.{overlays,inserts,zooms,blurs,wipeFull,hideCaption,captionTracks,
  annotations} / bgm.tracks / shorts.shorts)。
- (b) test: id 一致要素の変更 → element-modify、theirs が id 追加 →
  element-add(非 conflict)、mine が消し theirs が変更 → 同 id で conflict。
  id 無しプロジェクトは配列 hunk のまま(退行なし)。
- (c) 純関数のみ。id 無しの既存プロジェクトが**必ず**T1 と同じ粒度になることを
  テストで固定(id 機能未採用ユーザーの体験を変えない)。

### T4 — フィールド粒度(`field`)+ ラベル生成

- (a) `src/lib/docDiff.ts`: element-modify の内訳を再帰比較して `field` hunk へ。
  `HunkAddress.label` を生成(file + arrayKey + 短縮 id + field パス)。
- (b) test: `style.color` だけ違う → field hunk 1件、ネストの片方だけ変更、
  ラベル文字列のスナップショット。
- (c) 純関数のみ。既存不変。

### T5 — `applyResolution` を要素/フィールド粒度へ拡張

- (a) `src/lib/docDiff.ts`: element-add/remove/modify・field を宛先へ適用する
  書き戻し(id で要素を引く。add は theirs 側に既にある/mine 側から復活、
  remove は theirs から除去 or mine 維持)。
- (b) test: 混在 resolution(一部 mine・一部 theirs)で期待 JSON を固定。
  「全 theirs」== theirs、id 済みでも往復不変。approved は常に theirs 値(固定)。
- (c) 純関数のみ。**approved を書き換えないこと**をテストで固定
  (`applyEdits` の不変条件2と整合)。

### T6 — API クライアントに theirs 取得の口(既存 getProject 流用の薄いラッパ)

- (a) `editor/client/widgets.tsx`: 追加は不要かもしれない(既存
  `getProject()` をそのまま使う)。必要なら `ProjectData → ReviewDocs` への
  抽出ヘルパ `reviewDocsOf(p)` を `editor/client/` に置く(mine 側の束ね
  `{cutplan,overlays,transcript,bgm,shorts}` と対称)。
- (b) `test/docDiff.test.ts` かクライアント側の小テスト: `reviewDocsOf` が
  ProjectData から正しい5キーを抜くこと。
- (c) サーバ無改変。`editorServer.test.ts` 緑のまま。

### T7 — `DiffReview.tsx`(表示専用コンポーネント)

- (a) 新規 `editor/client/DiffReview.tsx`: props =
  `{ conflicts: Hunk[]; resolution; onSet(hunk, side); onBulk(side);
     onApply(); onCancel() }`。hunk ごとに mine/theirs 値とラジオ、一括ボタン。
  App の state には触れず props だけで描く(テスト容易・既存 UI 非依存)。
- (b) headless CDP(§8)でパネル DOM の描画・ラジオ・一括の見た目確認。純表示
  なのでロジックテストは軽い。
- (c) 既存コンポーネントに import されるまで**未参照=既存 UI 不変**。

### T8 — App の SSE 分岐を 3-way 経路へ(cleanMerge はサイレントリロード等価)

- (a) `editor/client/App.tsx`: `reviewExternalChange()` を新設。
  `es.onmessage`(§463–466)の `dirty` 側を、現行の `setExternalChange(true)`
  から「theirs=getProject → `threeWayDiff(proj, mine, theirs)` → cleanMerge なら
  `applyResolution` 全自動を live state へ+`setProj(theirs)`(= reloadFromDisk と
  同じ結果)/ conflicts>0 なら review 状態をセット」へ差し替え。
  **非 dirty 側(§465 の `else` = `reloadFromDisk`)は1バイトも触らない**。
- (b) headless CDP: (i) 未保存なし + 外部変更 → 現行どおりパネル無しで反映
  (退行なし)。(ii) 未保存あり + 非衝突な外部変更 → パネル無しで両者マージ
  (mine 温存 + theirs 反映)。(iii) 未保存あり + 衝突 → review 状態。
- (c) 壊さない: **非 dirty の外部変更はパネルを出さず現行と同結果**。証明 =
  CDP シナリオ (i) と、`threeWayDiff` の「mine==base ⇒ conflicts=[]」単体テスト
  (T1)。dirtyRef の意味・draft 退避・beforeunload は無改変。

### T9 — バナー拡張 + review パネルのマウント/適用配線

- (a) `editor/client/App.tsx`: review 状態 `useState<{theirs; result} | null>`。
  `HeaderBanners`(§3735–3811)の externalChange バナーに「差分をレビュー」
  ボタンを追加(conflicts>0 のときだけ)。**既存の「読み込み直す(未保存の編集は
  破棄)」ボタンは残す**(逃げ道)。`DiffReview` をマウント。適用ハンドラ:
  `pushHistory()` → set<doc>(merged) → `setProj(theirs)` →
  `setExternalChange(false)` → review=null。キャンセル: review=null のみ
  (externalChange バナーは残る=元の状態)。
- (b) headless CDP フルシナリオ(§8): 編集 → 外部書換 → バナー →「レビュー」→
  hunk ごと accept/reject → 適用 → タイムライン反映 → ⌘S →
  `saveProject` 成功。⌘Z で適用前へ戻る(pushHistory 1回)。
- (c) 壊さない: `externalChange` の従来ボタン経路・`reloadFromDisk`・`save`・
  `pushHistory`/undo は無改変。既存 `editorServer.test.ts`・保存 validate ゲート
  緑。CDP で「レビューをキャンセル → 従来の読み込み直すが従来どおり動く」。

### T10 — 競合中の編集ブロック(モーダル)+ approved 除外の最終確認

- (a) `DiffReview.tsx` をモーダルオーバーレイにし、開いている間は背後の編集入力を
  ブロック。App の review 適用が cutplan/short の `approved` を diff/merge から
  除外していることを確認(threeWayDiff 側で approved フィールドを field 走査から
  スキップ)。
- (b) test: threeWayDiff が cutplan.approved / short.approved を hunk に出さない
  (T5 と別の観点で固定)。CDP: パネル表示中にタイムラインクリックが素通り
  しないこと。
- (c) 壊さない: approved を GUI 保存が別途 mint/clear する経路
  (server.ts §760–787)は無改変。

### T11 — ドキュメント追随

- (a) `docs/usage.md`(差分レビューの節)/ `CLAUDE.md`(「GUI エディタ起動中でも
  JSON を直接編集してよい」の段に、衝突時は差分レビューが出る旨を追記)。
  スキーマ・ファイル分類・CLI コマンドは**変わらない**ので5点セット / AGENTS_CONTRACT.md
  の更新は不要(新規は純関数と UI のみ、承認境界も不変)。
- (b) `npm test`(`agentsMd.test.ts` が落ちないこと=契約非変更の裏取り)。
- (c) 既存不変。

> タスク数: **11**(純関数 T1–T5、配線 T6–T10、docs T11)。UI 未接続の純関数を
> 前半に厚く積み、後半で既存経路へ最小侵襲に配線する。

---

## 4. 「壊してはいけない既存挙動」と共通の証明手段

差分レビューを**使わない/衝突が無い**通常時に、以下がバイト/挙動不変であること:

| 既存挙動 | 不変の理由 | 証明 |
|---|---|---|
| 未保存なし → サイレント全再読込 | `es.onmessage` の `else`(§465)を触らない | CDP シナリオ(i)+ `threeWayDiff` mine==base 単体テスト |
| 未保存あり → 「読み込み直す(破棄)」ボタン | 既存ボタン・`reloadFromDisk` を残す | CDP キャンセル後の従来経路 |
| ⌘S 保存前 `validate` 全拒否ゲート | `saveProject`/`mergeBodyOverDisk` 無改変 | 既存 `editorServer.test.ts` |
| undo/redo(履歴100)・coalesce | `pushHistory` は適用時に1回呼ぶだけ | CDP で適用→⌘Z 1回で復帰 |
| `.editor-draft.json` 自動退避 | draft 経路無改変 | 既存 draft テスト/手動確認 |
| server の watch / SSE / 全 API | サーバ側新規 0(§論点6) | `git diff editor/server.ts` が空 |
| id 未採用プロジェクトの粒度 | id 無し配列は `kind:"file"` フォールバック | T3 の「id 無し=配列 hunk」テスト |
| approved(承認境界) | diff/merge から除外・theirs 値固定 | T5 / T10 テスト |

---

## 5. 先に読むべきコード(実 API の形)

- `editor/server.ts`
  - `watch(dir, …)` + `WATCHED_FILES` + `selfWroteAt` + 200ms デバウンス
    (§99–115, §158–163): 外部変更検知と SSE 配信 `data: {files}`。**無改変**。
  - `/api/events`(§210–225): SSE。`/api/save` → `saveProject`(§232–235,
    §729–796): validate 全拒否ゲート・id 採番・approved mint/clear・
    `selfWroteAt` セット。
  - `mergeBodyOverDisk`(import 元 `src/lib/applyEdits.ts`)を saveProject が使う。
- `editor/client/App.tsx`
  - 状態: `proj`(base)/ `cutplan…shorts`(mine)(§208–221)。
  - dirty 判定(§819–845)、`dirtyRef`。
  - SSE ハンドラ(§456–468)= **唯一の分岐点**。
  - `reloadFromDisk`(§419–454)= cleanMerge 経路が模倣すべき挙動。
  - `save`(§2646–2665)、draft 退避(§2670–2680)、beforeunload(§2684–2690)。
  - `pushHistory` / `HistoryDocs` / undo(§137–149, §504–557)。
  - `HeaderBanners` の externalChange バナー(§3781–3791)+ 呼び出し(§3262–3275)。
- `editor/client/model.ts`: `Selection` / `SpanKind` / 配列添字の意味(diff の
  要素対応の背景。id が無いときの添字対応が壊れる理由の裏取り)。
- `editor/client/apiTypes.ts`: `ProjectData` / `SaveRequest` / `DraftData`
  (theirs=ProjectData、mine=SaveRequest 相当の形)。
- `editor/client/widgets.tsx`: `getProject`(§13)/ `postSave`(§35)= theirs 取得
  と保存の実クライアント。
- `src/lib/applyEdits.ts`: `ApplyDiffEntry`(diff hunk の先例形)、
  `mergeBodyOverDisk`、`KIND_ARRAY`/`ADD_SELECTORS`(対象配列の正準集合)、
  `enforceApprovedUnchanged`(approved を触らない不変条件)。
- `src/lib/ids.ts`: `ID_PREFIX` / `ID_RE` / `ensureIds` / `carryIds`
  (id 対応キーの土台)/ `hasAnyId`。
- `test/*.test.ts`(`node --test`): `docDiff.test.ts` を足す先例(`applyEdits.
  test.ts` / `editorServer.test.ts` / `ids.test.ts` / `describeJson.test.ts`)。

---

## 6. 実データ検証の前提(タスクへの織り込み)

- scratch は bench から汚さずコピー:
  `~/Movies/cutflow/2026-07-02-whisper-bench` から `proxy.mp4` + `audio/` +
  `*.json` + `materials/` を scratchpad 配下へコピーして対象にする(実収録は
  触らない)。id 済み/無しの両方を作るため、片方は `id-stamp` を当てておく
  (要素粒度と配列粒度の両経路を CDP で踏む)。
- headless 実測は **Remotion 同梱 chrome-headless-shell を Node の global
  WebSocket + CDP 直叩き**で駆動(Google Chrome stable 未インストール・
  puppeteer 無し)。navigate / evaluate / screenshot、`Input.dispatchMouseEvent`、
  pointerdown 起点のセレクト。**editor は起動時に1回だけ esbuild バンドル
  → 検証前に必ずサーバ再起動**([MEMORY: editor-bundle-restart])。
- CDP シナリオの外部書換は、別プロセスから scratch の `cutplan.json` 等を
  `writeFileSync`(または `node src/cli.ts apply`)で書いて SSE を発火させる。
  `selfWroteAt` の 1500ms 窓を避けるため、GUI 保存直後は少し待つ。
- muted video は headless で凍るので、進行検証は非ミュート側だけ見る
  ([MEMORY: headless-chrome-muted-video-freeze])。差分レビューの検証は主に
  DOM(バナー・パネル・ラジオ・保存成功)なので動画進行には依存しない。

---

## 7. リスクと緩和

- **id 無しプロジェクトで粒度が粗い**: 配列まるごと accept/reject に退化するが、
  破綻はしない。安定 id 導入(診断 NEXT の兄弟項目)が進むほど体験が良くなる
  設計にして、依存を作らない。
- **theirs 取得と SSE の競合**: `getProject()` 中にさらに外部書換が来ると
  theirs が古くなり得る。v1 はモーダルで凍結し、パネルを閉じるまで再取得しない
  (再度 SSE が来ても review 中は無視 or「新しい変更あり」を軽く表示。v1 は無視で
  可)。
- **大量 hunk**: 長尺収録で数百 hunk になり得る。v1 はファイル別グルーピング +
  「全部ディスク版/全部自分の版」の一括を用意して現実的にする。仮想化は v2。
- **JSON.stringify 等価のキー順依存**: 既存 dirty 判定・`applyEdits` の diff が
  すべて同じ `JSON.stringify` 基準なので、cutflow 内で生成される JSON はキー順が
  安定(同じ writer)。外部が異なるキー順で書いた場合の誤差分は v1 では許容
  (実害は「同値なのに conflict」= 安全側)。正規化は v2。

---

## 8. スコープ外(v2 送り・明示)

1. **語/トークン単位のテキスト diff**(caption `text` の語単位ハイライト)。
   v1 はフィールドまるごと mine/theirs。
2. **配列の並べ替え / move 検出**(LCS)。v1 は add+remove。
3. **タイムライン / Inspector へのインライン diff 装飾**(Cursor 風の行内表示)。
   v1 は独立パネル。
4. **同一要素の非重複サブフィールドの自動3-wayマージ**(mine が `color`、theirs が
   `pos` を変えたら両採用)。v1 は要素内で衝突があれば**要素/フィールド単位で
   人間に出す**(自動合成しない=安全側)。
5. **レビュー中のライブ再 diff**(パネルを開いたまま編集し続ける)。v1 はモーダル凍結。
6. **chapters / meta / thumbnail の diff**(現状 GUI 非対応。GUI 化と同時に対応)。
7. **変更の出所表示**(この hunk は `plan` 由来 / 手編集 / `apply` 由来か)。
8. **JSON 正規化(キー順・数値表記)**による誤差分の除去。
9. **サーバ側 diff エンドポイント**(v1 は完全クライアント計算でサーバ無改変)。

---

## 9. まとめ(この設計が決めたこと)

- **base はもう手元にある**(`proj`)。3-way マージは追加のバージョン管理無しで
  成立し、**非 dirty は必ず cleanMerge = 現行サイレントリロードとバイト等価**。
  これが「既存挙動を壊さない」の技術的核。
- **サーバは1バイトも変えない**。検知は既存 SSE、計算はクライアント、純関数は
  `src/lib/docDiff.ts`(node --test 可)。保存は既存 ⌘S validate ゲート。
- **粒度は id で決まる**: id 済み配列は要素/フィールド、id 無しは配列まるごと。
  安定 id を差分レビューの enabling feature に昇格。
- **approved は diff/merge の対象外**(承認境界を侵さない)。
- v1 = 検知 → 3-way → 衝突 hunk のパネルレビュー(accept-theirs / keep-mine +
  一括)→ 適用 → validate 保存。**11 タスク**、純関数を前半に厚く、後半で
  最小侵襲配線。語単位 diff・reorder 検出・インライン装飾・ライブ再 diff は v2。
