# 設計判断の記録

動画台本・概要欄の素材を兼ねる。新しい判断は上に追記する。

## 2026-07-08 plan 知覚は fallback 強制オンにせず、明示化と workflow 表示を優先

**判断**: `resolvePerceptionCfg()` の未指定 fallback は互換のため全オフのまま保つ。
一方で標準 `config.yaml` は `plan.perception.audio/ocr` を明示オンにし、`plan` /
`remeta` / `run` は実行前に今回の知覚状態を必ず表示する。`plan.perception` 自体が
無い config では警告を出すが、処理は止めない。GUI editor の AI command は
単発 proposal ではなく、差分確認 → 適用 → 保存 → 任意の frames 確認までを
1 回の workflow 状態として扱う。

**理由**: 問題は「黙ってオフ」であり、OCR をコード fallback で強制オンにすると
旧 config / 非対応環境に別の退行を持ち込む。まずは CLI と editor に状態を露出して、
実際に何が有効かを即座に判断できるようにする方が P0 として堅い。AI 編集も同様で、
安全境界(diff review + planApply)は既に足りており、欠けていたのは「一発編集が
どこまで完了したか」の主経路表示だった。

## 2026-07-08 AI 設定は `ai.provider` に統一し、旧 `llm` は互換扱い

**判断**: ユーザー向けの AI 設定入口を `ai.provider` / `ai.model` にする。
既定は `claude-code`。`codex` / `anthropic` / `openai` も同じ provider 概念で
扱う。旧 `llm.backend: claude-cli | api` は既存 config の互換のため読み続けるが、
新規ドキュメントでは `ai.provider` を正とする。

**理由**: 利便性を優先すると、ユーザーに one-shot / agent / API / CLI の内部差を
設定させない方がよい。一方、実装では provider ごとの能力差を隠しすぎない。
`claude-code` は `claude -p`、`codex` は read-only の `codex exec`、API provider は
各 API の one-shot 呼び出しとして扱う。外部 agent が CutFlow を操作する本命導線は
引き続き MCP(`describe/apply/validate/frames`)に寄せる。

## 2026-07-06 plain(カメラ無し通常動画)のショート化に縦プロファイルを新設

**背景**: plain(`manifest.layout:"plain"`。カメラ無しの通常動画。多くは
画面録画)をショート化すると初期レイアウトが破綻する。原因はショート既定
profile が全経路で無条件 `"vertical"`(camera 上607+screen 下607 の2段。OBS
拡張キャンバス前提)であること——render.ts:333 / validate.ts:612 /
frames.ts:102 / editor の App.tsx:117(resolveShortProfile 既定)と
Inspector.tsx:2488 の Segmented 初期値がそれぞれ `?? "vertical"` を持つ。plain
には camera が無いので、validate.ts:618-627 が「screen+camera 両方を持つ
layout」をエラーにし、plain+vertical(既定)は弾かれる。plain 向けに「画面だけを
縦に見せる」プリセットが存在しないのが穴。あわせてユーザーの問い「vertical /
default は何のためにあるのか、必要か」に profile ピッカーの設計で答える。

前提の裏取り(実コード確認済み): `hasCamera(m)`(types.ts:41)は
`layout==="obs-canvas" && cameraRegion!=null` のときだけ true。remotion の
`renderBase`(Main.tsx:201-204)は `panel.source==="camera"` を
`cameraRegion ?? screenRegion` に解決する——つまり plain で vertical-cover
(camera 全面)が「通る」のは screen を無理やり camera 枠に流用しているから。
16:9 の画面録画を 1080x1920 へ cover すると左右が大きく切れて画面内の文字が
読めなくなる。plain の主目的(画面を見せる)と真逆で、これが「vertical-cover を
使え」で済ませられない理由。

### 論点1: plain 用縦プロファイル `vertical-screen` の新設と幾何

**判断**: screen 単一パネルの縦プロファイル `vertical-screen` を
`src/lib/profile.ts` の `PROFILES` に追加する。確定値:

```ts
"vertical-screen": {
  width: 1080,
  height: 1920,
  layout: {
    // screen を上3/4(0..1440)へ contain。16:9 は 1080x608 のフル幅帯として
    // その枠の縦中央(約 y=416..1024)にレターボックスされ、左右も上下も
    // 決して切れない(contain)。縦・スクエア収録はこの枠をより広く使う。
    // 下1/4(1440..1920, 480px)はテロップ/タイトル帯(背景黒)
    panels: [{ source: "screen", rect: { x: 0, y: 0, w: 1080, h: 1440 }, fit: "contain" }],
    caption: { x: 540, y: 1680, anchor: "center", fontScale: 1.6 },
  },
},
```

**理由**:
- **fit は cover ではなく contain**。plain の中身は任意アスペクト(16:9 の画面
  録画・縦のスマホ動画・スクエア)がありうる。cover は 16:9 画面録画の両端を
  切り捨てて画面内テキストを壊す=plain の目的破壊。contain は「絶対に切らない」
  代わりに黒帯が出るが、可読性優先の plain ではこれが正しい既定。黒帯の見栄えは
  preview で詰める(幾何は仮案・実装時調整、という既存 profile.ts の方針を踏襲)。
- **source は "screen" 単一**。camera を含めないので validate の plain ガード
  (screen+camera 両持ちを弾く。論点2で共通述語化)を自然に通る。vertical との
  対比が明快(vertical=2段、vertical-screen=画面のみ)。
- **caption は既存縦プリセットと揃える**。fontScale 1.6・anchor center は
  vertical(y=1560)/ vertical-cover(y=1500)と同一。screen 帯(0..1440)の下の
  黒帯中央 y=1680 に置き、画面と重ならない。
- **命名 `vertical-screen`**: `vertical` / `vertical-cover` と並ぶ第3の縦。
  「縦・画面だけ」を素直に表す。

**トレードオフ**: 16:9 画面録画は上下に黒が乗り「浮いた帯」に見える(cover なら
全面だが切れる)。可読性を取り、見栄えは preview 調整に委ねる。将来「画面を
もっと大きく」の要望が出たら rect の h を縮める(例 608)チューニングで対応でき、
スキーマ変更は不要。

### 論点2: hasCamera → 既定 profile を一意に解く共通関数の新設

**判断**: `src/lib/profile.ts` に純関数を2つ足し、散在する `?? "vertical"` を
全廃して一箇所に集約する。

```ts
/** ショートの省略時 profile 名。camera 有り→"vertical"、plain→"vertical-screen" */
export function defaultShortProfileName(hasCamera: boolean): string {
  return hasCamera ? "vertical" : "vertical-screen";
}

/** その profile を plain(カメラ無し)に使えるか。panels の source 集合が
 * screen と camera を両方含むときだけ false(validate の plain ガードと同一規則)。
 * layout 無し(default)・screen のみ・camera のみは true */
export function profileSupportsPlain(profileName: string): boolean {
  const panels = PROFILES[profileName]?.layout?.panels;
  if (!panels) return true;
  const src = new Set(panels.map((p) => p.source));
  return !(src.has("screen") && src.has("camera"));
}
```

**呼び出し置換箇所**(現状の既定 `"vertical"` を `defaultShortProfileName(...)` へ):

| 箇所 | 現状 | 置換後 |
|---|---|---|
| src/stages/render.ts:333 | `short.profile ?? "vertical"` | `short.profile ?? defaultShortProfileName(hasCamera(manifest))` |
| src/stages/frames.ts:102 | `short.profile ?? "vertical"` | `short.profile ?? defaultShortProfileName(hasCamera(manifest))` |
| src/stages/validate.ts:612 | `typeof s.profile==="string" ? s.profile : "vertical"` | `... : defaultShortProfileName(cameraPresent)`(cameraPresent は既に算出済み) |
| src/stages/planShorts.ts:150 | `profile: "vertical"` 固定 | `profile: defaultShortProfileName(hasCamera(manifest))`(`shortsFromSelection` に `hasCamera:boolean` 引数を足して planShorts から渡す) |
| editor/client/App.tsx:117,688,691 | `resolveShortProfile(name ?? "vertical", ...)` | 既定を `defaultShortProfileName(proj.hasCamera)` に(下記) |
| editor/client/Inspector.tsx:2488,2493 | Segmented の `?? "vertical"` センチネル | `?? defaultShortProfileName(hasCamera)`(論点3) |

**理由**: 分岐(camera→vertical / plain→vertical-screen)が5ファイル横断で
散らばると、片方だけ直して破綻する。一意な関数に寄せれば「既定はここだけ」で
保守できる。`profileSupportsPlain` は validate の plain ガード規則を述語化した
もので、validate と editor のピッカー絞り込み(論点3)が**同じ規則**を共有する
(規則の二重定義を避ける)。**後方互換**: camera 有り案件は `hasCamera=true` で
従来どおり `"vertical"` に解決され、省略時挙動は不変。

**addShort は分岐不要**(重要): editor の addShort(App.tsx:1543)は profile を
付けずショートを作る=既定に委ねる。解決を `defaultShortProfileName` に集約した
ので、plain 案件で profile を省略しても resolve 時に vertical-screen に化ける。
addShort に hasCamera 分岐を持たせる必要はなく、`profile` 未設定のまま据え置く
(センチネルの一貫性は論点3で担保)。

### 論点3: Inspector の profile ピッカー出し分け(ShortPropertiesSection)

**判断**: B2/T5 で右インスペクタへ移設済みの `ShortPropertiesSection`
(Inspector.tsx:2474)の Segmented を、`hasCamera` で **plain 非対応を非表示**に
する(disable ではなくフィルタ)。並びは縦を先・横を末尾に固定し、各選択肢に
1行説明を付ける。`hasCamera` を InspectorPanel の props(現状 `project` 型は
`{dir,approved,bgmFile,bgmTracks}` で hasCamera を持たない=要追加)経由で
ShortPropertiesSection まで通す。

- **選択肢の生成**(profile.ts の `profileSupportsPlain` で絞る):
  `["vertical","vertical-screen","vertical-cover","default"]` の固定順から、
  `hasCamera || profileSupportsPlain(name)` を満たすものだけ。
  - camera 有り: 全4件(vertical / vertical-screen / vertical-cover / default)
  - plain: vertical を除いた3件(vertical-screen / vertical-cover / default)
- **各選択肢のラベル+説明**(ユーザーの「何のため」への回答。UI コピーは
  Inspector 側に持つ):
  - `vertical` … 「カメラ+画面の2段(OBS 収録向け)」
  - `vertical-screen` … 「画面だけを縦に(通常動画向け)」
  - `vertical-cover` … 「収録全体を縦いっぱいに(元から縦の動画向け)」
  - `default` … 「横16:9(本編と同じ・横向きの切り抜き用)」
- **センチネル**: `value = activeShort.profile ?? defaultShortProfileName(hasCamera)`。
  onChange で選んだ名が `defaultShortProfileName(hasCamera)` と一致するなら
  `profile` を削除(=省略時既定に戻す)、それ以外は代入。これで「profile 省略=
  hasCamera 相応の既定」の意味が camera/plain 両方で崩れない。

**理由(disable 案・全表示案を退けた理由)**: 非対応(plain の vertical)を
disable で残すと、選べないセグメントがピッカーを占有して読み手を惑わす。plain で
vertical は「そもそも作れない」ので、選択肢から**消す**のが正直。選択肢集合が
小さい(3〜4)ので、消えても迷子にならない。説明文で「何のため」に答えるので、
default(横)を隠さず残す意味(論点4)も自然に伝わる。フィルタ規則を profile.ts の
`profileSupportsPlain` に一本化しているので、将来プリセットが増えても validate と
UI が同時に追随する。

**トレードオフ**: InspectorPanel の `project` 型 or props に `hasCamera` を足す
配線が要る(server は既に `hasCamera` を proj で返しており apiTypes.ts:51 にも
ある。App→InspectorPanel→ShortPropertiesSection へ1本通すだけ)。

### 論点4: `default`(横16:9)profile をショートから撤去するか

**判断**: 撤去しない。縦(vertical / vertical-screen / vertical-cover)を上位に
並べ、`default` はピッカー末尾に残す。

**理由**: `default` は「横向きハイライトの切り出し」用途を持つ——ショート機構は
本編 cutplan と独立の ranges 集合を持つので、`default` を選べば本編とは別の
見せ場を 16:9 のまま別ファイル(`shorts/<name>.mp4`)へ書き出せる(埋め込み用
クリップ・横向き SNS 用など)。validate も plain/camera 双方で `default` を
許可済み(layout 無し=plain ガードに引っかからない)。撤去は機能を削るだけで
得が無い。ただしショートの主目的は縦なので、並び順で縦を先頭に置き、既定
(省略時)は縦(defaultShortProfileName)にして「横は明示的に選んだときだけ」に
する。ユーザーの「vertical / default は何のためにあるのか」への回答:
**vertical=OBS 収録の縦2段、default=横のまま別尺で切り出す用**、どちらも役割が
あり残す。plain には vertical が使えないので vertical-screen を新設して埋める。

### 波及範囲

- **src/lib/profile.ts**: `vertical-screen` 追加、`defaultShortProfileName` /
  `profileSupportsPlain` 新設。
- **src/stages/validate.ts**: 省略時 profileName を `defaultShortProfileName`
  に(~612)。plain ガード(618-627)は `profileSupportsPlain` で置換可(**エラー
  文言は不変に保つ**)。plain+vertical-screen が通ること・plain+vertical が
  従来文言でエラーのままなことを固定。
- **src/stages/render.ts / frames.ts**: 既定を `defaultShortProfileName(hasCamera(manifest))`。
- **src/stages/planShorts.ts**: `shortsFromSelection` に `hasCamera` 引数追加、
  下書きの profile を `defaultShortProfileName` に(plain で invalid な
  `"vertical"` を書かない)。
- **editor**: App.tsx の resolveShortProfile 既定を hasCamera 相応に(688/691)、
  addShort は据え置き(profile 省略)。Inspector.tsx の ShortPropertiesSection に
  hasCamera を配線・ピッカー絞り込み/並び/説明・センチネル修正。InspectorPanel の
  `project`(or 新規 prop)に hasCamera を追加。
- **docs/usage.md**: shorts.json / profile の表(42行目・136-143行目)に
  vertical-screen を追記し、plain の既定が vertical-screen に変わったことを反映。
- **src/types.ts**: `hasCamera` 周辺コメントの更新は不要(挙動不変)。profile の
  スキーマは profile.ts 側なので types.ts は無変更。

### タスク分解(1タスク=1コミット)

- **C1 profile.ts コア**: `vertical-screen` プリセット+`defaultShortProfileName`
  +`profileSupportsPlain` を追加。
  - テスト: `test/profile.test.ts` に固定値検証——vertical-screen の
    width/height/panels(source="screen", rect, fit="contain")/caption、
    `defaultShortProfileName(true)==="vertical"` / `(false)==="vertical-screen"`、
    `profileSupportsPlain` を全プリセットで(vertical=false、他=true)。
  - 壊すな: 既存 PROFILES(default/vertical/vertical-cover)の値、
    `resolveProfile` の default サイズ上書き(name 無し/"default" で defaultSize)。
- **C2 validate**: 省略時 profileName を `defaultShortProfileName(cameraPresent)`
  に、plain ガードを `profileSupportsPlain` へリファクタ。
  - テスト: `test/validate.test.ts`——plain+`vertical` は**従来文言のまま**
    エラー、plain+`vertical-screen` は通る、plain で profile 省略は通る、
    camera 案件は全 profile 通る(vertical 既定含む)。
  - 壊すな: 既存 plain+vertical のエラー文言、camera 案件の検証結果。
- **C3 render + frames**: 両者の `?? "vertical"` を
  `defaultShortProfileName(hasCamera(manifest))` に。
  - テスト: 実データ検証。camera 案件
    `/Users/19mo/Movies/cutflow/2026-07-02-whisper-bench` で `frames --short
    <name> --every 10` が従来どおり vertical(2段)で出ることを確認(退行なし)。
    plain 経路は plain 収録フォルダ(無ければ通常動画を editor で bootstrap して
    ショートを1本作る)で `frames --short` が vertical-screen で出ることを確認。
  - 壊すな: camera 案件の vertical 既定。
- **C4 planShorts**: `shortsFromSelection(..., hasCamera)` に引数追加、profile を
  `defaultShortProfileName` に。planShorts から hasCamera を渡す配線。
  - テスト: `shortsFromSelection` 単体で hasCamera true→profile "vertical"、
    false→"vertical-screen" を固定。
  - 壊すな: camera 案件の下書きが vertical のまま。
- **C5 editor 描画(preview)**: App.tsx の resolveShortProfile 既定を
  `defaultShortProfileName(proj.hasCamera)` に(688/691)。addShort は無変更。
  - テスト: エディタ再起動(MEMORY: bundle は起動時1回)後、plain 案件を開き
    ショートモードでプレビューが vertical-screen レイアウトになることを目視。
  - 壊すな: camera 案件のショートプレビュー(vertical)。
- **C6 editor ピッカー**: InspectorPanel/ShortPropertiesSection に hasCamera 配線、
  Segmented を `profileSupportsPlain` で絞り+縦先頭の並び+1行説明、センチネルを
  `defaultShortProfileName(hasCamera)` 基準に。
  - テスト: 再起動後、plain 案件のピッカーに vertical が出ないこと・
    vertical-screen 既定が選択表示されること、camera 案件で全4件が出ることを目視。
  - 壊すな: camera 案件のピッカー(全 profile 選択可)、profile 省略の保存。
  - 注: C5 と密結合。分けにくければ1コミットに統合可(その場合は editor 一括)。
- **C7 docs**: docs/usage.md の profile 表・plain 節に vertical-screen を追記、
  plain 既定が vertical-screen になったことを反映。
  - テスト: なし(文書)。CLAUDE.md の「スキーマを変えたら usage.md も」に従い最後に。

## 2026-07-06 GUI エディタのヘッダー再設計(トースト+バナー行への分離)

**背景**: ヘッダー(index.html:76 の flex 行)に一過性の状態が直接インライン
展開されている——`error`(App.tsx:2800)/ `draftOffer`(2801)/ `externalChange`
(2814)/ `job`=レンダー・プレビューの実行中/完了(2825)/ `proxyStale`(2845)。
これらは横へ伸びると、中央に絶対配置した収録フォルダ名(index.html:85、
`position:absolute; left:50%`)へ被る。加えてショート操作がヘッダーに3ウィジェット
散在している——`modeSwitch`(本編/ショート選択セレクト、2872)と `shortBar`
(profile セレクト+承認チェック、2886)。この2系統の混雑を、通知は**トースト**へ、
継続的な要対応は**バナー行**へ、ショートのプロパティは**右インスペクタ**へ
逃がして解く。ソロ保守前提なので外部ライブラリは足さず内製する。

### 論点1: どの状態をトースト化し、どれを常設に残すか

**判断**: 状態を「通知(fire-and-forget)」と「要対応の継続条件」で二分し、
前者だけをトーストにする。後者はヘッダー直下の**常設バナー行**に残す(=消えない
トーストではなく、専用のバナー行)。

- トースト(自動消滅あり): `job` 完了(success)。
- トースト(sticky・手動クローズ): `error`(読み落とすと困るので自動消滅させない)。
- トースト(progress・更新式): `job` 実行中。進行中は消えず、完了時に同じトースト
  を success へ差し替えて自動消滅タイマーを開始する(論点2の更新方式)。
- 常設バナー行(トーストにしない): `draftOffer`(復元/破棄)・`externalChange`
  (読み込み直す)・`proxyStale`(プロキシ再生成)。

**理由**: `draftOffer` / `externalChange` / `proxyStale` は「ユーザーが操作するまで
真であり続けるプロジェクト/セッションの状態」であって、時間で消える通知ではない。
自動消滅は相性が悪く、消えない sticky トーストにすると (1)一過性トーストと同じ隅を
奪い合い、(2)手動クローズで要対応の事実を誤って消せてしまう。バナー行なら
常時可視で内容を覆わず、`externalChange`+`proxyStale` のような**同時成立**も
縦積みで自然に扱える。既に未使用の `.banner` スタイル(index.html:179、黄系の
警告帯)が語彙として用意済みで、これをそのまま採用できる。

**トレードオフ**: バナー行は縦の場所を常に確保するのではなく、いずれかの条件が
真のときだけ描画する(header と stage の間に条件付きで挿入)。トーストとバナーの
2機構を持つことになるが、寿命モデル(通知=消える/条件=残る)が根本的に違うので
1機構に無理に寄せない方が読みやすい。

### 論点2: トースト機構の仕様

**判断(位置・積み重ね)**: 画面**右下**に縦積み、新しいものを下(隅側)に置き
古いものを上へ押し上げる(VSCode の通知と同じ意匠。ヘッダーの `layoutBtns` が
既に「VSCode 風」を名乗っており意匠が揃う)。下端はトランスポート/タイムラインを
避けるよう余白を取る。同時表示は最大5件、超過は最古を落とす。

**判断(自動消滅)**: `info` 4秒 / `success` 6秒(完了トーストはファイル名を読む
時間が要る)/ `error`・`progress` は自動消滅なし(手動クローズか、progress は
解決時に success へ差し替えて消滅開始)。

**判断(種別)**: `info` / `success` / `error` / `progress` の4種。要対応アクションは
バナー行が持つのでトースト側には「アクション種別」を作らず、代わりに任意の
`action?: {label,onClick}` ボタンを全種に付けられるようにする(例: 完了トーストの
「開く」で出力先を再度開く)。

**判断(手動クローズ)**: 全トーストに × を付ける。progress も閉じられる(閉じても
ジョブは走り続ける=表示だけ消える)。

**判断(アクセシビリティ)**: コンテナを `aria-live` のライブリージョンにする。
`info`/`success`/`progress` は `aria-live="polite"` + `role="status"`、`error` は
`aria-live="assertive"` + `role="alert"`。× は本物の `<button>`。progress→success の
差し替えはテキスト変更として polite に再読み上げされる。

**判断(実行中の更新方法)**: `addToast` は id を返し、`updateToast(id, patch)` で
その場更新する。`job` 実行中に progress トーストを1枚出して id を ref に保持し、
完了時に `updateToast(id, {kind:"success", message, action, ttlMs})` で差し替える
(消して出し直さない=積み位置が飛ばない)。

**トースト API 案**(App.tsx か小さな新規モジュールに `useToasts` として内製。
id はブラウザ側なので単純なカウンタ ref で採番、タイマーは id→timeoutId の
ref マップで持ち update/dismiss から確実に解除する):

```ts
type ToastKind = "info" | "success" | "error" | "progress";

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** 任意アクション(例: 完了トーストの「開く」)。省略可 */
  action?: { label: string; onClick: () => void };
  /** 自動消滅までのミリ秒。0/undefined = 消えない(error/progress) */
  ttlMs?: number;
  /** 手動クローズを許すか(既定 true) */
  closable?: boolean;
}

// 返り値の id を保持しておけば後から updateToast で差し替えられる
function addToast(t: Omit<Toast, "id">): string;
function updateToast(id: string, patch: Partial<Omit<Toast, "id">>): void;
function dismissToast(id: string): void;
// フック: { toasts, addToast, updateToast, dismissToast } を返す
```

sticky 可否は `ttlMs` の有無で表す(error/progress は付けない)。キュー操作
(追加・ttl 期限切れ・更新・削除)は純関数のリデューサに切り出し、注入した
時計で node --test する(論点=タスク分解のT1)。

### 論点3: ショート操作の集約UI

**判断**: 案B(右インスペクタにショート専用の節)を採る。ヘッダーには**切替**
(本編/ショート選択)だけを残し、選択中ショートの **profile / 承認 / 名前変更 /
削除**は右インスペクタ(「プロパティ」パネル)の「ショート」節へ移す。profile は
既存の `Segmented` ウィジェット(widgets.tsx:254)で描く。

**理由(案A ポップオーバー・案C を退けた理由も含む)**:
- 切替は「エディタ全体が何を映すか」を変える**文脈切替**(プレビュー・タイムラインが
  当該ショートの縦レイアウト/ranges 帯に変わる)。ドキュメントのタブ選択に相当し、
  常時可視のヘッダーに置くのが正しい。ショート数が増えてもセレクトなら破綻しない
  (案C のセグメントコントロールは切替相手が多いとスケールしない)。
- profile / 承認 / 削除は「選択中ショートのプロパティ」。プロパティは既に
  右インスペクタに住んでおり(クリップ・テロップの選択時)、メンタルモデルが一貫する。
- **plain 対応(profile 可変)で決定的**: フェーズCで plain 用の縦プロファイルと
  hasCamera 出し分けが入ると、profile ピッカーの選択肢は**条件付き・可変**になる。
  ヘッダーのポップオーバー(案A)は窮屈で、条件で増減する選択肢や説明文を置きにくい。
  インスペクタの節なら Segmented/セレクト+説明を広く持て、将来 `PROFILES` を
  hasCamera でフィルタした一覧に差し替えるだけで済む。
- 承認はレンダーゲート(`render --short`)の意味的に重要な状態。ポップオーバーに
  隠すと開くまで状態が見えない。インスペクタなら常に見える。
- 発見性/クリック数: ショートへ切り替えるとインスペクタのショート節が出る(案A の
  「+1クリックで開く」が不要)。ただしインスペクタを閉じている(inspOpen=false)と
  見えないので、**ショートへ切り替えた時にインスペクタが閉じていれば自動で開く**
  (一度きりのナッジ)で発見性を担保する。

**トレードオフ**: 実装量は案A(ヘッダー内ポップオーバー)より中程度に増える
(インスペクタ節+文脈連動の条件描画+削除の確認)。ただし `shortBar` をヘッダー
から外せて #4 の混雑が減り、インスペクタの既存の節スタイルを再利用できる。削除は
`deleteMaterial` と同じく undo できないので確認を挟む。**AI が承認を true に
しない**規約は不変(人間トグルのまま位置だけ移す)。

### 論点4: 中央プロジェクト名を絶対配置のまま維持するか

**判断**: 通常フロー化し、**左寄せのパンくず**(`CutFlow / <フォルダ名>`)にする。
`position:absolute; left:50%` と `pointer-events:none` をやめる。

**理由**: 中央絶対配置は「混雑したヘッダーで名前を退避させる」ための回避策。
論点1〜3 で一過性状態がトースト/バナー/インスペクタへ抜けると、ヘッダーの
インライン要素は brand+名前(左)/ spacer / saveStatus・切替・layoutBtns・設定・
書き出し(右)に限定され、**衝突の原因そのもの(#4本質)が移設で解消する**。
残った絶対配置は壊れやすい特殊ケース(pointer-events:none で名前をコピー等で
選べない・理屈上まだ重なりうる)でしかなく、利得がない。左パンくずは頑健で、
エディタの慣習(VSCode 等はファイル同定を左上に置く)にも合い、衝突クラスを
紙で覆うのでなく消せる。

**トレードオフ**: 中央寄せの見栄えは失う。もし中央寄せの意匠を残したい場合は、
移設後は絶対配置が**安全**になっている(左右が短く固定幅)ので、絶対中央のまま
にするのは可逆な装飾判断として選べる。既定は左パンくずを推奨する。

### タスク分解(1タスク=1コミット)

依存: T1 → T2 / T3(トースト消費者)。T4・T5・T6 は互いに独立(T6 は概念的に
T2〜T4 でヘッダーが空くのを前提にするが技術的には独立)。各タスク後に
`npx tsc --noEmit` と `npm test`。エディタは起動時1回バンドルなので、
headless 検証の前に**必ずサーバー再起動**する([[editor-bundle-restart]])。
ヘッダー系タスクの多くは純関数の核を持たず headless スモーク+目視に頼る——
唯一 T1 のキュー・リデューサが node --test 対象。

- **T1 トースト基盤(基盤のみ・配線なし)**: `useToasts` フック(状態ストア+
  addToast/updateToast/dismissToast+ttl タイマー管理)、右下スタックのコンテナ
  コンポーネント、index.html への CSS(`.toastStack` / `.toast.<kind>` / × / action)。
  - テスト: キュー操作を純関数リデューサに切り出し、注入した時計で追加・ttl
    期限切れ・in-place 更新・削除・最大5件超過の最古落としを node --test。
    headless ではコンテナに `aria-live` が付き、追加/自動消滅で DOM が増減する
    ことを確認。
  - 壊してはいけない: なし(純増分)。
- **T2 `error` をトーストへ**: ヘッダーの `error` インライン span(2800)を撤去し、
  `setError` の各経路をエラートースト(sticky)に流す。設定モーダル脚部の
  `.error`(settingsError)は別物なので残す。
  - テスト: 失敗する操作(例: 保存失敗)でエラートーストが出て自動消滅しないこと。
  - 壊してはいけない: すべての `setError` 経路でエラーが必ず可視化されること。
- **T3 `job` を progress/success トーストへ**: 実行中=progress トーストを1枚出し
  id を ref に保持、完了=`updateToast` で success+「開く」+ttl に差し替え。
  ヘッダーの job span(2825)を撤去。**`job` state 自体は消さない**(実行中ゲート:
  runExport の 2437・render/preview ボタンの disabled 2991/3006 が依存)。
  - テスト: headless で preview を起動し progress→success の差し替えを確認。
    実行中に書き出しボタンが disabled のままであることを確認。
  - 壊してはいけない: **job 実行ゲート**(実行中の二重起動防止・ボタン無効化)。
- **T4 要対応バナー行**: `draftOffer` / `externalChange` / `proxyStale` を
  ヘッダーから撤去し、header と stage の間の条件付きバナー行(`.banner` 再利用、
  複数同時は縦積み)へ移す。
  - テスト: headless で SSE の外部変更を発火→「読み込み直す」バナー表示、
    起動時の draft 提示、proxyStale 表示を確認。
  - 壊してはいけない: **⌘S 保存**・**外部変更検知**(SSE→dirty 分岐)・
    **draftOffer 復元フロー**(restoreDraft/discardDraft)・regenProxyForSettings。
- **T5 ショートのプロパティを右インスペクタへ**: ヘッダーは `modeSwitch` の
  切替セレクトだけ残す。`shortBar`(profile/承認)をインスペクタの「ショート」節へ
  移し、profile は `Segmented`、承認チェック、名前変更、削除(確認付き)を置く。
  ショートへ切替時にインスペクタが閉じていれば自動で開く。profile 選択肢は
  将来 hasCamera でフィルタできるよう一覧を組み立てる箇所を1つにまとめる。
  - テスト: 切替→インスペクタにショート節が出る/profile 変更が shorts.json へ
    書かれる/`validate` 通過。承認トグルが `render --short` ゲートに効くこと。
  - 壊してはいけない: **activeShortName 切替**(プレビュー/タイムラインの縦
    レイアウト・ranges 帯連動)・profile 書き込み・**AI は承認を true にしない**
    規約(人間トグルのまま)。
- **T6 プロジェクト名を左パンくずへ**: 中央絶対配置(index.html:85)をやめ、
  brand の隣に `CutFlow / <名前>` を通常フローで左寄せ。フォルダ名の
  ellipsis と `title`(フルパス)は維持。
  - テスト: headless で狭幅にしても横スクロールが出ない/名前が省略される。
  - 壊してはいけない: なし(機能非依存の見た目変更)。
- **T7(任意・後片付け)**: 4箇所で使い回していた `.externalChange` クラスの
  用途が減るので CSS を整理。純増減のみ。

## 2026-07-06 plain × マージ後機能(shorts / zooms / colorFilter / thumbnail)の整合

**背景**: 下の「通常動画(plain)は…」判断は feature/editor-bootstrap 単独開発時
(profile.ts / zooms 未マージ)に書かれた。その後 feature/editor-improvements
(ショート・ズーム・パネル・チャンク差分レンダー・colorFilter・サムネイル)が
マージされ、plain とこれらの相互作用を確定する必要が出た。実装分解は
`docs/plans/plain-video-support.md`(マージ後コードで改訂済み)。

**判断(採用)**:
1. **出力解像度の真実源一本化は `resolveProfile` の付け替えで行う**。マージ後は
   「出力解像度 = default プロファイル」の解決が `src/lib/profile.ts` の
   `resolveProfile(cfg, "default")` に集約され、render / frames / thumbnail /
   editor がそこ経由で `cfg.ingest.screenRegion` に到達する。`resolveProfile` の
   引数を cfg から**出力サイズ(manifest.video.screenRegion)**へ変えれば、消費
   箇所すべてが一点で manifest 由来になる(editor はクライアントが server の
   `output` を読むので server 側 1 行で追随)。
2. **wipeFull は plain で validate エラー**(カメラ=crop 元が無い)。方針は初版から
   維持。`layerOrder` に `wipe` があれば警告(無視される旨)。
3. **zooms / colorFilter / thumbnail は plain でそのまま使える**。実コードで確認:
   zooms はベース映像の**背景=画面クロップだけ**を拡大する(remotion/Main.tsx の
   背景レイヤーに transform)ためカメラ非依存。colorFilter はベース映像への CSS
   filter で plain では画面クロップだけに掛かる。thumbnail は default プロファイルで
   `buildRenderProps` を通すだけ(全編 keep+texts)。いずれも B1 のワイプ非描画
   ガードの上でそのまま成立する。validate の zoom rect 上限は manifest.screenRegion
   (plain では全フレーム)で判定するので追加作業なし。
4. **plain のショートは「カメラ=全フレーム」の規約で成立させる**。縦プリセット
   `vertical` / `vertical-cover` は `source:"camera"` パネル前提(profile.ts)。
   plain には物理的なカメラが無いので、描画側で **camera パネルを screen(全
   フレーム)へ解決**する。これで `vertical-cover`(カメラ全面)は「画面全体を
   縦へ cover」になり、元から縦のスマホ動画は追加加工なしで綺麗に出る。ただし
   `vertical`(画面+カメラの2段スタック)は plain では同じフレームを2枚重ねる
   だけで無意味なので **validate エラー**にする(profile 名ではなく layout の
   panel source 集合=screen と camera が両方あるか、で判定)。
5. **チャンク差分レンダー / render.key は cameraRegion optional で無改造**。
   `chunkPlan.globalVideoProps` は screenRegion / cameraRegion / width / height を
   既にキーへ含み、`stableHash`(JSON.stringify+キーソート)が undefined を落とす
   ので plain でも決定的。obs↔plain はこれらのどれかが必ず違うのでキーは自然に
   分かれる(layout タグをキーへ足す必要は無い=冗長)。

**捨てた案**:
- **plain のショートを一律 validate エラー(未対応)にする**: 実装は最小だが、
  「元から縦のスマホ動画をショートにする」という自然な要求まで塞ぐ。camera→screen
  の1行の解決で成立するので、塞ぐ理由が弱い。
- **plain 専用の縦プロファイル(`vertical-screen` 等)を新設する**: プリセットが
  増えると D1(プリセットは閉じた組み込み・設定爆発の回避)に逆行する。既存
  `vertical-cover` を「カメラ=全フレーム」で読み替える方が組み込みを増やさない。
- **camera→screen を profile 解決時(resolveProfile)に静的に書き換える**: profile は
  manifest を知らない純データにしておきたい(cfg 依存を外す F4 の方針と整合)ので、
  manifest(=カメラの有無)を知っている描画側(Main.tsx renderPanels)で解決する。
- **cache キーに layout タグを足す**: 上記5のとおり width/height/region で既に
  区別できるので冗長。真実源を増やさない。

## 2026-07-06 通常動画(plain)は「カメラの無い obs-canvas」として一級サポート

**判断**: OBS 拡張キャンバスでない通常動画(スマホ・カメラ・画面録画)を、
manifest に `layout: "obs-canvas" | "plain"` の区別を持たせて ingest〜レンダーまで
サポートする。plain は **screenRegion=全フレーム / cameraRegion=無し**で表現し、
「ワイプ(カメラ)の crop 元が無い」一点にすべての差分を集約する。OBS 形式の
既存挙動は完全維持する。実装分解は `docs/plans/plain-video-support.md`。

**判断の柱**:
1. **出力解像度は manifest.video.screenRegion を正とする**(config を再読みしない)。
   現状 render/frames/editor が `cfg.ingest.screenRegion` を直読みしており、ingest
   時に焼き込んだ manifest と二重の真実源になっていた。manifest 一本に寄せると、
   plain の縦動画は縦のまま・4K は 4K のまま config を触らず自然に出る。obs-canvas
   では値が同じなので出力はバイト同一(退行なし。むしろ ingest 後に config を
   変えても壊れなくなる改善)。
2. **manifest スキーマは `layout` 明示タグ + `cameraRegion` optional の併用**。
   後方互換のため `layout` 未指定は "obs-canvas" 扱い、既存 manifest は
   cameraRegion を持つので判定不変。
3. **plain の判定は明示を既定にする**(config `ingest.layout`、CLI `--layout`、
   editor 起動 bootstrap は plain を明示)。`auto`(キャンバス寸法の完全一致で
   obs 判定)は opt-in で提供するが**既定にしない**。

**捨てた案**:
- **cameraRegion optional のみで layout タグを持たない(構造から暗黙推論)**: 動作は
  するが「意図した plain」か「壊れた manifest」かの正の信号が無く、validate/editor の
  分岐とメッセージが不明瞭。明示タグは文字列ユニオン1個でコストが小さく、
  「types.ts コメント+validate+usage.md を揃える」規約とも相性が良い。
- **screenRegion=全フレームのフォールバックだけ(スキーマ変更なし)**: 同上で暗黙的
  すぎる。将来の多カメラ等の拡張の掛け先も無い。
- **ingest の幅ベース自動判定を既定にする(`幅 >= screenRegion.w+cameraRegion.w` で
  OBS)**: 4K 通常動画(3840x2160)が OBS キャンバス幅 3840 と一致し**誤判定**する。
  誤判定は「動画の半分しか映らない」等の分かりにくい壊れ方になる。auto を採るなら
  最低でも W×H 完全一致を条件にすべきで、それでも 3840x1080 の通常動画は誤る。
  よって既定は明示、auto は逃げ道付きの opt-in にした。

> **失効(マージ後)**: 本判断の初版にあった「訂正(profile.ts・zooms・vertical-cover
> は実在しない)」の段落は、feature/editor-bootstrap 単独開発時点の事実であり、
> feature/editor-improvements のマージで**すべて失効**した(profile.ts・zooms・
> vertical-cover はいずれも実在する)。plain とこれらの整合は上の
> 「plain × マージ後機能」判断で確定した。実装分解も
> `docs/plans/plain-video-support.md` をマージ後コードで改訂済み。

## 2026-07-06 簡易カラー調整(overlays.json の colorFilter)とサムネイル生成(thumbnail.json)

**判断**:
- **colorFilter**: `overlays.json` のトップレベルに全編一律(区間指定なし)の
  `{brightness?, contrast?, saturate?}` を追加。実装は CSS filter で、
  Remotion のベース映像(画面クロップ+カメラ=同一収録動画)にだけ適用する。
  素材オーバーレイ・挿入クリップは対象外(素材は完成品であり、補正したいのは
  収録の見た目だけのため)。**ショートにも例外的に継承する**(zooms 等の
  演出と違い「収録の見た目補正」という扱いなので、本編とショートで肌色が
  変わる事故を防ぐ)。チャンク差分レンダーではグローバルキー扱い(変更したら
  全チャンクがフルレンダーになる。wipe 幾何等の既存の全域設定と同じ側)
- **thumbnail**: 収録フォルダに `thumbnail.json`(`{t, texts[]}`)を書くと
  `thumbnail` コマンドで `thumbnail.png`(1920x1080)を書き出せる。`t` は
  frames と違いスナップしない(カットされた瞬間も指定できる。サムネは動画に
  入っていない絵を使ってよいため)。`texts[]` は transcript と同じ
  `CaptionStyle` を共有し、`pos` は省略不可。合成は最終レンダーと同じ見た目
  機構(buildRenderProps)を通し、keep=全編・テロップ=texts のみ・
  `wipeFull` / `zooms` / `colorFilter` は本編と同じに乗る。ベースは
  `frames` のプロキシと違い元収録のフル解像度を使う(静止画の可読性が命)。
  `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格)。
  エディタ対応は今回やらない

**理由**: どちらも既存の時刻写像・`buildRenderProps`・キャッシュキー機構に
相乗りさせて実装コストを抑える方針(zooms・ショートと同じ考え方)。colorFilter
は「演出」(zooms 等)と「見た目補正」を区別し、後者だけをショート・
サムネイルへ横断的に効かせることで、一箇所直せば全出力の肌色が揃うようにした。
thumbnail は「動画に入っていない絵も使いたい」という要件が frames の
スナップ挙動と相容れないため、専用のスナップなし経路として独立させた。

## 2026-07-06 ズーム演出(overlays.json の zooms)

**判断**: 画面の一部を拡大して見せる演出を、既存の `wipeFull` と同じ
「元収録の秒の区間+宣言的な指定」の作法で `overlays.json` に追加する。

- スキーマ: `zooms: [{ start, end, rect: {x,y,w,h}, easeSec? }]`。`rect` は
  出力px座標系(テロップ `pos`・overlays `rect` と同じ)で「この矩形を全画面へ
  拡大する」の意味。倍率は書かせない(`scale = 出力幅 / rect.w` が rect から
  一意に決まる。倍率と rect の二重指定は矛盾の温床になるため)
- 拡大は一様スケール(歪ませない)。rect のアスペクトが出力と違う場合も
  この規則で決まる(validate で警告)
- かかるのは**ベース映像の背景レイヤー(画面クロップ)だけ**。ワイプ・
  テロップ・素材オーバーレイ・挿入クリップは動かさない(拡大してもテロップの
  位置・可読性が変わらないのが狙い)
- 区間の重なりは禁止(validate エラー)。ズーム中のパン(rect の時間変化)は
  v1では対応しない(区間を分ければ実用上足りる)
- 遷移(イーズイン/アウト)は `wipeFull` の `wipeTransitionSec` と同じ
  smoothstep・区間が短いときの遷移縮小規則を踏襲(`src/lib/zoom.ts` に
  純関数として切り出し、`remotion/Main.tsx` の背景レイヤーだけに適用)
- チャンク差分レンダー(render.chunks/)では `wipeFull` と同じ「区間限定
  (チャンク重なりだけ無効化)」の扱いにする(`src/lib/chunkPlan.ts`)
- ショート(`profile` の layout 経路)には効かせない。ショートは
  `overlays.json` を継承しない既存設計(D2)により自動的に対象外になる
  (特別扱いのコードは書いていない)

**理由**: 「画面のこの部分に注目」を作る解説動画向けの演出。既存の
時刻写像・キャッシュキー機構への相乗りで実装コストを抑えつつ、
`wipeFull` で確立済みの UX(タイムラインの属性スパン帯・プレビュー上の
枠ドラッグ)を踏襲してユーザーの学習コストも増やさない。

## 2026-07-06 ショート動画対応(縦動画の書き出し・エディタ編集)

**判断**(詳細は docs/shorts-design.md、実装済み):
- **D1**: 出力プロファイルは `src/lib/profile.ts` の組み込みプリセット
  (`default` / `vertical` / `vertical-cover`)。config.yaml には追加しない
  (プリセットは閉じた組み込み。設定爆発の回避)。
- **D2**: `shorts.json` の各ショートは `ranges`(元収録の秒)をそのまま
  `mergeIntervals` した keep 集合として使う。本編 cutplan の keep とは
  独立(交差させない)。テロップは transcript.json を流用し、位置/スタイルは
  ショート専用の `captionTracks`(トラック単位。per-segment 上書きは持たない)
  で上書きする。
- **D3**: 縦レイアウトは `vertical`(camera上/screen下スタック)と
  `vertical-cover`(camera 全画面)の2プリセットに閉じる。既存の横ワイプ
  経路は無改造(layout 無し = 現行のまま)。
- **D4**: レンダーはショートごとに `cut.<name>.mp4` → `shorts/<name>.mp4`。
  承認は本編とは別の `short.approved`(render --short のゲート)。キャッシュは
  full-skip のみ(チャンク差分レンダーはショートに入れない)。
- **D5**: エディタの縦プレビューは既存 `proxy.mp4` を流用(縦専用 proxy は
  作らない)。カメラの甘さは既知・許容。
- **D6**: エディタは新規ビューを作らず、ヘッダーの「本編/各ショート」
  セレクタ + プリセット/承認バー、既存 Timeline への `SpanKind: "short"`
  帯、パネルの「ショート」タブ(CRUD)に留める。ショート編集
  (ranges・captionTracks・profile・approved)は cutplan/overlays/transcript/
  bgm の undo 履歴には含めない(別ドキュメントで、この程度の編集に undo
  一貫性のコストを払う価値が薄いと判断した意図的な簡略化)。

**理由**: 本編とは別解像度・別レイアウトの出力を、既存の時刻写像
(`lib/timeline.ts`)・`buildRenderProps`・キャッシュキー機構に相乗りさせて
実装コストを抑える。エディタ側も同じ発想で、新規サーフェスをセレクタ1個・
タブ1個・SpanKind 1個に絞り `App.tsx`/`Timeline.tsx` の肥大を避けた。

## 2026-07-02 音量は render でツーパス loudnorm、BGM はファイル規約で自動合成

**判断**: 最終出力の音量は ffmpeg の loudnorm(EBU R128)で -14 LUFS
(YouTube 基準)に自動正規化する。方式はツーパス(1回目に音声のみ実測、
2回目に実測値を渡して線形正規化)。BGM は「収録フォルダに bgm.mp3 が
あれば合成する」というファイル規約にし、Remotion の Audio でループ+
終端フェードアウト付きミックスする。

**理由**: 実収録の初回レンダーは -30.2 LUFS で、YouTube 基準より16dBも
小さかった。収録時のゲイン管理だけに頼ると毎回ばらつくので、出口で
ツールが保証する。ワンパス loudnorm を試したら -16.7 LUFS までしか
届かなかった(流しながら調整する方式のため、入力が目標から遠いと
数dB残る)。ツーパスにしたら -14.3 LUFS(誤差0.3dB)。

**ハマった点**: 「loudnorm を1フィルタ足すだけ」では終わらなかった。
音量系は必ず実測で確認すること(ebur128 フィルタで数秒で測れる)。

**注意**: 収録ゲインが低すぎる問題は出口では直せない。detect の無音判定
(-35dB)に発言が引っかかるリスクがあるため、収録時は OBS メーターで
黄色ゾーンを維持する(docs/usage.md 参照)。

## 2026-07-02 render は「ffmpegでカット→Remotionで合成」の2段構成

**判断**: 最終レンダーは、①ffmpeg が cutplan の keep 区間をフル解像度のまま
結合して中間ファイル cut.mp4 を作り、②Remotion は1本になった動画の上に
画面クロップ・ワイプ・字幕・章カードを重ねるだけ、という2段構成にする。
字幕と章の時刻は、コード側で「元動画→カット後」のタイムライン変換
(src/lib/timeline.ts)をしてから Remotion に渡す。

**理由**: Remotion のタイムライン上で OffthreadVideo に区間ごとの細かい
シークをさせると、遅い上にフレームずれの温床になる。トリム・結合は決定的な
ffmpeg が得意な仕事なのでそちらに寄せ、Remotion には「表現」(レイアウト・
字幕・カード)だけをさせる。役割が分かれるのでデバッグも楽になる。

**トレードオフ**: 中間ファイル分のエンコードが1回増える(世代劣化を抑える
ため高ビットレートで出力)。M5 のハードウェアエンコーダなら時間は問題に
ならない。

## 2026-07-02 plan は LLM に「区間番号の選択」だけをさせる

**判断**: plan ステージは detect が出した「残す候補区間」に番号を付けて
LLM に渡し、LLM は「どの番号をカットするか+理由」「章の開始番号+章タイトル」
だけを返す。タイムスタンプ(秒数)は LLM に一切生成させない。

**理由**: LLM に時刻を直接出力させると、もっともらしい数値のでっち上げ
(ハルシネーション)が起きて動画が壊れる。番号選択方式なら時刻は常に
コード側が管理し、LLM の間違いは「存在しない番号」として機械的に検出・無視
できる。出力トークンも減って速く安くなる。

**副産物**: LLM の生応答は毎回 plan.raw.txt に保存する(パース失敗時の調査用。
判断過程の記録として動画素材にもなる)。

**ハマった点**: 初回実行でプロンプトのテンプレート置換が壊れていた
(memory/lessons/template-replace-first-match.md 参照)。壊れたプロンプトを
受け取った `claude -p` は JSON を返す代わりに「あなたのコードのバグはここです」
という診断レポートを返してきた。LLM をパイプラインに組み込むと、失敗モードが
「エラー」ではなく「想定外の正しい応答」になることがある。

## 2026-07-02 収録は「拡張キャンバス方式」(3840x1080 横並び)

**判断**: OBS のキャンバスを 3840x1080 にし、左半分に画面・右半分にカメラを
並べて1本の mkv に録る。パイプラインは領域クロップで画面とカメラを分離する。

**理由**: ワイプ焼き込みだと後からレイアウト変更が一切できず、編集自動化の
価値が激減する。一方 OBS のマルチトラックは音声専用で、映像は必ず1本に合成
される(これが最初の誤算だった)。映像を分けて録る Source Record プラグインは
macOS で不安定という報告が多い。拡張キャンバスならプラグイン不要・同期ズレ
ゼロ・決定的に処理できる。

**トレードオフ**: 録画ファイルの解像度が倍になる(ビットレート増)。
Apple M5 のハードウェアエンコーダなら負荷は問題にならない。

## 2026-07-02 ingest では映像を再エンコードしない

**判断**: ingest は「解析+マイク音声抽出+manifest.json 生成」のみ。
画面/カメラの切り出しは manifest に領域情報として記録し、preview/render が
必要になった時点でクロップする。

**理由**: 3840x1080 の再エンコードは時間もディスクも食う。試した結果、
再エンコードなしなら ingest は数秒で終わる。中間生成物は増やさない。

## 2026-07-02 LLM は claude-cli をデフォルトに、API は後日切替

**判断**: 意味カット・章立ての LLM 呼び出しは `claude -p` のサブプロセス実行を
デフォルトにし、config.yaml で従量課金 API に切り替え可能にする(2択のみ)。

**理由**: Claude Code サブスク内なら追加費用ゼロ・API キー管理不要。
運用が安定したら安いモデルの API に移す。プロンプトは prompts/ に外部化して
あるのでバックエンドを替えても中身は共通。

## 2026-07-02 whisper モデルは large-v3-turbo の q5_0 量子化

**判断**: `ggml-large-v3-turbo-q5_0.bin`(574MB)を採用。

**理由**: 日本語精度と速度のバランスが最良のクラスで、量子化版なら
16GB RAM でも余裕。実測: Apple M5 で16秒の音声を約1.0秒で文字起こし
(約16倍速)。フル精度版(1.6GB)との差が問題になったら差し替える。

## 2026-07-02 Lottie Creator MCP は保留

**判断**: アニメーション挿入用の Lottie Creator MCP は今回導入しない。

**理由**: 今週の目標はパイプライン完成であり、アニメ挿入は装飾(完成後の
改善領域)。採用済みの Remotion は `@remotion/lottie` で Lottie を再生できる
ため、後から導入しても設計変更が発生しない。再検討はパイプラインで動画を
2〜3本作った後。

## 2026-07-02 チャンネル運用者の決定(記録)

- カット判断: AI がカット案を生成し、**人間が承認してから**レンダー
  (見せ場=本番事故シーンの誤カットを防ぐ)
- レンダラー: Remotion(字幕・ワイプ・章カードの表現力を優先)
- 第1話: パイプライン完成後に自作ツール自身で編集する(ドッグフーディングがオチ)
