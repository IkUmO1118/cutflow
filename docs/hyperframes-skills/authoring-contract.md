# HyperFrames 作図契約(Cutflow 版の抜粋)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ./PROVENANCE.md.

`hyperframes-core` skill の技術契約のうち、Cutflow の native interpreter(C1)
と check ゲート(C2)が実際に honor する部分だけを抜き出したもの。完全な
契約仕様(全 `data-*` 一覧・sub-composition・track の詳細)は
`../../remotion/vendor/hyperframes/upstream-docs/data-attributes.md` /
`compositions.md` を正とする。ここは「Cutflow でカード HTML を書くときに
最低限守ること」の要約。

## ルート要素

- composition のルートは `data-composition-id="<id>"` を持つ**単一の
  div**(または任意のブロック要素)。この `id` が check ゲートの Rule 1 の
  対象
- ルートは正の整数の `data-width` / `data-height`(px)を持つ。省略は警告
  (呼び出し側の解像度で render されるが、明示しておくこと)
- ルートは明示的にサイズされた箱でなければならない(`width`/`height` を
  px で指定。flex/`100%` に頼って高さが 0 に潰れる罠は upstream
  `hyperframes-core` が「サイレントに壊れるバグ」として警告している。
  Cutflow でも同様に、必ず px 指定する)

## typed variables

- `<html data-composition-variables='[...]'>` に**配列**として書く
  (オブジェクト形式は check ゲートのエラー)。各要素は
  `{"id": string, "type": string, "label"?: string, "default"?: any}`
- カード内から `window.__hyperframes.getVariables()` で読み出し、
  `textContent` や `style` へ反映する。値の代入は同期的に(ページロード時に)
  行う

## clip のライフサイクル

- 時間制御したい要素はすべて `class="clip"` を付け、`data-start` /
  `data-duration`(秒。非負の数値)を持つ。この2属性の組がタイミングの
  正で、それ以外に render 側が独自に導出する時刻は無い
- `class="clip"` の無い要素に `data-start`/`data-duration` だけ付けても
  可視ウィンドウは適用されない(警告止まりだが実質バグなので必ず両方揃える)
- clip の可視/不可視は framework(native interpreter)が管理する。JS 側で
  `display`/`visibility` を直接いじって clip のライフサイクルを乗っ取らない
- 可視ウィンドウは **開始含む・終了含まない**(`t >= start && t < start+duration`)。
  ちょうど `start+duration` の瞬間は hidden 側になる(upstream の両端含むとは違う)。
  最終フレームまで見せたい reveal は窓をわずかに伸ばすか、着地を `duration` 手前に置く
- clip は root の直下でなくてよい(interpreter は `.clip` を深さ無視で全走査する)。
  upstream の「clip は root の直接の子」制約は Cutflow には無い(track が無いため)

## Cutflow が honor しない upstream 機能(スコープ境界)

Cutflow の native interpreter(`src/lib/hyperframe.ts` の bootstrap)は **1カード=
1 HTML ファイルのフラットな単一 composition** を seek するだけの最小実装で、upstream
HyperFrames の以下の機能は**実装していない**。upstream 側のドキュメント・サンプルから
これらをコピーすると、check ゲートは 0 エラーで通っても render で黙って壊れる
(何も出ない/常に hidden/黒画面)。**カードはこれらを使わずに書く**:

- **sub-composition(`data-composition-src` / `<template>` 分割)は無い**。interpreter は
  1つの srcdoc を1つの iframe に読むだけで、外部 composition の fetch・DOMParser・
  `<template>` 抽出・独立 seek を一切しない(`data-composition-src` は check ゲートでは
  remote-URL スキャンの対象にしかならない)。複数シーンは**同じ1ファイル内の
  `class="clip"` 兄弟**(内部フェーズ div)で表現する
- **track(`data-track-index`)は無い**。可視性は各 clip の `data-start`/`data-duration`
  の窓だけで決まり、track 番号や「同一 track 内は重なり禁止」という概念は interpreter に
  無い(読まれない)。重なり順は CSS `z-index` で作る
- **相対タイミング(`data-start="<clip-id>"` / `"intro + 2"`)は無い**。interpreter は
  `parseFloat(data-start)` で**数値秒だけ**を読む。clip-id 文字列は `NaN` になりその clip は
  常に hidden。`data-start` は必ず数値で書く
- **メディア clip(`<video>`/`<audio>` の駆動)は無い**。interpreter は `<video>`/`<audio>`
  の `currentTime` を seek せず、`data-media-start`/`data-volume`/`data-has-audio` も読まない
  (カードは無音の作図素材)。動画を見せたいときはカードにではなく本編の
  overlays/inserts(`materials/`)に置く
- **宣言的な変数バインドは無い**。`data-var-src`/`data-var-text`・スカラ変数の自動
  `--{id}` CSS custom property 化は未実装。変数は既存の「typed variables」節どおり
  `window.__hyperframes.getVariables()` で読んで script から代入する
- **root の `data-duration` は尺の正本ではない**。interpreter/`parseComposition` は root の
  `data-duration` を読まず、尺は clip 群の `max(data-start + data-duration)`
  (`intrinsicDurationSec`)か CLI の `--durationSec`・props で決まる。尺を変えたいときは
  clip の窓を伸ばすか `--durationSec` を渡す(root の `data-duration` は無視される)

## 全画面モーションと複数シーン(単一ファイルでの作法)

sub-composition が無いぶん、連続する背景モーションや複数シーンは1ファイル内で作る:

- **共有背景レイヤー**: 全編ずっと出す背景は `class="clip"` を**付けない**素の要素にする
  (clip を付けないので可視性管理の対象外=常時表示)。その要素を WAAPI か GSAP timeline で
  seek 駆動し、色替え・ビネット・グレイン等の全域ステートはここ1枚に集約する。上に載せる
  シーンは背景透過の `class="clip"` レイヤーにする
- **複数シーン/フェーズ**: ハードカットは同一ファイル内の `class="clip"` 兄弟を
  `data-start`/`data-duration` で並べる。連続ステートを共有するフェーズ(伸びるチャット・
  カットをまたぐ見出し語)は、clip を分けず1つの入れ物の中の内部フェーズ div にして
  timeline で `opacity`/`visibility` を切り替える(clip 境界を跨がない)
- 背景・フェーズ要素の可視制御に `.clip` のライフサイクルを乗っ取らせない
  (`display`/`visibility` の直接 tween は clip 以外の要素/ラッパーにだけ、B0 の allowlist 内で)

## determinism(seek-safe)

Cutflow の native interpreter は Remotion の `useCurrentFrame()` から
`document.getAnimations()` の `currentTime` を絶対時刻で seek する。つまり
**同じ時刻に何度 seek しても同じ絵になる**ことが前提。これを壊す入力は
check ゲート(C2)がエラーで止める:

- インラインスクリプト内の `Math.random` / `Date.now` / `performance.now` /
  `new Date()` / `requestAnimationFrame` / `setInterval` は**エラー**
- `setTimeout` は**警告**(壁時計基準で動くため、composition 内の時間制御には
  使えない。CSS/WAAPI に置き換える)
- リモート URL(`http(s)://` / `//` 始まり)は `src`/`href`/`srcset`/
  `poster`/`data-composition-src`・CSS `url()`・`@import`・`@font-face` の
  どこにあってもエラー。フォントは総称ファミリー(`system-ui`/`sans-serif`/
  `serif`/`monospace` 等)、または `hyperframe --from-brief --asset <subset.woff2>`
  が提供したローカル `@font-face` だけを使う。後者は prompt に示された family
  `HFAsset<n>` と `__HF_FONT_<n>__` token をそのまま使い、publish 前に
  `data:font/woff2;base64,...` へ置換される。手書きカードでも同じ data URL 形式なら
  Rule 6 がローカル font として扱い、`document.fonts.ready` が render readiness を
  担保する。**script の唯一の例外**: `<script src>` が
  `src/lib/hyperframeCdn.ts` の CDN ピン表に一致する URL・`integrity`
  (両方一字一句そのまま)を持ち、かつ `crossorigin="anonymous"` を持つ
  場合だけは許可される。それ以外の remote 参照(script 以外の全部)は
  この例外の対象外で常にエラーのまま

WOFF2 は拡張子と先頭 magic `wOF2` を照合する。単体は固定 1MiB 以下、かつ
`hyperframe.assets.maxBytes` と1回の `maxTotalBytes` にも従う。Cutflow は subset
tool を同梱しない。例えば外部の fonttools を使う場合は、必要文字だけを明示する:

```sh
pyftsubset remotion/fonts/NotoSansJP.woff2 \
  --output-file=/tmp/NotoSansJP-subset.woff2 --flavor=woff2 \
  --text='CutFlow フォント埋め込み' --layout-features='*'
```

配布時は元フォントのライセンスも確認し、この repository の Noto Sans JP なら
`remotion/fonts/OFL.txt` を一緒に扱う。

詳しいモーションの作法(CSS/WAAPI アダプタの書き方)は
`./motion-css-waapi.md` を見る。

## backend 選択の規範

### 選択規則

1. まず backend 名ではなく、必要な表現能力で考える。
2. 必要能力を満たさない候補は使わない。
3. 素材・render profile・決定論 tier・利用可否を満たさない候補は使わない。
   利用可否は `hyperframe-backends --json` の `status` を正とする。
4. 残った候補から runtime cost が最小のものを選ぶ。
5. 同点なら browser-native、依存ゼロ、byte tier の順に優先する。
6. より重い backend へ昇格するときは、軽い候補で不足する能力を理由として
   card HTML の冒頭コメントに1行残す。
7. render 時に別 backend へ黙って fallback しない。fallback は生成前に
   再計画する。

初期 cost 順序(実測でのみ変更する):

```text
CSS/SVG/DOM < WAAPI < Anime.js < Canvas 2D < GSAP core / Lottie(既存素材あり)
  < Raw WebGL/shader < Three.js
```

これは表現力の優劣ではなく、依存・起動・検査・失敗面・再現性・AI 生成難度を
含む運用コスト。既存の Lottie 素材を再生する場合は、同じ絵を WAAPI で再実装
するより Lottie の方が低コストになり得るため、文脈で補正する。重い backend
を選べるのは brief が明示した場合か、軽い候補では満たせない固有能力がある
場合だけとする。

### capability から backend への標準対応

| 表現要件 | 第一候補 | 昇格条件 |
|---|---|---|
| fade / translate / scale / rotate / clip / simple stagger | CSS/WAAPI | 無し。原則ここで完結 |
| text layout / diagram / UI mock / vector shape | DOM/SVG + WAAPI | pixel 単位の大量描画が必要な場合のみ Canvas |
| 軽量な直列・並列 timeline、複数micro-animation | WAAPI、次に Anime.js | manual cardでAnime.js構文の方が明瞭な場合 |
| 複雑な直列・並列 timeline、label、反復可能な choreography | WAAPI、次に GSAP | WAAPI が明瞭さ・生成成功率・保守性で劣る実測がある場合(B3 実測では出ていない) |
| AE/bodymovin 素材の再生 | Lottie SVG | 有効な JSON 素材が実在する場合だけ |
| 2D procedural drawing / 大量の同種プリミティブ | Canvas 2D | DOM/SVG の要素数・描画コストが実測で問題になる |
| per-pixel shader / GPU particle / procedural texture | Raw WebGL/shader | Canvas/CSS で要件を満たせないことを説明できる場合 |
| 真の3D geometry / perspective camera / lighting / depth occlusion | Three.js(manual) | 2D transform の擬似奥行きでは満たせない場合 |
| data-driven SVG chart | 素の SVG + WAAPI | D3 は使わない |
| 地図 | 事前取得・固定した静止画/SVG | map runtime は使わない |

Raw WebGL/shader と Three.js は `gpu-angle` profile で `usable`。Three.js は
manual authoring 限定で、core-only の静的 gate を通す。詳細と実測結果は
下記「GPU / WebGL / shader cards」を参照する。

### card の過剰設計

- CSS transform でできるカードに Three.js scene/camera/renderer を作る。
- 1要素の fade/slide のために GSAP をロードする。
- CSS/WAAPIで明瞭に書ける1要素のためにAnime.jsをロードする。
- JSON 素材が無いのに「滑らかそう」という理由で Lottie を選ぶ。
- テキスト中心のカードを Canvas/WebGL に描き、アクセシビリティ・レイアウト・
  font readiness を自前実装する。
- shader を使うこと自体を visual quality の根拠にする。
- GSAP + Anime.js + Three.js + Lottie を同一 card へ積み、どれが時間の正本か不明にする。
  **1 card 1 runtime** は、外部 animation runtime と時間の正本を1つにする
  規範である。DOM/SVG/CSS は別 runtime と数えず、外部 runtime と併用できる。

重い backend の使用が直ちに check error になるわけではなく、人間の明示指定は
尊重する。ただし理由の無い重い選択は authoring レビューで差し戻す。各 runtime
の登録・seek 規約は下記の既存節を参照する。

### tooling の過剰設計

- backend ごとの worked example を常に全量 prompt に入れ、例示頻度で AI の
  選択を偏らせる。
- 将来追加するかもしれない backend のために、現時点で汎用 plugin ABI を
  設計する。

## seek conventions(B1)

CSS/WAAPI(`class="clip"` + Web Animations)の他に、bootstrap は以下の
シーク規約もサポートする(名前は上流 HyperFrames と同一。エコシステム
互換のため):

- **GSAP**: `window.__timelines["<id>"]` にポーズ状態
  (`{paused:true}`)の GSAP timeline を登録する。bootstrap は毎シークで
  `tl.pause()` した上で `tl.totalTime(tSec, true)`(GSAP 3.x の
  same-time-seek nudge として `tSec+0.001` へ一度寄せてから `tSec` へ
  戻す二重呼び出し)する
- **Anime.js**: `window.__hfAnime`に`anime({...})`または
  `anime.timeline({...})`が返したinstanceを配列登録する。全factoryは
  `autoplay:false`。bootstrapは毎シークで各instanceを`pause()`してから
  `seek(tMs)`する(GSAPのnudgeは使わない)
- **Lottie**: `window.__hfLottie` に Lottie アニメーションインスタンスの
  配列を登録する。bootstrap は毎シークで `an.goToAndStop(tMs, false)`
  (ミリ秒・`isFrame=false`)する
- **hf-seek CustomEvent**: GPU/WebGL/canvas の自己描画カード向け。
  bootstrap は毎シークで `window.dispatchEvent(new CustomEvent('hf-seek',
  {detail:{time: tSec}}))` を dispatch する(`detail.time` は**秒**。
  同じ時刻への連続シークはイベントを重複 dispatch しない)。カード側は
  `window.addEventListener('hf-seek', function(e){ draw(e.detail.time);
  })` で購読して絶対時刻から描き直す
- **readiness hook**: `window.__hyperframes.__ready` に任意で Promise を
  代入すると、bootstrap の `__isReady()`(フォント読み込み・
  `data-hf-requires` の必須ライブラリ存在チェック・Lottie 読み込み完了を
  待った後にこの Promise も待つ)がそれを解決してから render 側の
  seek+continueRender を進める
- **エラーチャンネル**: `window.__hyperframes.__failed` に
  `{message, fatal}` の配列が溜まる(`window` の `error`/
  `unhandledrejection` から自動収集。リソース読み込み失敗や
  `data-hf-requires` の未定義ライブラリも fatal として積まれる)。
  fatal な失敗が1件でもあると Remotion 側(`HyperFrame.tsx`)は
  `cancelRender` してレンダーを止める
- **`data-hf-requires`**: ルート要素(または任意の要素)に
  `data-hf-requires="gsap"` のように空白/カンマ区切りで宣言する
  (既知トークン: `gsap` / `lottie` / `anime` / `three`)。bootstrap は宣言された
  トークンごとに対応するグローバル(`window.gsap` / `window.lottie` /
  `window.anime` / `window.THREE`)の存在を確認し、無ければ `__failed` に積む

**GPU/`hf-seek`/`three` カードは `data-hf-determinism="perceptual"` を
必ず宣言する**(check ゲート Rule 9)。ANGLE の GPU/canvas 出力は driver
依存で byte 決定論を保証できないため、`hf-seek` イベントの購読
(`addEventListener('hf-seek', ...)` 等クォート済みの `'hf-seek'`/
`"hf-seek"` トークンを検出)または `data-hf-requires` に `three` を含む
カードは、`data-hf-determinism` が未指定(既定 byte 相当)または
`"byte"` のままだとエラーになる。GSAP(`window.__timelines`)・Anime.js
(`window.__hfAnime`)・Lottie(`window.__hfLottie`)単独の使用は対象外(DOM スタイル書き込みなので
byte のまま宣言してよい)。

## Pinned CDN scripts(B2)

Rule 4 の唯一の例外として、バージョン固定済みの CDN `<script src>` を
ピン表から読み込めます(既定 pin は GSAP、lottie-web、Anime.js、Three.js r160)。すべて満たすこと:

- `src` の URL が `src/lib/hyperframeCdn.ts` の `CDN_PINS` に一字一句一致する
  (バージョンを上げ下げしたり、`?` 付きクエリを足すだけでも `not-in-table`
  エラーになる)
- `integrity="sha384-..."` がそのピンの `integrity` と一字一句一致する
  (手書き・自己計算した sha384 は必ず不一致になる。値は表からそのまま
  コピーする)
- `crossorigin="anonymous"` を付ける(無いと SRI が効かずブラウザに
  ブロックされるため check ゲートがエラーにする)
- ルート要素(または任意の要素)に `data-hf-requires="<lib>"`
  (例: `data-hf-requires="gsap"`)を付ける(Rule 10。CDN 読み込みが
  失敗したときに bootstrap の requiresCheck が `__failed` へ積んで
  fail-fast させるための必須条件)

GSAP は `window.__timelines` 経由の DOM スタイル書き込みである限り
**byte tier のまま**でよい(`data-hf-determinism` は省略可・Rule 9 の対象外)。
`gsap.to` / `gsap.from` / `gsap.fromTo` / `gsap.delayedCall` /
`gsap.globalTimeline` の直接利用は禁止。すべての tween を
`data-composition-id` と同じ key で登録した `{paused:true}` timeline に追加する
(Rule 11)。
Anime.jsも`window.__hfAnime`経由で絶対時刻へseekする限り**byte tierのまま**でよい。
`anime()`/`anime.timeline()`の全factoryに`autoplay:false`を指定し、返り値を
初期化済み配列へpushする。`loop`は省略/false/有限非負整数、時間値は有限、
`play`/`restart`/`reverse`は禁止(Rule 16)。author routeはmanualのみで、
`prompts/hyperframe.md`/`card-patterns.md`はAnime.jsを注入しない。
srcdoc には `connect-src 'none'` を含む CSP が張られる — ライブラリの
読み込み・実行(script-src 経由)はできるが、そのライブラリが outbound の
fetch/XHR/WebSocket でどこかへ送信することはできない。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"headline","type":"string","label":"Headline","default":"Powered by GSAP"}
]'>
<head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" integrity="sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2" crossorigin="anonymous"></script>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1280px;height:720px;background:#0a0a12;overflow:hidden;font-family:system-ui,sans-serif}
  #headline{position:absolute;top:300px;left:80px;right:80px;margin:0;font-size:64px;font-weight:700;color:#f5f5f7;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1280" data-height="720" data-hf-requires="gsap">
    <h1 id="headline" class="clip" data-start="0" data-duration="3"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      var h = document.getElementById('headline');
      h.textContent = v.headline;
      window.__timelines = window.__timelines || {};
      window.__timelines.root = gsap.timeline({paused:true});
      window.__timelines.root.fromTo(h, {opacity:0, y:24}, {opacity:1, y:0, duration:0.6, ease:'power2.out'});
    </script>
  </div>
</html>
```

## 0エラーの composition 例

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"headline","type":"string","label":"Headline","default":"Deterministic by design"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1280px;height:720px;background:#0a0a12;overflow:hidden;font-family:system-ui,sans-serif}
  #headline{position:absolute;top:300px;left:80px;right:80px;margin:0;font-size:64px;font-weight:700;color:#f5f5f7;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1280" data-height="720">
    <h1 id="headline" class="clip" data-start="0" data-duration="3"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      var h = document.getElementById('headline');
      h.textContent = v.headline;
      h.animate(
        [{opacity:0, transform:'translateY(24px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:600, delay:100, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```

## Lottie(人間持ち込み AE 素材)— B4

Lottie は After Effects の書き出し(bodymovin/Lottie JSON)を composition
カードへ持ち込むための受け皿。**LLM は Lottie カードを作図しない**
(`prompts/hyperframe.md` / `card-patterns.md` のパターンメニューに Lottie は
無い)。人間が AE から書き出した JSON は次の material import 経路で card にする:

```sh
node src/cli.ts hyperframe <dir> --name <name> --embed-lottie <animation.json>
```

この authoring-only command は JSON の `w` / `h` / `fr` / `ip` / `op` から
寸法と尺を導出し、canonical な `renderer:'svg'` / byte tier card を
`hyperframes/<name>.html` へ atomic publish する。既存 card の置換は `--force`
必須。`--from-brief` や `--pattern` / `--var` / 寸法・fps・尺 flag とは併用しない。
canvas は生成も自動 fallback もしない。

対応するのは lottie-web が読む **JSON `animationData` のみ**。dotLottie の
`.lottie` コンテナは runtime/pin が無いため未対応。

- **animationData のインライン埋め込みが必須。`path:` フェッチは禁止**
  (check ゲート Rule 13a/13b)。理由は2つ: srcdoc の CSP
  `connect-src 'none'` が実行時フェッチをブロックする、そして
  `hyperframe.<name>.key.json` のキャッシュキー(html の sha256)は html の
  バイトしか見ないため、`path:` で外部 JSON を読む構成だとアニメのバイトが
  キャッシュキーに乗らない(アニメを差し替えてもキャッシュヒットしてしまう)
- AE 書き出しに画像 asset がある場合、`assets[].p` は `data:` URL にする。
  `assets[].u` の外部ディレクトリや `p:'img_0.png'` のようなファイル参照は
  Rule 13 でエラーになる(CSP の `img-src data:` と html sha256 cache key の
  両方に外れるため)
- importer は `assets[].u + p` を JSON directory 内だけで解決する。既存の
  `data:image` は保持し、PNG/JPEG/GIF/WebP は拡張子で信用せず magic bytes を
  検査して `p=data:...` / `u=""` / `e=1` に正規化する。remote/protocol/absolute/
  path escape、directory 外への symlink、未知形式、拡張子不一致は拒否する。
  precomp asset(`p` 無し)は変更しない
- source provenance は元 JSON の basename と sha256 だけを inert metadata に残す。
  JSON と画像 byte はすべて HTML に入るため、素材差し替えは html sha256 と
  render cache key を必ず変える。生成後の check は 0 errors / 0 warnings 必須で、
  失敗時は新規 card を書かず、`--force` 時も既存 byte を保持する
- **ピン留めスクリプトタグは表から一字一句そのままコピーする**(下記)
- ルート要素(または任意の要素)に `data-hf-requires="lottie"` を宣言する
  (Rule 10 と同じ規約)
- **`renderer:'svg'`(既定)は byte tier のまま**(解像度非依存の SVG パスを
  描くため)。**`renderer:'canvas'` はラスタライズするため byte 一致を
  保証しない**。使うときは `data-hf-determinism="perceptual"` を宣言する
  (Rule 14。宣言しないと警告)
- seek 規約は既存どおり: `window.__hfLottie = window.__hfLottie || [];
  window.__hfLottie.push(anim);` で登録する。`loadAnimation` には
  `autoplay:false` と `loop:false` を渡す(bootstrap が毎シークで
  `goToAndStop` するため、自走再生は不要かつ壁時計 drift の原因になる)。
  3点はすべて check ゲートで強制される

```html
<!doctype html>
<html data-composition-variables='[]'>
<head>
<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js" integrity="sha384-J8C0MvgX4WP58J4N2W99vCKd2J6z99ynOJ5bEfE6jeP7kVTW1drYtv/jzrxM5jbm" crossorigin="anonymous"></script>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1280px;height:720px;background:#0a0a12;overflow:hidden}
  #lottie{position:absolute;inset:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1280" data-height="720" data-hf-requires="lottie">
    <div id="lottie"></div>
    <script>
      var DATA = {"v":"5.7.4","fr":30,"ip":0,"op":30,"w":1280,"h":720,"nm":"card","assets":[],"layers":[]};
      var anim = lottie.loadAnimation({
        container: document.getElementById('lottie'),
        renderer: 'svg', loop: false, autoplay: false, animationData: DATA
      });
      window.__hfLottie = window.__hfLottie || [];
      window.__hfLottie.push(anim);
    </script>
  </div>
</html>
```

## GPU / WebGL / shader cards(F2: `gpu-angle`)

生 WebGL(inline fragment shader)でカードを自己描画するための規約と、
現状の render 対応状況をまとめる。GSAP/Anime.js/Lottie と違い、GPU カードは
**ライブラリもCDNピンも不要**(下記)。

### hf-seek self-draw 契約

GPU カードは `window.addEventListener('hf-seek', function(e){ draw(e.detail.time);
})` を購読し、`e.detail.time`(絶対秒)から**ハンドラ内で同期的に**描き直す
(上記「seek conventions(B1)」の hf-seek 規約と同一)。禁止事項は
Rule 5 と共通で、`requestAnimationFrame` / `setInterval` / `Date.now` /
`performance.now` / `new Date()` / `Math.random` は使えない — WebGL の描画
自体は同期呼び出し(`gl.drawArrays` 等)で完結するため、rAF ループなしで
1フレームぶんを即座に描ける。`getContext('webgl', {preserveDrawingBuffer:
true})` を指定し、描画バッファが capture 時点まで保持されるようにする。

### `data-hf-determinism="perceptual"` は必須

`hf-seek` を購読する、または `data-hf-requires="three"` を宣言するカードは
`data-hf-determinism="perceptual"` を**必ず**宣言する(Rule 9。省略または
`"byte"` はエラー)。

### ライブラリ・CDN 不要

生 WebGL・inline shader 文字列・`getContext('webgl')` はいずれも `src` 経由の
外部フェッチではないため、composition の `default-src 'none'` CSP には
一切ブロックされない。GSAP/Anime.js/Lottie のような CDN ピン留めや
`data-hf-requires` 宣言も不要。

### render 対応状況(`gpu-angle`、生 WebGL は usable)

GPU/WebGL カードは Rule 9 と共有する resolver で `gpu-angle` profile に分類し、
その card だけ `openBrowser("chrome", {chromiumOptions:{gl:"angle"}})` で
render する。非 GPU card は従来どおり `openBrowser("chrome")` のまま。
配線判断の根拠となった Cutflow の Remotion/Chrome(macOS)実測:

- **既定**(`openBrowser("chrome")`。現行の render 経路)→
  `getContext('webgl')` が **null** を返し、カードは描画できず render に
  失敗する
- **swiftshader**(`chromiumOptions.gl:"swiftshader"`)→ こちらも
  **null(WebGL コンテキストが取得できない)**。program §2.3 が想定していた
  「SwiftShader が GPU の byte 決定論を保証する」という前提は、この
  Cutflow の Remotion/Chrome/macOS 構成では成立しない(SwiftShader 自体が
  WebGL を提供しない)
- **angle**(`chromiumOptions.gl:"angle"`)→ WebGL が**動作し**、2回の
  re-render で frame 0/60/119 が **byte 単位で完全一致**した(4秒/120フレーム
  のクリップで render 約3.7秒)

生 WebGL/shader は現在 CLI render まで対応する。ただし angle の byte 一致は
環境一般の保証ではなく、GL の決定論は GPU/driver 依存なので Rule 9 が強制する
`perceptual` tier を維持する。`getContext('webgl'|'webgl2'|
'experimental-webgl')` の要求が1回以上あり成功がゼロなら、bootstrap が
author script/readiness 後または同期 `hf-seek` dispatch 直後に既存の fatal
channel へ明示エラーを積み、黒画面 MP4 を成功扱いしない。profile は cache key
と `hyperframe.<name>.key.json` に含むため、profile が変われば cache miss する。

### Three.js core-only(X3)

Three.js は manual route で `usable`。classic UMD build が最後に存在する
`three@0.160.0`(実測669884 bytes、runtime `THREE.REVISION === "160"`)を固定する。
r160→r161 の公式 migration で classic build が削除され、現行0.181.2の
`three.module.min.js`は`./three.core.min.js`を追加importするため1本のSRIで閉じず、
jsDelivrの`+esm`も動的生成物でSRI非推奨を明記するため、classic 1ファイルを
固定できるr160を採用した:

```html
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js" integrity="sha384-qOkzR5Ke/XkQxuGVJ9hpFEpDlcoLtWwVYhnJf06cLIZa2vaIptSqaubivErzmD5O" crossorigin="anonymous"></script>
```

- root に `data-hf-requires="three"` と `data-hf-determinism="perceptual"` を宣言する
- `hf-seek` を同期購読し、`event.detail.time` の絶対秒を明示した有限 duration
  へ clamp して、scene の状態を毎回**代入**で再構築してから
  `renderer.render(scene,camera)`する。`+=`/`-=`/`++`/`--` のフレーム積算を避ける
- `new THREE.WebGLRenderer({...})` の literal options は
  `preserveDrawingBuffer:true`、動画用 pixel ratio は `1`、fixture の
  `antialias:false` と固定サイズを基準にする
- `renderer.setAnimationLoop`、`new THREE.Clock()`、`getDelta()`/
  `getElapsedTime()`、loader、Worker、blob URL は X3 core-only では禁止。
  model/texture/HDRI/addon の読み込みはまだ対応しない
- 実例は `examples/hyperframes-animation--three-geometry.html`、逐語 upstream は
  `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/three.md`

`html-in-canvas` は **OUT のまま**とする。上流は実験的な `layoutsubtree` / `drawElementImage` を必要とする一方、Cutflow が Chromium に渡すのは `gl:"angle"` だけで有効化 flag が無く、通常 canvas への fallback は同等機能ではないうえ、DOM→bitmap の readiness・cache key・決定論を別途設計すべき独立課題だからである。

### check と render を通る例

以下は check ゲートを 0 エラーで通り、`hyperframe <dir> --name <name>` が
自動選択する `gpu-angle` profile で render できる(Rule 5 の同期描画・Rule 9 の
perceptual 宣言を満たす)。

```html
<!doctype html>
<html data-composition-variables='[]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1280px;height:720px;background:#000;overflow:hidden}
  #gl{position:absolute;inset:0;display:block}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1280" data-height="720" data-hf-determinism="perceptual">
    <canvas id="gl" class="clip" data-start="0" data-duration="4" width="1280" height="720"></canvas>
    <script>
      var cv = document.getElementById('gl');
      var gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
      var vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
      var fs = 'precision highp float;uniform float uT;uniform vec2 uR;'
             + 'void main(){vec2 uv=gl_FragCoord.xy/uR;'
             + 'vec3 c=vec3(0.5+0.5*sin(uT+uv.x*6.2831),uv.y,0.5+0.5*cos(uT));'
             + 'gl_FragColor=vec4(c,1.0);}';
      function sh(t,s){var o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);return o;}
      var prog=gl.createProgram();
      gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs));
      gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs));
      gl.linkProgram(prog);gl.useProgram(prog);
      var b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
      var loc=gl.getAttribLocation(prog,'p');gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      var uT=gl.getUniformLocation(prog,'uT'),uR=gl.getUniformLocation(prog,'uR');
      gl.uniform2f(uR,1280,720);
      function draw(t){gl.uniform1f(uT,t);gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();}
      window.addEventListener('hf-seek',function(e){draw(e.detail.time);});
      draw(0);
    </script>
  </div>
</html>
```
