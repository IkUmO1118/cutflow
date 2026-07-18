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
  `serif`/`monospace` 等)のみを使う

詳しいモーションの作法(CSS/WAAPI アダプタの書き方)は
`./motion-css-waapi.md` を見る。

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
