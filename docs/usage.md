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
| `transcript.json` | **テロップ**の文言と表示タイミング。`track` でテロップトラック(既定 1)、`pos`(`{x, y}`: 出力px。トラックの `anchor` が無ければテキスト中心、`topLeft` なら左上)でそのテロップだけの表示位置。幅はテキストに自動で合い、折り返しは文言内の改行で指定、`style`(そのテロップだけの見た目。各項目とも省略可: `fontSizePx` / `color`(文字色)/ `outlineColor`(縁取り色。`"none"` で縁なし)/ `fontFamily`(CSS フォント指定)/ `fontWeight`(100〜900)/ `background`(座布団=背景帯。`{color, paddingPx?, radiusPx?}`))でそのテロップだけの見た目 | whisper の誤字修正、不要な字幕の削除、言い回し調整。位置はエディタのプレビュー上でドラッグ、サイズ・色・フォント・座布団は右側のインスペクタ(クリップ選択時に常時表示)で変更できる |
| `cutplan.json` | **どこを残すか**(`action`: keep/cut)。境界の秒数も手で微調整できる | preview を見て「切りすぎ」「ここは残す」 |
| `chapters.json` | **概要欄チャプター用メタデータ**(`start` / `title` のみ)。動画への描画には使われない: 章タイトルは plan が「章」という名前のテロップトラックとして transcript.json に書き、以降はただのテロップとして編集する | YouTube 概要欄に載せる章タイトルの言い換え |
| `overlays.json` | **演出**: 素材の表示(全画面または `rect` で部分配置。頭出し・音量・不透明度・フェード付き)・インサート編集・ワイプ全画面・字幕非表示・トラックの重なり順(`layerOrder`)・テロップトラックの標準設定(`captionTracks`: `{track, name, x, y, anchor, style}`。`name` はトラック名、`anchor: "topLeft"` で座標を左上基準に、位置・スタイルは個別指定の無いテロップに項目単位で効く) | B-roll を挟む、カメラだけの場面を作る(下の「演出」参照) |
| `bgm.json` | **BGM**を区間ごとに配置(`tracks[]`: `{start, end, file, volumeDb?, startFrom?, fadeInSec?, fadeOutSec?}`)。覆っていない区間は無音、別ファイルの区間で曲の切り替え・重奏。無ければ収録フォルダ直下の `bgm.*` を全編1曲で流す(後方互換) | イントロだけ BGM なし、途中で曲を変える、別の BGM を足す(下の「BGM」参照) |
| `meta.json` | 動画には影響なし。タイトル・概要欄の**下書き** | 投稿時のコピペ元 |

**触らないファイル**(中間生成物。再実行すると上書きされる):
`manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `render.props.json` /
`whisper-out.*` / `cut.mp4` / `cut.keeps.json`(cut.mp4 の再利用可否を
判定するキャッシュキー。keeps・音声設定・元収録ファイルが前回と同じなら
render は ffmpeg cut を省略する。削除すれば常にフル再生成に戻る)

## ⚠️ 最重要の注意: plan の再実行は手編集を消す

`plan`(と `run`)を再実行すると **cutplan.json / chapters.json / meta.json と
「章」トラックのテロップが上書きされる**(他のトラックのテロップは保たれる)。
手編集を始めたら plan は再実行しないこと。
「LLM の案は最初の1回だけ、以降は人間が育てる」が原則。

運用ルールだけには頼らない二重の防御がある:

- 生成物が既にあるときの `plan` / `run` は **`--force` を付けないとエラーで
  止まる**(初回は今までどおり何も聞かれない)
- `--force` で実行しても、上書き前に手編集ファイル一式(cutplan / chapters /
  meta / transcript / overlays)が **`backups/<日時>/` へ自動退避**される。
  消してしまったら退避先のファイルを収録フォルダ直下へコピーし直せば戻る
  (`transcribe` の単体再実行も transcript.json を同じ場所へ退避する)

## 個別コマンドの使い分け

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | 収録直後の1回だけ(2回目以降は `--force` が必要。実行前に backups/ へ退避) |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる。transcribe の再実行はテロップの手編集ごと上書きする(既存の transcript.json は backups/ へ退避される) |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(上記。2回目以降は `--force` が必要) |
| `remeta <dir>` | **カットは手編集済みだが、章立て・タイトル案・概要欄だけ作り直したい**とき。現在の cutplan の keep 区間(=完成動画)を見て chapters / meta と「章」トラックのテロップだけを再生成する。cutplan は触らないのでカットの手編集は保たれる(実行前に transcript / chapters / meta を backups/ へ退避) |
| `validate <dir>` | JSON を手編集した後は毎回。整合性エラー(exit 1)と警告を出す。概要欄チャプター(chapters.json)と画面表示の章タイトル(「章」トラックのテロップ)が食い違うと警告するので、片方だけ直した取りこぼしに気づける。GUI の保存も同じ検査を通す(壊れた JSON は保存できない) |
| `preview <dir>` | cutplan.json を編集するたび。approved が false でも動く |
| `render <dir>` | approved: true にした後。transcript.json 修正後の再実行も速い(再文字起こし不要) |

`preview` / `render` は GUI エディタのヘッダーの「プレビュー生成」「レンダー」
ボタンからも起動できる(未保存の編集は自動保存してから走る。render は
「承認済み」チェックが要る)。完了したレンダーは Finder で開く。

AI のカット判断を使いたくない回は、plan を1回走らせてから cutplan.json を
全部自分で直せばよい(実質手動編集)。cutplan.json を自分でゼロから
書いても動く(必要なのは `approved: true` と keep 区間のリストだけ)。

## 音量

- **最終出力は自動で -14 LUFS(YouTube 基準)に正規化される**ので、
  収録音量の多少のばらつきは気にしなくてよい(config.yaml `render.targetLufs`)
- **システム音声(OBS トラック2)は収録にあれば自動でマイクとミックス**されて
  出力に入る(render / preview / proxy 共通)。バランスは config.yaml
  `render.systemAudio.volumeDb`、`mix: false` でマイクのみ(従来どおり)に戻せる。
  正規化はミックス後の全体にかかる
- ただし**収録時のゲインが低すぎるのは別問題**: detect の無音判定
  (-35dB 以下=無音)に発言が引っかかってカットされる危険がある。
  OBS のメーターで、普通に喋って黄色ゾーン(-20〜-10dB)を目安に

## BGM

いちばん簡単なのは収録フォルダに `bgm.mp3`(または bgm.m4a / bgm.wav)を
置いて render するだけ。全編に自動ループで流れ、終端でフェードアウトする。

**区間ごとに BGM を出し分けたい**(イントロだけ無音、途中で別の曲に切り替え、
2曲を重ねる…)ときは収録フォルダに `bgm.json` を書く。`bgm.json` があると
上の `bgm.*` 全編1曲は無効になり、`tracks[]` の区間だけが流れる。

```jsonc
{
  "tracks": [
    // イントロ(元 0〜42.5 秒)は覆わない → 無音
    { "start": 42.5, "end": 600, "file": "bgm.mp3", "fadeInSec": 1 },
    // エンディングだけ別の曲(materials/ に置く)。終端でフェードアウト
    { "start": 600, "end": 640, "file": "materials/outro.mp3", "volumeDb": -18, "fadeOutSec": 3 }
  ]
}
```

- `start` / `end` は他の編集ファイルと同じく**元収録の秒**。ツールがカット後の
  時刻へ写像する(カットをまたぐ区間は自動でひと続きに繋がる)
- `file` は収録フォルダからの相対パス。**素材と同じように** `materials/` に
  別の BGM を置いて参照すればよい(アップロードはエディタの素材パネルからでも
  OK)。区間を並べれば曲の切り替え、区間を重ねれば重奏になる
- `volumeDb`(省略時は config の `render.bgm.volumeDb`)/ `startFrom`(頭出し)/
  `fadeInSec` / `fadeOutSec` を区間ごとに指定できる
- 音量は config.yaml `render.bgm.volumeDb`(デフォルト -22dB)。
  「BGMがうるさい動画」になるのを避けるため、声より20dB前後小さくが目安
- **発話中は自動でダッキング**(さらに `render.bgm.ducking.duckDb` 下げる。
  デフォルト -8dB、`fadeSec` 秒で滑らかに下げ・戻し)。どの区間の BGM にも
  効く。発話区間は無音検出(cuts.auto.json)から決定的に求めるので LLM は
  使わない。`duckDb: 0` で無効。エディタのプレビューでも同じ聞こえ方になる
- `bgm.json` を編集したら `validate` で検査する(区間・ファイル存在を確認)

## 演出(overlays.json)

収録フォルダに `overlays.json` を手で書くと、render 時に演出が合成される。
無ければ何も起きない(plan は生成しないので上書きの心配もない)。
時刻は他のファイルと同じく**元動画の秒**で書く。

```json
{
  "overlays": [
    { "start": 12.0, "end": 18.5, "file": "materials/bench-table.png" },
    { "start": 30.0, "end": 36.0, "file": "materials/demo.mp4", "layer": "over", "fit": "cover" },
    { "start": 60.0, "end": 66.0, "file": "materials/pip.mp4",
      "rect": { "x": 1200, "y": 60, "w": 640, "h": 360 },
      "startFrom": 3.0, "volume": 0.5, "opacity": 0.9,
      "fadeInSec": 0.5, "fadeOutSec": 0.5 }
  ],
  "inserts": [
    { "at": 40.0, "file": "materials/broll.mp4", "durationSec": 4.0, "startFrom": 5.0,
      "volume": 0.8, "fadeInSec": 0.3, "fadeOutSec": 0.3 }
  ],
  "wipeFull":    [ { "start": 50.0, "end": 55.0 } ],
  "hideCaption": [ { "start": 50.0, "end": 55.0 } ]
}
```

- **overlays**: 素材(画像/動画)を表示する。素材ファイルは収録
  フォルダ内に置く(相対パス)。`layer` 省略時は `under`
  - `under`: 背景(画面キャプチャ)だけ覆う。ワイプ・字幕は見える
  - `over`: ワイプごと覆う。字幕だけ素材の上に出る
  - `fit`: `contain`(全体を見せる・全画面時の余白は黒/省略時)か
    `cover`(領域を埋める・端が切れる)
  - `rect`: 表示領域 `{x, y, w, h}`(出力px)。省略時は全画面。指定すると
    ピクチャ・イン・ピクチャ的な部分配置になる(`contain` の余白は透過)。
    エディタではプレビュー上で枠をドラッグして移動・端のハンドルでリサイズできる
    (その素材が再生ヘッド上にあるとき)
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・動画のみ)
  - `volume`: 音量(0〜2、1=素材のまま)。**省略時 0=無音**(動画のみ。
    マイク音声・BGM はそのまま重なる)
  - `opacity`: 不透明度(0〜1。省略時 1)
  - `fadeInSec` / `fadeOutSec`: 表示区間の頭/末尾のフェード(秒。音量も連動)
- **inserts**: ベース映像を割って素材を差し込む(Premiere のインサート編集相当)。
  `at`(元収録の秒)の手前に `file` を `durationSec` ぶん挿入し、後続の映像・
  テロップ・章・素材は尺のぶん後ろへずれる。overlays と違い**音声込み**で全面に出る
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・
    動画のみ有効)。エディタでは挿入クリップの左端ドラッグでも調整できる
  - `fit`: `contain`(省略時)か `cover`
  - `volume`: 音量(0〜2。**省略時 1=素材のまま**、0 で無音)
  - `fadeInSec` / `fadeOutSec`: 黒からの明転/黒への暗転(秒。音量も連動)
- **wipeFull**: ワイプ(カメラ)を全画面にして背景を隠す区間。出入りは
  config.yaml の `render.wipeTransitionSec`(既定 0.3 秒、0 で瞬時。エディタの
  設定画面 ⌘, からも変更可)でなめらかに遷移する。遷移は区間全体の頭と末尾に
  だけ入り、カット・挿入・隣接エントリで区間が繋がっている継ぎ目では走らない
- **hideCaption**: 字幕(全テロップトラック)を出さない区間

注意: カット境界をまたいでも区間は1つに繋がったまま扱われ、動画素材も
連続再生される。ただしカットで消えた分だけ表示時間は短くなるため、
素材を最後まで見せたいときはカットされない区間内に収めるのが無難。
インサート(挿入)で時間が割り込まれる場合だけ区間が複数に割れ、
動画素材は挿入のあとも続きから再生される。

## 見た目の調整(Remotion Studio)

ワイプの大きさ・余白・字幕サイズ・テロップ既定の色/縁/フォントは
GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)から変更できる
(実体は config.yaml の `render` セクションなので YAML 手編集でもよい)。
黒帯などデザインそのものを変えたいときは `remotion/Main.tsx` を編集する。

設定画面で保存した変更のうちラウドネス(`targetLufs`)・システム音声・
プレビュー幅は proxy.mp4 に焼き込まれるため、エディタのプレビューへ
反映するにはプロキシの再生成が必要(保存後にバナーで案内が出る。
書き出しには再生成なしで反映される)。

## render の高速化(config.yaml `render.hardwareAcceleration`)

`render` の Remotion 合成段は `if-possible`(既定)で GPU ハードウェア
エンコーダ(macOS は VideoToolbox)を使い、`disable` で従来のソフトウェア
エンコードに戻せる。`if-possible` はハードウェアエンコーダが使えない
環境では自動でソフトウェアエンコードにフォールバックする(エラーには
ならない)。実測は docs/perf.md 参照。

`proxy.mp4` / `preview.mp4` は config.yaml `preview.videoEncoder`(既定
`videotoolbox`)で同じくハードウェアエンコーダを使う。生成時間は
`libx264` とほぼ同じだがファイルサイズが小さい。`libx264` を指定すると
従来の ultrafast+CRF に戻る。

```sh
# レイアウトだけ確認(動画部分はプレースホルダー表示)
npx remotion studio

# 実際の収録データを流し込んで確認(render を1回実行した後に使える)
npx remotion studio --props <収録フォルダ>/render.props.json --public-dir <収録フォルダ>
```

Studio はブラウザで開く動画エディタ風の画面で、Main.tsx を保存すると
即座に反映される。デザインが決まったら通常の `render` を実行する。
