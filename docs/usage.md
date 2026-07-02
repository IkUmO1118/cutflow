# 使い方ガイド(人間が調整しながら使うワークフロー)

cutflow は「全部AI任せ」のツールではない。**自動処理は最初の1回だけ、
以降は人間が JSON を直しながら preview / render と往復する**のが正しい使い方。

## 全体フロー

```
① 収録 → ~/Movies/cutflow/<日付-内容>/ に mkv を置く
     (企画ブリーフがあれば brief.md としてコピーしておくと plan の材料になる)

② node src/cli.ts run <フォルダ>
     自動部分を一括実行: ingest → transcribe → detect → plan(LLM呼び出し込み)

③ 人間の編集タイム(下の表のファイルを直す)

④ node src/cli.ts preview <フォルダ>
     カットのテンポを軽い動画(preview.mp4)で確認
     → 気に入らなければ ③④ を何度でも往復

⑤ cutplan.json の "approved": false を true に書き換え(承認)

⑥ node src/cli.ts render <フォルダ>
     final.mp4 完成(音量は自動で -14 LUFS に正規化される)
     → テロップを直したくなったら transcript.json を編集して ⑥ だけ再実行

⑦ meta.json のタイトル案・概要欄、chapters.json の章をYouTube投稿に使う
```

## どのファイルを直すと何が変わるか

時刻はすべて**元動画(収録ファイル)の秒**で書く。カット後の時刻への
換算はツールが自動でやるので、頭の中で引き算する必要はない。

| ファイル | 直すと変わるもの | 編集する場面 |
|---|---|---|
| `transcript.json` | **テロップ**の文言と表示タイミング | whisper の誤字修正、不要な字幕の削除、言い回し調整 |
| `cutplan.json` | **どこを残すか**(`action`: keep/cut)。境界の秒数も手で微調整できる | preview を見て「切りすぎ」「ここは残す」 |
| `chapters.json` | **章カード**と概要欄チャプター | 章タイトルの言い換え、位置調整 |
| `meta.json` | 動画には影響なし。タイトル・概要欄の**下書き** | 投稿時のコピペ元 |

**触らないファイル**(中間生成物。再実行すると上書きされる):
`manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `render.props.json` /
`whisper-out.*` / `cut.mp4`

## ⚠️ 最重要の注意: plan の再実行は手編集を消す

`plan`(と `run`)を再実行すると **cutplan.json / chapters.json / meta.json が
上書きされる**。手編集を始めたら plan は再実行しないこと。
「LLM の案は最初の1回だけ、以降は人間が育てる」が原則。

## 個別コマンドの使い分け

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | 収録直後の1回だけ |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(上記) |
| `preview <dir>` | cutplan.json を編集するたび。approved が false でも動く |
| `render <dir>` | approved: true にした後。transcript.json 修正後の再実行も速い(再文字起こし不要) |

AI のカット判断を使いたくない回は、plan を1回走らせてから cutplan.json を
全部自分で直せばよい(実質手動編集)。cutplan.json を自分でゼロから
書いても動く(必要なのは `approved: true` と keep 区間のリストだけ)。

## 音量

- **最終出力は自動で -14 LUFS(YouTube 基準)に正規化される**ので、
  収録音量の多少のばらつきは気にしなくてよい(config.yaml `render.targetLufs`)
- ただし**収録時のゲインが低すぎるのは別問題**: detect の無音判定
  (-35dB 以下=無音)に発言が引っかかってカットされる危険がある。
  OBS のメーターで、普通に喋って黄色ゾーン(-20〜-10dB)を目安に

## BGM

収録フォルダに `bgm.mp3`(または bgm.m4a / bgm.wav)を置いて render するだけ。

- 動画の長さに合わせて自動ループ、終端でフェードアウト
- 音量は config.yaml `render.bgm.volumeDb`(デフォルト -22dB)。
  「BGMがうるさい動画」になるのを避けるため、声より20dB前後小さくが目安

## 見た目の調整(Remotion Studio)

ワイプの大きさ・余白・字幕サイズは config.yaml の `render` セクションで変更。
字幕の色・黒帯・章カードのスタイルなどデザインそのものを変えたいときは
`remotion/Main.tsx` を編集する。

```sh
# レイアウトだけ確認(動画部分はプレースホルダー表示)
npx remotion studio

# 実際の収録データを流し込んで確認(render を1回実行した後に使える)
npx remotion studio --props <収録フォルダ>/render.props.json --public-dir <収録フォルダ>
```

Studio はブラウザで開く動画エディタ風の画面で、Main.tsx を保存すると
即座に反映される。デザインが決まったら通常の `render` を実行する。
