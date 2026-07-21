# already-legible

> 系: 何もしない · 既定の型: none
> 接地: 実データ(2026-07-12, zoom外アンカー) + craft · 観測: none理由は未記録

## 一行定義

画面上に関連する文字やUIはあるが、現在の出力解像度ですでに十分読めるため
拡大しない。

## 判定シグナル

### 語彙(transcript)

- **補助**: 発話が画面の具体物に言及していても、「小さい」「読みにくい」ことは
  語彙だけでは確定しない
- **補助(craft)**: 指示語があっても、視聴者が全体配置と対象を同時に理解する方が
  有益なら拡大を控える

### 座標(frames --ocr の box / av の motion 領域)

- **決定的**: OCR box と文字が現在の出力で判読でき、局所 rect に寄らなくても
  発話対象を識別できる
- **補助(craft)**: box 面積だけに固定閾値を置かず、文字数・コントラスト・出力
  解像度を合わせて見る

### 画面(frames / OCR テキスト)

- **決定的**: frames で対象名・値・状態が読み取れ、周辺UIとの関係も明瞭
- **補助**: OCRが取れない場合でも、代表 frame で視覚的に判読できれば none に倒す

### 時間・格子(アンカーの形)

- **補助**: zoom が置かれていない区間が多いことだけでは本分類を確定しない。
  `concept-talk` や `motion-carries` の none と区別する

## 既定の型

`none`。演出を検討した理由は残すが、zoom は置かない。

## 反例(この型を当てない場合)

```text
OCRには「approvalHash」と出るが、全画面では値を判読できず、発話が「この値」を指す。
→ tiny-target(zoom)。

文字は読めるがAPIトークンそのものが表示されている。
→ 読みやすさより安全を優先して secret-exposure(blur)。
```

## 紛らわしい隣

- `tiny-target` — 表層は同じOCRアンカー。現在の解像度で読めるなら
  `already-legible`、読めず発話が具体物を指すなら `tiny-target`。双方向のG2対比
- `concept-talk` — 具体物はあるが読めるので何もしないのが本分類。そもそも
  具体物を指していないなら `concept-talk`

## worked example

`~/Movies/cutflow/2026-07-12` の実収録。最終 overlays は zoom 4件だけで、
`[468.78-472.42]` には zoom が無い。none の理由は当時保存されていないため、
これは実データを反転して再分類した例である。

```text
#15 [468.78-472.42] ocr [既に読める見出し領域]
transcript: "Claude CodeなどのAPIを毎回叩いていると"
final overlay: zoomなし
```

```json
{ "anchorId": 15, "effect": "none", "effectReasonId": "already-legible", "reason": "関連する画面文字は全画面のまま判読できる" }
```
