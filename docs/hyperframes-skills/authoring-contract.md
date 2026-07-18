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
  `serif`/`monospace` 等)のみを使う。**唯一の例外**: `<script src>` が
  `src/lib/hyperframeCdn.ts` の CDN ピン表に一致する URL・`integrity`
  (両方一字一句そのまま)を持ち、かつ `crossorigin="anonymous"` を持つ
  場合だけは許可される。それ以外の remote 参照(script 以外の全部)は
  この例外の対象外で常にエラーのまま

詳しいモーションの作法(CSS/WAAPI アダプタの書き方)は
`./motion-css-waapi.md` を見る。

## seek conventions(B1)

CSS/WAAPI(`class="clip"` + Web Animations)の他に、bootstrap は以下の
シーク規約もサポートする(名前は上流 HyperFrames と同一。エコシステム
互換のため):

- **GSAP**: `window.__timelines["<id>"]` にポーズ状態
  (`{paused:true}`)の GSAP timeline を登録する。bootstrap は毎シークで
  `tl.pause()` した上で `tl.totalTime(tSec, true)`(GSAP 3.x の
  same-time-seek nudge として `tSec+0.001` へ一度寄せてから `tSec` へ
  戻す二重呼び出し)する
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
  (既知トークン: `gsap` / `lottie` / `three`)。bootstrap は宣言された
  トークンごとに対応するグローバル(`window.gsap` / `window.lottie` /
  `window.THREE`)の存在を確認し、無ければ `__failed` に積む

**GPU/`hf-seek`/`three` カードは `data-hf-determinism="perceptual"` を
必ず宣言する**(check ゲート Rule 9)。GPU/canvas 出力は SwiftShader
無しでは byte 決定論を保証できないため、`hf-seek` イベントの購読
(`addEventListener('hf-seek', ...)` 等クォート済みの `'hf-seek'`/
`"hf-seek"` トークンを検出)または `data-hf-requires` に `three` を含む
カードは、`data-hf-determinism` が未指定(既定 byte 相当)または
`"byte"` のままだとエラーになる。GSAP(`window.__timelines`)・Lottie
(`window.__hfLottie`)単独の使用は対象外(DOM スタイル書き込みなので
byte のまま宣言してよい)。

## Pinned CDN scripts(B2)

Rule 4 の唯一の例外として、バージョン固定済みの CDN `<script src>` を
1本まで読み込めます(既定は GSAP のみがピン留め済み)。すべて満たすこと:

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
無い)。人間が AE から書き出した JSON をカード作者(人間、または
`hyperframe --from-brief` が生成した下書きへ人間が後付け)が手で埋め込む
運用専用。

- **animationData のインライン埋め込みが必須。`path:` フェッチは禁止**
  (check ゲート Rule 13a/13b)。理由は2つ: srcdoc の CSP
  `connect-src 'none'` が実行時フェッチをブロックする、そして
  `hyperframe.<name>.key.json` のキャッシュキー(html の sha256)は html の
  バイトしか見ないため、`path:` で外部 JSON を読む構成だとアニメのバイトが
  キャッシュキーに乗らない(アニメを差し替えてもキャッシュヒットしてしまう)
- **ピン留めスクリプトタグは表から一字一句そのままコピーする**(下記)
- ルート要素(または任意の要素)に `data-hf-requires="lottie"` を宣言する
  (Rule 10 と同じ規約)
- **`renderer:'svg'`(既定)は byte tier のまま**(解像度非依存の SVG パスを
  描くため)。**`renderer:'canvas'` はラスタライズするため byte 一致を
  保証しない**。使うときは `data-hf-determinism="perceptual"` を宣言する
  (Rule 14。宣言しないと警告)
- seek 規約は既存どおり: `window.__hfLottie = window.__hfLottie || [];
  window.__hfLottie.push(anim);` で登録する。`loadAnimation` には
  `autoplay:false` を渡す(bootstrap が毎シークで `goToAndStop` するため、
  自走再生は不要かつ壁時計 drift の原因になる)

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
