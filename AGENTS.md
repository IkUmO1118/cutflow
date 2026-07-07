# cutflow

Codex 向けの開発ドキュメントです。編集の正本は `AGENTS_CONTRACT.md`、
運用上の補足は `CLAUDE.md` にあります。このファイルは、Codex が
このリポジトリで迷わず作業するための短い実行指針です。

## まず守ること

- このプロジェクトで「動画を編集して」と言われたら、コードではなく
  収録フォルダ内の JSON を編集する
- 編集対象は `cutplan.json` / `transcript.json` / `overlays.json` /
  `bgm.json` / `chapters.json` / `meta.json` / `shorts.json` /
  `thumbnail.json`
- 動画ファイル自体は触らない
- 時刻はすべて raw 録画の秒で扱う。カット後の秒へ手計算で変換しない
- JSON を編集したら必ず `node src/cli.ts validate <dir>` を実行する
- `plan` と `run` は、明示的に頼まれたときだけ再実行する
- `cutplan.json` の `approved: true` を自分で立てない
- `approvals.json` を直接書かない

## 正本

- 機械可読な契約は `AGENTS_CONTRACT.md`
- ここに書かれている内容と矛盾があれば `AGENTS_CONTRACT.md` を優先する
- JSON Schema は `schemas/` にある
- 状態確認は `node src/cli.ts describe <dir> --json` を優先する

## 安全な作業手順

1. まず対象フォルダの JSON を読む
2. 必要なら最小限の JSON 編集を行う
3. `node src/cli.ts validate <dir>` で整合性を確認する
4. 目視確認が必要なら `node src/cli.ts frames <dir> --t ...` を使う
5. 承認が必要なら人間に確認してもらう
6. 承認後に `node src/cli.ts render <dir>` を実行する

## 再実行の注意

- `plan` は再実行で `cutplan.json` / `chapters.json` / `meta.json` を上書きしうる
- `run` も同様に再実行禁止の扱い
- 章立てやタイトルだけ作り直したいなら `remeta` を使う
- 手編集を守りたいときに `--force` を自分判断で付けない

## 承認

- 承認の実体は `approvals.json`
- `cutplan.approved` や `shorts.json` の `approved` は表示上の意図にすぎない
- 承認レコードは `approve` / `unapprove` と GUI の保存だけが書く
- 承認後に keep 範囲を変えると承認は失効する

## 中間生成物

- `manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `plan-shorts.raw.txt`
- `render.props.json` / `whisper-out.*` / `transcript.system.json`
- `whisper-system-out.json` / `cut.mp4` / `cut.keeps.json`
- `render.key.json` / `preview.mp4` / `proxy.mp4` / `proxy.key.json`
- `frames/` / `render.chunks/` / `shorts/`
- `materials.probe/`

これらは再生成される前提なので、手で編集しない。

## 便利なコマンド

- `node src/cli.ts describe <dir>`
- `node src/cli.ts describe <dir> --json`
- `node src/cli.ts validate <dir>`
- `node src/cli.ts frames <dir> --t 90,2:30.5`
- `node src/cli.ts remeta <dir>`
- `node src/cli.ts approve <dir>`
- `node src/cli.ts unapprove <dir>`
- `node src/cli.ts render <dir>`

## 実装時の注意

- 既存のユーザー変更は勝手に戻さない
- 破壊的コマンドは使わない
- 変更後は必要十分な検証までやる
- 迷ったらコードではなく契約と既存のテストを先に見る

