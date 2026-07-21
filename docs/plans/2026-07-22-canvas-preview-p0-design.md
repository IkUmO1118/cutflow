# P0 設計書 — 連続ベイク・プレビュー(エディタの脱ガタつき暫定策)

> 親ドキュメント: `docs/programs/canvas-gpu-engine-program.md`(canvas/GPU エンジン母艦)の **P0**。
> 状態: **READY(設計ゲート通過。実装未着手)。2026-07-22。**
> 位置づけ: **暫定・撤去前提**。P1(プレビューの canvas 化)が landing したら本経路は撤去する(母艦 §5・§9)。
> 前提事実は read-only scout + 実コード裏取りで確定済み(§1)。

---

## 0. 要旨(TL;DR)

- **現行のガタつきの実体**: エディタプレビューは `proxy.mp4` を `videoIsSource: true` で回し、keep 区間を
  **カット境界ごとに `<video>` seek** して繋ぐ(`Main.tsx` の非 continuous 分岐)。境界ごとの GOP デコード
  待ちがヒッチの主因。緩和策(0.2s GOP・premount 2s・frame-hold・Safari の false-waiting 抑制)は
  全部この傷の対症療法。
- **P0 の一手**: `proxy.mp4` から **keeps-only の連続ファイル**(proxy 解像度)を `trim+concat` でベイクし、
  それを `videoIsSource: false`(=省略)で **既存の continuous 経路**に流す。ベース映像が単一連続区間になり
  **カット境界シークが原理的に消える**。
- **合成コンポーネント(`remotion/Main.tsx`)は無改造**。continuous 分岐は既に存在する(§1 で裏取り)。
  P0 が足すのは「別ファイルを渡す」+「そのファイルをベイクする/古さを判定する/再ベイクを起動する/
  ベイク中の UX」だけ。**合成意味論は 1 バイトも移植しない**(P1 の仕事)。
- **render 側の full-res `cut.mp4` は再利用しない**。重い(full-res ~20Mbps)・承認ゲートの内側でしか
  生成されない・wipe 焼き込みで幾何が違う、の 3 点で preview には不適(§1・§2.1)。
- **触らない一線(母艦 §1)**: JSON が正・approvals・AI の脳・CLI 契約。P0 は「エディタが**どのファイルを
  ベース映像として再生するか**」を差し替えるだけで、cutplan/承認/脳には一切触れない。
- **重要な実装契約**: 再ベイク要求は未保存の `cutplan` スナップショットを body で受ける。異なる keep の要求は
  同一 promise に dedup せず直列化し、client は要求世代と keep signature が最新の応答だけを採用する。
  これを欠くと A→B 編集中に旧 A の完了が B として表示される。

---

## 1. 確認済みの事実(scout + 自己裏取り)

### 1.1 現行プレビュー(source ドメインの境界シーク)
- Player マウント: `editor/client/App.tsx:5018-5037`(`component={Main}` を `videoVersion` で remount)。
- ベース映像: `buildRenderProps` で `videoFile: "media/proxy.mp4", videoIsSource: true`(`App.tsx:1243-1244`)。
  proxy は元収録を縮小した**全長**ファイル。
- 区間分割の写像: `videoIsSource` が true のとき `videoStart = e.sourceStart`(元収録秒)、false のとき
  `videoStart = toOutputTime(e.sourceStart, keepsOnly)`(カット後秒)。**裏取り済み**: `src/lib/renderProps.ts:370-396`。
  連続区間は `baseSegments` マージループで 1 本に畳まれる。
- continuous 分岐: `baseSegs.length===1 && start===0 && videoStart===0 && playbackRate===undefined` のとき
  `<Sequence>` 分割せず単一 `<CroppedVideo src={src}>`(seek 無し)。**裏取り済み**: `remotion/Main.tsx:161-209`。
  非 continuous 分岐は区間ごとに `startFromFrames={Math.round(seg.videoStart*fps)}` で proxy をシーク(=ヒッチ源)。
- 緩和策(全部この傷の対症療法): 0.2s GOP(`src/lib/videoEncode.ts` `PROXY_GOP_FRAMES=6`)・
  premount 2s(`Main.tsx:193` Player 専用)・frame-hold canvas(`Main.tsx:593-617`)・
  `pauseWhenBuffering={false}`/`acceptableTimeShiftInSeconds={0.2}`(Safari false-waiting 抑制)。

### 1.2 caption/overlay/zoom/wipe/scrub は既に output ドメイン
- playhead・caption・zoom・wipe・blur・annotation は `useCurrentFrame()`(=output 秒)駆動で、ベース映像の
  `videoStart` を参照しない(`Main.tsx` の `t` 駆動群、overlays/inserts は自前 `startFrom` でシーク)。
- **含意**: これらは連続ファイルが暮らす output ドメインに**既にいる**。P0 で source→output に変わるのは
  **ベース映像の区間分割だけ**。caption 等は無改造で同じ絵になる(§7 の回帰で確認する)。

### 1.3 既存 cut.mp4(render 側)= 再利用不可
- 生成: `cutFullRes`(`src/stages/render.ts:889-962`)、`render()` 内でのみ呼ばれる。中身は keeps の
  `trim+concat` + 2-pass loudnorm。
- **再利用しない 3 理由**:
  1. **重い**: full-res `libx264 -crf 18` / `h264_videotoolbox 20000k`。proxy が存在する理由(軽量化)を無効化する。
  2. **可用性**: `render()` は承認レコードの strict ゲート内。編集中(承認前=エディタの本領)には存在しない/陳腐。
  3. **幾何差**: composite 経路では wipe を**焼き込み**・canvas を出力解像度に書き換える。preview は wipe を
     `Main.tsx` で live 合成するので二重合成になる。
- 傍証: `src/stages/frames.ts`・`src/stages/thumbnail.ts` も cut.mp4 を作らず proxy+`videoIsSource:true` を選んでいる。

### 1.4 editor の保存境界と並行制御
- `App.tsx` の `cutplan` は保存前から React state 上で更新される一方、`POST /api/save` までは disk の
  `cutplan.json` は旧版のまま。したがって再ベイク endpoint が disk だけを読む設計では、debounce しても必ず
  旧版を焼く。endpoint は `{cutplan}` を受け、生成物だけを更新する。editable JSON や approvals は書かない。
- `POST /api/proxy` の `proxyBuilding` は「実行中なら同じ promise」を返す単純 dedup。これは入力が常に同一の
  proxy では正しいが、keep A/B が異なる preview-cut へそのまま流用してはいけない。異 key は要求順に直列化し、
  同 key だけを共有する。client 側でも旧応答を捨てる二重の競合防止が要る。
- `/media/*` は `no-cache` + `{size,mtime}` ETag なので、atomic rename 後の remount では新ファイルへ再検証される。

---

## 2. P0 の設計

### 2.1 ベイク対象 — **proxy.mp4 から keeps-only, proxy 解像度**(決定)
- 入力: 存在し、かつ `isProxyStale(...) === false` の `proxy.mp4`(既に縮小済み・全編 loudnorm 済み)。
  **元収録には触らない**(二重の full-res パスも再 loudnorm も避ける)。proxy 欠落/陳腐時はベイクせず
  source 経路を維持し、proxy の生成/再生成完了後に改めて要求する。
- 内容: `playbackSegmentsOf(cutplan)` の keep 区間を video は
  `trim=start=..:end=..,setpts=(PTS-STARTPTS)/speed`、audio は
  `atrim,asetpts` + `atempoFilters(speed)` で切り、`concat=n=..:v=1:a=1` する。
  **keeps-only**(inserts は含めない=render の cut.mp4 と同じ)。speed はファイルへ焼くため、
  `videoIsSource:false` 経路に `playbackRate` は残らない。
- **音声 stream copy は不可**: filter graph を通った音声は `-c:a copy` できない。proxy は1本の正規化済み
  audio stream なので再 loudnorm/再ミックスはせず、AAC 48kHz へ1回だけ再エンコードする。video も
  `videoEncodeArgs(cfg)` で再エンコードし、`+faststart` を維持する。
- 出力ファイル名は `preview-cut.mp4`(収録フォルダ直下)、sidecar は `preview-cut.key.json` で確定。
  → `src/lib/files.ts` の `GENERATED_FILES` に分類(§3・母艦の generated 規律)。
- **なぜ keeps-only が要か(設計の hinge)**: `videoIsSource:false` の `toOutputTime(e.sourceStart, keepsOnly)`
  写像がそのまま適用でき、既存の render 連続経路を**逐語で再利用**できる。full source からベイクしたり
  inserts を含めると写像を作り直すことになる(§5 Q1)。

### 2.2 データの流れ
```
proxy.mp4 ──(trim+concat, keeps-only, proxy res)──▶ preview-cut.mp4
                                                          │
App.tsx buildRenderProps: videoFile="media/preview-cut.mp4", videoIsSource 省略(=false)
                                                          │
renderProps: videoStart = toOutputTime(...) ─ 連続区間を1本にマージ ─▶ baseSegs.length===1
                                                          │
Main.tsx: continuous 分岐 ─▶ 単一 <CroppedVideo>(seek 無し)= 脱ガタつき
```

### 2.3 inserts があるときの挙動(nuance・許容)
- inserts があるとベース映像は insert gap で分割され `baseSegs.length > 1` になり **continuous 分岐に入らない**。
  ただし各 `<Sequence>` がシークするのは **keeps-only 連続ファイルの output 時間位置**(隣接)であって、
  元 proxy の飛び飛び source 位置ではない。**シーク点はカット数ぶんから insert 数ぶんへ激減**する
  (render 経路が今やっているのと同じ)。P0 の効能は inserts があっても大半得られる。完全 continuous は
  「inserts 無しの収録」で最大。→ 設計判断は不要(既存写像がそのまま正しく動く)。

### 2.4 wipe/zoom は live-composite のまま(焼き込まない)
- preview-cut は「keeps を繋いだだけ」の素の連続ファイル。wipe/zoom/blur/annotation/caption は従来どおり
  `Main.tsx` が live 合成する。`wipeBurnedIn` は**立てない**。→ zoom/wipe の編集が効いたまま・二重合成も無い。

### 2.5 cache key と公開の原子性
- `PreviewCutCacheKey` は `schemaVersion`、正規化した keep `{start,end,speed?}`、proxy の
  `{file,mtimeMs,size}`、解決済み video encode args、audio encode args、bake algorithm version を含む。
  **keep + proxy stat だけではコード/codec 変更を検出できないため不十分**。overlay/transcript は live 合成なので含めない。
- sidecar は key に加え、公開済み `preview-cut.mp4` の `{mtimeMs,size}` を持つ。fresh 判定は
  「proxy が非 stale」「mp4/sidecar が存在」「sidecar が parse 可」「現在 key と一致」「sidecar の output stat と
  現 mp4 が一致」の全条件。欠落・壊れた JSON は例外ではなく stale/fallback とする。
- `publishAsTransaction` を再利用し、proxy stat を入力 snapshot として temp mp4 へ生成 → ffprobe verify →
  proxy drift 検査 → mp4 atomic rename → sidecar を temp JSON + rename で公開する。mp4 と JSON の2ファイルは
  OS 上で同時 rename できないが、sidecar が output stat を束縛するため、どのクラッシュ窓でも誤って fresh にはならない。
  sidecar 公開失敗時は再ベイク対象になるだけで、半端な mp4 を採用しない。

### 2.6 出力検証
- ffprobe で video/audio 各1 stream、正の duration、proxy と同じ width/height、期待尺
  を検査する。秒指定 `trim` は区間ごとのframe量子化が累積するため使わず、proxy実fpsに対して
  source start/endを`Math.round(sec*fps)`した`start_frame/end_frame`へ揃える。さらにPlayerの
  `frameSpans`と同じ累積出力境界の丸めで区間ごとのoutput frame数を先に確定し、映像は
  `fps+tpad+trim`、音声は`apad+atrim`でその尺へ揃えてからconcatする。ffprobeのvideo frame数は
  この総frame数と厳密一致を要求し、container durationは`総frame数/fps`との差
  `max(0.10秒, 2/fps + 1024/48000)`だけを許す。
- 根拠: 2026-07-12 の実収録(proxy 2560x720、約582秒、114 keep、期待209.64秒)を従来の秒trimで
  libx264ベイクすると53.65秒、ffprobe 210.146秒(+0.506秒、0.133 frame/keep相当)となった。
  観測平均を許容係数にはせず、Playerと同じframe indexへ生成自体を量子化して区間累積を除く。
  algorithm versionをv2へ上げ、旧sidecar/outputは再利用しない。

---

## 3. 変更面(ファイル/関数)

| ファイル | 変更 |
|---|---|
| 新規 `src/stages/previewCut.ts` | proxy から keeps-only 連続ファイルを `trim+concat` するベイク、ffprobe 検査、transaction publish。CLI command は増やさない |
| 新規 `src/lib/previewCutCache.ts` | cache key/sidecar/fresh 判定。cache hit、malformed sidecar、output stat 不一致を純粋テスト可能にする |
| `editor/server.ts` | `POST /api/preview-cut`、同 key dedup + 異 key FIFO、project load の fresh surface。proxy build と同時に proxy を読まない |
| `editor/client/apiTypes.ts` / `widgets.tsx` | request `{cutplan}`、response `{ok,path,keepSignature,reused}`、ProjectData の ready 状態を型付きで追加 |
| `editor/client/App.tsx` | 本編だけ `videoFile`/`videoIsSource` を切替。keep signature、debounce、最新世代照合、busy/failure UX、remount。short は無変更 |
| `src/lib/files.ts` / `AGENTS_CONTRACT.md` | 2生成物を generated + heavy cache に分類し、契約の固定名一覧を同期(clean full/cache-only 対象、logs-only では保持) |
| `test/previewCut*.test.ts`、editor/clean/contract tests | cache・transaction・FIFO/世代競合・API状態・実ffmpeg A/V/speed・generated分類を固定 |
| `remotion/Main.tsx` | **無改造**(continuous 分岐が既にある。premount/frame-hold は inert になるだけ) |

---

## 4. 再ベイク・トリガと UX(P0 が背負う唯一の新規コスト)

現行はカット境界編集が**即時反映**(何も焼いていないから。`App.tsx:412-415`)。P0 は滑らかさと引き換えに
「編集→再エンコード待ち→反映」という反映レイテンシを持ち込む。これを最小化する設計:

- **invalidation**: §2.5 の key/sidecar が fresh でないときだけ再ベイク。
  render の再利用ゲート(`render.ts:246-251`)が雛形。
- **どこで焼くか**: editor-server の endpoint。client は `playbackSegmentsOf(cutplan)` の signature が変わった時だけ
  **1.5秒 debounce** して、未保存 `cutplan` のスナップショットを送る。保存はトリガ条件ではない
  (reason/approved だけの変更では焼かない)。全編集経路を覆い、ドラッグ中は timer が延びる。
- **dual-path 共存(推奨・§5 Q2)**: ベイクが landing するまでは **現行の seek-over-proxy 経路を live に保つ**
  (編集の即時反映を殺さない)。ベイク完了で `videoFile` を差し替え + `videoVersion` remount して滑らか経路へ
  スワップ。→ 「編集中はこれまで通り即時・手が止まったら数秒で滑らかに化ける」体験。
- **UX**: 「プレビュー再ベイク中…」の非ブロッキング表示(`proxyBusy` バナー機構 `App.tsx:5119-5126` を再利用)。
- **競合規約**: server は同一 key のみ dedup、異 key は FIFO。client は単調増加 request generation と
  `keepSignature` を照合し、最新 keep と一致する完了だけで ready を立てる。編集した瞬間は signature 不一致により
  自動的に source 経路へ戻る。旧完了・失敗は最新 busy/ready を下げない。
- **latency**: proxy 解像度 + 正規化済み音声のコピーなので `cutFullRes`(full-res + 2-pass loudnorm)より桁で軽く、
  総 keep 尺・区間数に比例して**秒オーダー**の想定(§7 で実測して数値を埋める)。

---

## 5. 未決の設計論点と推奨解

| # | 論点 | 推奨 | 影響度 | 要ユーザー判断 |
|---|---|---|---|---|
| Q1 | ベイク入力・範囲 | **proxy から keeps-only**(既存写像を逐語再利用) | 最高 | 済(§2.1 で採用) |
| Q2 | 再ベイク中の反映即時性 | **dual-path 共存**(ベイク完了までは seek-over-proxy を live、完了でスワップ) | 高 | **済(ユーザー確定 2026-07-22)** |
| Q3 | wipe/zoom | **live-composite(焼き込まない)** | 中 | 済(§2.4 で採用) |
| Q4 | debounce 粒度 | **keep signature 変更後1.5秒**。ドラッグ中は更新ごとに延長 | 中 | 済(本設計で確定) |
| Q5 | P1 への撤去シーム | 単一モジュール + `videoFile`/`videoIsSource` トグルに閉じる(§8) | 低 | 推奨で進めてよい |
| Q6 | short モードを P0 に含めるか | **含めない**(本編のみ。shorts は seek-over-proxy のまま。別コミットで後追い可) | 低 | **済(ユーザー確定 2026-07-22。含めない)** |

---

## 6. 実装の分解(コミット単位 = リレー単位)

Sonnet 役が 1 コミット = 1 リレーで着手できる粒度。各コミットに受け入れ基準を付す。

- **C1 — ベイクモジュール + キャッシュキー + generated 分類**(export 関数 + test で検証。CLI は増やさない)
  - 受け入れ: 任意の承認済みでない収録で `preview-cut.mp4` が keeps-only・proxy 解像度で生成される /
    video/audio 各1 stream・speed/尺が正しい / sidecar が keep・speed・proxy・codec/algorithm 変化で失効し、
    同一入力で再利用 / failure・proxy drift で旧成果物を誤 fresh にしない / `clean` full/cache-only が2ファイルを拾い、
    logs-only は保持 / 契約 drift test・関連 test・typecheck green。
- **C2 — editor/server.ts エンドポイント + staleness surface**
  - 受け入れ: `POST /api/preview-cut` が未保存 cutplan を焼く / 同 key dedup・異 key FIFO / proxy 欠落・stale を採用しない /
    project load が fresh/欠落/malformed/output-stat不一致を正しく返す / 既存 `/api/proxy` に回帰なし。
- **C3 — App.tsx で videoFile 差し替え + dual-path 共存 + remount**
  - 受け入れ: ベイク存在時は continuous 経路(単一 `<CroppedVideo>`)で再生される(frames/DevTools で確認) /
    ベイク不在・陳腐・keep変更直後・short mode は現行 seek-over-proxy / caption/overlay/zoom/wipe が従来と同じ位置(§7 回帰)。
- **C4 — 再ベイク・トリガ(debounce)+ UX バナー**
  - 受け入れ: カット境界編集後、手が止まると数秒で滑らか経路にスワップ / 編集連打中は即時反映が死なない /
    A生成中にBへ編集してもAを採用せず、最終ファイル/PlayerはB / proxy 再生成後にも新proxyから再ベイク /
    「再ベイク中」表示が出て失敗時はsource経路のまま再試行可能。

---

## 7. 検証(実測必須 — メモリ `llm-command-verify-neutral-cwd` / 完了報告は実測ルール)

- **絵の回帰ゼロ**: `frames` CLI は現状 base video override を持たないため、存在しない option を前提にしない。
  同じ edit snapshot から source props と baked props を作り、同じ Remotion bundle/browserへ注入して、同一 output frame を
  別 temporary dir に撮る test/検証 harness を使う。caption 3層継承・karaoke・zoom 連鎖・wipe・blur 下層限定・
  annotation 最前面・colorFilter と全 cut 境界前後を対象にする。preview-cut はH.264再圧縮なので PNG byte一致は要求せず、
  幾何/表示レイヤーの一致を目視し、全画面 SSIM 0.99 以上を暫定下限とする。1 frameずれ・要素位置ずれはSSIMに関係なく fail。
- **脱ガタつきの実測**: エディタを起動し、カット境界を跨ぐ再生で `frameupdate` の連続性(playhead の欠落/停滞)を
  CDP で計測、または目視。Safari(memory: chrome-headless-shell はミュート video 凍結の罠あり)は実機で確認。
  before/after を並べて「境界ヒッチが消えたこと」を数値/録画で残す。
- **二重生成が起きていないこと**: full-res `cut.mp4` を preview 目的で焼いていない(承認前の収録で `cut.mp4` が
  生成されない)ことを確認。
- **再ベイク latency**: 実収録で総 keep 尺 × 区間数に対する秒数を測って §4 の「秒オーダー」を数値で確定。
- **競合の実測**: Aを十分長いベイクにして開始し、完了前にBへ境界変更。network応答順、sidecar key、最終Player propsを記録し、
  A完了ではswapせずB完了だけがswapすることを確認する。

---

## 8. P1 への撤去シーム

P0 は P1(canvas 化)landing 後に撤去する前提。撤去を trivial に保つ:
- ベイク実体は単一モジュール(`previewCut.ts` + `previewCutCache.ts`)+ server の 1 エンドポイントに閉じる。
- App.tsx 側の分岐は `videoFile`/`videoIsSource` の 1 トグルに閉じる(canvas 経路が来たら preview-cut を渡すのを
  やめるだけ)。
- `remotion/Main.tsx` は無改造なので撤去時の巻き戻しが無い。

---

## 9. リスクと留意

- **inserts 時の残存シーク**: 完全 continuous にならない(§2.3)。許容=それでも seek 点は激減。inserts 多用収録での
  体感を §7 で確認。
- **再ベイク latency は非ゼロ**: dual-path 共存(Q2)で即時反映は守るが、滑らか化までのタイムラグは残る。P0 が
  暫定・撤去前提である所以(母艦 §5)。
- **Safari の `<video>` 挙動**: 連続ファイルなら false-waiting 誘発が減る想定だが、memory
  `headless-chrome-muted-video-freeze` の罠があるため実機実測で確認する。
- **proxy 依存**: proxy が陳腐だと preview-cut も陳腐。staleness は proxy→preview-cut の順で伝播させる
  (proxy stat をキーに含めるので proxy 再生成→preview-cut 再ベイクが自然に連鎖する)。
