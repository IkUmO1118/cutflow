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
ピン表から読み込めます(既定 pin は GSAP と lottie-web)。すべて満たすこと:

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

## GPU / WebGL / shader cards(B5: `not-wired`)

生 WebGL(inline fragment shader)でカードを自己描画するための規約と、
現状の render 対応状況をまとめる。GSAP/Lottie と違い、GPU カードは
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
一切ブロックされない。GSAP/Lottie のような CDN ピン留めや
`data-hf-requires` 宣言も不要。

### 実測: render 対応状況(`not-wired`、現状は render 不可)

GPU/WebGL カードは check ゲートを通る(Rule 5 の同期描画・Rule 9 の
perceptual 宣言を満たせば 0 エラー)が、**現状の既定 gl 設定では render
できない**。Cutflow の Remotion/Chrome(macOS)環境で実測した結果:

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

つまり、生 WebGL/shader カードは作図可能・check ゲートも通るが、
**`chromiumOptions.gl` を render 経路へ配線しない限り実際には render
できない**(angle が動作することは確認済みだが、GL の決定論はドライバ
依存(program §2.3)であり、このマシンで byte 一致したことがどの環境でも
保証されるわけではない — だから Rule 9 が強制する `perceptual` tier が
引き続き正しい既定)。この配線は**実需要が出るまで意図的に見送る**
(今この瞬間の需要はゼロ)。今日時点では「作図・check は通るが
`hyperframe <dir> --name <name>` の render は失敗する」が正直な現状。

### three.js は未ピン留め(見送り)

three.js は**ピン留めしない**。生 WebGL と同様、現状は GPU render profile
未配線のため `not-wired` であり、サポート済み作図経路ではない。
three を後で導入するときに必要になるもの(いずれも実需要が出るまで
見送り):

- CDN ピン(算出済みだが `CDN_PINS` には未追加): url
  `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js`、
  integrity `sha384-qOkzR5Ke/XkQxuGVJ9hpFEpDlcoLtWwVYhnJf06cLIZa2vaIptSqaubivErzmD5O`、
  lib `three`
- CSP の緩和: three のローダー/ワーカーは `blob:` worker を生成することが
  あり、`default-src 'none'` はこれをブロックする(`blob:`/`worker-src` の
  緩和が要る)

### check ゲートを通る例(render には gl:"angle" 配線が必要)

以下は check ゲートを 0 エラーで通る(Rule 5 の同期描画・Rule 9 の
perceptual 宣言を満たす)。skills sweep(`test/hyperframeSkills.test.ts`)は
`checkComposition` の静的検査だけを行うため、上記の render 不可の実測は
この例の合格判定に影響しない。ただし実際に
`hyperframe <dir> --name <name>` で render するには、上記のとおり
`chromiumOptions.gl:"angle"` の配線(未実装・見送り中)が要る。

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
