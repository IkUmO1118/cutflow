# P1: キャンバスのプロジェクト昇格 — 出力サイズを Short から取り出す

親ドキュメント: `docs/programs/editor-first-project-program.md`(編集器ファースト母艦)
状態: **COMPLETE / VERIFIED** / 2026-08-02
前提: **P0 landing 必須**(`Short.profile` が消えていること。消えていないと
キャンバスの置き場所が Short とプロジェクトで二重になる)。

---

## 0. この plan が達成すること

`src/lib/profile.ts` の `PROFILES` を **Short 専用の設定から、プロジェクトの
一級属性へ昇格**させる。P0 の終了時点で失われた「縦動画を作る手段」を、
より一般的な形(16:9 / 9:16 / 1:1 / 4:5 のプロジェクト)で取り戻す。

**キャンバスは作成時に固定**(母艦 §4 決定3)。後から変える手段は作らない。

## 1. 発見 — 昇格先は既に1つの式に集約されている

コードベースを走査すると、「このプロジェクトの出力解像度は何か」という問いの
答えは**既に単一の式**で表現されている:

```ts
resolveProfile(manifest.video.screenRegion, "default")
```

出現箇所(2026-08-02 時点、P0 適用後の想定):

| ファイル | 行 |
|---|---|
| `src/stages/render.ts` | `:257` |
| `src/stages/renderEngine.ts` | `:128` |
| `src/stages/planEffects.ts` | `:474` |
| `src/stages/thumbnail.ts` | `:64` |
| `src/stages/autoZoom.ts` | `:96` |

加えて `screenRegion` を「出力解像度」として**直接**使っている箇所:

| ファイル | 行 | 用途 |
|---|---|---|
| `src/stages/validate.ts` | `:252-254` | 座標の範囲検査(`outputRegion`) |
| `src/stages/av.ts` | `:504-505` | 出力寸法 |
| `src/stages/describe.ts` | `:966` | 射影の出力寸法 |
| `src/stages/planEffects.ts` | `:363-377` | 「resolveProfile と同じ値」と明記したうえで直接使用 |
| `src/stages/review.ts` | `:371`, `:703` | still の領域 |
| `src/stages/editorAi.ts` | `:1033` | `outputBounds` |
| `src/stages/frames.ts` | `:279-281` | OCR 座標の出力px 換算 |

**この plan の本体は「この2種類の式を1つの関数へ集約し、その関数に
`manifest.canvas` を見させること」に尽きる。**

## 2. 決定 — キャンバスは `manifest.json` に置く(母艦 §6 の未決を解消)

**結論: `manifest.json` の `canvas` フィールドに置き、`ingest` が書く。**

根拠:
- `manifest.json` は既に「収録フォルダの中身だけからは復元できない ingest の
  決定」を保持する場所である(`layout` / `screenRegion` / `cameraRegion` /
  音声トラック番号)。`clean` の保護対象でもある(CLAUDE.md)。
  キャンバスはまさに同じ性質の値
- `layout` に**完全な先例がある**: `--layout` フラグで指定し、
  `bootstrapProjectWithLayout`(`src/stages/bootstrap.ts:44-53`)が
  「既に別の layout で作成済み」を検出して明示的なエラーで止める。
  **キャンバスも同じガードをそのまま適用する**(= 作成時固定の実装)
- 新しい編集ファイルを増やさない(母艦 §8-2)

**AI は `manifest.json` を編集しない**という既存のルールは変わらない。
キャンバスを書く主体は `ingest` だけ(`--canvas` フラグ / config 既定 /
エディタのプロジェクト作成ダイアログが `ingest` へ渡す)。

## 3. スキーマ

### 3.1 `src/types.ts` の `Manifest`

```ts
export interface Manifest {
  // …既存…
  video: {
    width: number;
    height: number;
    fps: number;
    screenRegion: Region;
    cameraRegion?: Region;
  };
  /** 出力キャンバス(= 出力解像度 + ベース映像のパネル配置)。
   *  **省略時は screenRegion のサイズ**(= 従来どおり。既存収録はバイト等価)。
   *  作成時に固定され、後から変えられない(pos / rect / blurs.rect /
   *  annotations / zooms.rect がすべて出力px絶対のため)。
   *  値は src/lib/profile.ts の CANVAS_PRESETS のキー */
  canvas?: string;
}
```

**`canvas` は文字列のプリセット名1つだけ**にする。width/height を直接書かせない:
- 設定爆発を避ける(`profile.ts` 冒頭の D1「プリセットは閉じた組み込み」を継承)
- `layout.panels` / `caption` 既定とセットでないと意味を持たない

### 3.2 `src/lib/profile.ts`

`PROFILES` を `CANVAS_PRESETS` へ改名し、キーを**アスペクト比の語彙**にする。
中身(`layout.panels` / `caption`)は P0 で残した既存値をそのまま流用する。

| 新キー | 寸法 | 中身の出所 |
|---|---|---|
| `landscape`(既定) | `screenRegion` のサイズ | 旧 `default`(layout 無し=現行ワイプ経路) |
| `portrait` | 1080×1920 | 旧 `vertical`(camera 上 / screen 下 / 下部テロップ帯) |
| `portrait-cover` | 1080×1920 | 旧 `vertical-cover`(camera 全面) |
| `portrait-screen` | 1080×1920 | 旧 `vertical-screen`(screen を上3/4 contain) |
| `square` | 1080×1080 | **新規**。screen を全面 contain + テロップ下部中央 |
| `portrait-4x5` | 1080×1350 | **新規**。screen を上4/5 contain + 下部テロップ帯 |

- 旧キー名(`default` / `vertical` / `vertical-cover` / `vertical-screen`)は
  **エイリアスとして残さない**。P0 で唯一の消費者(`Short.profile`)が消えており、
  外部から参照されない
- `resolveProfile(defaultSize, name)` は `resolveCanvas(manifest)` に置き換える(§4)
- `Profile` 型・`BasePanel` 型はそのまま

**新規プリセット2つ(`square` / `portrait-4x5`)の幾何は仮案。**
実装後に `frames` で1枚撮って目視し、テロップ帯の高さを調整する。
`portrait-screen` の構造(screen を上側へ contain、下部を黒帯のテロップ領域)を
比率だけ変えて写すこと。

### 3.3 config

```yaml
render:
  # プロジェクト作成時の既定キャンバス。ingest の --canvas で実行時に上書きできる。
  # 省略時 landscape(= 従来どおり screenRegion のサイズ)
  canvas: landscape
```

`src/lib/config.ts` に `render.canvas?: string` と
`DEFAULT_CANVAS = "landscape"` を足す。

## 4. 単一の出所を作る

`src/lib/profile.ts` に新設:

```ts
/** このプロジェクトの出力キャンバスを解決する唯一の関数。
 *  manifest.canvas が無ければ screenRegion のサイズ(= 従来の
 *  resolveProfile(manifest.video.screenRegion, "default"))を返す。
 *  §1 に列挙した全消費者はこの関数だけを呼ぶ */
export function resolveCanvas(manifest: Manifest): Profile;

/** 出力解像度だけが要る消費者のための薄い糖衣。
 *  { w, h } を返す(旧 manifest.video.screenRegion の直接参照を置き換える) */
export function outputSize(manifest: Manifest): { w: number; h: number };
```

### 置き換え表

| 現行の式 | 置き換え先 |
|---|---|
| `resolveProfile(manifest.video.screenRegion, "default")` | `resolveCanvas(manifest)` |
| `manifest.video.screenRegion.w` / `.h`(**出力寸法として使っている箇所だけ**) | `outputSize(manifest).w` / `.h` |

⚠️ **`screenRegion` の全参照を機械的に置換してはいけない。**
`screenRegion` には2つの役割がある:

1. **ソース映像のどこを切り出すか**(ffmpeg のクロップ矩形。元収録の画素座標)
2. **出力解像度**(1 の結果がそのまま出力になる、という現行の恒等が根拠)

キャンバス導入で**この恒等が壊れる**。置き換えるのは 2 の用途だけ。
1 の用途(`render.ts:101` の `const sr = manifest.video.screenRegion` による
クロップ、`frames.ts:273` の OCR クロップ、`assert.ts:484` の OCR クロップ)は
**そのまま `screenRegion` を使い続ける**。

各箇所の判定:

| 箇所 | 役割 | 措置 |
|---|---|---|
| `render.ts:101` | 1(クロップ) | 変更なし |
| `render.ts:257` | 2 | `resolveCanvas` |
| `render.ts:274-280` | 1→2 の橋(composite 時にベースを焼き込み済み扱いにする) | **要注意**。§7 の落とし穴参照 |
| `renderEngine.ts:128` | 2 | `resolveCanvas` |
| `planEffects.ts:363-377`, `:474` | 2 | `resolveCanvas` / `outputSize` |
| `thumbnail.ts:64` | 2 | `resolveCanvas` |
| `autoZoom.ts:96` | 2 | `resolveCanvas` |
| `validate.ts:252-254` | 2(座標範囲の検査) | `outputSize` |
| `av.ts:504-505` | 2 | `outputSize` |
| `describe.ts:966` | 2 | `outputSize` |
| `review.ts:371`, `:703` | 2 | `outputSize` |
| `editorAi.ts:1033` | 2 | `outputSize` |
| `frames.ts:273` | 1(OCR クロップ) | 変更なし |
| `frames.ts:279-281` | 1→2 の換算(OCR box を出力px へ) | **要注意**。§7 |
| `assert.ts:484` | 1(OCR クロップ) | 変更なし |

## 5. CLI / エディタ

- `ingest` に `--canvas <preset>` を足す(`src/stages/ingest.ts:204` の
  シグネチャに `canvas?: string` を追加)。`run` / `editor` にも同じフラグを通す
  (`--layout` と完全に同じ配線をコピーする)
- `bootstrapProjectWithLayout` に canvas 版のガードを足す:
  既存 manifest の `canvas` と指定された `--canvas` が食い違うときは
  **`--layout` と同じ文面のエラーで止める**(`bootstrap.ts:44-53` を写す)
- `node src/cli.ts canvases`(または `commands` の一覧に載る形)で
  プリセット一覧を出せるようにする — **任意**。無くてもよい
- エディタ: P0 で消した Panels.tsx のヒントブロックの位置に、
  **現在のキャンバス名を表示するだけ**の読み取り専用表示を置く。
  切り替え UI は作らない(作成時固定のため)。プロジェクト作成時の選択は
  P5(ランチャー)の仕事

## 6. テスト

**新規**:
1. `manifest.canvas` が無いプロジェクトで `resolveCanvas` が
   `screenRegion` のサイズを返す(**バイト等価の要**)
2. `manifest.canvas: "portrait"` で 1080×1920 と `layout.panels` が返る
3. 未知のプリセット名で明確に throw する
4. `bootstrapProjectWithLayout` が canvas 不一致を検出して止める
5. `outputSize` が `resolveCanvas` の width/height と常に一致する

**回帰(最重要)**: `manifest.canvas` を書かないプロジェクトで
`render` / `frames` / `describe` / `validate` / `av` / `thumbnail` の出力が
**P1 導入前とバイト等価**であること。既存の `renderProps.test.ts` /
`describe.test.ts` のゴールデンが変わらないことで担保する。

**ゲート**: `npx tsc --noEmit` / `npm test` / **`npm run gate:pixel` 必須**
(`renderProps` の入力経路を触るため)。

**5点セット**: `src/types.ts`(`Manifest.canvas`)/ `validate.ts` /
`docs/usage.md`(キャンバスの節を新設)/ `schemas/`(manifest のスキーマがあれば)/
`AGENTS_CONTRACT.md`(`ingest --canvas` の追加でコマンド表面が変わる)。

## 7. 落とし穴

- **`render.ts:274-280`(composite 経路)**: ベース映像を焼き込み済みとして
  `props.screenRegion = { x:0, y:0, w:sr.w, h:sr.h }` に潰している。
  キャンバスが `screenRegion` と違うサイズのとき、この式は**出力解像度ではなく
  ベース映像の寸法**を指すべき。`resolveCanvas` に置き換えると壊れる可能性が
  高いので、**この箇所は最後に触り、`gate:pixel` で必ず確認する**
- **`frames.ts:279-281` の OCR 座標換算**: 「screenRegion 画素 = 出力px の恒等」に
  依存しているとコメントに明記されている。キャンバス導入でこの恒等が壊れるため、
  `resolveCanvas` の `layout.panels` を見て「画面パネルが出力のどこに、どの倍率で
  置かれるか」から換算し直す必要がある。**landscape(layout 無し)では恒等が
  保たれるので、既存収録は影響を受けない**
- **`validate` の座標範囲検査**: キャンバスが縦になると、既存の横向き前提の
  `pos` / `rect` が範囲外になる。これは**正しい警告**(作成時固定なので、
  そもそも横向きプロジェクトが縦になることはない)。新規の縦プロジェクトで
  誤検知しないことだけ確認する
- **`PROFILES` 改名の巻き添え**: `test/profile.test.ts` が旧キー名を参照している。
  P0 で一部削除済みのはずだが、残りを新キー名へ更新する

## 8. 完了記録(2026-08-02)

- `manifest.canvas` と閉じた `CANVAS_PRESETS` を導入し、出力寸法の単一入口を
  `resolveCanvas()` / `outputSize()` に統一した。canvas 省略時は `screenRegion` 寸法と
  layout 無しを返し、既存プロジェクトの描画を維持する。
- `ingest` / `run` / `editor` に `--canvas` を通し、bootstrap 済み manifest と異なる
  canvas の再指定を拒否する。エディタは現在値を読み取り専用表示する。
- render / engine / frames / thumbnail / validate / av / review / editor AI / effect planning の
  出力寸法を canvas に接続し、OCR・cursor は screen panel の実表示矩形へ写像する。
- `square`(1080x1080) と `portrait-4x5`(1080x1350)を追加し、既存縦 profile を
  `portrait*` 語彙へ移した。非 landscape では旧 wipe burn-in 高速経路を安全側で止める。
- 主担当が独立に実測したゲート:
  - `npm run typecheck`: PASS
  - `npm test`: **2692 / 2692 PASS**
  - `npm run gate:pixel`: **11 / 11 一致、exit 0**
  - square / portrait-4x5 を `ingest --canvas` で作成し、`frames --t 2.5` が成功
  - PNG 実寸: **1080x1080 / 1080x1350**。両方を目視し、screen contain・下部帯・
    caption 位置に破綻なし
  - 未知 canvas の validate error、bootstrap 不一致拒否、`git diff --check`: PASS
- 次の一手は P2(空プロジェクトと GUI base-media 選択)。
