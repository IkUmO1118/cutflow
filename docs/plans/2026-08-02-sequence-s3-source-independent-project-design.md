# S3: 映像なしプロジェクト — 画像だけ + 音声ファイルで動画を作る

親ドキュメント: `docs/programs/sequence-time-program.md`(シーケンス時間母艦)
状態: **IMPLEMENTED** / 2026-08-02
前提: **S0 landing 必須**(`baseSegments[].audioStart` を音声のみ経路が使う)。
**S1 landing 必須**(スライドは無音なので BGM/ナレーション以外に音源が無い)。
**S2 landing 強く推奨**(V1 が全部スチルになるため B1/B4/B5 がそのまま効く)。

解決する要望: 母艦 §2 の **(1) 画像だけで構成し、音声ファイルを流し続ける動画**。

---

## 0. 方式の選択 — 音声ファイルを `manifest.source` にする

### 採る方式

```
manifest.json   source: "narration.m4a"     ← 映像ストリーム無し
                layout: "stills"             ← 唯一の判別子
                durationSec: 612.4           ← 音声の尺 = 「元収録の秒」の軸
                video: { width/height/fps は config 由来。screenRegion は canvas 全面 }

overlays.json   inserts: [                   ← スライド = 静止画クリップ(S2)
                  { at: 0,   file: "materials/s1.png", durationSec: 42 },
                  { at: 42,  file: "materials/s2.png", durationSec: 53 }, ...
                ]
bgm.json        音楽(timebase は "source" でも "output" でもよい)
transcript.json whisper が音声から起こしたテロップ(そのまま動く)
cutplan.json    音声の秒で不要部分をカット(スライドも一緒に詰まる)
```

**この形の利点**: 「元収録の秒」の軸が音声の秒になるだけで、
`whisper` → `transcript` → テロップ、`detect` → `plan` のカット判断、
`describe`、`frames`、`apply`、`id-stamp`、承認 hash、GUI エディタが
**すべて無改造で動く**。

### 採らない方式(記録)
「画像リスト主導(各スライドが尺を持ち、それが動画尺を決める)」は採らない。
`slides.json` 的な新概念が要り、`cutplan` の「元収録の秒」が何を指すかの再定義、
`validate.checkSpan`、承認 hash、エディタの時間軸まで波及する。
**同じ機能を得るのに変更範囲が数倍**になる。

### スライドは `overlays[]` ではなく `inserts[]`
`overlays[]` は出力尺を伸ばせない(`remapIntervalPieces` が既存 entries との
交差しか返さない)。スライドは V1 のクリップであって上に重ねる素材ではない。
`inserts[]` = ベース映像トラックへの挿入 = V1 のクリップ、が正しい対応。

---

## 1. 下層は既にメディア非依存(変更不要な資産)

| 層 | 状態 | 根拠 |
|---|---|---|
| `src/lib/timeline.ts` | **変更不要** | 277行の純粋な区間演算。ファイル・コーデック・fps を知らない。`Manifest` を import すらしない |
| `describeFrame.ts:169` | **実装済み** | `if (props.videoFile === "") return []` = 「ベース映像なし」分岐。`renderPropsTypes.ts:139-141` に「空文字列なら動画なしのプレースホルダー表示」 |
| `describeFrame.ts:147-156` | **実装済み** | `baseSourceTimeAt()` が `null` を返す = その時刻にベース映像が無い(挿入中と同じ状態) |
| `describeFrame.ts:176-187` | **実装済み** | `design.backgroundFile` が全画面 `sourceKind:"image"` としてベース映像**より下**に描かれ、ベース映像が無くても描かれる |
| `compositor.ts:98-124, 187-209` | **実装済み** | `ImageCache` + `resolveImageLayer`。`fetch`+`createImageBitmap` で1度だけデコードしキャッシュ |
| `describeFrame.ts:534-552` | **実装済み** | insert は常に全画面 + 黒レターボックス。画像なら `sourceKind:"image"` |

**つまり「映像なし + 全画面静止画 + テロップ」は描画側では既に描ける。**
ブロッカーは全部**入口(ingest)と ffmpeg 経路**にある。

---

## 2. ブロッカーと修正(依存順)

### B1 `src/lib/findSource.ts:26-29` — 動画ファイルを必須にしている

```ts
  const rawCandidates = readdirSync(dir).filter((f) => /\.(mkv|mp4|mov)$/i.test(f));
  if (rawCandidates.length === 0) {
    throw new Error(`${dir} に動画ファイル(mkv/mp4/mov)がありません`);
  }
```

**修正**: 動画候補が0件のときだけ音声候補を探す。動画があれば従来どおり優先。

```ts
const VIDEO_SOURCE_RE = /\.(mkv|mp4|mov)$/i;
/** 映像なしプロジェクト(スライドショー)の元ファイル。動画候補が
 * 1本も無いときだけ探す(S3-B1)。materials.ts の AUDIO_EXT と同じ集合 */
const AUDIO_SOURCE_RE = /\.(mp3|m4a|wav|aac|flac|ogg)$/i;

export function findSource(dir: string): string {
  const manifestSource = readManifestSource(dir);
  if (manifestSource !== null && existsSync(join(dir, manifestSource))) return manifestSource;

  const all = readdirSync(dir);
  const rawCandidates = all.filter((f) => VIDEO_SOURCE_RE.test(f));
  const audioCandidates = rawCandidates.length === 0
    ? all.filter((f) => AUDIO_SOURCE_RE.test(f))
    : [];
  const pool = rawCandidates.length > 0 ? rawCandidates : audioCandidates;
  if (pool.length === 0) {
    throw new Error(`${dir} に動画ファイル(mkv/mp4/mov)も音声ファイル(mp3/m4a/wav 等)もありません`);
  }
  const candidates = pool.filter(
    (f) => !f.startsWith(".") && !f.includes(".tmp.") && fileRole(f) !== "generated" && f !== "final.mp4",
  );
  ...(以降は従来どおり。`raw.*` 優先も維持)
}
```

**除外規則は音声にもそのまま効かせる**こと。特に `fileRole(f) !== "generated"` は
`bgm.mp3` を弾かない(`bgm.mp3` は generated ではない)ので、
**収録直下の `bgm.mp3` が元ファイルに選ばれる事故が起こりうる**。
対策として音声候補からは既知の BGM 名を除く:
```ts
const BGM_FALLBACK_NAMES = new Set(["bgm.mp3", "bgm.m4a", "bgm.wav"]);
```
`findSource.ts` 冒頭の実害コメント(2026-07-28 の事故記録)と同じ流儀で、
この除外理由もコメントに残すこと。

### B2 `src/stages/ingest.ts:214-220` — 映像+音声ストリームを必須にしている

```ts
  const video = info.streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`${sourceFile} に映像ストリームがありません`);
```

**修正**: 映像が無いときは `layout: "stills"` として続行する。

```ts
  const video = info.streams.find((s) => s.codec_type === "video");
  const audioStreams = info.streams.filter((s) => s.codec_type === "audio");
  if (audioStreams.length === 0) {
    throw new Error(`${sourceFile} に音声ストリームがありません`);
  }
  // 映像ストリームが無い = 画像だけで構成するプロジェクト(スライドショー)。
  // canvas は元ファイルではなく config から取る(S3-B2)
  const isStills = video === undefined;
  if (isStills && layout !== undefined && layout !== "auto" && layout !== "stills") {
    throw new Error(
      `${sourceFile} に映像ストリームが無いため layout は "stills" になります(指定: ${layout})`,
    );
  }
```

canvas の決定:
```ts
  const stillsCfg = cfg.ingest.stills;   // { width, height, fps }
  const width  = isStills ? stillsCfg.width  : (video!.width  ?? 0);
  const height = isStills ? stillsCfg.height : (video!.height ?? 0);
  const fps    = isStills ? stillsCfg.fps    : parseFps(video!.avg_frame_rate);
  const effectiveLayout = isStills
    ? "stills"
    : resolveLayout(layout, cfg.ingest.layout, width, height, cfg);

  const videoInfo =
    effectiveLayout === "obs-canvas"
      ? { width, height, fps, screenRegion: cfg.ingest.screenRegion, cameraRegion: cfg.ingest.cameraRegion }
      : { width, height, fps, screenRegion: { x: 0, y: 0, w: width, h: height } };
```
(`stills` は `plain` と同じ「canvas 全面が screenRegion」でよい)

`config.yaml` の `ingest:` へ追加:
```yaml
  # 映像ストリームを持たない元ファイル(音声のみ)を ingest したときの canvas。
  # 画像だけで構成するプロジェクト(スライドショー)の出力解像度になる
  stills:
    width: 1920
    height: 1080
    fps: 30
```

### B3 `src/types.ts:5-39` — `layout` に `"stills"` を足す

```ts
  /** 収録のレイアウト。
   *  - "obs-canvas" … OBS 拡張キャンバス(画面 + カメラ)
   *  - "plain" … カメラ無しの素の動画(多くは画面録画)
   *  - "stills" … **映像ストリームを持たない元ファイル(音声のみ)**。
   *    ベース映像が存在せず、画面は overlays.json の inserts[](静止画クリップ)で
   *    構成する。video.width/height/fps は config の ingest.stills 由来 */
  layout?: "obs-canvas" | "plain" | "stills";
```

`hasCamera(m)`(`src/types.ts:41`)は
`layout === "obs-canvas" && cameraRegion != null` なので **`stills` で自動的に false**。変更不要。

5点セット: `src/types.ts` / `src/stages/validate.ts`(manifest 検査の layout enum) /
`docs/usage.md` / `schemas/manifest.schema.json` があれば enum 追加 /
`AGENTS_CONTRACT.md` は**ファイル分類もコマンドも変わらないので無変更**。

### B4 `src/stages/proxy.ts:43-96` — `[0:v]` 起点

**修正**: `layout === "stills"` なら proxy を作らない(早期 return + 情報ログ)。
`isProxyStale`(`proxy.ts:98-130`)も同様に「stills では常に stale でない」を返す。

proxy を使う下流のガード:
- `src/stages/frames.ts:13,137` — ベースは proxy(`--full-res` で `manifest.source`)。
  **stills では `props.videoFile` が空文字列**になる(B6)ので、
  `sourceUrls` の構築(`frames.ts:136-138`)を空ファイル名で汚さないようにする:
  ```ts
  const sourceUrls: Record<string, string> = {};
  if (props.videoFile) sourceUrls[props.videoFile] = `/${props.videoFile}`;
  ```
- `src/stages/av.ts:197,311,428` — motion はベース映像が対象。stills では
  `--motion-only` / 既定実行で **motion をスキップし「映像なし」と報告**する
  (`av.probe/motion.json` は書かない、または `{ skipped: "stills" }` を書く)。
  sound 側は `cut.m4a`(B6)を対象にそのまま動く

### B5 `src/stages/preview.ts:34-52` — `[0:v]` 起点

**決定(母艦 §6 の未決を本 plan で解決)**:
**S3 v1 は `preview` を stills で非対応にする。**

理由: stills の合成はベース映像が無く、背景+全画面画像+テロップをすべて
エンジンが描く。ffmpeg の trim/concat では再現できず、エンジンで作ると
per-frame headless Chrome になり `preview` の存在意義(軽い)を失う。

```ts
  if (manifest.layout === "stills") {
    throw new Error(
      "preview は映像なしプロジェクト(layout:\"stills\")に対応していません。" +
        `確認は \`${cliCmd()} editor <dir>\`(ホットリロード)か ` +
        `\`${cliCmd()} render <dir>\` を使ってください`,
    );
  }
```
エディタのプレビューはエンジン経路なので**stills でもそのまま動く**
(`enginePreviewTimeline.ts` は `props.baseSegments` から組むため、
baseSegments が空でも破綻しないことを実機で確認すること)。

### B6 `src/stages/render.ts:572-645` `cutFullRes()` — `concat=…:v=1:a=1`

現行は単一入力から映像+音声を trim/concat して `cut.mp4` を作る。
stills では**映像が無い**ので音声だけを連結した `cut.m4a` を作る。

**修正1: `cutFullRes` に音声のみ分岐を足す**

```ts
async function cutFullRes(dir, manifest, keeps, output, cfg, opts = {}) {
  const input = join(dir, manifest.source);
  const source = audioSourceOf(manifest, cfg);
  const audioOnly = manifest.layout === "stills";

  // colorTags は映像ストリームの色情報。音声のみでは取れない
  const colorTags = audioOnly
    ? undefined
    : (opts.colorTags ?? colorTagsOfProbe(await probe(input)));

  const audioParts = keepAudioParts(source, keeps);
  const loudnorm = await timed("loudnorm 実測", () => measuredLoudnormFilter({ ... }));

  if (audioOnly) {
    await timed("ffmpeg cut(音声のみ)", () =>
      run("ffmpeg", [
        "-y", "-v", "error",
        "-i", input,
        "-filter_complex", [...audioParts, ...loudnormParts].join(";"),
        "-map", "[aout]",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        output,
      ]),
    );
    return;
  }
  ...(以降は従来の映像込み経路をそのまま)
}
```

**修正2: 出力ファイル名**

`src/stages/render.ts:192` の `const cutPath = join(dir, "cut.mp4")` を
```ts
  const cutPath = join(dir, manifest.layout === "stills" ? "cut.m4a" : "cut.mp4");
```
`cut.m4a` を `src/lib/files.ts` の `GENERATED_FILES` に追加すること
(`clean` の対象・`AGENTS_CONTRACT.md` の生成物一覧・`CLAUDE.md` の中間生成物列挙も
追随。**この1点だけ `AGENTS_CONTRACT.md` の更新が要る**)。
`cut.keeps.json` は共通のまま。

**修正3: `renderEngine` が空のベース映像を渡す**

`src/stages/renderEngine.ts:133,143-144`:
```ts
  const isStills = manifest.layout === "stills";
  // 映像なしプロジェクトではベース映像レイヤーを空にする。
  // describeFrame.ts:169 の `videoFile === ""` 分岐がこれを受ける(S3-B6)
  const sourceFile = isStills ? "" : manifest.source;
  ...
    videoFile: sourceFile,
    videoIsSource: !isStills,
```
`videoIsSource: false` にすることで `baseSegments[].videoStart` が
カット後の秒になり(`renderProps.ts:511`)、S0-T3 の `audioStart` と一致する。
`insertMix` は `cut.m4a` を索引して正しく動く。

**修正4: `mixFastAudio` / `mixInsertAudio` の入力**

両者とも `cutPath` を ffmpeg の `-i` に渡すだけなので **m4a でそのまま動く**
(`bgmMix.ts:175-178` の `extractAudio(cutPath, outM4a)`、
`insertMix.ts` の `decodeAudioToPcm` はどちらも `-vn` 相当)。
ただし `insertMix.ts:272` 付近で `probe(cutPath)` から映像情報を読んでいないか確認すること。

### B7 `src/lib/design.ts:196` — `hasCamera` ゲート

```ts
  // plain 収録(OBSではない素の動画)にはデザインをかぶせない
  if (!hasCamera) return undefined;
```
stills では**背景が唯一の下地**なので、これを通す必要がある。

**修正**: `resolveDesign` に「stills か」を渡し、stills なら `hasCamera` ゲートを免除する。
`plain` の挙動は**1バイトも変えない**(既存の設計判断を尊重する)。

```ts
export function resolveDesign(
  cfg, width, height,
  hasCamera: boolean,
  wipeStyle?: ResolvedWipeStyle,
  /** 映像なしプロジェクト(layout:"stills")か。true なら背景が唯一の下地に
   *  なるため hasCamera ゲートを免除する(S3-B7)。plain の挙動は不変 */
  isStills = false,
): DesignProps | undefined {
  if (!cfg?.enabled) return undefined;
  if (!hasCamera && !isStills) return undefined;
  ...
```
`DesignProps.camera` は「常に存在する」と doc されている(`design.ts:44-53`)ので、
stills では**カメラ円を描かない**ことを `describeBaseLayer` 側で保証するか、
`camera` の rect を 0 サイズにするかを実装時に決める。
**推奨: `resolveDesign` が stills のとき `camera` を省いた `DesignProps` を返し、
`design.ts:44-53` の doc を「stills では省略される」に更新する。**
`describeBaseLayer`(`describeFrame.ts:176-187`)は `design.backgroundFile` しか
見ていないので背景は問題なく出る。カメラ円の描画箇所を grep して
`design.camera` の undefined ガードを入れること。

`src/lib/renderProps.ts:182-184` の呼び出し側に `isStills` を渡す。

---

## 3. 変更が不要なことの確認(実装時にチェックする)

| 対象 | 期待 | 確認方法 |
|---|---|---|
| `transcribe` | 音声ファイルから抽出した `audio/mic.wav` で普通に動く | `node src/cli.ts transcribe <dir>` |
| `detect` / `plan` | 音声の秒で候補が出る | `plan.first.json` に候補が並ぶ |
| 承認 hash | keep 集合だけなので影響なし | `approve` → keep を触らず `render` が通る |
| `apply` / `id-stamp` | 時間軸を知らないので影響なし | `apply --dry-run` |
| `describe` | keeps + inserts の二軸射影がそのまま出る | `describe <dir> --json` |
| `render.ts:176-179` の `keep 区間が0件です` throw | stills でも keep は音声の尺から作られるので0件にならない | `bootstrap.initialCutplan(manifest.durationSec)` |

---

## 4. `validate` の追加検査(stills 固有)

`src/stages/validate.ts` の manifest 検査へ:
- `layout === "stills"` かつ `cameraRegion` があればエラー
  (「映像なしプロジェクトにカメラ領域は持てません」)
- `layout === "stills"` かつ `overlays.inserts` が0件のとき警告
  (「スライド(inserts の静止画クリップ)が1件もありません。画面が背景だけになります」)
- `layout === "stills"` かつ `shorts.json` があればエラーまたは警告
  → **本 plan の射程外。ショートは stills 非対応として警告に留める**
  (母艦 §7 の「ショートに挿入を導入しない」と整合。スライドは insert なので
  ショートへは継承されず、ショートは背景だけになる)

---

## 5. 検証

```sh
npx tsc --noEmit
npm test
npm run gate:pixel      # 既存収録の絵が変わらないこと(design のゲート変更が漏れていないか)
```

### 新規プロジェクトの end-to-end
```sh
mkdir -p ~/Movies/framewright/2026-08-02-slides/materials
cp narration.m4a ~/Movies/framewright/2026-08-02-slides/
cp slide-*.png   ~/Movies/framewright/2026-08-02-slides/materials/

node src/cli.ts ingest    ~/Movies/framewright/2026-08-02-slides
#   → manifest.json に layout:"stills" / source:"narration.m4a" / video は config 由来
node src/cli.ts transcribe ~/Movies/framewright/2026-08-02-slides
node src/cli.ts detect     ~/Movies/framewright/2026-08-02-slides
node src/cli.ts plan       ~/Movies/framewright/2026-08-02-slides

# スライドを inserts として並べる(S2 の静止画クリップ)
node src/cli.ts validate  ~/Movies/framewright/2026-08-02-slides
node src/cli.ts describe  ~/Movies/framewright/2026-08-02-slides
node src/cli.ts frames    ~/Movies/framewright/2026-08-02-slides --every 10
#   → スライドが全画面で写り、テロップが乗っていること
node src/cli.ts approve   ~/Movies/framewright/2026-08-02-slides
node src/cli.ts render    ~/Movies/framewright/2026-08-02-slides
node src/cli.ts av        ~/Movies/framewright/2026-08-02-slides --sound-only
#   → ナレーションが全編で鳴り、BGM も切れないこと
```

### 既存(映像あり)収録の非退行
`layout: "obs-canvas"` と `"plain"` の既存収録で、
`ingest` / `proxy` / `preview` / `render` / `frames` / `av` / `describe` の
出力が S3 導入前と**バイト等価**であること。特に:
- `findSource` が同じファイルを返す(B1 の分岐は動画0件のときしか走らない)
- `resolveDesign` の `plain` 挙動が不変(B7 の `isStills` 既定値 false)
- `cutPath` が `cut.mp4` のまま(B6 の分岐は `layout === "stills"` のときだけ)

---

## 6. この段の非目標

- **ショートの stills 対応**(§4)。スライドは insert でショートへ継承されない
- **`preview` の stills 対応**(§B5 で非対応を決定)
- **スライドの自動配置**(`plan-slides` のようなコマンド)。
  スライドと台本の対応は人間が決める。需要が出たら別 plan
- **画像リスト主導のデータモデル**(§0 で不採用)
- **画像以外(PDF/PPTX)からのスライド取り込み**。`materials/` に PNG を
  置くところまでは人間の仕事
