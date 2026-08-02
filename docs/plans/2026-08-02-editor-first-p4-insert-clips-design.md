# P4: inserts のタイムライン一級化 — 「演出」から「クリップ」へ

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: なし(P0〜P3 と独立。UI 層に閉じる)

解決する欠落: 母艦 §1 の **(3) `inserts[]` がクリップとして扱われていない**。

---

## 0. 調査の結果 — 残っている欠落は「移動」だけ

着手前の想定より**ずっと小さい**。`editor/client/App.tsx` を読むと、
inserts は既にタイムラインの一級市民に近い:

| 能力 | 状態 | 実装箇所 |
|---|---|---|
| `cut` トラック上に区間として描かれる | **実装済み** | `:2050-2053`(`insertSpans`) |
| 選択・Inspector 表示 | **実装済み** | `:4505-4508` |
| 複製 | **実装済み** | `:327`(`DUPLICABLE`) |
| 分割 | **実装済み** | `:2442-2463` |
| 削除 | **実装済み** | `:4183` |
| 右端ドラッグでトリム(`durationSec`) | **実装済み** | `:3151-3155` |
| 左端ドラッグ(静止画は尺、動画は `startFrom`) | **実装済み** | `:3156-3168`(S2-B5) |
| 素材パネルから `cut` トラックへドロップして挿入 | **実装済み** | `:5034`, `:3835` |
| **本体ドラッグで位置(`at`)を動かす** | **未実装** | `:3146` の分岐に `mode === "move"` が無い |
| **同一 `at` の insert の順序を変える** | **未実装** | — |

したがってこの plan の中身は **(A) 移動 + (B) 同値順序 + (C) クリップらしい
見た目** の3点に絞られる。データモデルは1バイトも変えない。

## 1. (A) 移動 — `at` を動かす

### 1.1 挙動

`App.tsx:3146` の `sel.kind === "insert"` ブロックに `mode === "move"` の枝を足す。

```ts
if (mode === "move") {
  arr[sel.index] = { ...ins, at: round2(clamp(ins.at + d, lo, hi)) };
}
```

`d` はドラッグ量を**元収録の秒**へ変換した値(既存の `cut` / `overlays` の
move と同じ変換経路を使う。新しい変換を書かない)。

### 1.2 `lo` / `hi` の決め方 — ここが本題

`at` は**元収録の秒のアンカー**で、「この時刻の手前に挿入される」という意味
(`src/types.ts` の `inserts[].at` のコメント)。したがって:

- **`lo = 0`、`hi = manifest.durationSec`** が素朴な上下限
- しかし `at` が**カット区間の中**に落ちると、挿入は「その cut の直後の keep の
  先頭」へ実質スナップする。ユーザーから見ると**ドラッグが効かない死に領域**になる

**決定: `at` は keep 区間の内部にだけ置けるようにスナップする。**
`frames --t` が「カット内なら直後の keep へ自動スナップ」する既存の規約
(CLAUDE.md)と同じ流儀に揃える。

実装:
```ts
/** src 秒を、keep 区間の内部へスナップする(cut 内なら直後の keep の先頭)。
 *  keep が1つも無いときは値をそのまま返す */
function snapToKeep(srcSec: number, keeps: Interval[]): number;
```
`editor/client/playhead.ts` に既存の類似関数があればそれを使う。無ければ
`model.ts` に置く(**`src/lib/timeline.ts` には足さない** — UI 都合の関数で、
render の時刻写像とは別物)。

### 1.3 ripple の可視化

insert を動かすと、**その後ろの全要素の出力秒がずれる**(ripple)。
タイムラインの横軸は出力秒(`model.ts` 冒頭)なので、ドラッグ中は
後続のクリップ・テロップが動いて見える。**これは正しい表示**で、抑制しない。

ただしドラッグ中に毎フレーム `buildTimeline` を再計算すると重い。
既存の transient commit の仕組み
(`docs/plans/2026-07-18-editor-gesture-transient-commit-design.md`)に
そのまま乗せること。**新しいスロットリングを書かない。**

## 2. (B) 同一 `at` の順序

`src/types.ts` の `inserts[].at` のコメント:
> `at` が同じ挿入が複数あるときは overlays.json に書いた順に並ぶ

= **配列の添字が順序**。UI で順序を変える = 配列内で要素を入れ替える。

- Inspector の insert 節に「前へ / 後ろへ」ボタンを2つ置く
- 同じ `at` を持つ insert が**2件以上あるときだけ**表示する
  (それ以外の場合は順序に意味が無く、ボタンが混乱を生む)
- 入れ替えは `arr.splice` ではなく新しい配列を作って `setOverlays`
  (既存の不変更新の流儀に揃える)

⚠️ 入れ替えると `selection.index` がずれる。入れ替え後に
`setSelection({ kind: "insert", index: 新しい添字 })` を必ず行う
(`:2463` の split が同じことをしているので、それを写す)。

## 3. (C) クリップらしい見た目

`cut` トラック上の insert 区間に、他の span と区別できる表示を与える:

- **ファイル名**(basename)をラベルとして描く。区間が狭いときは省略
- 動画/静止画の区別をアイコンかクラス名で示す(`isImageFile` が既にある)
- サムネイル: **この plan では作らない**。`materials.probe/<slug>.png`
  (`materials --frames` が書く)を流用できるが、materials.probe が
  未生成のときのフォールバックが要るため、独立した施策として後回しにする

`editor/client/styles.css` に `.tlSpan.insert` 系のクラスを足す。
`:1401` に既に `insert` クラスの前例(`tlDropGhost insert`)があるので、
命名を揃える。

## 4. やらないこと

- **データモデルの変更**(`inserts[]` のスキーマは不変)
- **複数の V トラック**(母艦 §7 の非目標)
- **insert 同士のクロスフェード / トランジション**(別施策)
- **`at` の出力秒アンカー化**。sequence-time 母艦 §9 で
  **却下済み**(2026-08-02)の決定を覆さない

## 5. テスト

エディタのロジックは `model.ts` 側の純関数だけがテスト可能なので、
テストは `snapToKeep` に集中させる:

1. keep 内の秒はそのまま返る
2. cut 内の秒は直後の keep の先頭へ寄る
3. 最後の keep より後ろの秒は最後の keep の末尾へ寄る
4. keep が空のときは入力をそのまま返す

加えて UI の design テスト(`test/editorPanelDesign.test.ts` /
`test/editorInspectorDesign.test.ts` の既存の流儀)で:

5. insert の Inspector に「前へ / 後ろへ」が、同一 `at` が2件以上のときだけ出る

**回帰**: insert を1つも持たないプロジェクトで、タイムラインの描画と
保存ペイロードが P4 導入前と等価であること。

## 6. 落とし穴

- **`d` の単位**: `cut` の move は「元収録の秒」で計算しているが、
  タイムラインの横軸は出力秒。`insert` の `at` も元収録の秒なので、
  `cut` の move と**同じ変換**を使えばよい。`overlays` の move
  (`:3219`)ではなく `cut` の move(`:3134`)を写すこと
- **ドラッグ中の ripple で自分自身の位置が動く**。`at` を動かすと
  自分より後ろがずれるが、**自分自身の出力位置も** `at` より前の要素の
  影響を受ける。ドラッグの基準点は**ドラッグ開始時の値**に固定し、
  中間状態から差分を積まないこと(既存の transient commit がこれを担保する)
- **`splitInsertIndex` との相互作用**(`:2442-2463`)。分割直後の選択が
  `index + 1` を指すので、順序入れ替えのロジックと衝突しないか確認する

## 7. 完了記録(2026-08-02)

- insert 本体のドラッグ移動を、ドラッグ開始時の値から毎回再計算する既存
  transient 経路に実装。自分自身を除いた output timeline から source 秒へ
  逆変換し、cut 内は直後の keep 先頭、終端後は最後の keep 末尾へ寄せる。
- 同一 `at` の insert だけを対象にした「前へ / 後ろへ」を Inspector に追加し、
  不変更配列の入れ替え後に selection index も追随させた。
- cut トラックの insert に basename と動画/静止画の種別表示を追加。
  schema / render データモデルは変更していない。
- 主担当が独立に実測したゲート:
  - `node --test test/editorInsertClips.test.ts`: **8 / 8 PASS**
  - `npm run typecheck`: PASS
  - `npm test`: **2726 / 2726 PASS**
  - 本番設定の `buildEditorClientAssets`: JS 10,694,565 bytes / CSS 166,411 bytes /
    HTML 905 bytes、すべて非空
  - insert なしの `buildTimeline(keeps, [])` と既定引数の深い等価、
    same-at の前後探索、keep 吸着の境界値を固定
  - `git diff --check`: PASS
- 次の一手は P5(プロジェクトランチャー + `derive`)。
