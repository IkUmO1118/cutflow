# チャンク単位の差分レンダー(render chunk cache)設計 / go・no-go

**結論: GO(ただし技術リードの前提を1つ修正)。**
連結互換性は完全に成立した。音声だけは「Remotion の音声レンダーは Chrome
不要で速い」という前提が**実測で否定された**ため、音声は再レンダーせず
**直前フルレンダーの連続音声を再利用する**方式に変える(下記 §4)。

対象は `render` の Remotion 段(全体の約89%、~190秒/2分収録。docs/perf.md
フェーズ0)。既存の全スキップキャッシュ(`render.key.json`、フェーズ5)は
「何も変わっていない再実行」を 0.15 秒にする。本機能はその手前の空白
——「**直前フルレンダー以降、映像に効く要素だけを触った**再実行」——を
埋める。想定は AI/人間のテロップ・位置・ワイプ微調整ループ。

---

## 1. プロトタイプ実測(ベンチ収録 `2026-07-02-whisper-bench`、読み取り専用)

すべて既存の `cut.mp4` / `render.props.json` を入力に、出力はスクラッチパッドへ。
収録フォルダの JSON は一切変更していない(plan/run 未実行)。

### 1-1. 独立チャンクの連結互換性(-c copy) — **完全一致**

同一コンポジションのフレーム 900–1199 を「フル1本」と「900–1049 / 1050–1199
の2チャンク」で `remotion render --frames` し、2チャンクを concat demuxer
`-c copy` で連結して比較。

| 検証 | 結果 |
|---|---|
| concat `-c copy` の成否 | exit 0・警告なし |
| 総フレーム数 | 300(= フル)。duration ちょうど 10.000s |
| コーデック/pix_fmt/profile/level/fps | 全チャンク一致(h264 / yuvj420p / High / L4.0 / 30) |
| 各チャンク先頭 | I フレーム(keyframe=1)。**閉じた GOP** |
| 境界フレーム(concat[150])の decode | チャンク B の先頭フレームと **md5 一致**(= `-c copy` はバイト保存) |
| フル vs 連結の per-frame PSNR(0–150) | **全フレーム `inf`(ビット同一)。境界フレーム150も同一** |
| フル vs 連結(151–300、チャンクB の GOP 内) | 45.18–61.4 dB(最悪 45.18 dB)。人間には不可視 |

**要点**: チャンク境界の差は「その区間を独立した閉じ GOP として再エンコード
した」ことによる符号化ノイズだけで、連結由来のアーティファクトはゼロ。
**先頭が必ず keyframe なので、境界をまたぐデコード依存が原理的に発生しない。**
これが `-c copy` 連結が安全な理由。

### 1-2. フルレンダーの keyframe 切り出し(carve)— **可逆・フレーム完全**

既存 `final.mp4`(3848フレーム)を `-c copy -f segment -segment_time 30
-reset_timestamps 1` で keyframe 境界に沿って分割 → 900/900/900/900/248 =
3848。連結して戻すと **全 3848 フレームの framemd5 がオリジナルと完全一致**
(`ca381f…` 同値)。Remotion 出力は keyframe が密(3848中321本、平均~0.4秒毎)
なので、任意の目標サイズ近傍の keyframe で正確に切れる。

### 1-3. エンドツーエンド(reused + swapped + reused、音声 mux)

carve した seg000(0–899)+ **再レンダーした 900–1799**(`--frames --muted`)+
carve した seg002–004(1800–3847)を concat `-c copy` し、`final.mp4` から
`-c copy` で抜いた音声を mux。

| 検証 | 結果 |
|---|---|
| 構造 | 3848フレーム / yuvj420p / 30fps / duration 128.27s / 音声 aac 128.26s |
| **再利用領域 0–899** | オリジナル `final.mp4` と framemd5 **バイト完全一致** |
| **再利用領域 1800–3847** | 同上 **バイト完全一致**(swapped chunk の後ろも無傷) |
| swapped 領域 900–1799 | 再レンダー由来(§1-1 と同じ ≥45 dB クラス。変更対象なので当然) |

再利用チャンクはドリフトゼロ。差分が出るのは再レンダーしたチャンクだけ。

### 1-4. コスト実測(M5・単発、熱変動あり)

| 操作 | 実測 |
|---|---|
| Remotion 1呼び出しの固定オーバーヘッド | 約 1.3秒(150f=8.5s と 300f=15.7s の線形回帰の切片) |
| 映像 per-frame(muted, `if-possible`) | 約 48–55ms/f |
| **1チャンク再レンダー 30s(900f, muted)** | **52.6秒** |
| フルレンダー(既存、参考) | ~190–216秒 |
| `final.mp4` からの音声抽出 `-c copy` | 0.05秒 |
| carve(segment `-c copy`)/ concat `-c copy` | 各 ~0.1–1秒 |

**含意**: 30秒チャンク1本の再レンダー ≈ 53秒(フルの ~1/4)。15秒チャンクなら
~26秒、10秒なら ~16秒。固定オーバーヘッドが小さい(1.3秒)ので、細かめの
チャンクでも割に合う。

---

## 2. 音声の実測——技術リードの前提の訂正(重要)

> 「音声は全編を Remotion の音声レンダー(Chrome 不要で速い)で作り直して mux」

**これは `remotion render` CLI では成り立たない。** `--codec aac`(音声のみ出力)
でも Remotion は**全 3848 フレームを Chrome で実行する**(ログに
`Setting the current frame to N` / `Rendered 2002/3848` / 素材の Img・
OffthreadVideo フェッチ)。PNG エンコードは省くが、per-frame の Chrome
コンポジット——これが本ツールのボトルネック(docs/perf.md フェーズ2で確認済)
——は省かれない。実測で 128秒コンポジションの音声のみレンダーが 76秒時点で
2002/3848・ETA 2分と、**フル映像レンダーとほぼ同オーダー(~150–190秒)**。

さらに、**チャンク音声を連結する案も不可**: 各チャンクの AAC は先頭に
エンコーダ遅延(priming)パディングを持ち、5.0秒映像に対し音声は 5.056秒
(237 AAC frame × 1024 = +56ms)。concat `-c copy` すると **境界ごとに +56ms
ずつドリフト**(2チャンクで映像10.048s に対し音声10.112s)。境界数だけ
A/V がずれる。**音声は連続した1本でなければならない。**

→ **音声は再レンダーしない。直前フルレンダーの `final.mp4` から `-c copy` で
抜いた連続音声を、音声に効く入力が不変な限り再利用する**(§4)。抜き出しは
0.05秒。音声に効く入力が変わったら**フルレンダーへフォールバック**(音声の
作り直し自体がフル並みのコストなので、部分再利用しても得がない)。

---

## 3. props → チャンク影響写像の仕様(純関数・単体テストで固定)

チャンク = 出力フレーム区間 `[fromFrame, toFrame)`。境界は「直前フルレンダーの
`final.mp4` を carve したときの実 keyframe 位置」で、`chunks.key.json` に永続化
する(次のチャンク再利用時に同じ境界を使う)。

要素を2種に分類する。

### 3-1. 全域に効く props(1つでも変われば全チャンク無効 → フルレンダー)

`layerOrder` / `caption`(既定スタイル)/ `wipe`(widthPx・marginPx・
transitionSec)/ `width` / `height` / `canvas` / `screenRegion` /
`cameraRegion` / `fps` / `videoFile` と **`cut.mp4` の mtime+size**。
ベース映像(`baseSegments`)は `cut.mp4` を各フレーム決定的にクロップする
だけなので、この全域キー(cut.mp4 stat + 各 region + wipe 幾何)に含めれば
チャンク個別の変動要因にならない。`baseSegments` が変わる = keeps が変わる =
`cut.mp4` が変わるので、これもフルレンダー行き。

**全域 props が変わったら全チャンク再レンダーと等価 → 素直にフルレンダーに
落とす**(実装も判定も単純化)。

### 3-2. 区間限定の props(重なるチャンクだけ無効)

`captions[]` / `overlays[]`(映像に効く項目: start・end・track・file・fit・
opacity・rect・startFrom・fadeInSec/OutSec・pos・anchor・style)/
`inserts[]`(映像項目)/ `wipeFull[]` / `zooms[]`(ズーム演出。rect・easeSec
込み)/ `hideCaption[]`。

各要素は出力フレーム区間 `[round(start·fps), round(end·fps))` を持つ。
**その区間がチャンク `[from,to)` と重なる要素だけがそのチャンクの絵に効く。**
フェード・ワイプ遷移は要素自身の start/end から計算される(チャンク境界とは
無関係)ので、要素を丸ごとハッシュに含めれば境界をまたぐ遷移も正しく反映
される——スピルオーバーは要素の `[start,end]` を超えない。

**安全マージン**: 丸めの1フレーム端を吸収するため、重なり判定は
`[from-1, to+1)` で取る(`wipeTransitionSec` / `fadeIn/OutSec` は要素区間内で
完結するので追加マージン不要。premount は Player 専用で最終レンダーに無関係)。

### 3-3. 純関数(実装対象)

```
chunkVideoKey(props, fromFrame, toFrame): string
  = stableHash({
      global: <§3-1 の全域 props の射影 + cut.mp4 stat>,   // 全チャンク共通
      local:  <§3-2 のうち [from-1,to+1) に重なる要素だけを、
               安定ソートして射影>,
      bounds: { fromFrame, toFrame, fps },
    })

audioKey(props): string
  = stableHash({ bgm, muteは除外(最終レンダーでは常に未指定),
      overlays/inserts の音声項目(volume・startFrom・fade・file),
      baseSegments, durationSec, fps, cut.mp4 stat,
      音声を持つ素材ファイル(bgm/insert/overlay の file)の mtime+size })
```

`stableHash` は `renderKey.ts` と同じ「キーを安定ソートして JSON.stringify
一致」で十分(暗号学的ハッシュ不要)。テストで固定する不変条件:

- テロップ1件の text/pos/style を変えると、それが載るチャンクの
  `chunkVideoKey` **だけ**が変わり、他チャンクと `audioKey` は不変。
- BGM/volume/ducking を変えると `audioKey` が変わる(→ フォールバック)。
- 全域 props(layerOrder 等)を変えると全チャンクの `chunkVideoKey` が変わる。
- 境界 `[from,to)` ちょうどに end が来る要素が ±1 フレームで取りこぼれない。

---

## 4. アーキテクチャ(判定木)

`render` の先頭で上から順に評価する。

1. **`render.key.json` 一致(既存フェーズ5)** → `final.mp4` 即再利用(0.15秒)。
2. **チャンクパスが使えるか**:
   - 有効な直前 `final.mp4` と `render.chunks/` が存在し、かつ
   - `audioKey` が前回と一致(音声に効く入力が不変)し、かつ
   - §3-1 の全域 props が不変(cut.mp4・keeps 含む)
   - を**すべて満たす**とき:
     a. `chunks.key.json` の境界で、各チャンクの `chunkVideoKey` を再計算。
     b. 変わったチャンクだけ `remotion render --frames=from-(to-1) --muted`
        で再レンダー(video only)。変わらないチャンクは `render.chunks/vNNN.mp4`
        をそのまま使う。
     c. 全チャンクを **concat `-c copy`** → 映像。
     d. `render.chunks/audio.m4a`(前回フルレンダーから `-c copy` 抽出済み)を
        mux → `final.mp4`。
     e. **検証**(§5)。OK なら更新した `chunks.key.json` を書いて終了。
        NG なら破棄して 3 へ。
3. **フルレンダー(既存パス)** → `final.mp4` 生成後、**チャンクキャッシュを
   種付け**:
   - `final.mp4` の映像を keyframe 境界(目標 `render.chunkSec`)で carve →
     `render.chunks/vNNN.mp4`。
   - `final.mp4` の音声を `-c copy` 抽出 → `render.chunks/audio.m4a`。
   - 各チャンクの実境界・`chunkVideoKey`・`audioKey` を `chunks.key.json` に記録。
   - `render.key.json` も従来どおり書く。

**コスト特性**:

| シナリオ | コスト | 現状 |
|---|---|---|
| 何も変えず再実行 | 0.15秒(既存 render.key) | 0.15秒 |
| テロップ/位置/ワイプを1チャンク内で変更 | 1チャンク再レンダー + concat + mux ≈ **15–53秒**(チャンク長次第) | ~200秒 |
| 変更が2チャンクにまたがる | 2チャンク ≈ 30–105秒 | ~200秒 |
| BGM/音量/ducking/keeps/cut.mp4/全域 props を変更 | **フルレンダー ~200秒**(音声再生成が必要なので部分化しても無得) | ~200秒 |
| 初回(コールドキャッシュ) | フルレンダー + carve/抽出 ~1–2秒 | ~200秒 |

**コールドスタートは回帰しない**(フル + 数秒の `-c copy` 種付けのみ)。
音声を Chrome で2回払うこと(映像チャンク + 音声パス)を避けたのがこの設計の要。

**チャンクサイズ**: `config.yaml` `render.chunkSec`(既定 **15秒 = 450f** 案。
`0`/未設定で機能オフ=常にフルレンダー)。小さいほど粒度は細かいが、境界を
またぐ要素は複数チャンクに乗る。keyframe が ~0.4秒毎なので carve 整合は
サイズに依らず取れる。静的シーンで keyframe が疎な区間は目標より大きい
チャンクになりうる(フレーム完全性は保たれる。効果が薄くなるだけ)。

---

## 5. フォールバックと検証

チャンクパスの成果物は mux 後に**必ず検証**し、少しでも不審ならフルレンダー:

- `ffprobe -count_frames` の総フレーム数 == 期待値(Σチャンク長)。
- コンテナ duration が `durationSec` と ±1フレーム以内。音声 duration も同様。
- 各チャンクの codec/pix_fmt/profile/level/fps が一致(carve と再レンダーで
  揃うことは §1 で確認済みだが、素材更新等の想定外に対する保険)。
- 再レンダーチャンクの先頭が keyframe。
- ffprobe/ffmpeg が非0で返る・warning を吐く → 破棄。

NG 時は `render.chunks/` を破棄してフルレンダー(§4-3)を実行。ユーザーには
「チャンク検証に失敗したためフル再生成しました」と1行で伝える(黙ってフルに
落ちない)。

**中断安全**: `cut.mp4` / `render.key.json` と同じく「成果物を書き切ってから
キーを書く」順序。`chunks.key.json` はチャンク再レンダー+concat+mux+検証が
全部通った後に一括更新する。途中で落ちれば次回はキー不一致で該当チャンクを
再レンダーするだけ(壊れたキャッシュを信じない)。

**IDR の確認**: videotoolbox の keyframe が全て IDR(閉じ GOP)であることを
前提にしている(§1 で境界 md5 一致・carve 可逆を確認済み)。将来 Remotion/
videotoolbox の既定が open-GOP に変わると carve 境界でデコードが乱れうるので、
検証(§5 の framemd5 スポットチェックを実装のテストに含める)で早期検知する。

---

## 6. `config.yaml` / 中間生成物 / CLAUDE.md 追記案

### config.yaml(`render:` 配下に追加)

```yaml
  # チャンク単位の差分レンダー(render chunk cache)。直前フルレンダー以降、
  # 映像に効く要素(テロップ・位置・ワイプ等)だけを変えた再実行で、変わった
  # チャンクだけを再レンダーして連結する。音声・keeps・全域設定を変えたときは
  # 自動でフルレンダーに戻る。chunkSec がチャンクの目標長(秒)。0 で無効。
  chunkSec: 15
```

### 中間生成物(`render.chunks/` ディレクトリ)

`render.chunks/vNNN.mp4`(チャンク映像・video only)/ `render.chunks/audio.m4a`
(直前フルレンダーの連続音声)/ `render.chunks/chunks.key.json`(境界フレーム
一覧・各チャンクの `chunkVideoKey`・`audioKey`)。すべて**中間生成物**:
手編集しない。ディレクトリごと削除すれば次回は必ずフルレンダー(§4-3)に戻る。

### CLAUDE.md「中間生成物は編集しない」リストへの追記案

> `render.chunks/`(チャンク差分レンダーのキャッシュ。`vNNN.mp4`=チャンク映像・
> `audio.m4a`=直前フルレンダーの連続音声・`chunks.key.json`=再利用可否を判定
> するキー。映像に効く要素だけを変えた再実行で変更チャンクだけ再レンダーする。
> 音声・keeps・全域設定の変更時は自動でフルレンダーに戻る。ディレクトリごと
> 削除すれば常にフル再生成に戻る)

`docs/usage.md` の「触らないファイル」表と `src/types.ts` 近辺のコメントも同様に。

---

## 7. 実装手順(ファイル単位・Sonnet 粒度)

前提: 純関数とキャッシュキーを**先に**単体テストで固定し(TDD)、`render.ts`
の結線は最後。既存の `cutCache.ts` / `renderKey.ts` と同じ形をなぞる。

1. **`src/lib/chunkPlan.ts`(新規・純関数)**
   - `carveBoundaries(keyframeFrames: number[], totalFrames: number,
     chunkSec: number, fps: number): number[]` — keyframe 位置から目標長
     近傍で境界フレーム列 `[0, b1, b2, …, totalFrames]` を選ぶ。
   - `chunkVideoKey(props, fromFrame, toFrame, cutStat, fps): string` と
     `audioKey(props, cutStat, materialStats): string`(§3)。
   - `overlapsChunk(elemStart, elemEnd, fromFrame, toFrame, fps): boolean`
     (±1フレームマージン)。
   - `stableHash` は `renderKey.ts` の JSON.stringify 一致方式を流用/共有。
   - **Node 23 type stripping 制約厳守**(enum/namespace/パラメータ
     プロパティ禁止。フィールドは明示宣言)。

2. **`test/chunkPlan.test.ts`(新規)** — §3-3 の不変条件を固定:
   テロップ1件変更で該当チャンクキーだけ変わる / audioKey は BGM・音量・
   ducking・cut.mp4 でのみ変わる / 全域 props で全チャンク変わる /
   境界 ±1フレームの取りこぼしなし / carveBoundaries が疎 keyframe でも
   単調増加・被りなし。

3. **`src/lib/chunkCache.ts`(新規)** — ffmpeg 実行の薄いラッパ:
   - `carveFinalToChunks(finalMp4, boundaries, outDir)` — `-f segment
     -segment_frames <境界>` あるいは境界ごとに `-ss/-frames -c copy`。
     ※ `-segment_time` より `segment_frames`(フレーム指定)が正確。
   - `extractAudio(finalMp4, outM4a)` — `-map 0:a -c copy`。
   - `concatChunks(chunkFiles, outMp4)` — concat demuxer `-c copy`。
   - `muxVideoAudio(video, audioM4a, outMp4)` — `-c copy -shortest`。
   - `probeKeyframes(mp4): number[]` / `verifyAssembled(mp4, expected)`(§5)。
   - `run()`(`src/lib/exec.ts`)を使う。ログは既存 `timed()` で計測表示。

4. **`test/chunkCache.test.ts`(任意・統合寄り)** — 小さな合成 mp4 で
   carve→concat の framemd5 可逆、境界フレーム数の一致を固定(§1-2/§1-3 の
   自動化)。CI にベンチ収録は無いので合成素材で。

5. **`src/stages/render.ts`(結線)** — §4 の判定木を実装:
   - `render.key.json` 一致チェックの**後**に「チャンクパス可否」判定を挿入。
   - 可なら: `chunks.key.json` 読み込み → チャンク別 `chunkVideoKey` 差分 →
     変更チャンクを `remotion render --frames=from-(to-1) --muted`(既存の
     remotion CLI 呼び出しに `--frames` と `--muted` を足すだけ)→ concat →
     mux(`audio.m4a`)→ 検証 → `chunks.key.json` 更新。
   - 不可/検証NG なら既存フルレンダー → 種付け(carve + extractAudio +
     `chunks.key.json` 書き込み)。
   - **`buildRenderProps` / `render.props.json` の生成は一切変えない**
     (「同じ絵」の土台。renderProps.ts は不変)。
   - フル/チャンク双方で `render.props.json` は今まで通り書く。

6. **ドキュメント**: `config.yaml` にコメント付き `chunkSec`、CLAUDE.md /
   docs/usage.md の中間生成物リストに `render.chunks/`、docs/perf.md に
   フェーズ8として実測(本書 §1 を移植 + 実装後の同一収録ベンチ)。

7. **切り戻し**: `render.chunks/` を無視すればフル動作。`config.yaml`
   `render.chunkSec: 0` で機能を完全に切れる(既存挙動と bit 単位で同じ)。

### 触ってはいけない不変条件(再掲・厳守)

- `renderProps.ts`(`buildRenderProps`)と `remotion/Main.tsx` の絵の組み立ては
  変えない。チャンク化は「同じ props を frame 範囲を区切って Remotion に渡す」
  だけで、1フレームの見た目も変えない。
- 再利用チャンクはバイト完全一致(§1-3)。差分が出るのは再レンダーした
  チャンクだけ、しかも ≥45 dB(不可視)。
- 承認ゲート(`approved`)・plan/run 再実行禁止は本機能と無関係(render 内部の
  最適化)。
