# モーション(CSS/WAAPI 既定 + GSAP/Lottie/Anime.js/Three.js は pin 経由)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ./PROVENANCE.md.

`hyperframes-animation` skill は7種類のランタイムアダプタを持つ。Cutflow の
native interpreter(`remotion/HyperFrame.tsx` + `src/lib/hyperframe.ts`)は
**CSS アニメーション・WAAPI(`element.animate`)を `document.getAnimations()`
経由で seek** し、さらに **GSAP 3.14.2・Lottie 5.12.2・Anime.js 3.2.2・Three.js r160 を pin 済み**
(`src/lib/hyperframeCdn.ts`)で、GSAP は `window.__timelines["<composition-id>"]`
へ登録した **paused timeline**、Lottie は `window.__hfLottie` 登録の
animation、Anime.js は `window.__hfAnime` のinstance配列を絶対時刻へ seekし、
Three.js は`hf-seek`の絶対秒で同期描画する。したがって **GSAP/Anime.js/Three.js
前提の記法は使える**(pin タグ逐語+対応する`data-hf-requires`が条件)。TypeGPU は
未 pin で対象外。本書は CSS/WAAPI アダプタ(最も単純で
byte 決定的な既定経路)と `hyperframes-keyframes` の seek-safe な作法を
Cutflow 向けに書き直す。GSAP/Anime.jsを使うときの作法は各節、Lottie は authoring-contract の B4 と下記「Lottie アダプタ」節にまとめる。

## なぜ CSS/WAAPI だけで足りるか

native interpreter は Remotion の各フレームで `useCurrentFrame()` から
composition 内の絶対時刻を求め、`document.getAnimations()` を辿って各
アニメーションの `currentTime` をその絶対時刻へ直接セットし `pause()` する。
CSS `@keyframes` アニメーションも `element.animate()` で作った WAAPI
アニメーションも、ブラウザの `Animation` オブジェクトとして
`document.getAnimations()` に載るので、この1つの仕組みで両方 seek できる。
GSAP のタイムラインは `Animation` オブジェクトを介さない独自実装なので、
`document.getAnimations()` 経由では seek できない。そのため GSAP は別経路
——`window.__timelines["<composition-id>"]` に **`paused:true` の timeline**
を登録し、interpreter が各フレームで `timeline.time(absoluteSeconds)` を
直接セットして seek する——で駆動する(`checkComposition` の Rule 11/12 が
この規約を強制する:直接 `gsap.to/from`・`gsap.ticker` は self-running/
壁時計依存で禁止)。CSS/WAAPI が最も単純な既定経路である点は変わらない。

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

upstream の rules/blueprints は GSAP のプロパティ名で書かれている。**GSAP を
使わず CSS/WAAPI だけでカードを書くとき**は次のように読み替える(GSAP を
pin して使う場合は読み替え不要でそのまま書ける):

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

## GSAP を pin して使うとき(tween の作法)

GSAP の登録・seek 契約(pin タグ逐語+`data-hf-requires="gsap"`+`{paused:true}` を
`window.__timelines[compositionId]` に登録・直接 `gsap.to`/`gsap.ticker` 禁止)は
authoring-contract の「seek conventions(B1)」「Pinned CDN scripts(B2)」に既述。ここは
その paused timeline の**中身**の書き方(≤5点):

1. **1本の timeline に position parameter で積む**。`delay:` ではなく第3引数
   (`0`/`"<"`(直前と同時)/`">"`(直前の直後)/`"label"`)で並べ、`addLabel()` と
   `defaults:{duration,ease}` で読みやすくする(re-order に強い)
2. **アニメして良いプロパティだけ動かす**: `opacity`・`x`/`y`・`scale`/`scaleX`/`scaleY`・
   `rotation`・`transformOrigin`・`color`/`backgroundColor`/`borderRadius`・CSS 変数
   (`"--hue"`)。`width`/`height`/`top`/`left`/`margin*`/`padding*` は**使わない**
   (reflow で整数px にスナップし、遅い tween で「数フレーム止まって1px 飛ぶ」カク付きになる
   =render 正しさの問題)。`display`/raw `visibility` は tween しない
3. **可視性の変更は `autoAlpha`(opacity+終端でのみ visibility)か、境界での
   0秒 `tl.set(el,{visibility})`**。どちらも `.clip` 本体ではなく clip 以外の要素/
   内側ラッパーにだけ(clip の可視性は interpreter が持つ)
4. **transform は alias で**(`x`/`y`/`scale`/`rotation`/`skewX`)。軸ごとに独立補間され、
   同一要素への別 tween 同士の上書き事故を防ぐ。終端で CSS へ返すなら `clearProps`
5. **easing は smooth を基調に、overshoot は例外**。既定は house workhorse `power3.out`、
   1本の composition で ~3 種のイージング性格を使い分ける(`sine`/`power1` 静→`power3`
   標準→`power4`/`expo` パンチ)。`back`/`elastic`/`bounce` は「明示的に遊ぶ」レジスタ限定で
   既定にしない。反復は有限に: `repeat: Math.max(0, Math.floor(dur/cycle) - 1)`(**floor**。
   `ceil` は尺超過)

- **iOS 風の弾み**が要るときは spring の閉形式を ease に焼く(progress の純関数=seek-safe。
  velocity を積む実時間 spring ソルバは seek 不能で禁止)。臨界減衰 ζ=1 が既定、ζ0.8 で
  「felt not seen」、ζ0.6–0.7 で明示的に遊ぶ。実装(`springEase` 関数)は
  `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/gsap-easing-and-stagger.md`
- **stagger・function-based value・SVG(DrawSVG/MorphSVG/SplitText)・`quickTo`/`will-change`**
  の詳細は同ディレクトリの `gsap-easing-and-stagger.md` / `gsap-transforms-and-perf.md` /
  `gsap-timeline-and-labels.md` を見る(`quickTo`・`matchMedia` はイベント駆動=preview 専用で
  render では発火しない)

## Anime.js アダプタ

upstream `adapters/animejs.md` の契約をCutflowのpin/checkへ翻案した要点(5点):

1. **manual route限定**。CSS/WAAPIよりAnime.jsの簡潔なtimeline構文が明確な場合だけ使い、
   card冒頭に昇格理由を1行書く。`--from-brief`のprompt/card-patternsには注入しない
2. pinはAnime.js 3.2.2の逐語tagだけを使い、rootへ`data-hf-requires="anime"`を付ける:
   `<script src="https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js" integrity="sha384-oLmuahJgYYR1aWgZwdMQQ2AClE6A2eEwV2x1Z7cbIHehfkkmommQLH3wX1NDEszb" crossorigin="anonymous"></script>`
3. `anime({...})`と`anime.timeline({...})`の両方を使えるが、**全factoryで
   `autoplay:false`**にし、返り値を初期化済み`window.__hfAnime=[]`へ
   `window.__hfAnime.push(instance)`で必ず登録する
4. `loop`は省略/`false`/有限の非負整数だけ、factoryの`duration`/`delay`/`endDelay`は
   有限値だけにする。`play()`/`restart()`/`reverse()`は相対状態・壁時計を持ち込むため禁止
5. bootstrapは登録配列の全instanceを毎frame `pause(); seek(tMs)`する(GSAPのsame-time
   nudgeは使わない)。実例は`examples/hyperframes-animation--anime-timeline.html`、逐語upstreamは
   `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/animejs.md`

## Three.js アダプタ

upstream `adapters/three.md` をCutflowのmanual/core-only契約へ翻案した要点:

1. 真のgeometry/perspective/depthが必要なときだけ使い、`three@0.160.0`の逐語pin tag、
   `data-hf-requires="three"`、`data-hf-determinism="perceptual"`を宣言する
2. `hf-seek`を同期購読し、`event.detail.time`(秒)を有限durationへclampする。rotation/
   camera/parameterはその絶対時刻の純関数として毎回代入し、前frameから積算しない
3. `WebGLRenderer`は`preserveDrawingBuffer:true`、固定size、`setPixelRatio(1)`で作り、
   handler内の`renderer.render(scene,camera)`で1frameを同期描画する
4. `setAnimationLoop`、`THREE.Clock`、delta/elapsed clock、loader、worker、blob URLは
   X3 core-onlyでは禁止。Rule 5のrAF/壁時計/乱数禁止もそのまま適用する
5. ANGLE出力はGPU/driver依存なのでbyte一致を一般化しない。実例は
   `examples/hyperframes-animation--three-geometry.html`、上流逐語版は
   `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/three.md`

## Lottie アダプタ

Lottie は AE 書き出しのモーション(タイムラインが素材に内包済み)を持ち込む受け皿で、
Cutflow は seek できるプレイヤーだけを必要とする。**LLM は Lottie を作図しない**・
埋め込み/autoplay:false/loop:false/`__hfLottie` 登録・`renderer` の tier・dotLottie 非対応
などの契約は authoring-contract の「Lottie(B4)」、seek 規約(`goToAndStop(ms,false)`)は
「seek conventions(B1)」に既述。本書の追補は1点だけ: **複数の Lottie を同一カードに置く
場合、各インスタンスを `window.__hfLottie.push(anim)` で登録すれば全部が同じ composition
時刻へ seek される**(背景+アイコン+紙吹雪を1枚で同期できる)。

## テキストアニメ(animate-text)

upstream の `animate-text` は Pixel Point の**外部**スキル(24種の名前付きテキスト効果)で
本リポジトリには**同梱していない**(`npx skills add` / `/animate-text` は Cutflow には無い)。
Cutflow では以下で足りる(≤5点):

- 単純なテキストモーション(語ごと・文字ごとのフェード+stagger)は本書の CSS/WAAPI/GSAP で
  そのまま書く。名前付き効果の語彙(soft-blur-in・typewriter・per-word-crossfade・
  mask-reveal-up など)は storyboard で参照できるが、**実装スペックは in-repo に無い**
  (詳細は `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/animate-text.md`)
- **文字間(letter-spacing / word-spacing)を動かすときは per-glyph に分割して各 `x` を
  animate する**。一律 `scale` は**別物**(字形自体を拡縮するだけで字間は変わらない)。
  `scale` が忠実なのは `fontSize` を動かすときだけ。`letterSpacing`/`fontSize` を直接 tween
  すると reflow で1フレームごとに離散したグリフレイアウトに留まりカク付く(GSAP 節の (2) と同根)
- `typewriter` は「補間なしの1文字ずつ表示」= `steps()` / 文字単位の可視切替。カーソル点滅は
  有限反復で(seek-safe doctrine)

## seek-safe の追補(keyframes からの穴埋め)

上の「seek-safe doctrine」に載っていない、`hyperframes-keyframes` 由来の作法:

- **無限ループは禁止、有限回に落とす**。`repeat: -1` / `iteration-count: infinite` は seek 尺を
  持てない。周期から `Math.max(0, Math.floor(duration / cycle) - 1)` を**floor**で出す
  (`ceil` は尺を超える)。Cutflow では尺は clip 窓/`--durationSec` 側で決まるので、無限
  アニメでも clip に `data-duration` があれば描画自体は成立するが、有限化して意図を明示する
- **canvas/WebGL/3D は時間の純関数で描く**。GSAP の proxy object(`tl.to(state,{progress:1,
  onUpdate:...})`)か hf-seek(authoring-contract F2)で「progress→絵」を毎シーク再計算する。
  `AnimationMixer.setTime(t)` のように**絶対時刻でスクラブ**できる API だけを使い、
  フレーム更新を積算(`requestAnimationFrame` ループ)しない
- **最終フレームは演出の一部**。可視ウィンドウ終端まで見える最後の絵が resolved end state に
  なるよう `fill:'both'` / `animation-fill-mode:both` を必ず付ける。rest への自動リセットや
  黒への落としを勝手に入れない
- **同一プロパティを複数の tween/timeline から同時刻に書かない**(GSAP の overwrite は
  順序依存で render 間で反転しうる)。重ねるなら意図を明示して検証する

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
