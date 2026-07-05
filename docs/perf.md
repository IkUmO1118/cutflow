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

## フェーズ3: proxy/preview のエンコーダ切替(2026-07-05)

`proxy.ts` / `preview.ts` のビデオエンコード引数を `src/lib/videoEncode.ts`
に切り出し、config.yaml `preview.videoEncoder` で `h264_videotoolbox`
(既定・`-q:v 50`)と従来の `libx264 -preset ultrafast -crf 28` を切替可能に
した。`-g 30`(GOP 1秒)と `+faststart` はどちらでも必ず付く。

同一収録(実際の proxy/preview 生成パイプライン、loudnorm 実測込み)での実測:

| コマンド | libx264(従来) | h264_videotoolbox(新既定) |
|---|---|---|
| `proxy`(`frames` 経由の自動生成) | 10.3秒 / 18.5MB | 10.1〜10.2秒 / 6.5MB |
| `preview` | 8.1秒 / 12.6MB | 7.9〜8.0秒 / 4.5MB |

**所見**: 生成時間はフェーズ2の Remotion と同様にほぼ差が無かった
(decode・scale・loudnorm 実測側が支配的で、この解像度・尺では
エンコード自体がボトルネックではない)。一方でファイルサイズは
`h264_videotoolbox` が libx264 の 1/3〜1/2.8 程度と明確に小さい。
画質はターミナルの文字・顔とも同一フレームで目視比較し、プレビュー
解像度(1280px)では判別できる劣化は無かった。

生成時間で明確な勝者が出なかったため、判断基準は
「同等の速度・画質でファイルサイズが小さい」という点に置き、
`h264_videotoolbox` を新しい既定にした(`videoEncoder: libx264` で
いつでも従来動作に戻せる)。cut.mp4(cutFullRes)側はもともと
`h264_videotoolbox` を無条件で使っており、今回の変更でこの前提と
揃った。

エディタのスモークテスト: `node src/cli.ts editor` を再起動した上で
(クライアントは起動時バンドルのため)確認。この環境には Chrome が
無く chrome-devtools MCP でのブラウザ操作(実クリック・シーク)は
実行できなかったため、代わりにサーバー配信側を検証した:
`/media/proxy.mp4` への Range リクエストで `206 Partial Content` +
正しい `Content-Range` を確認(Player のシークが依存する経路)、
`ftyp→moov→mdat` の順(+faststart 効いている)とキーフレーム間隔
ちょうど1秒(`-g 30` 反映)を実ファイルから直接確認した。ブラウザでの
実際の見た目・操作感の最終確認は人間に委ねる。

preview.mp4 を proxy.mp4 から切り出す案(音声正規化の二重適用と
staleness 連鎖の懸念あり)は、proxy 高速化後の `preview` 生成が
7.9〜8.1秒(30秒超の痛点なし)のため、今回は提案のみに留め実装しない。

## フェーズ4: エディタ再生・編集の主スレッド負荷(2026-07-05)

エディタは proxy.mp4 を Remotion Player で keep 区間ごとに飛び飛び再生し、
プレビューと最終レンダーは `buildRenderProps` を共有して「同じ絵」を保証する。
長尺(テロップ数百件)での主スレッド負荷を、技術リードの未計測推定
①〜④に沿って実測した。

**計測手段**: この環境には Player を実駆動できるブラウザが無く(フェーズ3と
同じ制約)、1時間ぶんの実 proxy.mp4 も無いため、React Profiler / Chrome
トレースの代わりに**ホットパスの実関数を Node で直接ベンチした**
(`buildRenderProps` / `remapInterval` / `frameSpans` / captionAt 相当 /
`JSON.stringify`)。合成プロジェクトは keep と cut を交互に敷いて 30分/1時間/
2時間、テロップを隙間なく敷いて 約450/900/1800件。①②④ は「編集・再生中に
主スレッドで実際に走る関数」そのものなので、この直接計測で CPU コストを
切り分けられる。フレーム落ち・補正シークの有無の目視最終確認は人間の
preview に委ねる(下記「除外」参照)。

### 実測(1回あたり。①は再生10秒=300フレーム分を合算)

| 推定 | 何 | 30分/約450件 | 1時間/約900件 | 2時間/約1800件 | 走る頻度 |
|---|---|---|---|---|---|
| ② | `buildRenderProps` 全体 | 0.14ms | 0.16ms | 0.30ms | 1キーストローク/ドラッグ毎 |
| ② | App.clips 相当(全 remap) | 0.06ms | 0.10ms | 0.21ms | 同上 |
| ① | captionAt **線形**(1フレーム) | 0.7µs | 0.8µs | 2.2µs | 再生中 毎フレーム×トラック |
| ① | captionAt **二分**(1フレーム) | ~0µs | 0.1µs | ~0µs | 同上 |
| - | `frameSpans`(1フレーム) | 7µs | 10µs | 30µs | 再生中 毎フレーム(memo前) |
| ④ | `JSON.stringify`(4文書) | 0.08ms | 0.16ms | 0.36ms | ドキュメント差し替え時のみ |

**所見**: 推定①②④ の絶対コストはいずれもサブミリ秒で、2時間・1800件でも
フレーム予算(33ms)に対して桁違いに小さい。理由は、時刻写像の重い原始関数
(`remapInterval` / `toOutputTime`)が既に二分探索化されており(`lib/timeline.ts`
の `lowerBound`)、テロップ数に比例する O(n) の走査が編集パスからは既に
消えているため。つまり①②④の推定は「既に緩和済み」だった。

一方、推定に無かったが**再生中フレームごとに O(n) を再計算していた**のは
Main.tsx 側:
- `frameSpans` … `useCurrentFrame` より下で毎フレーム、baseSegments(プロキシ
  では keep 数ぶん=419〜960)を毎回ソート+配列確保していた。
- `captionAt` … `props.captions` 全件を毎フレーム線形 `.find`。
- 素材レイヤ … `props.overlays.filter(...)` を ov レイヤ×毎フレームで配列確保。

これらは入力(props)が再生中に変わらないので、memo 化で丸ごと消せる。

### 実施した対策(消費側の計算量だけを下げる。renderProps の出力形は不変)

1. **captionAt の索引化(①)** — `src/lib/captionIndex.ts` を新設。トラック別に
   start 昇順でまとめ、時間的な重なりが無い"clean"なトラックは二分探索で
   O(log n)。**同一トラックのテロップが重なる手編集データでは `.find` の
   「配列順で最初の一致」と食い違う**ため、重なり/順序崩れのあるトラックは
   従来の `.find` に委ねて厳密一致を保つ(プレビュー・レンダーの絵を1px も
   変えない)。旧実装との完全一致を `test/captionIndex.test.ts` で固定
   (乱数500件・重なり・順序崩れ・多トラック・track 省略を網羅)。
2. **`frameSpans` / 素材トラック分けの memo 化** — Main.tsx で `useMemo`。
   再生中フレームごとのソート・`filter`・配列確保を、props 変化時の1回に落とす。

### 前後比較(Main が毎フレーム再計算していた分の合算。再生10秒=300フレーム)

| 規模 | 旧(毎フレーム再計算) | 新(memo後) | 倍率 |
|---|---|---|---|
| 1時間(baseSeg419・caps900・素材40) | 15.0µs/フレーム | 0.18µs/フレーム | 84× |
| 2時間(baseSeg960・caps1800・素材80) | 24.9µs/フレーム | 0.23µs/フレーム | 107× |

絶対値は元から小さい(フレーム落ちの主因ではない)。ただしこの変更で再生中の
コンポジションから**テロップ数・keep 数に比例する毎フレームの再計算と
ヒープ確保が無くなる**ため、GC 由来の間欠的な主スレッド詰まり(=Player の
補正シークの誘因)を構造的に断てる。①の索引化は絶対効果こそ小さいが、
「毎フレーム O(テロップ数)」を残さないための正しい構造化であり、安全
(clean 判定で厳密一致を保証)なので採用した。

### 除外した対策(実測で効果が小さい/既に手当て済み)

- **② built 再構築 + Player inputProps 差し替え** … `buildRenderProps` は
  0.16ms/キーストロークで予算に対し桁違いに軽い(remap が二分探索済みのため)。
  inputProps 差し替えは Main を1回再レンダーするだけで、上記 memo 化後は
  その1回もさらに軽い。キーストローク間隔(~100ms)に対して過剰最適化に
  なるため見送り。
- **③ Timeline クリップ DOM の仮想化** … **既に実装済み**。`byTrack` で
  トラック別 start 索引を作り、可視窓 `[winStart,winEnd)` に重なるクリップだけを
  二分探索2回(`visibleRange`)で取り出して DOM 化、スクロールは `VIRT_CHUNK`
  境界跨ぎ時のみ再レンダー。DOM ノード数はビューポート幅で頭打ちになり
  クリップ総数に依存しない。追加対策は不要と確認。
- **④ dirty 判定の `JSON.stringify`** … **既にドキュメント差し替え時のみ**に
  絞られている(App.tsx の各 `*Dirty` useMemo が対応ドキュメントの参照変化を
  トリガに再評価。毎フレーム・毎キーストロークでは走らない)。0.16〜0.36ms で
  頻度も低く、追加対策は不要。

### 検証

- `npm run typecheck` 通過。`npm test` 83件 pass(captionAt 同一性の新規6件を
  含む)。
- 性能予算(合成プロジェクトで「ドラッグ中 60fps」「再生中に補正シークが
  出ない」)の**最終目視はブラウザが要る**ため人間の preview に委ねる。
  本フェーズは、その予算を脅かしうる毎フレーム/毎編集の主スレッド計算量を
  実測し、残っていた毎フレーム O(n) を除去したところまで。切り戻しは
  `remotion/Main.tsx` の memo 化と `captionIndex.ts` の revert で従来動作へ戻る
  (出力は元から不変)。

## フェーズ5: final.mp4 全スキップキャッシュ(2026-07-05)

`render.key.json`(`buildRenderProps` の返り値 = render.props.json の内容 +
`cut.mp4` の mtime/size + props が参照する素材ファイル(overlays / inserts /
bgm の `file`。重複排除・ソート済み)各々の mtime/size + `hardwareAcceleration`
設定をキーとして記録)が `final.mp4` と一致すれば、render は Remotion 実行
そのものを丸ごとスキップする(`cut.mp4` 再利用と同じ「成功後にのみキーを
書く」中断安全パターン)。

同一収録(`2026-07-02-whisper-bench`)での実測:

| シナリオ | render 合計 |
|---|---|
| 初回(render.key.json なし。Remotion 実行) | 215.1秒 |
| 再実行・変更なし(3回中央値。実行順: 0.17秒→0.13秒→0.15秒) | 0.15秒 |

**所見**: cut.mp4・編集内容(props)・参照素材・エンコーダ設定のいずれも
不変な再実行では Remotion 段(既存計測で 192〜251秒)が丸ごと消え、
render 合計は完了基準の10秒を大きく下回る。キーの不一致検知は
`test/renderKey.test.ts` で props / cut.mp4 の mtime・size / 素材ファイルの
mtime・size / hardwareAcceleration のいずれの変化も固定済み。

**切り戻し**: `render.key.json` を削除すれば次回 render は常にフル再生成に
戻る。

## フェーズ6: proxy.mp4 陳腐化キー(2026-07-05)

`proxy.key.json`(ラウドネス・システム音声・プレビュー幅・エンコーダ・
元収録ファイルの mtime+size をキーとして記録)を GET /api/project が
`isProxyStale` で照合し、レスポンスの `proxyStale` に載せる。既存のエディタ
設定バナー(`proxyStale` state・`regenProxyForSettings`)はこのセッション中の
設定保存で楽観的に立てていたが、別セッション・別ツール(Claude Code の
`config.yaml` 直接編集など)での変更やエディタ再起動後は検知できなかった。
サーバー側の判定を起動時・外部変更のリロード時に取り込むことで解消した。

同一収録(`2026-07-02-whisper-bench`)でエディタサーバーを起動し、
`/api/project` / `/api/config` / `/api/proxy` を直接叩いて確認(完了基準):

| 手順 | proxyStale |
|---|---|
| 初回起動時(proxy.key.json 未生成の古い proxy.mp4) | false(判定材料なしなので「陳腐化なし」扱い) |
| `/api/proxy` でキーを生成した直後 | false |
| `targetLufs` を -14→-16 へ変更 | **true** |
| `/api/proxy` で再生成 | false(戻る) |

**所見**: キー未生成時は誤って再生成を促さない(false)、設定変更は
即座に不一致として検知され、再生成で正しく解消することを確認。
`test/proxyCache.test.ts` で targetLufs / systemAudio / preview.width /
videoEncoder / 元ファイルの mtime・size・ファイル名のいずれの変化も
不一致として固定済み。

**切り戻し**: `proxy.key.json` を削除すれば常に「陳腐化なし」判定に戻る
(誤って古い proxy.mp4 を再生成させることはない)。
