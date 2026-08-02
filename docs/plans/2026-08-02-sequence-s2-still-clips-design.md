# S2: スチルクリップ — 静止画を「尺を持つ一級クリップ」にする

親ドキュメント: `docs/programs/sequence-time-program.md`(シーケンス時間母艦)
状態: **IMPLEMENTED** / 2026-08-02
前提: **S0 landing 必須**(T1 の `outputDurationSec` を B3 が使う)。
**S1 landing 強く推奨**(スチル区間は無音なので、BGM が鳴らないと実用にならない)。

解決する要望: 母艦 §2 の **(4) 画像の表示時間を伸ばして動画を長くしたい**。

---

## 0. 根本の診断 — 何が本当に足りないのか

**「画像 insert に大きい `durationSec` を書け」は対症療法。** 事実として:

- `overlays[]` の画像は**出力尺を伸ばせない**。`remapIntervalPieces`
  (`src/lib/timeline.ts:222-249`)は既存 entries との交差しか返さず、
  最後の keep より後ろは黙って切り捨てられる
- `inserts[]` の画像は**伸ばせる**。`timeline.ts:102` の `outCursor += p.durationSec`。
  描画側も完成済み(`describeFrame.ts:543` が `sourceKind:"image"` を出し、
  `compositor.ts:187-209` の `resolveImageLayer` が固定タイムスタンプ0で
  1度だけデコードしてキャッシュ = **宣言した尺いっぱい必ず描かれる**)

つまり**機構は既にある**。使い物にならない理由は5つ、すべて周辺にある:

| # | 実害 | 根本 |
|---|---|---|
| 1 | JPEG のスチルに `material-fit` が「尺を0へ潰せ」と提案する | 画像判定の出所が3つに分裂し、うち1つが実尺を誤って信じる |
| 2 | `durationSec: 400`(`4` の打ち間違い)が無検査で通り 400秒の動画になる | 出力尺に対する検証が存在しない |
| 3 | エディタで静止画クリップの左端をドラッグすると `startFrom` が書かれる | insert のトリムが動画素材前提 |
| 4 | スチル区間が無音 | BGM が挿入で切れる(**S1 が解決**) |
| 5 | `describe` でスチルと動画クリップの区別がつかない | 射影に kind が無い |

**この5つを潰すことが (4) の根本解決。** 新しいアンカー軸(`inserts[].timebase:"output"`)は
**入れない**(母艦 §6 の却下記録を参照。intro は `at:0`、ending は
`at: manifest.durationSec` で既に表現でき、中間配置は source アンカーの方が
「内容に貼り付く」ぶん正しい)。

---

## B1: 画像判定の出所を1つにする

### 現状 — 3つの実装が存在し、2種類の答えを返す

| 場所 | 実装 | `.tiff` / `.heic` |
|---|---|---|
| `src/lib/overlayFade.ts:32-33` | `/\.(png\|jpe?g\|webp\|gif\|bmp\|avif)$/i` | **画像でない** |
| `src/stages/validate.ts:456-457` | 上の**手書きコピー**(コメントで「同じ判定にする」と宣言) | **画像でない** |
| `src/lib/materials.ts:23-24` | `IMAGE_EXT` Set(`.tiff`/`.heic` を含む) | **画像** |

`overlayFade.isImageFile` は `describeFrame.ts:488,543`(描画)と
`insertMix.ts:128`(音声)が使う**描画の正**。
`materials.classifyKind` は `materials`/`material-fit`/`materialAnchors` が使う**知覚の正**。
**`.heic` の静止画を insert すると、描画は「動画」として扱い、`materials` は「画像」として扱う。**

### 修正

`src/lib/overlayFade.ts` は Node 非依存でなければならない(ブラウザ側も import する。
`overlayFade.ts:3-6` の注記)。`materials.ts` は `node:path` の `extname` を使うので
そのままは持ち込めない。**拡張子リストを Node 非依存の1箇所へ寄せる**:

`src/lib/overlayFade.ts`:
```ts
/** 画像とみなす拡張子。**描画(describeFrame/insertMix)と知覚(materials/
 * material-fit)の単一の出所**。ここに足したら両方の挙動が同時に変わる。
 * Node 非依存(ブラウザ側も import するため path モジュールを使わない) */
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|heic|heif)$/i;

export const isImageFile = (f: string): boolean => IMAGE_EXT_RE.test(f);
```

`src/lib/materials.ts`:
```ts
import { IMAGE_EXT_RE } from "./overlayFade.ts";
...
export function classifyKind(file: string): MaterialKind {
  const ext = extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT_RE.test(file)) return "image";     // ← 単一の出所
  if (AUDIO_EXT.has(ext)) return "audio";
  return "unknown";
}
```
`IMAGE_EXT` Set は削除する。

`src/stages/validate.ts:456-457` の手書きコピーを削除し、
`import { isImageFile } from "../lib/overlayFade.ts";` に置き換える
(ローカル変数名 `isImageFile` と衝突するので、ローカル定義を消すだけでよい)。

### テスト(`test/overlayFade.test.ts` または新規)
```ts
test("isImageFile / classifyKind: .tiff .heic が両方で画像になる", () => {
  assert.equal(isImageFile("materials/a.heic"), true);
  assert.equal(classifyKind("materials/a.heic"), "image");
  assert.equal(isImageFile("materials/a.tif"), true);
});
test("isImageFile: 動画拡張子は画像にならない", () => {
  for (const f of ["a.mp4", "a.mov", "a.mkv", "a.webm"]) assert.equal(isImageFile(f), false);
});
```

**`test/schema.test.ts` への影響**: 拡張子リストはスキーマに現れないため無し。
ただし `docs/usage.md` に画像拡張子の列挙があれば追随させる(5点セットの usage 分)。

---

## B4【実害あり】`material-fit` が JPEG のスチルを潰そうとする

### 事実(実測)
```
assets/backgrounds/teal.jpg          → format_name "image2",   duration "0.040000"
examples/sample/frames/out3.00s.png  → format_name "png_pipe",  duration キー無し
```

`src/lib/materialFit.ts:74-80` は「画像は `probe.durationSec` が undefined」を前提にする:
```ts
  // 画像素材(probe.durationSec 無し)…は除外する
  const materialDurationSec = entry.probe?.durationSec;
  if (materialDurationSec === undefined) continue;
```
**PNG では成立するが JPEG では成立しない。** `0.04` が入るので除外を素通りし、
`materialFit.ts:88` の
```ts
  if (startFrom + declaredSec > materialDurationSec + cfg.overrunEpsSec) { ... }
```
が `overrunEpsSec: 0.1`(`config.yaml:411`)に対して必ず真になる。
`overrunSuggestion`(`materialFit.ts:60-65`)は
overlay には `{op:"set", field:"end", value: start + 0}`、
insert には `{op:"set", field:"durationSec", value: 0}` を出す。
これが `material-fit.suggested.json` に入り、人間が `apply --patch` すると
**すべての JPEG スチルが尺0になる**。

既存テスト `test/materialFit.test.ts:147`
(`"detectFit: 画像素材(probe.durationSec 無し)は除外"`)は
`probe: { hasAudio: false, width: 1920, height: 1080 }` を**手作り**していて
`durationSec` を入れていないため、実 ffprobe の挙動を一切検証していない。

### 修正: 尺の有無ではなく **kind** で除外する

`src/lib/materialAnchors.ts:128` が既に採っている流儀(`material.kind === "video"`)へ揃える。

`src/lib/materialFit.ts:74-80`:
```ts
  // 画像素材は「尺」の概念を持たない(宣言した span いっぱい表示される)ので
  // 尺整合の対象外。**probe.durationSec の有無で判定してはいけない**:
  // PNG は png_pipe で duration 欠落だが JPEG は image2 で 0.04 を返すため、
  // 尺で判定すると全 JPEG が overrun になり「尺を0へ」の修正候補が出る(S2-B4)
  if (entry.kind === "image") continue;
  const materialDurationSec = entry.probe?.durationSec;
  if (materialDurationSec === undefined) continue;
```

`entry.kind` は `materials.probe/index.json` に既に入っている
(`src/stages/materials.ts:139` の `classifyKind(file)`)。型に無ければ足す。

### テスト(`test/materialFit.test.ts`)
既存の 147 行目のテストを**残したまま**、実 probe 形のケースを追加:
```ts
test("detectFit: JPEG スチル(probe.durationSec=0.04)も除外される", () => {
  // kind:"image", probe:{ durationSec: 0.04, width:1920, height:1080, hasAudio:false }
  // insert { durationSec: 8 } → findings が空であること
});
test("detectFit: 動画素材の overrun は従来どおり検出される", () => { ... });
```

---

## B2: 既定尺(NLE パリティ)

### 設計判断: `durationSec` は**必須のまま**にする

Premiere の "Still Image Default Duration" / FCP の既定尺に相当する概念を入れるが、
**データモデルでは `durationSec` を必須に保つ**。理由:

- JSON Schema で「画像のときだけ `durationSec` 任意」を表現するには
  `file` への大小文字非依存 `pattern` + `if/then/else` が必要で、
  ECMA-262 の `pattern` にインラインフラグが無いため
  `[pP][nN][gG]` 級の綴りになる。`test/schema.test.ts` の drift ゲートも複雑化する
- **`describe`/`apply`/エディタが「尺がいくつか」を常に読める**という現在の
  単純さは、AI が編集する系では実利が大きい

### やること: **生成側**が config から既定尺を入れる

`config.yaml`(`materialFit:` セクションの直後、L415 付近)に追加:
```yaml
# 静止画クリップ(inserts[] に置いた画像)の既定。画像は固有の尺を持たないので、
# 生成側(plan-materials / hyperframe-place / GUI の追加)が durationSec を
# 書くときの初期値になる。既存の durationSec を書き換えることはない
stills:
  defaultDurationSec: 5.0
  # 1つの静止画クリップが出力尺のこの割合を超えたら validate が警告する
  # (durationSec の桁間違いを検出する。0 で無効)
  maxShareWarnRatio: 0.5
```

読み出しは `src/lib/config.ts` の既存パターンに従い `resolveStillsCfg(cfg)` を足す
(`resolveAvCfg` / `resolveBgmFitCfg` と同じ流儀。未設定でも既定値で動くこと)。

書き手:
- `src/stages/planMaterials.ts` — 画像を insert として置く候補で `durationSec` 未定なら既定値
- `src/stages/hyperframePlace.ts` — 同様(HF カードは mp4 なので通常は実尺だが、
  画像として置く経路があれば)
- `editor/client/` の「素材を追加」経路 — 画像を選んだときの初期 `durationSec`

**既存の `durationSec` を後から書き換える処理は入れない**(人間が決めた尺が正)。

---

## B3: 出力尺に対する検証

### 現状
`src/stages/validate.ts:549-551` は `durationSec > 0` しか見ない:
```ts
  if (!isNum(o.durationSec) || o.durationSec <= 0) {
    err(f, w, `durationSec(挿入する尺)は正の数です: ${JSON.stringify(o.durationSec)}`);
  }
```
上限も、出力尺との関係も、素材の実尺との関係も**一切検査しない**。
`durationSec: 400`(`4` の打ち間違い)は無警告で通り、出力が400秒伸びる。

### 修正: 出力尺に対する占有率を警告する

S0-T1 が `validate` スコープに供給する `outputDurationSec` を使う。
**エラーではなく警告**(意図的に長いスチルは正当なユースケース)。

`validate.ts` の `inserts` ループ(`541-557`)へ追加:
```ts
  // 挿入1件が出力の大半を占めるときは警告する(durationSec の桁間違いの検出)。
  // 意図的に長いスチルは正当なので error ではなく warn(S2-B3)
  const shareRatio = stillsCfg.maxShareWarnRatio;
  if (
    shareRatio > 0 &&
    outputDurationSec !== null &&
    outputDurationSec > 0 &&
    isNum(o.durationSec) &&
    o.durationSec / outputDurationSec > shareRatio
  ) {
    warn(
      f, w,
      `durationSec(${fmtT(o.durationSec)})が出力尺(${fmtT(outputDurationSec)})の` +
        `${Math.round((o.durationSec / outputDurationSec) * 100)}%を占めます` +
        `(桁の書き間違いでなければ無視してください)`,
    );
  }
```

**注意**: `outputDurationSec` は**この挿入を含んだ**出力尺。よって
「挿入1件しか無い60秒のスチル+30秒の本編」では ratio = 60/90 = 0.67 で警告が出る。
これは意図どおり(そういう構成なら警告を無視すればよい)。

### テスト(`test/validate.test.ts`)
```ts
test("validate: 出力尺の過半を占める挿入は警告(エラーではない)", () => { ... });
test("validate: 通常の尺の挿入は警告が出ない", () => { ... });
test("validate: maxShareWarnRatio:0 なら警告しない", () => { ... });
```

---

## B5: エディタが静止画クリップを壊さないようにする

### 現状 — トリム自体は既にある

`editor/client/Timeline.tsx:1348,1355` が `trim-start` / `trim-end` の
ポインタハンドルを既に出しており、`editor/client/App.tsx:3141-3157` が insert に対して:

```ts
      if (mode === "trim-end") {
        arr[sel.index] = { ...ins, durationSec: round2(Math.max(MIN_SPAN, ins.durationSec + d)) };
      } else if (mode === "trim-start") {
        // 頭出し(In点トリム / ripple-trim-in): 割り込み位置 at は固定。素材の頭を
        // 削り(startFrom 増・尺減)、out 点(startFrom+尺)は保つ。
        const sf0 = ins.startFrom ?? 0;
        const out = sf0 + ins.durationSec;
        const sf1 = clamp(round2(sf0 + d), 0, round2(out - MIN_SPAN));
        const next = { ...ins, durationSec: round2(out - sf1) };
        if (sf1 > 0) next.startFrom = sf1;
        else delete next.startFrom;
        arr[sel.index] = next;
      }
```

**`trim-end` は静止画でも正しく動く**(= 「引き伸ばす」は既に可能)。
**`trim-start` が静止画を壊す**: 画像に In 点は存在せず
(`validate.ts:465-471` は「`startFrom` は動画素材のみ有効です(画像では無視されます)」と
警告する)、`startFrom` を書きながら尺だけが縮む = **左端を左へ引いても伸びず、
無意味な `startFrom` が JSON に残る**。

### 修正: 静止画では両端とも尺の変更にする

```ts
      const isStill = isImageFile(ins.file);          // ← B1 の単一の出所を import
      if (mode === "trim-end") {
        arr[sel.index] = { ...ins, durationSec: round2(Math.max(MIN_SPAN, ins.durationSec + d)) };
      } else if (mode === "trim-start" && isStill) {
        // 静止画に In 点は無い(startFrom は画像では無視される)。左端のドラッグは
        // 尺の伸縮として扱う。左へ引く(d<0)と伸び、右へ引くと縮む(S2-B5)
        arr[sel.index] = { ...ins, durationSec: round2(Math.max(MIN_SPAN, ins.durationSec - d)) };
      } else if (mode === "trim-start") {
        ...(既存の動画素材向け In 点トリムをそのまま)
      }
```

**符号に注意**: `trim-end` は `+d`、静止画の `trim-start` は `-d`
(左へ引く = `d < 0` = 尺が増える)。

あわせて `editor/client/Inspector.tsx` の insert セクションで、
静止画のときは `startFrom` のフィールドを**出さない**(または disabled にする)。
既存の `isImageFile` 相当の判定が Inspector に無ければ B1 の import を使う。

### 検証
エディタで静止画 insert を選び、左端・右端をドラッグして
`overlays.json` の `durationSec` だけが変わり `startFrom` が現れないこと。
既存の動画 insert のトリム挙動が**1ピクセルも変わらない**こと。

---

## B6: `describe` がスチルを区別して出す

### 現状
`src/stages/describe.ts` の `InsertEntry`(`describe.ts:552-564`)は
`at` / `out` / `file` / `durationSec` を持つが**種別が無い**。
散文側(`describe.ts:305-310`)も「挿入」としか出さない。
AI が `describe` を読んで「これは40秒の静止画だ」と分かる手段が無い。

### 修正
`InsertEntry` に追加:
```ts
  /** 素材の種別。"image" は静止画クリップ(尺は宣言値そのもの・音声なし)。
   * 判定は src/lib/overlayFade.ts の IMAGE_EXT_RE(描画と同じ出所) */
  kind: "image" | "video";
```
`buildProjection` の insert 構築で `kind: isImageFile(ins.file) ? "image" : "video"` を詰める。

散文側は静止画のときだけ1語足す:
```
挿入 [静止画] 40.0s  materials/slide-01.png   元 120.0 → 出力 95.0–135.0
```
**動画 insert の行は1バイトも変えない**(バイト等価)。

`docs/usage.md` の `describe --json` の説明に `kind` を追記(5点セットの usage 分)。
`schemas/` は `describe` の出力を持たないため無変更。

---

## 検証

```sh
npx tsc --noEmit
npm test          # overlayFade / materialFit / validate / describe
npm run gate:pixel
```

### 実収録での確認(要望(4)の end-to-end)
```sh
# 1) 末尾に 20秒の静止画エンディングを足す
#    overlays.json:
#      "inserts": [{ "at": <manifest.durationSec>, "file": "materials/end.png", "durationSec": 20 }]
node src/cli.ts validate <dir>          # 占有率が高ければ警告が出る(意図どおりなら無視)
node src/cli.ts describe <dir>          # 「挿入 [静止画] 20.0s」と出る
node src/cli.ts frames <dir> --out --t <出力尺-5>   # 静止画が全画面で出ている
node src/cli.ts render <dir>
node src/cli.ts av <dir> --sound-only   # S1 済みなら末尾20秒でも BGM の RMS が落ちない
```

```sh
# 2) JPEG スチルで material-fit が潰そうとしないこと(B4)
node src/cli.ts materials <dir>
node src/cli.ts material-fit <dir>
# → material-fit.suggested.json に durationSec:0 / end:start の提案が出ないこと
```

```sh
# 3) エディタ(B5)
node src/cli.ts editor <dir>
# 静止画 insert の左端をドラッグ → durationSec だけ変わる / startFrom が出ない
```

### バイト等価の回帰(母艦 §8-1)
静止画 insert を1件も持たない既存収録で、
`describe`(散文・`--json`)/ `validate` の警告一覧 / `material-fit.suggested.json` が
S2 導入前と同一であること。

---

## この段が S3 以降へ渡すもの

| 渡すもの | 使う段 |
|---|---|
| `IMAGE_EXT_RE`(描画と知覚の単一の出所) | S3(スライドは全部画像) |
| `stills.defaultDurationSec` / `resolveStillsCfg` | S3(スライドの既定尺) |
| `InsertEntry.kind` | S4(射影の種別ラベル) |
| 「静止画クリップが尺を持つ一級市民」という状態 | S3(V1 が全部スチルになる) |
