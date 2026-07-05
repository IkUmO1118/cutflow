# 性能ベースライン

各コマンドの所要時間を計測して記録する。フェーズ0で全コマンドに経過時間
表示(`(所要時間: X.X秒)`)を追加した。`render` は内訳(loudnorm実測/
ffmpeg cut/Remotion)も出す。数値はフェーズを追うごとに下に追記していく。

## 計測環境

- 機種: MacBook Air (Apple M5, 16GB)
- OS: macOS 26.5.1
- Node: v24.18.0
- ffmpeg: 8.1.2
- 収録: `~/Movies/cutflow/2026-07-02-whisper-bench`
  (元収録 2:22.6 / 出力(カット後) 2:08.3、keep 19区間)

`plan` / `run` はこの収録フォルダにすでに手編集済みの生成物があり、
CLAUDE.md の決まり(再実行禁止・`--force` で手編集を退避)により
ベースライン計測のために再実行していない。以下は非破壊なコマンド
(`validate` / `describe` / `frames` / `preview` / `render`、および
`frames` から間接的に呼ばれる `proxy` 単体)の実測。

## フェーズ0: ベースライン(2026-07-05)

| コマンド | 所要時間 | 内訳 |
|---|---|---|
| `validate` | 0.0秒 | - |
| `describe` | 0.0秒 | - |
| `preview` | 9.0秒 | - |
| `proxy`(単体。`frames` が初回に自動生成) | 10.2秒 | - |
| `render` | 216.3秒 | loudnorm実測 2.3秒 / ffmpeg cut 21.2秒 / Remotion 192.8秒 |

**所見**: `render` の内訳を見ると Remotion 合成が全体の約89%
(192.8/216.3秒)を占め、次に ffmpeg cut が約10%(21.2秒)。
loudnorm 実測は誤差程度(2.3秒)。

- フェーズ1(cut.mp4 キャッシュ)は「テロップだけ直して render し直す」
  ような、keeps・音声設定が変わらない再実行で ffmpeg cut(21.2秒)+
  loudnorm実測(2.3秒)= 約23.5秒をスキップできる見込み。
- フェーズ2(Remotion 高速化)は全体の9割を占める Remotion 段が対象
  なので、効果が出れば体感インパクトが最大。
- フェーズ3(proxy/preview のエンコーダ切替)は `proxy`(10.2秒)・
  `preview`(9.0秒)が対象。すでに軽いので改善余地は小さいが、
  収録が長くなるほど効いてくる。

## フェーズ1: cut.mp4 キャッシュ(2026-07-05)

`cut.keeps.json`(mergeIntervals 済み keeps・`targetLufs`・
`systemAudio.mix/volumeDb`・`manifest.audio.micStream/systemStream`・
元収録ファイルの mtime+size をキーとして記録)が `cut.mp4` と一致すれば
render はそのまま再利用し、loudnorm実測+ffmpeg cut を省略する。

同一収録での実測:

| シナリオ | ffmpeg cut 段 | render 合計 |
|---|---|---|
| 初回(cut.keeps.json なし) | loudnorm実測 2.3秒 + ffmpeg cut 21.2秒 | 221.2秒 |
| 再実行・変更なし | スキップ(「cut.mp4 を再利用します」) | 205.7秒 |
| `targetLufs` を変更(-14→-16) | loudnorm実測 2.4秒 + ffmpeg cut 21.2秒(再生成) | 216.7秒 |
| `transcript.json` だけ編集(keeps不変) | スキップ(再利用) | 234.5秒/250.6秒 |

**所見**: keeps・音声設定・元収録ファイルが不変な再実行(テロップ・演出の
微調整サイクル)では ffmpeg cut 段(約23.5秒)が丸ごと消える。`targetLufs`
変更時は正しく検知して再生成された(単体テスト: `test/cutCache.test.ts`
で keeps / targetLufs / systemAudio / manifest.audio / 元ファイルの
mtime・size のいずれの変化も不一致として検出することを固定済み)。
render 合計の分散は Remotion 段(192〜251秒)の実行時ばらつきが支配的で、
ffmpeg cut のスキップ自体の効果は内訳行で確認できる。

**切り戻し**: `cut.keeps.json` と `cut.mp4` を削除すれば次回 render は
常にフル再生成に戻る。

## フェーズ2: Remotion ハードウェアエンコーダ(2026-07-05)

事前に Remotion 4.0.484 の実装(`node_modules/@remotion/renderer/dist/
get-codec-name.js` / `probe-encoder.js`)と公式ドキュメント
(remotion.dev/docs/hardware-acceleration・/docs/encoding)を確認:
`--hardware-acceleration` は `disable`(Remotion 既定)/ `if-possible` /
`required` を受け付け、macOS + codec h264 では `if-possible`/`required` で
`h264_videotoolbox` を選ぶ(利用可否は ffmpeg の `-encoders` で実際に
probe する)。`if-possible` はエンコーダが無い環境ではソフトウェア
(`libx264`)へ自動フォールバックし失敗しない。制約: `crf` /
`encodingMaxRate` / `encodingBufferSize` を指定すると `required` はエラー、
`if-possible` は警告してソフトウェアへ落ちる(本ツールの Remotion 呼び出し
はこれらを指定していないため影響なし)。

config.yaml に `render.hardwareAcceleration`(既定 `if-possible`、
`disable` で従来の Remotion 既定=ソフトウェアエンコードに戻せる)を追加し、
render.ts の remotion CLI 呼び出しに反映。`--log verbose` で
`Encoder: h264_videotoolbox, hardware accelerated: true` を確認済み
(実際に GPU エンコーダが使われている)。

**実測(Remotion 段のみ、`--hardware-acceleration if-possible`)**:

| 条件 | Remotion 段 |
|---|---|
| フェーズ0ベースライン(ハードウェアエンコーダ未指定=ソフトウェア) | 192.8秒 |
| `if-possible`(h264_videotoolbox 使用) | 195.1秒 |
| `if-possible` + `--concurrency 10`(全コア。既定は5) | 229.5秒 |
| `if-possible`(既定 concurrency、2回目) | 241.8秒 |

**所見**: ハードウェアエンコーダへの切り替え自体では明確な短縮が
見られなかった。連続実行で 195→230→242秒と実行のたびに悪化しており、
ファンレス機体(MacBook Air M5)の熱制限による変動の影響が実測差より
大きく、単発測定ではエンコーダ・concurrency 変更の効果を切り分けられ
なかった。ボトルネックは最終エンコードではなく Remotion のフレーム
レンダー(headless Chrome でのコンポジット)側にあると考えられる
(`stitchFramesToVideo()` のログで実際に `h264_videotoolbox` 使用を確認
済みだが総時間は変わらないため)。`--concurrency 10` はむしろ悪化した
ため既定(5)のままとし、config 化は見送った。

`hardwareAcceleration: if-possible` は失敗しない設計(未対応環境は自動
フォールバック)なので実害はなく既定のまま残すが、体感速度への効果は
限定的という前提で報告する。画質は `frames --every 30` で目視し、
クロップ・ワイプ・テロップのレイアウト崩れは無し(画面キャプチャの
細かい文字の可読性はプロキシ解像度画像では判断できないため、最終判断は
人間の preview に委ねる)。
