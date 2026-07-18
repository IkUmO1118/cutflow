# モーション(CSS アニメーション + WAAPI のみ)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ./PROVENANCE.md.

`hyperframes-animation` skill は GSAP をデフォルトに7種類のランタイムアダプタ
(GSAP/Lottie/Three.js/Anime.js/CSS/WAAPI/TypeGPU)を持つが、Cutflow の native
interpreter(`remotion/HyperFrame.tsx` + `src/lib/hyperframe.ts`)は**CSS
アニメーションと WAAPI(`element.animate`)の2つしか seek しない**。GSAP
ランタイムは存在しないので、GSAP 前提の記法は一切使えない。ここでは
`hyperframes-animation` の CSS/WAAPI アダプタと `hyperframes-keyframes` の
seek-safe な作法を Cutflow 向けに書き直す。

## なぜ CSS/WAAPI だけで足りるか

native interpreter は Remotion の各フレームで `useCurrentFrame()` から
composition 内の絶対時刻を求め、`document.getAnimations()` を辿って各
アニメーションの `currentTime` をその絶対時刻へ直接セットし `pause()` する。
CSS `@keyframes` アニメーションも `element.animate()` で作った WAAPI
アニメーションも、ブラウザの `Animation` オブジェクトとして
`document.getAnimations()` に載るので、この1つの仕組みで両方 seek できる。
GSAP のタイムラインは `Animation` オブジェクトを介さない独自実装なので
この仕組みでは seek できない(だから native interpreter は対応しない)。

## CSS アニメーションの書き方

- `@keyframes` で状態を定義し、要素には `animation-play-state: paused` を
  必ず付ける(付け忘れると自動再生され、Chromium の実時間で進んでしまい
  render 時刻とズレる)
- `animation-delay` で開始をずらす。`animation-fill-mode: both`
  (または `forwards`)で開始前/終了後の状態を固定する
- 反復させる場合(点滅カーソル等)は `animation-iteration-count` を**有限の
  整数**にする(`infinite` は技術的には seek 可能だが、`hyperframes-keyframes`
  の作法に倣い、render 対象になるモーションは有限にしておく)

```css
#bar{
  width:0;
  animation: grow 0.8s ease-out 0.3s both;
  animation-play-state: paused;
}
@keyframes grow{ from{ width:0 } to{ width:320px } }
```

## WAAPI(`element.animate`)の書き方

```js
el.animate(
  [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }],
  { duration: 600, delay: 100, easing: 'ease-out', fill: 'both' }
);
```

- `duration`/`delay` は**有限の数値**(ミリ秒)
- `fill: 'both'` を必ず付ける(開始前・終了後の状態を固定し、seek 時に
  未定義区間を作らない)
- 呼び出しは同期的に(ページロード時に)行う。`async`/`Promise`/`setTimeout`
  の中でアニメーションを生成しない(生成タイミングが壁時計依存になり、
  render 時に間に合わない・二重生成される等の非決定を生む)

## GSAP → CSS/WAAPI の対応表

upstream の rules/blueprints は GSAP のプロパティ名で書かれている。Cutflow
でカードを書くときは次のように読み替える:

| GSAP | CSS / WAAPI |
|---|---|
| `x`, `y`(px 相対移動) | `transform: translateX()/translateY()` |
| `scale` | `transform: scale()` |
| `rotation` | `transform: rotate()` |
| `opacity` | `opacity`(そのまま) |
| `autoAlpha`(可視性込みの opacity) | `opacity` + 表示は `class="clip"` の
  ライフサイクルに任せる(要素自体の `display`/`visibility` を JS で
  いじらない) |
| `ease: "power2.out"` 等の GSAP イージング名 | 最寄りの CSS/WAAPI
  `easing`(`ease-out` / `cubic-bezier(...)`)に丸める。厳密な数式一致は
  不要 |
| `stagger` | 各要素の `animation-delay` / WAAPI `delay` を要素ごとに
  ずらして手書きする |

**空間移動には transform 系のプロパティだけを使う**(`x`/`y`/`scale`/
`rotate`)。`top`/`left`/`width`/`height` をレイアウト変更のためにアニメ
させない(compositor に乗らずカクつく上、`hyperframes-core` の
determinism 契約が禁じる `display`/`visibility` の直接操作と同じ理由で
サイズ変化はレイアウトを再計算し、seek 時に画面が一瞬乱れるリスクがある)。

## seek-safe doctrine(禁止リスト)

`hyperframes-keyframes` skill の「Never use for render-critical motion」を
Cutflow の check ゲート(C2)にそのまま対応させたもの。**インラインスクリプト
内で以下を使うと check ゲートがエラーで止める**:

- `Date.now()` / `performance.now()` / `new Date()`
- unseeded `Math.random()`
- `requestAnimationFrame` / `setInterval`
- (`setTimeout` は警告止まりだが同じ理由で避ける)
- 非同期(`async`/`Promise`/`setTimeout` 内)で生成するタイムライン・
  アニメーション(check ゲートはこれを構文的には検出しないが、seek 時に
  間に合わず未定義になるので実質バグ)

これらはすべて「render 時刻でない何か(壁時計・乱数)にモーションの状態が
依存する」ことを防ぐためのルールで、レイアウト定数の事前計算(setup 時に
座標を1回だけ計算し、tween のたびに `getBoundingClientRect()` を呼ばない)
も同じ理由。native interpreter は**任意の絶対時刻へ何度でも同じ結果で
seek できる**ことを前提に render するので、この前提を破る入力は見た目が
狂う。

## 0エラーの composition 例(モーション中心)

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"label","type":"string","label":"Label","default":"Step 1"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1280px;height:720px;background:#101014;overflow:hidden;font-family:system-ui,sans-serif}
  #chip{
    position:absolute;top:320px;left:80px;
    padding:16px 32px;border-radius:999px;background:#22c55e;color:#04140a;
    font-size:36px;font-weight:700;opacity:0;transform:scale(0.8);
  }
  #ring{
    position:absolute;top:280px;left:60px;width:120px;height:120px;
    border:6px solid #22c55e;border-radius:50%;opacity:0;
    animation:pulse 1.2s ease-in-out 0.6s 2 both;
    animation-play-state:paused;
  }
  @keyframes pulse{
    0%{opacity:0.6;transform:scale(0.9)}
    50%{opacity:0.1;transform:scale(1.15)}
    100%{opacity:0;transform:scale(1.3)}
  }
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1280" data-height="720">
    <div id="ring" class="clip" data-start="0" data-duration="3"></div>
    <div id="chip" class="clip" data-start="0" data-duration="3"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      var chip = document.getElementById('chip');
      chip.textContent = v.label;
      chip.animate(
        [{opacity:0, transform:'scale(0.8)'},{opacity:1, transform:'scale(1)'}],
        {duration:400, delay:200, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```
