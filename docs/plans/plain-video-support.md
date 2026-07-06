# 通常動画(plain)の一級サポート — 実装計画

対象: OBS 拡張キャンバス方式でない通常の動画(スマホ・カメラ・画面録画)を
ingest からエディタ・レンダーまで一級サポートする。**OBS 形式(obs-canvas)の
既存挙動は完全維持する。** 音声なし動画は対象外(ingest の既存エラーを維持)。

判断の要約は `docs/decisions.md` の該当エントリを参照。この文書は Sonnet 実装
セッションへ渡す実装分解(スキーマ差分+1タスク=1コミット)。

---

## 引き継ぎ資料の訂正(実装前に共有)

コードを読んで確認した結果、引き継ぎの「確定した事実」に次の不正確があった。
**幻の機能を追わないこと。**

1. **`src/lib/profile.ts`(ショート縦プロファイル)は存在しない。** 縦動画/
   ショート用のプロファイル機能はコードベースに無い(`grep -rniE 'vertical|ショート|profile'`
   で該当なし)。→ 論点4の vertical / vertical-cover は実装対象が無い。将来
   足すなら plain(縦は縦のまま出力)の上に `fit: cover` 相当で乗せる。今回は
   スコープ外。
2. **ズーム映像効果は存在しない。** `zoom` は `editor/client/Timeline.tsx` の
   タイムライン横スケール UI のみ。→ 論点4の「zooms」はカメラ非依存で確認不要。
3. **`validate.ts:117` は出力解像度チェックではない**(`cutplan.segments` の配列
   チェック)。validate は出力解像度を検査していない。真の消費箇所は
   `render.ts:84` / `frames.ts:103` / `editor/server.ts:309`(すべて
   `cfg.ingest.screenRegion` を直読み)。

---

## 設計の核

現状 `manifest.video.screenRegion` は ingest 時に config から焼き込まれている
のに、`render` / `frames` / `editor` は**出力解像度を config から再び読んで**
いる(二重の真実源)。これを **manifest 一本に寄せる**のが plain 対応の要:

- **出力解像度 = `manifest.video.screenRegion.{w,h}`**(config ではなく manifest)。
  obs-canvas では値が同じなので出力はバイト同一。plain では screenRegion=全フレーム
  なので、縦動画は縦のまま・4K は 4K のまま、config を触らず自然に出る。
- **plain は「カメラの無い obs-canvas」として表現する。** `cameraRegion` を
  optional にし、plain では持たない。ワイプ(器の crop 元)が無い=ワイプ関連
  機能を出さない、という一点に集約される。`CroppedVideo` は screenRegion=全フレーム
  なら scale=1 の恒等クロップになり、既存の描画経路をそのまま流用できる。

---

## Manifest / RenderProps スキーマ差分(types.ts / remotion/props.ts)

### `src/types.ts` — Manifest

```ts
export interface Manifest {
  dir: string;
  source: string;
  durationSec: number;
  /** レイアウト。省略時は "obs-canvas"(旧 manifest 互換)。
   *  obs-canvas: 拡張キャンバス(画面+カメラ横並び)。cameraRegion を持つ
   *  plain:      通常動画。カメラ無し。screenRegion は全フレーム */
  layout?: "obs-canvas" | "plain";
  video: {
    width: number;
    height: number;
    fps: number;
    /** 出力に使う画面領域(=出力解像度)。obs-canvas は 3840x1080 内の
     *  画面部分、plain は全フレーム(= {x:0,y:0,w:width,h:height}) */
    screenRegion: Region;
    /** カメラ(ワイプ)領域。plain では無し(ワイプ非対応) */
    cameraRegion?: Region;   // ← optional 化(既存は必ず持つので後方互換)
  };
  audio: { micStream: number; systemStream: number | null; micWav: string };
  createdAt: string;
}

/** manifest のレイアウト(未指定は旧 manifest 互換で obs-canvas) */
export const manifestLayout = (m: { layout?: string }): "obs-canvas" | "plain" =>
  m.layout === "plain" ? "plain" : "obs-canvas";

/** ワイプ(カメラ)を持つレイアウトか。plain・cameraRegion 欠落は false */
export const hasCamera = (m: Manifest): boolean =>
  manifestLayout(m) === "obs-canvas" && m.video.cameraRegion != null;
```

後方互換: 既存 manifest は `layout` を持たない → `manifestLayout` が
"obs-canvas" を返し、`cameraRegion` も持つので `hasCamera` = true。挙動不変。

### `remotion/props.ts` — RenderProps

```ts
export type RenderProps = {
  ...
  screenRegion: Region;
  cameraRegion?: Region;   // ← optional 化。plain では undefined
  ...
};
// defaultProps は obs-canvas のダミー値のまま(cameraRegion を持つ)。変更不要。
```

### `src/lib/config.ts` / `config.yaml` — ingest.layout

```ts
ingest: {
  screenRegion: Region;
  cameraRegion: Region;
  micTrack: number;
  systemTrack: number;
  /** 収録レイアウトの既定。省略時 "obs-canvas"(旧 config 互換)。
   *  auto = キャンバス寸法(W×H)が完全一致なら obs-canvas、それ以外は plain */
  layout?: "obs-canvas" | "plain" | "auto";
};
```

config.yaml は既定 `obs-canvas` を明記(既存 OBS 収録の挙動を1ミリも変えない)。

---

## タスク分解(1タスク=1コミット)

### 前半 — データモデル+非表示ロジック(types / ingest / validate / renderProps)

#### F1. Manifest / RenderProps / Config のスキーマ拡張(挙動変更なし)
- `src/types.ts`: `Manifest.layout?`、`video.cameraRegion?` optional 化、
  `manifestLayout` / `hasCamera` を追加。コメントも更新。
- `remotion/props.ts`: `RenderProps.cameraRegion?` optional 化。`defaultProps` は不変。
- `src/lib/config.ts`: `ingest.layout?` 追加。
- **テスト方針**: `npm run typecheck` が通る。`test/*.test.ts` に `manifestLayout` /
  `hasCamera` の単体テスト(layout 未指定→obs-canvas、plain→plain、
  cameraRegion 欠落→hasCamera=false)を追加。
- **壊してはいけない**: 既存 manifest(layout 無し)が同じ意味で読める。
  `defaultProps` の形は不変(Remotion Studio が動く)。この時点で ingest は
  まだ layout を書かない=生成物は完全に従来どおり。

#### F2. config.yaml に ingest.layout を追記(既定 obs-canvas)
- `config.yaml` の `ingest:` に `layout: obs-canvas` とコメントを追記。
- **テスト方針**: `loadConfig` が読めること(既存の config テストがあれば追随、
  無ければ手動 `node src/cli.ts validate` 系で起動確認)。
- **壊してはいけない**: `layout` キーの無い古い config.yaml でも
  `cfg.ingest.layout === undefined` として動く(F3 で undefined→obs-canvas 解決)。

#### F3. ingest の layout 解決と plain 書き出し
- `src/stages/ingest.ts`:
  - 実効 layout を決める純関数 `resolveLayout(explicit, cfgLayout, width, height, cfg)` を
    切り出す(テスト容易化)。優先順: 明示引数 > config > 既定 obs-canvas。
    `auto` はキャンバス寸法 **W=(screenRegion.w+cameraRegion.w) かつ H=screenRegion.h の
    完全一致で obs-canvas、それ以外は plain**。
  - plain のとき: `screenRegion = {x:0,y:0,w:width,h:height}`、`cameraRegion` は
    書かない、`width < expected` の警告は出さない、`manifest.layout = "plain"`。
  - obs-canvas のとき: 従来どおり(screenRegion/cameraRegion を config から焼き込み、
    幅不足の警告も維持)+ `manifest.layout = "obs-canvas"` を明示的に書く。
  - `ingest()` に layout 引数(optional)を追加。
- 呼び出し口:
  - `src/cli.ts` の `ingest <dir>` / `run <dir>` に `--layout <plain|obs-canvas|auto>`
    フラグを追加し ingest へ渡す(未指定は config 既定)。
  - `src/stages/bootstrap.ts`: editor 起動ブートストラップは **plain を明示指定**して
    ingest を呼ぶ(動画だけのフォルダを開く=通常動画のユースケース)。
- **テスト方針**: `resolveLayout` の単体テスト(明示 plain / 明示 obs / auto の
  完全一致→obs / auto の 1920x1080→plain / auto の 3840x2160→plain / config 既定)。
- **壊してはいけない**: 既定(obs-canvas)経路の manifest は `layout: "obs-canvas"` が
  増える以外は従来と同一(screenRegion/cameraRegion/audio すべて同値)。既存 OBS
  収録に対する `run` の挙動不変。**auto は既定にしない**(3840x1080 の通常動画を
  誤判定するため。誤判定回避の明示手段として `--layout` を残す)。

#### F4. 出力解像度を manifest から読む(二重真実源の解消)
- `src/stages/render.ts:84` / `src/stages/frames.ts:103`: `width/height` を
  `cfg.ingest.screenRegion.{w,h}` → `manifest.video.screenRegion.{w,h}` に変更。
- `src/lib/renderProps.ts`: `buildRenderProps` は既に `manifest` を受け取り
  `width/height` 引数も受ける。呼び出し側が manifest 由来の値を渡すよう統一。
  `props.cameraRegion` は `manifest.video.cameraRegion`(undefined ならそのまま
  undefined)を渡す(現状 line 171 の `cameraRegion: manifest.video.cameraRegion`)。
- `editor/server.ts:309` の `output` も `manifest.video.screenRegion` から作る
  (loadProject 内で manifest を読んでいるので置換するだけ)。
- **テスト方針**: obs-canvas の manifest(screenRegion 1920x1080)で
  `buildRenderProps` の `width/height/screenRegion` が従来と同値になる単体テスト。
  plain の manifest(例 1080x1920)で `width=1080,height=1920,cameraRegion=undefined`
  になるテスト。
- **壊してはいけない**: OBS の出力解像度 1920x1080 がバイト同一。config と
  manifest で screenRegion が食い違う場合は **manifest を正**とする(=ingest 後に
  config を変えても出力が壊れない。これは改善方向で退行ではない)。

#### F5. validate に plain ルールを追加
- `src/stages/validate.ts`:
  - manifest を読んで `hasCamera` を判定(型は F1 の Manifest)。
  - plain(カメラ無し)で `overlays.wipeFull` が非空 → **エラー**
    (「plain 動画にはカメラ(ワイプ)が無いため wipeFull は使えません」)。
  - plain で `overlays.layerOrder` に `"wipe"` が含まれる → **警告**(無視される旨)。
  - `manifest.video.cameraRegion` 欠落を「壊れ」とはみなさない(plain の正常形)。
- `docs/usage.md` のスキーマ表・`src/types.ts` コメントを揃えて更新(規約)。
- **テスト方針**: `test/*.test.ts`(validate 固定テスト)に plain fixture を追加。
  plain + wipeFull → エラー1件、plain + wipe in layerOrder → 警告1件、
  **obs fixture は従来どおり pass**(退行検知)。
- **壊してはいけない**: obs-canvas の検査結果(エラー/警告の数と内容)が不変。

### 後半 — 描画+エディタ UI(Remotion / editor / ドキュメント)

#### B1. Remotion Main.tsx を cameraRegion optional に対応
- `remotion/Main.tsx`:
  - `wipeH`(line 44)は `cameraRegion` があるときだけ計算(無ければワイプ非描画)。
  - `wipeLayer`(line 122)/ layerOrder の `"wipe"` ノード(line 205): `cameraRegion`
    が無ければ `null` を返す(ワイプを一切出さない)。
  - 字幕の既定位置(line 189-203)と `stdCaptionPos` 相当: **カメラが無ければ
    ワイプ回避の右側予約をせず、全幅中央**にする(`reserve = cameraRegion ?
    wipe.widthPx + wipe.marginPx*2 : 0`)。
  - `wipeFull`(line 49-51): plain では validate が弾くので通常来ないが、
    cameraRegion 無しなら全画面化しても crop 元が無い → ガードして無効化。
- **テスト方針**: 自動テストは無し(視覚)。plain の fixture 収録フォルダを1つ
  用意し、`node src/cli.ts frames <dir> --captions` と `--every 10` で
  「ワイプが出ない・字幕が全幅中央・縦動画が縦のまま」を PNG で自己確認。
  obs fixture でも frames を撮り、ワイプ・字幕予約が従来どおりを確認。
- **壊してはいけない**: obs-canvas のワイプ位置・サイズ、字幕の右側予約が同一。

#### B2. エディタ(server + client)にレイアウトを伝え、ワイプ UI を出し分け
- `editor/client/apiTypes.ts`: `ProjectData` に `hasCamera: boolean`(または
  `layout`)を追加。`output` は F4 で manifest 由来に。
- `editor/server.ts` `loadProject`: `hasCamera(manifest)` を詰める。
- `editor/client/App.tsx` / `model.ts`:
  - `buildTracks` に「ワイプトラックを含めるか」を渡す(カメラ無しなら `"wipe"`
    トラックを出さない)。または App 側で tracks から wipe を除外。
  - ワイプ常駐クリップの push(App.tsx:566)と wipeFull 作成(createKind
    `"wipeFull"`)をカメラ有り時のみに。
  - `stdCaptionPos`(App.tsx:717)を B1 と同じ「カメラ無し=全幅中央」に。
- **テスト方針**: 自動テストは無し。**エディタ検証はサーバー再起動が必須**
  (client は起動時1回だけ bundle。`memory/editor-bundle-restart.md`)。
  plain fixture で `npm run editor <plain-dir>` を再起動して開き、ワイプトラックが
  無い・字幕が全幅中央・保存が通ることを確認。obs fixture で従来 UI(ワイプ
  トラック+全画面スパン)が出ることを確認。headless 検証時は
  `memory/headless-chrome-muted-video-freeze.md` の注意に従う。
- **壊してはいけない**: obs-canvas のエディタでワイプトラック・wipeFull 作成・
  レイヤー並べ替えが従来どおり。

#### B3. ドキュメント整備(ユーザー向け)
- `docs/usage.md`: manifest スキーマ表に `layout` / `cameraRegion?` を追記
  (F5 で未了ならここで補完)。ワイプ系が plain 非対応である旨。
- `docs/getting-started.md` / `docs/recording-guide.md`: 「通常動画を動画だけの
  フォルダに置いて editor で開く(plain として自動 bootstrap)」フローを追記。
  `--layout` フラグと config `ingest.layout` の説明。
- **テスト方針**: ドキュメントのみ(コード変更なし)。記述と実装の一致を目視確認。
- **壊してはいけない**: 既存の OBS 収録手順の記述。

### スコープ外(今回やらない・幻の機能)
- 縦動画ショート専用プロファイル(`profile.ts`)— 存在しない。plain で縦は縦の
  まま出るので、専用機能なしで一次要件は満たす。将来やるなら plain の上に。
- ズーム映像効果 — 存在しない。
- plain の `fit: cover` による再フレーミング(横→縦の自動トリミング等)— 将来課題。

---

## 実装順序と依存

```
F1 → F2 → F3 → F4 → F5   （前半・直列。F1 が全ての土台）
                  ↘
                   B1（Remotion）  ── B3（docs）
                   B2（editor）    ──┘
```
F4 完了時点で「plain の manifest を手で置けば render が縦動画を正しく出す」まで
到達(描画は B1 が必要)。B1・B2 は F 群完了後に並行可。各コミットで
`npm run typecheck` と関連 `npm test` を緑に保つ。
