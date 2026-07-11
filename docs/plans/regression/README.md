# 回帰サンプル台帳(D7 回帰基準線)

`docs/plans/2026-07-11-d7-w0-implementation-design.md` Part A の成果物。
W0 / C1 / balanced 化などの施策が本当に効いたかを、主観ではなく
before/after の機械 diff + 人手採点で判断するための代表収録の一覧。

**選定は人間(ユーザー)が行う。実装担当はこの雛形だけを作る。**

- 3〜5本を目安に、傾向の異なる収録を選ぶ(長さ・話速・画面主体か
  喋り主体か・既知の弱点、など)。
- **収録フォルダ自体はリポジトリに入れない**(サイズ・秘匿)。ここには
  絶対パスとメタ情報だけを書く。
- `id` は `scripts/regression-snapshot.ts` がスナップショットのファイル名
  (`snapshots/<id>.<label>.json`)を決めるのに使う。この表の `収録フォルダ`
  列と一致するパスを渡すことで `<id>` を自動解決する。

## 使い方

```sh
# 1. 施策を入れる前に、各サンプルで baseline を1回取る
node scripts/regression-snapshot.ts <収録フォルダ> baseline

# 2. 施策(W0 など)を入れた後、同じ収録で after ラベルを取る
node scripts/regression-snapshot.ts <収録フォルダ> after-w0

# 3. 差分を見る
node scripts/regression-diff.ts <id> baseline after-w0
```

採点は `scorecard.md` に記録する(母艦 §5 の分類語でタグ付け)。

## サンプル一覧

<!--
記入例:
| id | 収録フォルダ(絶対パス) | 特徴 |
|---|---|---|
| sample-a | /Users/xxx/Movies/cutflow/2026-07-02-xxx | 20分・話速速い・画面主体・言い直し多め |
| sample-b | /Users/xxx/Movies/cutflow/2026-06-20-yyy | 8分・喋り主体・カメラのみ・間が多い |
-->

| id | 収録フォルダ(絶対パス) | 特徴 |
|---|---|---|
| sample-a | /Users/19mo/Movies/cutflow/2026-07-10_2 | 142秒・31セグメント・発話多め・cut系施策(W0/C1/X4)の一巡評価用 |
