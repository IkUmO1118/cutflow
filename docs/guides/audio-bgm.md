# 音(BGM・音量・A/V)

> 音量・BGM の配置と自動調整、A/V フィードバックの読み方。
> 関連: [export.md](export.md) / [command-reference.md](command-reference.md) / [../usage.md](../usage.md)

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
- **マイクの環境ノイズが気になる場合**は config.yaml `render.denoise.mic: true`
  でノイズ除去(ffmpeg afftdn)がかかる(既定 false)。**マイク音声にのみ**
  かかり、システム音声(アプリ音・デモ音)は対象外(デジタル由来でノイズが
  無く、通すと音楽・効果音が劣化するため)。強さは `noiseFloorDb`(既定 -25。
  下げるほど控えめ、上げるほど強い)で調整。正規化(loudnorm)より前段に
  入るため、ノイズ除去後の音声に対して -14 LUFS へ揃う


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


## BGM 配置候補の自動生成(plan-bgm)

`plan-bgm <dir>` は、編集済みタイムラインのどこにどの曲を敷くか
(または無音のままにするか)、LLM に**番号選択**だけさせて `bgm.json` の
下書きを作るコマンド。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **切替アンカー(B3・決定論)**: BGM を切り替える/区切る境界を機械的に
  列挙する。ソースは①**章境界**(`chapters.json` の各 `start`。あれば)と
  ②**大きなカット境界**(`cutplan.json` の cut 区間のうち尺が
  `config.yaml` の `planBgm.bigCutSec`(既定3.0秒)以上の所)。先頭(0)と
  末尾(総尺)も端アンカーに含める。`planBgm.minSlotSec`(既定8.0秒)未満の
  間隔で近接するアンカーは1つへマージする(章タイトルなど情報量の多い方を
  優先して残す)
- **区間スロット(B1)**: 隣り合うアンカーで挟まれた区間をスロットとして
  番号で列挙する。`minSlotSec` 未満のスロットは前後のスロットへ吸収され、
  `planBgm.maxSlots`(既定12)を超えるぶんは打ち切る(区切りすぎ防止。
  末尾の未カバー区間は BGM を敷かない=無音のままになる。これは正当な
  出力)。各スロットには章タイトル等の意味づけと、カット控除後にその
  区間で実際に再生される秒数(可視秒)を添えて LLM に渡す
- **曲候補**: `materials/` の音声ファイル(拡張子 `.mp3`/`.m4a`/`.wav`/
  `.aac`/`.flac`/`.ogg`)∪ 収録フォルダ直下の `bgm.mp3`/`bgm.m4a`/`bgm.wav`
  の実在集合に番号を振る。0件のときは「BGM 候補ファイルが無い」と告げて
  exit 1(例外にはしない)
- **番号選択のみ**: LLM に渡すのはスロット一覧(`#id [開始-終了] 可視Ns
  意味づけ`)と曲一覧(`#id ファイル名`)の2リストだけ。LLM の応答は
  `{ "assignments": [{ "slotId": N, "file": M または null, "reason": "..." }] }`
  のみで、時刻・ファイルパス・音量は一切書かせない。番号 → 実体の変換、
  存在しない番号の無視、**隣接スロットが同じ曲番号なら1トラックへ連結**
  (無駄な切れ目を作らない)、`file: null`(無音)のスロットは track を
  作らない、はすべてコード側が行う
- **音量/duck は触らない**: `volumeDb` 等は書かず config 既定
  (`render.bgm.volumeDb`)に任せる。無音・被り回避(B2)や fallback 検出
  (B4)は別コマンドの対象(本コマンドのスコープ外)
- **書き込み前検査(all-or-nothing)**: 組んだ `bgm.json` 下書きを、書く前に
  `validate` と同じ検査(区間・ファイル実在等)へ通す。1つでも不正なら
  1バイトも書かない
- **既存 `bgm.json` は `--force` 必須**(実行前に `backups/` へ退避)
- **承認不要・下書き扱い**: bgm の編集は承認 hash を失効させない
  (§承認(approve/unapprove))ため、生成しても既存の cutplan/short の承認は
  生きたまま。ただし人間が preview / エディタで聴いて、要らなければ消す前提
- **chapters.json が無くても動く**: 章境界アンカーが作れないだけで、
  大カット境界だけで区間割りする(区間の意味づけは薄くなる旨を告知)
- **測定の注意**: LLM 出力(選曲)は非決定的なので、単発 diff で選曲の質
  (区間と曲の雰囲気の一致度)は採点できない。決定論部分(アンカー生成・
  スロット化・連結・番号安全網)はテストで固定し、選曲の当否は人間が
  preview で聴いて判断する

```sh
node src/cli.ts plan-bgm <dir>          # bgm.json へ配置下書きを生成
node src/cli.ts validate <dir>          # 区間・ファイル実在を確認
node src/cli.ts av <dir>                # sound レポートで BGM spans の反映を確認
```


## BGM の音量/被り/単調の検出と調整提案(bgm-fit)

`bgm-fit <dir>` は、**既に置かれている** BGM(`bgm.json`)の音量/duck/フェードが
`av.probe/sound.json`(要 `av <dir>` の事前実行)の実測と合っているかを検品し、
補正案を `apply` パッチ下書き(`bgm-fit.suggested.json`)として出すコマンド。
`plan-bgm`(SD-B1)が
BGM の区間割り・選曲を**作る**のに対し、こちらは既存の BGM を**直す**役割で、
区間割り・選曲は一切行わない。**LLM を一切使わない決定論コマンド**(補正値は
すべて `av.probe/sound.json` の実測値からの算術)。

- **B2(無音/被り回避の音量・フェード補正。常に成功)**:
  - **speech-overlap**: `tracks.samples` を BGM の active 区間(`av` の
    `bgm.spans` から。トラックの `file` で対応付け)へ突き合わせ、`louder`
    が発話(mic)以外優勢の区間を「BGM が発話に被っている」とみなし、
    発話 RMS を `bgmFit.speechHeadroomDb` 下回るところまで `volumeDb` を
    下げる補正を出す
  - **silence-float**: `silences`(発話の無い区間)に BGM が原音量のまま
    乗っている箇所を「浮いている」とみなし、`bgmFit.silenceDuckDb` 下げる
    補正を出す
  - **loud**: `mix.integratedLufs` が `bgmFit.targetLufs` を超過していれば、
    BGM が主因という前提で全トラックへ超過分の `volumeDb` 減を出す
  - **no-fade**: 動画終端まで続くトラックに `fadeOutSec` が無ければ
    `bgmFit.minFadeSec` の付与を出す
  - **二重 duck 回避**: `av` の `bgm.duckSpans`(render が既に発話ダッキングを
    掛けている区間)を過半含む問題区間には補正を出さない(render 側で
    既に下がっているため)
  - 1トラックにつき `volumeDb` の補正は高々1本(speech-overlap →
    silence-float → loud の優先順)。v1 はトラック全体の `volumeDb` を
    下げる提案に留め、区間限定の減衰(トラック分割)は今後の拡張
- **B4(単調/fallback 検出。区間割り・選曲はしない)**: `bgm.json` が無く
  収録直下 `bgm.*` の全編1曲 fallback、または `bgm.json` が単一 file で
  総尺の `bgmFit.monotoneCoverRatio` 超を覆っているとき、章数が
  `bgmFit.minChaptersForVariety` 以上あれば「章が複数なのに BGM が単調」と
  警告し `plan-bgm <dir>` へ誘導する
- **収録フォルダへ直接書かない**: 出力は検出結果 `bgm-fit.json`(機械可読。
  findings 一覧 + 単調/fallback 判定)+ stdout の人間向けレポート + 補正候補が
  あるときだけの `bgm-fit.suggested.json`(使い捨ての `apply` パッチ下書き)。
  `bgm.json` の編集は必ず人間が `apply --patch` を経由する
- **bgm トラックの `@id` は補正が出るときだけ必要**: id の無いトラックに
  実際に B2 補正(volumeDb/fadeOutSec の set)が出る場合に限り「先に
  `id-stamp <dir>`」と告げて exit 1(補正 op の宛先に `@id` が要るため)。
  B4 の単調誘導だけ・検出なしのときは id 不要で通し exit 0(`plan-bgm` の
  出力は id 無しなので、この緩和で通常鎖 `plan-bgm` → `av` → `bgm-fit` が
  止まらない)
- **av.probe の欠如は優雅に拒否**: `av.probe/sound.json` が無ければ「先に
  `av <dir>`」と告げて exit 1
- **render の duck 実装は変えない**: `src/lib/duck.ts` は無改修。本コマンドは
  「配置意図」を `volumeDb`/`fadeOutSec` の補正案として `bgm.json` へ提案する
  だけで、render 時の動的ダッキングはそのまま効く
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない

```sh
node src/cli.ts bgm-fit <dir>       # 検出し apply パッチ下書きを書く
node src/cli.ts apply <dir> --patch bgm-fit.suggested.json --dry-run  # 変更内容を確認
node src/cli.ts apply <dir> --patch bgm-fit.suggested.json           # 適用
node src/cli.ts validate <dir>      # 適用後、整合性を再確認
```


## A/V フィードバックを知る(av)

`av <dir>` は、AI が keep 後タイムラインの**動き**と**音**を機械可読に読むための
知覚コマンド。動画再生 UI は作らず、ffmpeg だけで観測を JSON に落とす。

```sh
node src/cli.ts av <dir>
node src/cli.ts av <dir> --range 10-25.5
node src/cli.ts av <dir> --short intro --sound-only
node src/cli.ts av <dir> --full-res --motion-only
```

**出力**: `av.probe/motion.json` / `av.probe/sound.json` /
`av.probe/motion.strip.png`

- `motion.json`
  - keep 後タイムライン上のフィルムストリップのタイル時刻
  - `sceneScore` の時系列
  - `freezedetect` による freeze 区間
- `sound.json`
  - mic+system ベッドの統合 LUFS / true peak / short-term LUFS 包絡
  - 無音区間
  - mic/system の window ごとの RMS とどちらが大きいか
  - BGM 区間と duck 区間(実測ではなく render props 由来の解析値)
- `motion.strip.png`
  - keep 後タイムラインを `--every` 秒ごとに並べたフィルムストリップ

**主なオプション**

- `--range <a-b>`: **出力(カット後)秒**で部分区間を切る
- `--every <sec>`: motion サンプル間隔
- `--short <name>`: `shorts.json` の対象ショートの `ranges` を使う
- `--full-res`: motion の基映像に `proxy.mp4` ではなく元収録を使う
- `--motion-only` / `--sound-only`: 片側だけ取得

**キャッシュ**

- `av.probe/` は `materials.probe/` と同じ差分更新型
- 同じ入力 key なら JSON を再利用し、ffmpeg を再実行しない


