# 採点・分類テンプレ(D7 回帰基準線)

`docs/plans/2026-07-11-d7-w0-implementation-design.md` Part A の成果物。
施策(W0 / C1 / balanced 化など)を1つ入れるたびに、代表収録
(`README.md` の台帳)ごとに `regression-diff.ts` の結果を見ながら
人手で採点する。

## 採点基準(1〜5)

- **5**: 施策前より明確に良くなった(直す手間が減った)
- **4**: 良くなったが誤差の範囲もありうる
- **3**: 変化なし・良し悪し判断できない
- **2**: 悪くなったが許容範囲
- **1**: 明確に悪化した(施策前の方が良かった)

## タグ(母艦 §5 の分類語)

人間が直した箇所は次のどれかでタグ付けする:
`boundary` / `duplicate` / `visual-miss` / `context-break` /
`effect-mismatch` / `material-mismatch` / `bgm-mismatch` / `review-unclear`

## 記録表

<!--
記入例:
### after-w0(2026-07-15)

| sample | 採点(1-5) | タグ | メモ |
|---|---|---|---|
| sample-a | 4 | boundary | 言い直しの境界が1箇所ズレたが致命的ではない |
| sample-b | 3 | - | 変化なし(このサンプルは対象区間が無かった) |
-->

### <施策名>(<日付>)

| sample | 採点(1-5) | タグ | メモ |
|---|---|---|---|
