# 編集を回すためのツール運用(GUI エディタ / frames-serve / clean)

> GUI エディタの起動・外部編集との共存、frames の常駐サーバ、ディスク掃除。
> 関連: [captions-layout.md](captions-layout.md) / [command-reference.md](command-reference.md) / [../usage.md](../usage.md)

## GUI エディタのバックグラウンド起動(--detach)

`editor <dir>` は既定でフォアグラウンド常駐(終了は Ctrl+C)だが、ターミナルへ
出るのは起動 URL の2行だけで、あとは画面を占有するだけになる。GUI で編集
しながら同じターミナルで `validate` / `describe` / `frames`(や Claude Code)を
回したいときは `--detach` を使う。

```sh
node src/cli.ts editor <dir> --detach   # バックグラウンド起動。ターミナルは即返る
node src/cli.ts editor <dir> --status   # 起動しているか(URL・pid・ログの場所)
node src/cli.ts editor <dir> --stop     # 止める(冪等。起動していなければ何もしない)
```

- 待受情報(`{dir, port, pid, startedAt}`)とログは**収録フォルダの外**の
  `~/.cutflow/editor/<slug>.json` / `<slug>.log` に置く(`slug` は収録フォルダの
  実パスの sha256 先頭12桁)。収録フォルダに置かないのは、これが編集ファイル
  でも中間生成物でも承認レコードでもない実行時状態であり、`clean <dir>` に
  消されると起動中のエディタを `--stop` できなくなるため
- **既定はフォアグラウンドのまま**(Ctrl+C という分かりやすい停止手段を残す)。
  フォアグラウンド起動でも待受情報は同じように書くので、`--status` はどちらの
  起動でも見える
- デタッチしたサーバの stdout/stderr(波形デコード失敗などの警告)は上記の
  ログファイルへ行く。起動に失敗した場合(ポート 4310 使用中など)は
  `--detach` がログの末尾を添えてエラーにする
- 同じ収録フォルダを二重にデタッチ起動しようとすると、起動中の URL と停止
  コマンドを示して止まる。プロセスが `kill -9` 等で消えて待受情報だけ
  残った場合は、次の `--status` / `--detach` が応答の無い待受情報を掃除する


## GUI エディタ起動中の外部 JSON 編集

GUI エディタを開いたまま、Claude Code や別のエディタで
`cutplan.json` / `transcript.json` / `overlays.json` / `bgm.json` /
`shorts.json` を編集してよい。GUI 側に未保存の編集が無ければ、外部変更は
従来どおり自動で読み込まれる。

GUI 側にも未保存の編集があるときは、エディタ上部に外部変更バナーが出る。
外部変更と GUI 側の未保存編集が別の hunk なら自動マージされ、同じ
id 付き要素の同じフィールド、または id が無い配列全体が衝突した場合だけ
「差分をレビュー」で選べる。レビューでは hunk ごとに「自分の版」か
「ディスク版」を選び、「適用」で GUI の live state に反映する。適用だけでは
ファイルには書かれないので、内容を確認してから通常どおり保存する。

GUI の AI コマンドも同じ差分レビューを通る。1 回の自然言語指示は
`提案 → static validation(planApply) → diff review → 適用 → 保存 → 任意の
frames 確認` を 1 つの workflow として扱い、レビュー画面から
`適用のみ` / `適用して保存` / `適用して確認` を選ぶ。`適用して確認` は
隠れた保存ではなく、保存してから確認フレームを生成する明示的な経路。


### frames-serve(常駐フレームサーバ)

`frames` は1回の実行の中では bundle(webpack)と headless Chrome を使い
回すが、CLI は呼び出しのたびに別プロセスなので、微調整ループ(JSON 編集 →
`frames --t 90` → 確認 → JSON 編集 → `frames --t 90` → …)は毎回そのコールド
コストを払い直す。`frames-serve <dir>` はこれを暖めたまま待ち受ける**opt-in**
の常駐デーモン:

```sh
node src/cli.ts frames-serve <dir>          # 起動(bundle+browser を暖機。数十秒)
node src/cli.ts frames-serve <dir> --port 5000  # ポートを変えたいとき(既定 4311)
```

起動している間、`frames <dir> --t ...` 等は自動でデーモンを検出して撮影を
委譲する(何も指定しなくてよい)。**暖めるのは bundle(webpack)と browser
だけ**で、`config.yaml` と編集 JSON(cutplan/transcript/overlays/shorts)は
毎リクエスト読み直すので、デーモン経由でも単発実行と出る絵は完全に同一
(config 編集・JSON 編集は即座に反映される)。

- **opt-in**: `frames-serve` を明示的に起動しない限り、`frames` の挙動・
  出力は現状と1バイトも変わらない(portfile 有無の `existsSync` 1回が
  増えるだけ)
- **中間生成物**: `frames/.serve.json`(`{port, pid}`)。デーモン起動中だけ
  存在し、終了(Ctrl+C)時に自動で消える。`props.json`/`index.json` と同じ
  位置づけで、手で編集・作成しない
- **remotion を触ったら**: `remotion/*.tsx` の変更は mtime で検知して
  自動的に再バンドルする(`node_modules/.cache/webpack` の陳腐化ごと
  作り直す)ので、通常は再起動不要。ただしバンドル自体に失敗する等の
  異常時は一度 Ctrl+C で再起動すれば復旧する
- **終了**: Ctrl+C。`frames/.serve.json` を残さない
- 1 デーモン = 1 収録(bundle が対象フォルダに束縛されるため)。別の収録を
  同時に暖めたいときはポートを変えて別プロセスを立てる

`preview` / `render` は GUI エディタのヘッダーの「プレビュー生成」「レンダー」
ボタンからも起動できる(未保存の編集は自動保存してから走る。render は
「承認済み」チェックが要る)。完了したレンダーは Finder で開く。

AI のカット判断を使いたくない回は、plan を1回走らせてから cutplan.json を
全部自分で直せばよい(実質手動編集)。cutplan.json を自分でゼロから
書いても動く(必要なのは keep 区間のリストと、preview 確認後の
`node src/cli.ts approve <dir>` だけ)。


## 掃除とディスク(clean)

`node src/cli.ts clean <dir>` は収録フォルダに溜まった中間生成物・キャッシュを安全に消す。
削除対象の分類は `src/lib/files.ts` の `fileRole`(単一の真実)由来で、**role が
`generated` のトップレベル子エントリだけ**を消す。`cutplan.json` 等の編集ファイル・
`approvals.json`(承認レコード)・`materials/`(人間の素材)・元収録(raw)・成果物
(`final.mp4` / `thumbnail.png` / `bgm.*`)には1バイトも触れない。非 generated ディレクトリ
(`materials/` / `backups/`)には降りないので、その配下は常に安全。

- 既定: すべての中間生成物(`manifest.json` / `cuts.auto.json` / `proxy.mp4` /
  `cut*.mp4` / `render.chunks/` / `frames/` / `shorts/` / 各 `*.probe/` / `whisper-out.*` /
  `*.suggested.json` / `plan.first.json` / `plan-effects.first.json` 等)を削除。
- `--cache-only`: 再生成の重いキャッシュ(`proxy.mp4` / `cut*.mp4` / `render.chunks/` /
  `frames/` / `shorts/` / `materials.probe/` / `av.probe/` / `review.probe/` /
  `preview.mp4` / `*.key.json` / `render.props.json`)だけを消す。再文字起こしが数分かかる
  `whisper-out.*` や `manifest.json` / `cuts.auto.json` 等の**軽くて再生成が高価**な
  中間生成物は残す。write-once初版の`plan.first.json` / `plan-effects.first.json`も残す。
- `--logs-only`: ログ・検品結果・使い捨て下書きだけを消す。write-once初版の
  `plan.first.json` / `plan-effects.first.json`は測定資産なので残す。
- `--dry-run`: 何も消さず、削除対象の一覧と解放バイトだけを表示。
- `--json`: `CleanPlan`(targets / fileCount / dirCount / bytes / dryRun)を純 JSON で
  stdout に出す(`--dry-run` と併用で機械可読なプレビュー)。
- 冪等: 2回目以降は対象なしで exit 0。存在しないファイルは無視する。

```sh
node src/cli.ts clean <dir> --dry-run           # 何が消えるか確認するだけ
node src/cli.ts clean <dir> --cache-only        # 重いキャッシュだけ掃除(whisper-out等は残す)
node src/cli.ts clean <dir>                     # 全中間生成物を掃除
node src/cli.ts clean <dir> --dry-run --json    # 機械可読な削除計画(パイプ可)
```
