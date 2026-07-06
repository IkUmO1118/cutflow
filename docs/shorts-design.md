# ショート動画対応 設計

> 状態: **実装済み(2026-07-06)**。フェーズ3〜5(3-1〜3-4 / 4-1〜4-5 /
> 5-1〜5-5)すべて完了。設計判断(D1〜D6)の要約は `docs/decisions.md`
> の 2026-07-06 エントリを参照。本書はスキーマ・タスク分解の記録として残す。

## 0. 前提と一番効く事実

- `src/lib/renderProps.ts` の **`buildRenderProps` が唯一の合成 props 組み立て器**。
  最終レンダー(`render.ts`)とエディタの Player(`App.tsx:581`)が同じ関数を呼ぶ。
  ショートも**この一点を通す**。
- 横1080p が固定されているのは上流の2箇所だけ:
  1. `render.ts:145-146` … `width/height = cfg.ingest.screenRegion`(1920×1080)を直結
  2. `remotion/Main.tsx` … ワイプ=右下・字幕=下部中央・`wipeFull` 展開 の**レイアウト実装**
- `RenderCacheKey`(`renderKey.ts`)は **`props` 全体を `JSON.stringify` して比較**する。
  → 出力サイズ・レイアウト・ショート専用字幕を **props に載せれば、キャッシュキーは
  自動追随**する(キー定義を触らない)。full-skip キャッシュもこれで安く流用できる。
- `timeline.ts` の写像は keep 集合だけを入力に取る純関数。**ショートは「別の keep
  集合(=ショートの ranges)を渡すだけ」**でテロップ・BGM の再マッピングを再利用できる。
  ここは一切触らない。

---

## 1. 設計判断(確定)

### D1. プロファイルは組み込みプリセット、選択はクリップ単位で `shorts.json`

**判断**: レイアウトプリセット(サイズ+パネル配置+字幕既定)は**コードの組み込み定数**
(`src/lib/profile.ts` の `PROFILES`)として持つ。config.yaml には**追加しない**。
どのプリセットを使うかは `shorts.json` の**クリップごとの `profile` フィールド**で選ぶ。
v1 の組み込みは3つ: `default`(横・ワイプ)/ `vertical`(縦スタック=ショート既定)/
`vertical-cover`(縦・カメラ全画面)。

**理由**: 「プリセット2種で開始、任意 Region 配置の汎用化は今回やらない」の方針どおり、
プリセットは**閉じた組み込み**にする。config でレイアウト幾何を書けるようにすると
設定爆発+validate 複雑化を招く(ソロ保守の方針に反する)。個別調整はクリップ単位の
`captionTracks` 上書き(既存機構)で足りる。プリセットが名前で選べるので、同じ区間の
レイアウト切替が `profile` の一語で済む。

**トレードオフ**: 出力サイズ(1080×1920 等)を変えたくなったら組み込みプリセットを
増やす=コード変更。将来ユーザー定義プロファイルが要れば config.render.profiles を
足す拡張点は残すが、v1 では作らない(YAGNI)。

---

### D2. `shorts.json` — ranges を**そのまま keep 集合**にする(本編 keep とは独立)

**判断**: ショート1本は**元収録の秒**のレンジ(複数可)で定義し、その `ranges` を
`mergeIntervals` で正規化したものを**そのままショートの keep 集合**として
`buildRenderProps({ keeps: shortKeeps })` に渡す。**本編 cutplan の keep とは交差させない。**
テロップは transcript.json を流用し、縦用の位置/サイズは**プリセットの字幕既定 +
クリップ単位の `captionTracks` 上書き**(既存の captionTracks 解決機構に相乗り)で表現。

**理由(本編 keep と独立にする根拠)**: ショートは縦レイアウト・テロップ再配置・専用
スタイルを持つ**別の出力**であり、本編でテンポ優先に切った箇所をショートでは使いたい、が
普通に起きる。本編 keep の部分集合に限定する必然性はない。`ranges` を keep 集合に
直結すれば、本編がカットした素材もショートに含められる。副産物として交差ロジックが
不要になり設計が単純化する。
- 時刻は「元収録の秒」で維持(頭の中で引き算しない原則)。
- レンジ内のフィラーを落としたければ**レンジを分割**する(複数 ranges で飛ばす)。
- テロップ位置をクリップの `captionTracks` 相当で与えれば、`captionPosOf`/`captionStyleOf`
  (types.ts)の**既存マージ(セグメント → トラック標準 → 既定)を変えずに**縦用の
  大きい字幕にできる。per-segment 上書きは transcript 編集で添字がずれるので**非推奨**。

**スコープ注記(v1)**: ショートは transcript のテロップを流用する。本編 `overlays.json` の
素材/インサートの**継承は v1 では行わない**(rect が横向き前提で縦に翻訳できず、inserts は
尺を変えるため)。BGM も v1 はショート単位では持たず、必要なら後日 `shorts.json` に
per-short BGM を足す(props 経路なので後付け容易)。

---

### D3. 縦レイアウト — 既存 Region+fit を再利用、プリセットは2種、クリップで切替

**判断**: プリセットの `layout` が**ベース映像パネルの配置**を宣言する。各パネルは
`{ source: "screen"|"camera", rect(出力px), fit: "contain"|"cover" }`。座標系は
overlays の `rect` と**同じ出力px+Region+fit**で、新概念は導入しない。v1 は2プリセット:

- **`vertical`(スタック=既定)**: camera を上、screen を下に 16:9 のまま2段積み、
  下部にテロップ/タイトル帯を残す。対象ジャンル(画面デモ+解説)では画面の中身が
  主役になりやすく、cover で横66%を捨てないこのレイアウトがショートの定番。
- **`vertical-cover`(カメラ全画面)**: camera を 1080×1920 に cover。screen は出さない。
  「喋りだけの見せ場」を切り出すショート用。

`default`(横)プリセットは **`layout` を持たない**(=現行 `Main.tsx` ワイプ経路をそのまま
使う)。縦プリセットだけが `layout.panels` を持ち、`Main.tsx` に**新しいパネル描画経路**を
足す。既存経路はバイト単位で不変。

**理由**: 既存 `CroppedVideo` は「region を width×height ぴったりに伸ばす」実装で、横は
アスペクト一致で歪まない。縦はアスペクトが変わるので `rect + fit(cover)` への一般化が要り、
これは overlays.rect が既にやっている合成と同型=概念を増やさず書ける。ワイプ経路の
全 profile 汎用化はせず**2経路併存**(既存経路は無改造=回帰ゼロ・過剰抽象回避)。任意
Region 配置の汎用化はやらない(プリセット2種に閉じる)。

**トレードオフ**: `Main.tsx` に base 描画が2系統できる。将来 panels でワイプも表現して
一本化する余地は残すが、ショートが安定するまで分けておく。

---

### D4. レンダー — ショートごとに `cut.<name>.mp4`、承認はショート単位、full-skip キャッシュのみ

**判断**: ショート1本ごとに、既存の `cutFullRes(shortKeeps)` で `cut.<name>.mp4` を作り
(2段構成の1段目を再利用)、Remotion で縦プリセットを合成して `shorts/<name>.mp4` を出す。
承認ゲートは**ショートの `approved`**(本編 approved は流用しない)。キャッシュは
**full-skip(`render.<name>.key.json`)+ cut 再利用(`cut.<name>.keeps.json`)のみ**採用し、
**チャンク差分レンダーはショートには入れない**。

**理由**:
- 1段目(ffmpeg trim+concat+loudnorm)は keep 集合が変わるだけ=**「別 keeps を渡す」だけ**。
  keep 集合はショートの `ranges` そのもの(D2。交差計算なし)。
- **承認をショート単位にする根拠**: `approved` の意味は「人間がこの出力を確認した」。
  ショートは本編 preview で見たのとは別の絵(縦・字幕再配置)なので、見ていない縦動画を
  本編承認で通すのはゲートの趣旨(CLAUDE.md「承認は人間の仕事」)に反する。コストは
  クリップに bool 1個で、ソロ運用の複雑化にならない。`render --short` は当該ショートの
  `approved` が true でなければ拒否する。
- **full-skip キャッシュを入れ、チャンクは入れない根拠**: 実測で Remotion 段は出力128秒に
  約193秒(約1.5倍)、60秒以下のショートはフルでも約90秒。チャンク差分が効くのは
  「長尺の一部だけ直した再実行」で、短いショートは恩恵が小さい一方 `render.<name>.chunks/`
  のキー運用が増える。full-skip(props+素材不変なら Remotion 実行を丸ごと省略)は
  既存 `buildRenderCacheKey` の流用で安く、「直してないショートの再レンダーをゼロにする」
  効果が大きい。profile(サイズ・layout)は props に載るので、プリセットを変えれば
  `render.<name>.key.json` が自動で不一致=再レンダーされる。

**トレードオフ**: `cut.<name>.mp4` は本編と重複区間を再エンコードする(ショートは短く軽微)。
中間生成物が増えるので CLAUDE.md の一覧に追記。`render --short <name>` で1本、
`render --shorts` で **approved な全ショート**。

---

### D5. proxy — 既存 proxy.mp4 を流用(縦専用 proxy は作らない)

**判断**: エディタの縦プレビューも既存 `proxy.mp4`(3840×1080 を幅1280へ縮小)を流用。
カメラ領域が proxy 上640px→縦1080幅へ cover 拡大されて甘くなるのは**許容**する。

**理由**: CLAUDE.md が既に「proxy は位置・被り・レイアウト確認用。細かい文字の可読性は
この画像で判断しない。可読性の最終判断は人間が preview/render で行う」と明記済み。縦でも
一貫。エディタでやりたいのはクリップ範囲選定と字幕配置で、proxy 解像度で十分。`videoIsSource`
経路もそのまま効く。

**トレードオフ**: 縦プレビューのカメラが甘い。耐えられなければ後から preview.width を上げるか
カメラ専用 proxy を足す(投機的には作らない)。「甘さは既知・後日オプション」と記録。

---

### D6. エディタ UX — ヘッダに profile 切替、既存 Timeline を再利用(別ビューを作らない)

**判断**: ヘッダに**「本編 / 各ショート」セレクタ**を置く。ショートを選ぶと (a) Player の
props が縦プリセット + shortKeeps + ショート字幕上書きに切り替わりビューアが縦になる、
(b) ショートのレンジが**既存タイムライン上のドラッグ可能な帯**として出る(新
`SpanKind: "short"`。`wipeFull` と同じ属性スパン方式)。ショートモードには**レイアウト
プリセットのドロップダウン**(vertical / vertical-cover の切替)と**承認トグル**を置く。
別タイムラインは作らない。ショート一覧・CRUD は既存パネルのタブを1つ足して収める。

**理由**: `App.tsx` 3000行・`Timeline.tsx` 1200行の肥大回避が最優先。
- ショートのレンジは元秒軸上の1区間=既存 move/trim ドラッグ機構をそのまま使える
  (`model.ts` に `SpanKind` を1つ足す最小拡張)。
- 縦ビューは同じ Player に縦 props を渡すだけ(ビューア枠は既に `built.props.width/height`
  追従: `App.tsx:2828`)。
- 字幕の縦位置は、ショートモード時に既存の**ドラッグ位置決めオーバーレイ**(CaptionOverlay の
  pos 書き込み)を流用し、**書き込み先だけ**を transcript.json → ショートの `captionTracks` に
  切り替える。
- レイアウト切替(D1)はプリセット名の付け替えなのでドロップダウン1個、承認(D4)は
  bool トグル1個で済む。

**トレードオフ**: モード分岐が App に入る(props 組み立て・pos 書き込み先・保存対象)。
新規サーフェスは「ヘッダのセレクタ+プリセット/承認」「パネルのタブ1つ」「SpanKind 1つ」に
限定でき、巨大コンポーネントの分割は伴わない。

---

## 2. スキーマ提案

### 2.1 組み込みプリセット(`src/lib/profile.ts`・新規。config には書かない)

```ts
export interface Profile {
  width: number;
  height: number;
  /** ベース映像の配置。省略時は横 default のワイプ経路(screen 全面 + camera 右下ワイプ) */
  layout?: {
    panels: BasePanel[];
    /** 位置指定の無いテロップの既定位置と大きさ倍率 */
    caption?: { x: number; y: number; anchor?: "center" | "topLeft"; fontScale?: number };
  };
}
export interface BasePanel {
  source: "screen" | "camera";
  /** 出力px。省略時は全画面 */
  rect?: Region;
  fit: "contain" | "cover";
}

// 幾何は仮案(実装時にプレビューで調整)。width/height は screenRegion 依存に。
export const PROFILES: Record<string, Profile> = {
  default: { width: /*screenRegion.w*/ 1920, height: /*.h*/ 1080 }, // layout 無し=現行ワイプ
  vertical: {
    width: 1080, height: 1920,
    layout: {
      panels: [
        { source: "camera", rect: { x: 0, y: 0,   w: 1080, h: 607 }, fit: "cover" },
        { source: "screen", rect: { x: 0, y: 607, w: 1080, h: 607 }, fit: "cover" },
      ], // y=1214..1920(約706px)はテロップ/タイトル帯(背景黒)
      caption: { x: 540, y: 1560, anchor: "center", fontScale: 1.6 },
    },
  },
  "vertical-cover": {
    width: 1080, height: 1920,
    layout: {
      panels: [{ source: "camera", rect: { x: 0, y: 0, w: 1080, h: 1920 }, fit: "cover" }],
      caption: { x: 540, y: 1500, anchor: "center", fontScale: 1.6 },
    },
  },
};
```

`default` の width/height は `resolveProfile(cfg)` が `cfg.ingest.screenRegion` から埋める
(組み込み定数はプレースホルダ)。**config に何も書かなければ挙動不変。**

### 2.2 `shorts.json`(新規・収録フォルダ)

```jsonc
{
  "shorts": [
    {
      "name": "hook-mistake",          // 出力 shorts/hook-mistake.mp4。[a-z0-9-_]+ のみ・一意
      "profile": "vertical",           // 省略時 "vertical"。vertical / vertical-cover / default
      "approved": false,               // 人間がこの縦動画を確認したか。render --short のゲート
      "ranges": [                      // 元収録の秒。これ自体がショートの keep 集合(本編と独立)
        { "start": 120.0, "end": 158.0 }
      ],
      // 縦用テロップ位置/スタイルの上書き(任意)。overlays.captionTracks と同型。
      // buildRenderProps にこのショートの captionTracks として渡す=既存の解決機構に相乗り
      "captionTracks": [
        { "track": 1, "y": 1600, "style": { "fontSizePx": 92 } }
      ]
    }
  ]
}
```

- **時刻は全て元収録の秒**。`ranges` は複数可(飛び連結。フィラー除去はレンジ分割で)。
- `ranges` を `mergeIntervals` した集合を `buildTimeline` の keep 集合に直結(交差なし)。
- `approved` は**自分(AI)で true にしない**(cutplan の approved と同じ人間の仕事)。

### 2.3 `RenderProps`(`remotion/props.ts`)への追加(すべて任意)

```ts
// 既存 width/height/canvas/screenRegion/cameraRegion/wipe はそのまま。追加:
layout?: { panels: { source: "screen" | "camera"; rect?: Region; fit: "contain" | "cover" }[] };
/** 位置指定の無いテロップの既定位置(縦プリセット用)。省略時は現行の下部中央 */
captionDefaultPos?: { x: number; y: number; anchor?: "center" | "topLeft" };
```

`props.caption.fontSizePx` は `buildRenderProps` 側で `profile.caption.fontScale` を掛けて
確定(Main.tsx は既存どおり読むだけ)。**undefined は JSON に出ない**ので、既存収録の
`render.props.json`/`RenderCacheKey` はバイト不変=キャッシュ互換。

### 2.4 validate ルール(`src/stages/validate.ts` に `shorts.json` 検査を追加)

エラー(exit 1):
- `shorts` が配列でない / 要素がオブジェクトでない
- `name` が空・`[a-z0-9-_]+` 以外・重複
- `profile` が `PROFILES` に無い名前(省略は許可=`vertical`)
- `approved` が boolean でない
- `ranges` が配列でない・空・各要素が `checkSpan` 不合格(start<end、負、`dur+DUR_EPS` 超過)
- `captionTracks` は overlays.captionTracks と同じ検査(track 正整数・重複禁止、
  anchor center/topLeft、x/y 数値、`checkStyle`)

警告(exit 0):
- `captionTracks` の x/y が profile の width/height 外(はみ出し)
- ショートの座標が縦なのに profile が `default` 等、layout の想定と食い違うとき(任意)

（config は触らないので config 側 profile 検査は不要。プリセットは組み込み定数)

---

## 3. タスク分解(1タスク=1コミット)

各タスクに **テスト方針** と **壊してはいけない既存挙動** を明記。純関数中心に切る。

### フェーズ3 — 出力プロファイル土台(挙動不変)

**3-1. `Profile`/`BasePanel` 型 + `PROFILES` + `resolveProfile()`**
- `src/lib/profile.ts`(新規): `PROFILES` 組み込み定数、`resolveProfile(cfg, name?): Profile`。
  name 省略/`"default"` で `{ width: screenRegion.w, height: .h }`(layout 無し)。未知名 throw。
- テスト: `test/profile.test.ts` — default が screenRegion サイズ、vertical/vertical-cover の
  width/height/panels、未知名 throw。
- 壊さない: profiles 未使用時の default が現行 render の width/height と一致。

**3-2. `render.ts` を `resolveProfile("default")` 経由に(直結除去)**
- `render.ts:145-146` を `width: profile.width, height: profile.height` に置換(default 固定)。
- テスト: 既存 renderProps 系テスト緑。実収録1本で `render.props.json` が前後**バイト一致**を手動確認。
- 壊さない: `render.props.json` の中身・`final.mp4`・`render.key.json` 互換。

**3-3. `buildRenderProps` に `profile?` を通す(default は未設定=現行 props と deep-equal)**
- layout があれば props.layout に、`profile.caption` で `captionDefaultPos` と
  `caption.fontSizePx`(×fontScale)を確定。profile 省略時は現行と同一 props。
- テスト: 「profile 無し = 現行 props と deep-equal」+「縦 profile → layout/captionDefaultPos/
  fontSizePx が入る」。
- 壊さない: エディタ・render の既存呼び出し(profile 省略でコンパイル・挙動不変)。

**3-4. docs/型コメントの同期**
- `src/types.ts`/`remotion/props.ts` の新型コメント、`docs/usage.md` に profile/layout 行。
  config.yaml には**書かない**(プリセットは組み込み)ことを usage に明記。
- テスト: `npm run typecheck` 緑。

### フェーズ4 — ショート書き出し

**4-1. `Shorts`/`Short` 型 + `shorts.json` の validate**
- `src/types.ts` に型。`validate.ts` に §2.4 の検査(組み込み PROFILES 名の突き合わせ含む)。
- テスト: `test/validate` に正例/各エラー(未知 profile・name 重複/不正・approved 非 bool・
  range 逆転・captionTracks 不正・座標はみ出し警告)。
- 壊さない: `shorts.json` 無し収録の validate 出力。

**4-2. `Main.tsx` に panels 描画経路(layout ありのときだけ)**
- `props.layout` があれば `panels[]` を下→上に `CroppedVideo`(rect+fit 対応へ小拡張)で描画。
  layout 無しは**現行ワイプ経路のまま**。`captionDefaultPos` があれば位置無しテロップの既定に。
- `CroppedVideo` を rect(配置枠)+ fit(cover/contain)対応に拡張。現行の全面呼び出しは
  rect=全面・現行式と一致させる。panel→style 変換は純関数に切って unit test。
- テスト: 縦 props を手書きし `remotion render` で1枚スナップショット手動確認。純ロジック unit。
- 壊さない: **横 default の見た目**(layout 無し経路は1px も変えない)、`wipeFull`・下部中央字幕・
  premount/frameHold の Player 挙動。

**4-3. `render.ts` にショート経路 + `render --short/--shorts`**(実装済み)
- `shorts.json` を読み、各ショートで `shortKeeps = mergeIntervals(ranges)`(交差なし)。
  `cutFullRes(shortKeeps) → cut.<name>.mp4`、`buildRenderProps({ keeps: shortKeeps, profile,
  captionTracks: short.captionTracks })`、Remotion で `shorts/<name>.mp4`。
  **承認ゲート: `short.approved` が true でなければ拒否**。キャッシュは
  `cut.<name>.keeps.json` / `render.<name>.key.json` を name 別に(full-skip のみ・chunk なし)。
- CLI: `render <dir> --short <name>` / `--shorts`(approved な全ショート)。
- テスト: 実収録で1本出力・キャッシュ再利用ログ・未承認で拒否を手動確認。`mergeIntervals`
  による keep 化と remap 落ちの性質を unit(レンジ外テロップが空になる)。
- 壊さない: 引数無し `render`(本編 final.mp4)の経路・キャッシュ・承認ゲート。

**4-4. `describe`/`frames` のショート対応(AI の自己確認)**(実装済み)
- `frames <dir> --short <name>`(縦 props でサンプル PNG)、`describe` にショート要約
  (各ショートの profile・approved・ranges・出力尺)。
- テスト: 手動(frames PNG を Read して縦レイアウト・字幕位置確認)。
- 壊さない: 既存 `frames`/`describe` の全モード。

**4-5. CLAUDE.md/docs 同期**(実装済み)
- 中間生成物一覧に `cut.<name>.mp4`/`shorts/`/`cut.<name>.keeps.json`/`render.<name>.key.json`。
  編集ファイル表に `shorts.json`(+`approved` は人間の仕事の注記)。コマンド表に
  `render --short/--shorts`・`frames --short`。
- 壊さない: 既存記述。

### フェーズ5 — エディタのショート対応

**5-1. `/api/project` にショートを載せる**
- `loadProject` が `shorts.json` を返す。`ProjectData`/`apiTypes.ts` に型追加。組み込み
  PROFILES はクライアントからも参照(共有定数を import)。
- テスト: 手動(GUI 起動でデータ到達)。型整合。
- 壊さない: 既存 ProjectData 消費箇所(追加フィールドのみ)。

**5-2. ヘッダに「本編/ショート」セレクタ + ショートモード**
- 選択中ショートを state に。選択時は `built` の useMemo を分岐し Player props を
  縦 profile + shortKeeps + short.captionTracks で組む。ビューア枠は props.width/height 追従。
- テスト: 手動(縦へ切替・アスペクト・字幕サイズ)。**検証前に必ずサーバー再起動**
  (エディタはバンドルが起動時固定: memory 参照)。
- 壊さない: 本編モードのプレビュー・保存・書き出し。

**5-3. タイムラインにショートレンジの帯(SpanKind "short")+ プリセット/承認 UI**
- `model.ts` に `SpanKind: "short"`。ショートモードで `ranges` を帯として描き move/trim で
  `shorts.json` の ranges 更新(既存ドラッグ機構流用)。プリセット切替ドロップダウン
  (vertical/vertical-cover)と承認トグルをショートモードのバーに置く。
- テスト: 手動(帯ドラッグ→保存→validate 緑、プリセット切替で縦レイアウト変化)。
  ドラッグ計算の純関数があれば unit。
- 壊さない: 既存トラック(cut/wipe/ov/cap/bgm)のドラッグ・選択・分割。

**5-4. ショート字幕の位置編集(書き込み先の切替)**
- ショートモード時、CaptionOverlay のドラッグ位置と Inspector の pos/style 編集を
  transcript ではなく当該ショートの `captionTracks`(track 単位)へ書く。
- テスト: 手動(縦で字幕ドラッグ→shorts.json に captionTracks、本編字幕は不変)。
- 壊さない: 本編の transcript 直接編集(pos/style)。

**5-5. ショートの CRUD + 保存 API**
- パネルのショートタブでショート追加/削除/リネーム。`/api/save` に `shorts` 追加
  (検証は `validateDocs` にショートを通す)。書き/空削除は bgm.json と同型。
- テスト: 手動 + `validateDocs` のショート経路ケース。
- 壊さない: 既存 `/api/save`(cutplan/overlays/transcript/bgm)の不可侵範囲。

---

## 4. 決着済みの論点(2026-07-06)

1. **縦の既定レイアウト** → スタック(camera上/screen下)を既定、クリップ単位で
   `vertical`/`vertical-cover` を切替。任意 Region 配置の汎用化はやらない(プリセット2種)。
2. **承認ゲート** → **ショート単位の `approved`**(本編 approved は流用しない)。
3. **チャンク差分レンダー** → ショートには入れない。full-skip(`render.<name>.key.json`)のみ採用。
