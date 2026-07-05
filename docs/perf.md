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
