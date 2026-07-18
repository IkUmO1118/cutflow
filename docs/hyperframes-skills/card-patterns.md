# カードパターン(番号メニュー)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ./PROVENANCE.md.

`faceless-explainer` / `motion-graphics` / `pr-to-video` / `hyperframes-creative`
の4 skill から**デザイン感性だけ**を採取した、Cutflow 向けカードパターンの
numbered menu。`prompts/hyperframe.md` の `{{patterns}}` に差し込まれ、LLM は
ここから**1つだけ番号で選ぶ**(番号選択方式。plan-materials / plan-effects と
同じ流儀)。CLI・HeyGen サインイン・素材検索(media-use)・registry
block(`npx hyperframes add`)・sub-agent 分業といった upstream の実行機構は
一切引き継いでいない — ここにあるのはレイアウト・モーション・配色の発想だけ。

各パターンの ```html は Cutflow の check ゲート(`checkComposition`)を
**0エラー**で通過する(`test/hyperframeSkills.test.ts` が全パターンを機械
検査している)。

## 1. chapter-title(章タイトル)

**由来**: `motion-graphics` の `lower-thirds`/title-card 系カテゴリと
`faceless-explainer` のオープニング frame。

**レイアウト**: 暗い背景 + 左寄せの大見出し + 小さいサブタイトル + アクセント
カラーの短いバー。**モーション**: 見出しは下からフェードイン(WAAPI)、
サブタイトルは少し遅れて追従、バーは幅0→固定幅へ育つ(CSS)。**配色**:
背景はほぼ黒に近いネイビー系のグラデーション、アクセント1色のみ差し色。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"Chapter 1"},
  {"id":"subtitle","type":"string","label":"Subtitle","default":"Getting started"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:system-ui,sans-serif}
  #bg{position:absolute;inset:0;background:radial-gradient(circle at 30% 30%,#12203a,#0b0f1a)}
  #bar{position:absolute;top:520px;left:220px;width:0;height:8px;border-radius:4px;
       animation:grow 0.8s ease-out 0.3s both;animation-play-state:paused}
  @keyframes grow{from{width:0}to{width:320px}}
  #title{position:absolute;top:392px;left:220px;margin:0;font-size:120px;font-weight:800;color:#fff;opacity:0}
  #subtitle{position:absolute;top:560px;left:220px;margin:0;font-size:52px;font-weight:500;color:#9fb3c8;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="bg" class="clip" data-start="0" data-duration="4"></div>
    <h1 id="title" class="clip" data-start="0" data-duration="4"></h1>
    <p id="subtitle" class="clip" data-start="0" data-duration="4"></p>
    <div id="bar" class="clip" data-start="0" data-duration="4"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      var titleEl = document.getElementById('title');
      var subEl = document.getElementById('subtitle');
      titleEl.textContent = v.title;
      subEl.textContent = v.subtitle;
      document.getElementById('bar').style.background = v.accent;
      titleEl.animate(
        [{opacity:0, transform:'translateY(40px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:700, delay:100, easing:'ease-out', fill:'both'}
      );
      subEl.animate(
        [{opacity:0, transform:'translateY(30px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:700, delay:500, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```

## 2. explainer-card(説明カード)

**由来**: `faceless-explainer` の invented-visual 原則(実写素材が無い前提で
タイポグラフィと抽象図形だけで概念を説明する)。

**レイアウト**: 左に丸いバッジ(番号 or アイコン代わりの図形)、右に見出し+
本文の2カラム。**モーション**: バッジは弾むように拡大(WAAPI overshoot)、
テキストはバッジの後にフェードイン。**配色**: 明るい単色背景+濃色テキストの
「エディトリアル」トーン(`faceless-explainer` の house-style が言う「web
ページに見えない」ための、余白を大きく取った構図)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"heading","type":"string","label":"Heading","default":"Why it matters"},
  {"id":"body","type":"string","label":"Body","default":"One idea per card. No clutter."}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#f4f1ea;overflow:hidden;font-family:system-ui,sans-serif}
  #badge{
    position:absolute;top:400px;left:180px;width:280px;height:280px;border-radius:50%;
    background:#1c1c1e;opacity:0;transform:scale(0.6);
  }
  #heading{position:absolute;top:380px;left:560px;right:160px;margin:0;font-size:88px;font-weight:800;color:#1c1c1e;opacity:0}
  #body{position:absolute;top:540px;left:560px;right:220px;margin:0;font-size:44px;font-weight:400;color:#4b4b4f;line-height:1.4;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="badge" class="clip" data-start="0" data-duration="5"></div>
    <h1 id="heading" class="clip" data-start="0" data-duration="5"></h1>
    <p id="body" class="clip" data-start="0" data-duration="5"></p>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('heading').textContent = v.heading;
      document.getElementById('body').textContent = v.body;
      document.getElementById('badge').animate(
        [{opacity:0, transform:'scale(0.6)'},{opacity:1, transform:'scale(1.05)'},{opacity:1, transform:'scale(1)'}],
        {duration:600, delay:0, easing:'ease-out', fill:'both'}
      );
      document.getElementById('heading').animate(
        [{opacity:0, transform:'translateY(20px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:500, delay:250, easing:'ease-out', fill:'both'}
      );
      document.getElementById('body').animate(
        [{opacity:0, transform:'translateY(20px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:500, delay:450, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```

## 3. diagram / labeled(図解・ラベル付き)

**由来**: `motion-graphics` の `maps`/データ系カテゴリと同じ発想(要素同士の
関係を線でつなぐ)を、地図ではなく汎用の3ノード図として一般化。

**レイアウト**: 3つの矩形ノードを横一列に配置し、間を直線コネクタで結ぶ。
各ノードは時間差で出現し、コネクタはノードが揃ってから伸びる。**モーション**:
ノードは順番にフェード+スケールイン(WAAPI、`delay` で stagger)、コネクタは
`width`(またはSVG的な `stroke-dashoffset` 相当)を CSS keyframes で伸ばす。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"nodeA","type":"string","label":"Node A","default":"Input"},
  {"id":"nodeB","type":"string","label":"Node B","default":"Process"},
  {"id":"nodeC","type":"string","label":"Node C","default":"Output"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0e1116;overflow:hidden;font-family:system-ui,sans-serif}
  .node{
    position:absolute;top:460px;width:320px;height:160px;border-radius:16px;
    background:#1c2531;border:2px solid #3a4a5e;
    display:flex;align-items:center;justify-content:center;
    font-size:40px;font-weight:600;color:#e6edf3;opacity:0;transform:scale(0.85);
  }
  #nodeA{left:120px}
  #nodeB{left:800px}
  #nodeC{left:1480px}
  .connector{position:absolute;top:538px;height:4px;background:#4c9eea;width:0}
  #connAB{left:440px}
  #connBC{left:1120px}
  @keyframes extend{from{width:0}to{width:360px}}
  .connector{animation:extend 0.5s ease-out both;animation-play-state:paused}
  #connAB{animation-delay:0.6s}
  #connBC{animation-delay:1.1s}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="nodeA" class="node clip" data-start="0" data-duration="5"></div>
    <div id="nodeB" class="node clip" data-start="0" data-duration="5"></div>
    <div id="nodeC" class="node clip" data-start="0" data-duration="5"></div>
    <div id="connAB" class="connector clip" data-start="0" data-duration="5"></div>
    <div id="connBC" class="connector clip" data-start="0" data-duration="5"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('nodeA').textContent = v.nodeA;
      document.getElementById('nodeB').textContent = v.nodeB;
      document.getElementById('nodeC').textContent = v.nodeC;
      var nodes = [
        {id:'nodeA', delay:0},
        {id:'nodeB', delay:400},
        {id:'nodeC', delay:800}
      ];
      nodes.forEach(function(n){
        document.getElementById(n.id).animate(
          [{opacity:0, transform:'scale(0.85)'},{opacity:1, transform:'scale(1)'}],
          {duration:400, delay:n.delay, easing:'ease-out', fill:'both'}
        );
      });
    </script>
  </div>
</html>
```

## 4. kinetic-typography(キネティックタイポグラフィ)

**由来**: `motion-graphics` の `kinetic-type` カテゴリ(「モーションそのものが
メッセージ」の短尺・ナレーション無し原則)。

**レイアウト**: 大きな単語を1つずつ画面中央に積み重ねて出す(縦積み or
同一位置での置き換え)。**モーション**: 各語は CSS keyframes で
下から出現+フェード。語ごとに `animation-delay` を stagger する(手書き
stagger。GSAP は利用可能(B2)だが、このパターンはライブラリ無しの
CSS stagger で十分なので使わない)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"word1","type":"string","label":"Word 1","default":"Ship"},
  {"id":"word2","type":"string","label":"Word 2","default":"Fast."},
  {"id":"word3","type":"string","label":"Word 3","default":"Ship safe."}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#000;overflow:hidden;font-family:system-ui,sans-serif}
  .word{
    position:absolute;left:0;right:0;top:460px;margin:0;text-align:center;
    font-size:140px;font-weight:800;color:#fff;opacity:0;
    animation:rise 0.5s ease-out both;animation-play-state:paused;
  }
  @keyframes rise{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}
  #word1{animation-delay:0s}
  #word2{animation-delay:0.7s}
  #word3{animation-delay:1.4s;color:#22c55e}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <h1 id="word1" class="word clip" data-start="0" data-duration="0.7"></h1>
    <h1 id="word2" class="word clip" data-start="0.7" data-duration="0.7"></h1>
    <h1 id="word3" class="word clip" data-start="1.4" data-duration="1.6"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('word1').textContent = v.word1;
      document.getElementById('word2').textContent = v.word2;
      document.getElementById('word3').textContent = v.word3;
    </script>
  </div>
</html>
```

## 5. code-card(コードカード)

**由来**: `pr-to-video` の「navy code surface」コンセプト(diff/コードを
主役にした固定スタイル)を、diff 機能無しの単純な等幅コードパネルへ単純化。

**レイアウト**: ターミナル風パネル(角丸+3ドットのウィンドウ装飾)+等幅
フォントのコード行。**モーション**: 行を上から順にフェードイン、末尾に
点滅カーソル(CSS `@keyframes` で有限回点滅。無限ループにしない=
seek-safe doctrine)。**フォント**: 総称ファミリー `monospace` のみ
(埋め込みフォントは使わない)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"line1","type":"string","label":"Line 1","default":"$ node src/cli.ts validate ."},
  {"id":"line2","type":"string","label":"Line 2","default":"OK  cutplan.json"},
  {"id":"line3","type":"string","label":"Line 3","default":"OK  transcript.json"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0d1117;overflow:hidden;font-family:system-ui,sans-serif}
  #panel{
    position:absolute;top:220px;left:260px;width:1400px;height:640px;
    background:#161b22;border-radius:20px;border:1px solid #30363d;
  }
  .dot{position:absolute;top:44px;width:20px;height:20px;border-radius:50%}
  #d1{left:280px;background:#ff5f56}
  #d2{left:316px;background:#ffbd2e}
  #d3{left:352px;background:#27c93f}
  .line{
    position:absolute;left:300px;font-family:monospace;font-size:34px;color:#c9d1d9;opacity:0;
    animation:appear 0.35s ease-out both;animation-play-state:paused;
  }
  #line1{top:340px;animation-delay:0.2s}
  #line2{top:400px;color:#3fb950;animation-delay:0.6s}
  #line3{top:460px;color:#3fb950;animation-delay:1.0s}
  @keyframes appear{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
  #cursor{
    position:absolute;top:460px;left:900px;width:18px;height:38px;background:#c9d1d9;
    animation:blink 0.5s steps(1) 1.4s 4 both;animation-play-state:paused;
  }
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="panel" class="clip" data-start="0" data-duration="5"></div>
    <div id="d1" class="dot clip" data-start="0" data-duration="5"></div>
    <div id="d2" class="dot clip" data-start="0" data-duration="5"></div>
    <div id="d3" class="dot clip" data-start="0" data-duration="5"></div>
    <div id="line1" class="line clip" data-start="0" data-duration="5"></div>
    <div id="line2" class="line clip" data-start="0" data-duration="5"></div>
    <div id="line3" class="line clip" data-start="0" data-duration="5"></div>
    <div id="cursor" class="clip" data-start="0" data-duration="5"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('line1').textContent = v.line1;
      document.getElementById('line2').textContent = v.line2;
      document.getElementById('line3').textContent = v.line3;
    </script>
  </div>
</html>
```

## 6. stat / count-up(統計・カウントアップ)

**由来**: `motion-graphics` の `stat` カテゴリ(単一のヒーロー数値の
count-up)。upstream は GSAP の数値 tween を使う。GSAP は利用可能
(B2。ピン留め CDN 経由)だが、このパターンにライブラリは不要で、
かつインラインスクリプトでの `setInterval`/`requestAnimationFrame`
での手動カウントは check ゲートのエラーになる。代わりに**CSS
`@property` によるカスタムプロパティ補間 + `counter()`** で、JS 一切無し
の count-up を実現する(乱数もタイマーも使わないので determinism を壊さない)。

**レイアウト**: 中央に巨大な数値、下にラベル。**モーション**: `--num`
カスタムプロパティを 0 → 目標値へ CSS アニメーションで補間し、
`counter(num)` で整数として描画する。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"target","type":"number","label":"Target value","default":128},
  {"id":"caption","type":"string","label":"Caption","default":"commands shipped"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:system-ui,sans-serif}
  @property --num{
    syntax:'<integer>';
    inherits:false;
    initial-value:0;
  }
  #stat{
    position:absolute;top:340px;left:0;right:0;text-align:center;
    font-size:220px;font-weight:800;color:#22c55e;
    --num:0;
    counter-reset:num var(--num);
    animation:countup 1.6s linear 0.2s both;
    animation-play-state:paused;
  }
  #stat::after{content:counter(num)}
  @keyframes countup{from{--num:0}to{--num:128}}
  #caption{position:absolute;top:640px;left:0;right:0;text-align:center;margin:0;
    font-size:56px;font-weight:500;color:#9fb3c8;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="stat" class="clip" data-start="0" data-duration="4"></div>
    <p id="caption" class="clip" data-start="0" data-duration="4"></p>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('caption').textContent = v.caption;
      document.getElementById('caption').animate(
        [{opacity:0},{opacity:1}],
        {duration:500, delay:300, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```

> **注意**: `--num` の目標値(`@keyframes countup` の `to{--num:128}`)は
> `{{target}}` 変数から本来動的に決めたいところだが、CSS `@keyframes` は
> JS から値を渡せない。カード作成時に `target` の値を見て、この
> `@keyframes` 自体をその場で書き換える(= LLM が出力する `html` 文字列に
> 実際の目標値を直接埋め込む)。これは「座標や色を LLM が生成する」のとは
> 別の許容ケース(このパターン固有の技術的制約)であることに注意。
