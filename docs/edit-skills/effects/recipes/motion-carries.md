# motion-carries

> 系: 何もしない · 既定の型: none
> 接地: 想定(motionアンカー) + craft · 観測: none理由は未記録

**現行データは none 判断の理由を保存していないため、この分類に直接接地する
記録は無い。以下は motion アンカーの仕様とcraftから構成した接地なしの分類で、
worked example も合成例である。**

## 一行定義

スクロール・カーソル移動・クリック・画面遷移そのものが注視先を明らかにするため、
追加演出を置かない。

## 判定シグナル

### 語彙(transcript)

- **補助**: 「クリックします」「下へスクロール」「開くと」など、直後の画面動作を
  予告する発話
- **補助(craft)**: 発話がなくても動きが対象を示せるため、語彙だけで分類しない

### 座標(frames --ocr の box / av の motion 領域)

- **決定的**: motion領域またはカーソルの軌跡が一つの注視先へ収束し、追加rectで
  指さなくても対象が一意に分かる
- **補助(craft)**: 動きが広いだけでは本分類にしない。複数要素へ散るなら
  `attention-scatter` を検討する

### 画面(frames / OCR テキスト)

- **決定的**: クリック後の選択状態・画面遷移・展開結果が、どこを見ればよいかを
  視覚的に示している
- **補助(craft)**: 動きと追加annotationが同じ注意誘導を重複すると過剰になる

### 時間・格子(アンカーの形)

- **決定的**: motionアンカー内で「移動→操作→結果」が連続し、その順序だけで
  注視先を追える
- **補助**: 動きが終わっても似た要素が複数残る場合は、本分類から
  `attention-scatter` へ倒す

## 既定の型

`none`。画面自身の動きを見せ、zoomやannotationを重ねない。

## 反例(この型を当てない場合)

```text
一覧全体がスクロールするが、どの行を説明しているか分からず、同形の候補が残る。
→ attention-scatter(annotation)。

画面遷移後のエラー文字が小さく、動きが止まっても判読できない。
→ tiny-target(zoom)。
```

## 紛らわしい隣

- `attention-scatter` — motionアンカーという表層は同じ。動きが注視先を自明に
  するなら `motion-carries`、注意を散らすなら `attention-scatter`。双方向のG2対比
- `focus-shift` — 画面内の対象移動をzoomで追う必要があるなら `focus-shift`。
  カーソル・遷移だけで追えるなら本分類

## worked example

**接地なし(合成例)。** カーソルが一つのボタンへ移動し、クリック後に対応パネルが
開く想定。動作そのものが注視を運ぶ。

```text
#28 [想定 448.0-452.0] motion (領域なし)
frame sequence: カーソルが "Validate" ボタンへ移動 → click → 結果パネルが展開
transcript: "Validateを押すと結果がここに出ます"
```

```json
{ "anchorId": 28, "effect": "none", "effectReasonId": "motion-carries", "reason": "カーソル移動と展開結果だけで注視先が明らか" }
```
