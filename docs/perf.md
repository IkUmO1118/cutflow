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

## フェーズ7: 追加調査(計測のみ、2026-07-05)

技術リードから挙がっていた3件を実測した。いずれもコード変更は不要と判断
(効果なし、または現状の既定で十分)。

### `--gl` 指定の A/B

Remotion の OpenGL レンダラーは既定(`null` = Chrome に任せる)で、macOS では
ハードウェアの ANGLE バックエンドが選ばれる。フル 128秒の render を何度も
回すのはコストが高いため、同一コンポジション内の中間300フレーム(10秒ぶん、
`--frames=1000-1299`)を切り出して比較(3回中央値・実行順入替。同一
コンポジションなので per-frame コストの比較として妥当)。

| gl 設定 | 3回の実測 | 中央値 |
|---|---|---|
| 既定(未指定。ハードウェア ANGLE) | 15.96秒 / 16.48秒 / 17.51秒 | 16.48秒 |
| `--gl=swangle`(ソフトウェア) | 25.75秒 / 26.80秒 / 32.43秒 | 26.80秒 |

**所見**: ソフトウェアレンダラー(swangle)は既定より約63%遅い。既定の
ハードウェア ANGLE が既に最速のパスであることを確認しただけで、明示指定が
必要な改善余地はない。**対応: 見送り(config化しない)**。

### OffthreadVideo キャッシュサイズの A/B

既定は `null`(render 開始時点の空きメモリの半分)。同じ300フレーム区間で
明示的に小さい値(256MB = `268435456`)へ絞って比較。

| キャッシュ設定 | 3回の実測 | 中央値 |
|---|---|---|
| 既定(未指定) | 16.48秒(上表の既定と同じ計測) | 16.48秒 |
| `--offthreadvideo-cache-size-in-bytes=268435456`(256MB) | 15.06秒 / 15.22秒 / 16.11秒 | 15.22秒 |

**所見**: 256MB まで絞っても既定と有意差なし(むしろ誤差範囲でわずかに
速い)。このプロジェクトのコンポジションは同時に開く動画ソースの本数が
少なく(cut.mp4 本体+挿入・素材動画の数本)、キャッシュサイズに律速されて
いない。**対応: 見送り(効果なし)**。

### whisper 単体実測

収録フォルダの生成物に触らないよう、元収録(2:22.6、`.mkv`)を一時フォルダへ
コピーし、`ingest`(manifest.json・mic.wav 生成)→ `transcribe` 単体を
そこで実行(plan/run は実行禁止のため未実施。ingest/transcribe は再実行で
上書きされる中間生成物の再生成であり手編集を壊さない)。

モデル: `ggml-large-v3-turbo-q5_0`(config.yaml 既定)。

| 段 | 所要時間 |
|---|---|
| `ingest`(ffprobe + マイク音声抽出) | 0.2秒 |
| `transcribe`(whisper.cpp、3回中央値: 6.7秒/6.6秒/6.7秒) | 6.7秒 |

**所見**: 142.6秒の音声に対し whisper 単体は6.7秒(音声長の約21倍速)。
全体パイプラインの中で whisper が支配的なボトルネックではないことを確認。
追加対応は不要。

## フェーズ8: チャンク差分レンダー go/no-go プロトタイプ(2026-07-05)

設計と実測の全文は `docs/render-chunk-cache.md`。結論は **GO**(音声だけは
技術リードの前提を訂正)。ベンチ収録の `cut.mp4` / `render.props.json` を
入力に、出力はスクラッチパッドへ(収録フォルダの JSON は不変、plan/run 未実行)。

**連結互換性(GO の根拠)**:
- 独立チャンクの concat `-c copy` は境界フレームがバイト完全一致
  (concat[150] の md5 == チャンクB先頭)。フル vs 連結の per-frame PSNR は
  境界含め大半が `inf`(ビット同一)、チャンク GOP 内のみ最悪 45.18 dB(不可視)。
- 各チャンク先頭は必ず keyframe(閉じ GOP)→ 境界をまたぐデコード依存なし。
- `final.mp4` を keyframe 境界で carve→再連結すると全3848フレームの framemd5 が
  オリジナルと完全一致(可逆)。
- E2E(carve 再利用 + 1チャンク再レンダー + 音声 mux): 再利用領域は
  オリジナルと framemd5 バイト一致、差分は再レンダーチャンクだけ。

**コスト**: Remotion 1呼び出しの固定費 ~1.3秒 / 30秒チャンク(900f)再レンダー
52.6秒 / 音声 `-c copy` 抽出 0.05秒 / carve・concat 各 ~1秒。→ 1チャンク変更の
再実行が ~15–53秒(チャンク長次第)で、フル ~200秒に対し 4×前後。

**音声の訂正(実測)**: `remotion render --codec aac`(音声のみ)も**全フレームを
Chrome で実行**(ログで 3848 フレーム走査を確認)し、フル映像とほぼ同オーダー
(~150–190秒)。「Chrome 不要で速い」は CLI では不成立。またチャンク音声の
concat は AAC priming で境界ごと +56ms ドリフト(A/V ずれ)。→ 音声は再レンダー
せず**直前フルレンダーの連続音声を `-c copy` 再利用**し、音声に効く入力が
変わったらフルレンダーへフォールバックする設計にした(詳細は設計文書 §2/§4)。

### `frames --captions` 実測

同一収録(`2026-07-02-whisper-bench`、テロップ31件)で3回計測:
6.2秒 / 6.0秒 / 6.0秒(中央値 6.0秒 = 1件あたり約0.19秒)。

**所見**: テロップ一巡監査(AI の自己確認ループで多用)は31件で6秒程度。
現状のテロップ数では問題ないボリュームだが、テロップ数が数百件規模になる
編集(docs/perf.md フェーズ4のベンチ想定)では比例して数十秒〜のオーダーに
なりうる。実測のみに留め、対策(バッチ化・並列化等)はテロップ数が
実際に増えて問題になってから判断する。**対応: 見送り(データ取得のみ)**。

### 実装後の実測(2026-07-05)

`src/lib/chunkPlan.ts`(境界・キー計算の純関数)/ `src/lib/chunkCache.ts`
(carve・concat・mux・検証の ffmpeg ラッパ)/ `src/stages/render.ts` 結線
(§4 判定木)を実装し、`config.yaml` に `render.chunkSec: 15`(既定)を追加。
同一ベンチ収録(`2026-07-02-whisper-bench`、142.6秒・3848フレーム・
config.yaml 既定 `chunkSec: 15`)で読み取り専用の実測(cutplan 等の手編集
JSON は不変。plan/run 未実行。以下の editSec.md 手順そのまま)を行った。

**1. 初回 render(コールド)**: `render.key.json` を削除してフルレンダーを
強制 → Remotion 207.1秒(総 215.9秒)。直後に `render.chunks/` が種付け
された: keyframe から 9 チャンク(境界
`[0,456,912,1368,1824,2280,2736,3192,3648,3848]`、目標 450f=15秒に対し
実測は keyframe 間隔なりに ~456f=15.2秒)。

**2. テロップ1件編集 → 1チャンクだけ再レンダー**: `transcript.json` の
セグメント1件のテキストを変更(出力フレーム 1843–1981、チャンク4
`[1824,2280)` の内側)。`validate` 後に render 再実行 →
`チャンク4再レンダー(frame 1824-2279): 26.3秒` → 総所要 **43.8秒**
(フル 215.9秒の **約 20%**、4.9倍高速)。

再利用領域の検証(`framemd5`、`-map 0:v`): 編集前後の `final.mp4` を
全3848フレームで比較したところ、**差分はチャンク4の範囲内(frame
1824–2135、206フレーム)に完全に収まり、それ以外の全3392フレーム
(チャンク0–3・チャンク4後半・チャンク5–8)は完全一致**だった
(§1-3 の手動プロトタイプ結果を自動実装で再現)。総フレーム数・
コンテナ/音声 duration・fps は `verifyAssembled` の検証を通過。

**所見**: チャンク内でも変更した字幕の表示区間より広い範囲(約280フレーム
分)で decode 後ピクセルの厳密一致が崩れている。これは encode
非決定性(チャンク単体を独立再エンコードするとレート制御が異なる)による
もので、§1-1 で確認済みの「不可視レベルの符号化ノイズ」の範囲。境界を
またいだ劣化やチャンク外への波及は無い(バイト完全一致が証明)。

**実装時に見つけた不具合**: mux の一時出力ファイル名を `final.mp4.tmp` に
していたところ、ffmpeg が拡張子から出力フォーマットを推定できず
`Unable to choose an output format` で失敗した。`.final.tmp.mp4`
(`.mp4` 拡張子を保つ)に変更して解決。中断安全設計(キーは成功後にのみ
書く)のおかげで、この失敗の直後に再実行しても壊れず、単に該当チャンクを
再度作り直すだけで済んだ(実地で中断安全性を確認できた形になった)。

**3. BGM `volumeDb` 変更 → フルレンダーへのフォールバック**:
`config.yaml` の `render.bgm.volumeDb` を -22→-18 に変更 → render 実行
ログに `チャンク差分レンダー` の行は一切出ず、通常の
`Remotion: 188.4秒`(総197.1秒)のフルレンダー1本のみが走った
(`audioKey` 不一致でチャンクパスが静かに不採用になった証拠)。
-22 に戻して再実行(181.5秒/総190.4秒)し元の状態に復元。

**4. `render.chunkSec: 0`(機能オフ)**: `render.key.json` を削除して
フルレンダーを強制しつつ `chunkSec: 0` に設定 → `Remotion: 181.1秒`
(総181.1秒)の通常フルレンダーのみ。実行前後で
`render.chunks/chunks.key.json` の mtime が完全に一致(`1783258441`)
していることを確認 —— **`render.chunks/` に一切触れていない**
(既存挙動と bit 一致、という設計目標どおり)。`chunkSec: 15` に戻した。

**まとめ**: プロトタイプ(§1〜§5)の設計どおりに実装が成立した。
テロップ1件のような局所編集の再レンダーが 215.9秒 → 43.8秒
(約5倍)に短縮され、音声・全域設定の変更時は自動的に安全側
(フルレンダー)へフォールバックすることを実収録で確認した。

## フェーズ9: render 中のマシン圧迫(メモリ上限)と全滅バグ(2026-07-13)

対象収録は `2026-07-12`(出力 210.9秒 / 6301フレーム / 1920x1080 30fps)。
計測はシステム全体がすでに逼迫した状態(開始時点で圧縮メモリ 5〜6GB・
空き数百MB。16GB 機で通常アプリを開いたままの現実的な状況)で、収録フォルダを
スクラッチ領域へコピーして実施。1秒間隔でプロセスツリーの RSS/CPU と
vm_stat(スワップ・圧縮メモリ)をサンプリングした。

### 原因1: OffthreadVideo キャッシュの既定が「利用可能メモリの半分」

Remotion の Rust compositor(プロセス名 `remotion`)のフレームキャッシュは
既定で利用可能メモリの半分まで成長する。実測では render 開始から30秒で
compositor 単体 1048〜1074MB(なお成長中)+ タブ5個 ≈ 350-420MB/個で、
ツリー全体 3.6〜3.7GB。システム空きは 32MB まで枯渇しスワップアウトが発生
(+5628ページ/90秒)。**これが「render 中に Mac 全体が重くなる」の主因**。

`--offthreadvideo-cache-size-in-bytes=512MB` を付けると compositor は
577〜582MB で頭打ちになり、スワップアウト 0 で走る。フェーズ7の実測どおり
速度への影響は無い(キャッシュに律速されていない)。→ config.yaml
`render.offthreadVideoCacheMb: 512` を新既定にし、本編・チャンク・ショートの
全 render 経路に配線した(`render.concurrency` も同時に config 化。省略時は
Remotion 既定のまま)。どちらも出力に影響しないため renderKey には含めない。

### 原因2(全滅バグ): 1タブだけフォント読込が永久に固まり render ごと死ぬ

逼迫状態ではフル render が **6回連続で完全失敗**した(`A delayRender()
"Loading Noto Sans JP" was called but not cleared` + 巻き添えの
`Could not extract frame from compositor: Request closed`)。verbose ログで
特定した実体は「**5タブ中ちょうど1タブだけ FontFace.load() が永久に解決
しない**」(他の4タブは並行して数千フレームを正常に描画し続けており、
凍結タブの delayRender タイマーが満了した時点で render 全体が中断される)。

切り分けで**否定**されたもの: webpack バンドルキャッシュの陳腐化(削除後も
再現)/ Chrome の同一ホスト同時接続枠の枯渇(フォントを data URL で
バンドルに焼き込んでも再現= remotion.config.ts の asset/inline 化。
これ自体は構造的に良いので残した)/ 並列度(--concurrency 4 でも再現)/
props の内容(朝の props でも短尺スライスは正常)。短い render
(600フレーム)では再現せず、フル render の負荷でのみ発生する
chrome-headless-shell 側のフレーク。

**対策**: `remotion/loadFonts.ts` の delayRender に
`{ timeoutInMilliseconds: 20_000, retries: 2 }` を付けた。正常時のフォント
読込は数十msなので健常環境ではコストゼロ。凍結時は20秒で見切られ、担当
フレームは新しいページへ再割当されて続行する(フォント読込完了までフレームは
1枚も撮られないため出力は不変)。凍結が持続する病的状態では約18秒周期で
ページが作り直されレンダラープロセスが実行終了まで蓄積する(+5個/18秒。
終了時に回収される)が、「完走できない」が「完走する」に変わる。

### 実測(同一収録・同一の逼迫状態)

| 条件 | 完走 | Remotion 段 | compositor ピーク | スワップアウト増 |
|---|---|---|---|---|
| Before(既定設定) | **0/6**(30〜120秒で死亡) | - | 1074MB(死亡時点で成長中) | +5628/90秒 |
| After(上記全部入り) | **2/2** | 194.5秒 / 170.1秒 | 582MB(上限で頭打ち) | 0 / 0 |

参考: 健常なシステム状態での同収録の Remotion 段は約190秒(2026-07-13 朝の
実績)なので、**速度の劣化は無い**。出力は 6301フレーム/210.92秒/1080p30 で
正しく、テロップ(Noto の白文字+黒縁)・ワイプ焼き込み・画面クロップを
フレーム抽出で目視確認した。

**切り戻し**: `offthreadVideoCacheMb: 0` で Remotion 既定(無制限)に戻る。
フォントの retries は `remotion/loadFonts.ts` の revert で従来動作
(30秒1発勝負)に戻る。

**注意(computed cache の罠)**: remotion.config.ts の webpack override を
変えても、`node_modules/.cache/webpack` と `$TMPDIR/remotion-webpack-bundle-*`
が残っていると**古いバンドルがそのまま再利用され、設定変更が反映されない**
(override 関数は実行されるのにバンドル内容が変わらない)。バンドラ設定を
変えたら両方を削除してから検証すること。

---

## フェーズ10: render 高速パス(ハイブリッド ffmpeg 合成)cold Before/After

`docs/programs/render-fastpath-program.md` の P1〜P3。テロップ静止区間を ffmpeg
直合成(cut.mp4 → trim → テロップ透過 PNG overlay → h264_videotoolbox)に置き、
演出のある区間だけ Remotion に通す opt-in の高速パス(`render.fastPath`、既定 off)。

**実測(BGM 無し変種の 2026-07-12・6301f/210s・FAST 被覆 70.8%・同一マシン)**:

| 経路 | cold render 総時間 | 備考 |
|---|---|---|
| フルレンダー(既定) | **176.0s** | Remotion 段 162.4s(6301f) |
| 高速パス(fastPath:true) | **122.0s** | FAST 2 + SLOW 1 セグメント。約31%短縮 |

- 出力等価性: verifyAssembled 通過(6301f・30fps・duration 210.033s=frame 厳密)。
  FAST/SLOW 境界(frame 1676|1677)でテロップ・ワイプ・画面が連続し色/明るさの
  ステップ無し(目視)。FAST セグメント単体 vs Remotion 同 span は PSNR 平均35.9dB
  だが差分は画面テキストのクロマ再サンプリングに集中し視覚的に不可視(P0-3a と同種)。
- **CFR の罠**: cut.mp4 は実測 VFR(avg 29.94fps)。FAST セグメントを
  `setpts=PTS-STARTPTS` で切ると VFR が残り frames は正しいのに container duration が
  伸び(1677f=56.07s、正しくは 55.90s)、Remotion(厳密30fps)との混在 concat 後に
  verifyAssembled の duration 判定で落ちる。`setpts=N/fps/TB`(frame 序数で CFR
  再スタンプ)で解決。frame 内容・順序・overlay の n ベース enable は不変。
  **⚠ 追記(2026-07-14)**: この序数ベース再スタンプは duration は直るが、
  ソースフレームの選択が「序数」になり Remotion の「時刻」選択と食い違う
  (VFR ドリフト分=最大 400ms の A/V 先行と境界ジャンプ)ことが P3.5 検収で
  判明。**時刻ベースの `fps=30` フィルタに置換済み**(プログラム文書 §5 P3.5)。
- 楽観試算(90〜100s)に届かない残差は、SLOW Remotion を別プロセス(bundle 込み)で
  呼ぶ固定費+ caption still 用 bundle。P6 で bundle 共有の余地。
- ユーザーの実収録は BGM×3 で v1 音声ゲート(cut.mp4 音声 -c copy)では発動しない
  =P4(決定論 BGM ミキサ)が実運用の必須フェーズ。

---

## フェーズ11: render 高速パス P3.5〜P6(検収・リソース実測・既定化。2026-07-14)

プログラム(`docs/programs/render-fastpath-program.md`)の P3.5(VFR 時刻写像の
修正)・P4(決定論 BGM ミキサ)・P5-1〜P5-4(overlay/annotation/colorFilter/inserts
の適格化)を経た最終形の検収。対象は実収録 2026-07-12(BGM×3・そのまま。
6301f/210.03s)、cut.mp4 温存の cold render、同一マシン状態、フェーズ9と同じ
1秒サンプリング(プロセス RSS/CPU + vm_stat)。

### cold render 時間(フェーズ経過の要約)

| 時点 | フル | 高速パス | 短縮 | 備考 |
|---|---|---|---|---|
| P3(BGM 無し変種・被覆 70.8%) | 176.0s | 122.0s | 31% | フェーズ10。※CFR は後に P3.5 で修正 |
| P4(BGM あり実収録・被覆 70.8%) | 183.1s | 123.3s | 33% | 音声 bgm-mix で初発動 |
| P5-1(同・overlay 適格化で被覆 100%) | 210.5s | 92.8s | 56% | Remotion 呼び出し 0 回 |
| **P6 検収(同・2回実測)** | **202.6s**(Remotion 段 188.5s) | **102.2s / 92.5s** | **約50〜55%(約2.1倍速)** | `FAST 1 / SLOW 0(被覆 100.0%, 音声 bgm-mix)` |

### リソース(1秒サンプリング。render 関連プロセスのみ集計)

| 指標 | フルレンダー | 高速パス |
|---|---|---|
| 併走 RSS ピーク(render 関連計) | **6.7GB** | **2.7GB** |
| chrome-headless-shell | 同時最大 **59 プロセス**・単体最大 602MB | 同時最大 **5 プロセス**・単体最大 133MB(caption still 用) |
| Remotion compositor | 594MB(512MB 上限+管理領域) | 8MB(still のみ) |
| ffmpeg 単体最大 | 134MB(Remotion 同梱) | **2459MB**(FAST セグメント合成。PNG 107 入力) |
| システム空きメモリ最小 | **23MB**(逼迫) | **1816MB** |
| スワップアウト増 | 0 | 0 |

「render 中に Mac が重くなる」問題はフェーズ9の対策(キャッシュ 512MB)後も
フル経路では空きメモリ 23MB まで逼迫していたが、高速パスは構造的に軽い
(Chrome の大群がいない)。ただし FAST の ffmpeg は **PNG 入力数に比例して
メモリを食う**(107 入力で単体 2.4GB)点は今後 caption の多い収録で注意。

### 等価性(fast vs full、クリーン run 同士)

- 両者 **6301f / 30fps / 210.033333s**(comp 期待値と一致)
- 全編 per-frame PSNR: **avg 42.52dB / min 33.04dB / 30dB 未満 0 frame**
  (P5-1 検収と同値。min はフェーズ8から既知の画面テキストのクロマ再サンプリング由来)
- 統合ラウドネス: 両方 **-14.2 LUFS**(差 0.0 LU)

### 副産物: フル(Remotion)経路の非決定 +1 frame フレークを観測

本日のフルレンダー2回のうち1回が **6302f**(出力 frame 3567 付近に1枚重複)。
重複を +1 シフトすると以降の全フレームが一致(min 35.70dB・30dB 未満 0)する
ので、重複挿入以外は正常。再実行では 6301f で再現せず。
**フル経路にはこれを検出するゲートが無い**(黙って 1 frame 長い final.mp4 が
出る。33ms の A/V ずれ)。高速パスは `verifyAssembled`(フレーム数・尺・fps・
先頭 keyframe)が同種の組み立て異常を弾いてフルレンダーへ自動退避するため、
この観点ではむしろ頑健。P5-4 検収で見えた「full 側が挿入内で 1 frame 隣を
引く」OffthreadVideo 抽出アーティファクトと同族の可能性が高い。

### 既定化判断(P6): `render.fastPath: true` を config.yaml の既定に

根拠: (1) 実収録+4種の合成変種(BGM 無し / annotation / colorFilter / inserts)で
frame パリティ・音声パリティを深く検証済み、(2) 約2倍速+マシン圧迫の大幅減、
(3) 不適格要素は span 単位/全編の自動フォールバック・組み立て異常は
verifyAssembled ゲートで自動退避(失敗しても壊れた出力ではなく遅い出力になるだけ)、
(4) 切り戻しが config.yaml 1行。

- 実装: `config.yaml` の `render.fastPath: true`(**コード側の省略時既定は
  false のまま**=config を持たない環境では従来どおりオフ)
- 残リスクと運用: パリティ検証は実収録1本+合成変種に基づく。**今後の数収録は
  final をざっと目視**し、違和感があれば `fastPath: false` で即切り戻して
  収録フォルダを保全→プログラム文書 §8 に追記する
- 未適格(SLOW/フォールバックのまま): カラオケ word・anim テロップ・
  動画素材 overlay・ショート・blurs(恒久 SLOW=判断B)・素材音声 overlay

### 切り戻し

`config.yaml` の `render.fastPath: false` で従来のフルレンダーへ完全に戻る
(コード削除不要。発動条件・フォールバックは 1 行ログで観測できる)。

---

## フェーズ12: plain design と高速基底の検収(2026-07-15)

`docs/programs/render-design-program.md` のP3。cameraの無い通常動画(`plain`)へ
背景+画面パネルのdesignを適用し、design無しは恒等基底、design有りは
backdrop+screenMask基底として高速パスを解禁した。実収録から切り出した6秒の
横1920x1080/縦1080x1920 scratchを使い、各条件でキャッシュを消したfullとFASTを
比較した。全ケースが **180f / 30fps / 6.000s、-14.2 LUFS** で一致した。

### cold時間と全編等価性

| plain条件 | full | FAST | 全編PSNR avg / min / 30dB未満 | panel crop avg / min |
|---|---:|---:|---:|---:|
| 横・design無し | 5.5s | **1.9s** | 44.8958 / 44.42 / 0/180 | - |
| 横・design有り | 6.6s | **3.3s** | 44.0856 / 43.67 / 0/180 | 43.3445 / 42.99 |
| 縦・design無し | 5.5s | **1.9s** | 45.8423 / 45.40 / 0/180 | - |
| 縦・design有り | 6.6s | **3.2s** | 46.1911 / 45.77 / 0/180 | 44.7723 / 44.41 |

design解決後の画面rectは横`{x:100,y:22,w:1720,h:968}`、縦
`{x:100,y:266,w:880,h:1564}`。repo背景、角丸、影、カメラ/wipeが無いことを
代表frameで目視確認した。横designの代表runを`/usr/bin/time -l`で測ると、fullは
6.98s / max RSS 745,340,928B、FASTは3.55s / 677,150,720Bだった。このmax RSSは
**計測対象の親プロセスだけ**の値で、子ffmpeg/Chromeを含むプロセスツリー総量では
ないため、フェーズ11の併走RSSとは直接比較しない。

### 混在境界とフォールバック

- 縦designにblurを1区間入れた混在ケースは`FAST 1 / SLOW 1`、被覆50%、境界
  frame 90。full/FASTをframe序数でPNG化して比較した全編PSNRはfinite
  avg 52.0523dB / min 43.62dB / 30dB未満0/180(127 finite、53 inf)、境界
  frame 80〜100はavg 54.2748dB / min 44.30dB / 30dB未満0/21だった。
- 動画同士を直接framesyncしたPSNRはB-frame timestamp表現の違いにより境界で
  比較が止まった。このため、デコード後のframe数・順序を固定できる**序数PNG比較を
  本ゲートの正式手法**とした。
- `render.fast/design`をディレクトリではなくfileで塞いで`EEXIST`を起こすと、警告後に
  `design asset missing backdrop/screenMask`を非適用理由として高速パスを使わず、
  通常Remotionが5.2sで成功した。資産失敗を壊れたFAST出力へ進めないことを確認した。

### 残リスク

高周波synthetic stressではplain 25.88dB / design 29.46dBとなった。geometryの
ずれではなく、full(libx264)とFAST(VideoToolbox)の固定bitrate差を人工的な高周波が
増幅した結果なので、実収録由来素材を使う正式ゲートからは除外した。ただしcodec
依存の画質差が高周波素材で見えやすいことは残リスクとして保持する。実装検収は
`npm run typecheck`と`npm test` **1565/1565** が成功した。
