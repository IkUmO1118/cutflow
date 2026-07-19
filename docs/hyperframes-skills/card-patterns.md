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

## パターンの使い方(Reproduce / Adapt / Compose)

このメニューは「1つ選んで番号を返す」だけの表ではなく、**選んだあとの作り込み方**に
3つの姿勢がある(upstream faceless-explainer の visual-design/motion-language から
採取)。カードは**無音の作図素材**なので、upstream の「ナレーション(VO)に合わせて
出す」は「**カードの尺(clip の窓)に合わせて出す**」に読み替える。

- **Reproduce(再現)** — 選んだパターンの `[slot]`(= `data-composition-variables`)に
  今回の語・数値・ラベルを入れるだけで beat に合う。既存の ```html をそのまま使い、
  変数だけ差し替える。
- **Adapt(改変)** — 構造は合うが要素数・面(surface)・配色が違う。**signature move
  (各パターンの肝の動き)は絶対に落とさない**(落とすなら別パターンを選び直す)。
  何を残し何を変えるかを1行決めてから、色・座標・要素数・尺を調整する。
- **Compose(合成)** — どのパターンも beat に合わない。`recipes/`(atomic motion recipes)
  の move を 2〜4個、1本の paused timeline か WAAPI `.animate()` 列に積んで自作する。

どの姿勢でも守る**モーションの原則**(motion-language の doctrine を Cutflow 向けに):

1. **なめらか > 弾み**。既定は long-tail の減速(`ease-out` / `power3` 相当)。
   `back`/`elastic`/`bounce` のオーバーシュートは「明示的に遊ぶ」1点(句読点的な
   スプリング)だけに限る。既定にしない(agent が最も外しやすい失敗)。
2. **前半に全部出さない**。t=0 では「今その瞬間の主役」だけを出し、残りは尺の
   **後半 ~50%** に stagger で送る(無音なので beat/尺基準)。全要素の同時入場は禁止。
3. **安いアニメを足さない**。ホールドを埋めるための呼吸スケール(lazy breathing)や
   後半の遅いパン/プッシュは逆効果。**動かさない方がマシ**。ホールド中に許すのは
   低振幅の subtle jitter(`sine-wave-loop` の低振幅レジスタ)だけ。
4. **seek-safe**(既定でこのメニューは全部満たしている)。無限ループ・乱数・壁時計・
   `requestAnimationFrame`/`setInterval` は使わない。反復は有限、entrance は `fromTo`
   (= WAAPI なら明示の from キーフレーム)で t=0 の seek を正しくする。

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

**語彙の広がり(kinetic-type-beats blueprint より)**: このカードは「積み上げ」以外にも
kinetic type の型を持てる — **in-place token cycle**(固定行の可変スロットだけを
ハードカットで token→token に差し替える。差し替え自体が beat。`discrete-text-sequence`)、
**kinetic beat-slam**(共有の beat 配列に短句を打点入場させ locked finale に着地。
`kinetic-beat-slam`)、**big→small scale-down**(特大の1語が中央で縮んで着地。
`spring-pop-entrance` + プレーンな scale)、**karaoke ハイライトスイープ**(語を左→右に
点灯。`css-marker-patterns` / `asr-keyword-glow`)、**bg-invert ハードフリップ**(選んだ
beat で背景を反転し文字色も反転。`discrete-text-sequence` の whole-state swap)。
これらは Compose 素材(`recipes/`)で足す — 既定は上の CSS stagger のまま。

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

**コード演出の語彙(pr-to-video code-vocabulary より)**: upstream の `code-*`
レジストリブロック(`npx hyperframes add`)は Cutflow には無いので、必要な**動きだけ**を
手で組む — **diff**(消える行は赤で畳み、増える行は緑で開く、stagger)、**morph**
(共有トークンを FLIP で滑らせ、去る語はフェードアウト・来る語はフェードイン)、
**typewriter**(`discrete-text-sequence` + キャレットは `context-sensitive-cursor`)、
**highlight band**(1行を帯でスイープし他を減光。`css-marker-patterns`)、
**scroll-to-line**(長いファイルを対象行が中央に来るまでスクロール。`viewport-change` /
`camera-cursor-tracking`)。UI デモに寄せるなら、クリックは `cursor-click-ripple` /
`physics-press-reaction`(カーソルとボタンを一緒に圧縮)。**2つの原則**: (1) コードだけの
連続は平板になる。**「何をするか」を見せる mechanism/behavior beat**(自作の SVG/GSAP
図でふるまいを再生)と交互に置く。(2) **タイプの速度は clip の `data-duration` に
合わせる**(文字数×1文字尺 + settle が窓に収まるように)。窓を超えるとタイプが
終わらず、周辺の演出も発火しない。

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

**data-viz の語彙(dataviz-countup blueprint より)**: 数値はグラフィックと**対で**
出すと強い — 数値の隣で**満ちる図**(棒の scaleY / 進捗バー・リングの scaleX /
星評価の clip-path ワイプ。`stat-bars-and-fills`。リングの描画は `svg-path-draw`)、
hero 数値の**背後に soft な ambient glow bloom**(peak opacity ≤ ~0.45。
`ambient-glow-bloom`)、**値に連動して字が育つ count-up**(font-size が値とともに伸びる。
`counting-dynamic-scale`)、変わる桁を**スロットマシン風に縦ロール**(`vertical-spring-ticker`)。
数値+図は**同じイージングで着地**させ、ひとつの beat に見せる。

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

---

## 7. titlecard-reveal(タイトルカード・単カード提示)

**由来**: `hyperframes-animation` の `titlecard-reveal` blueprint(Benefits の
「落ち着いた2行の価値タイトル」/ Social_Proof の「雑多な画面を1回のワイプで
きれいなロックアップへ」)。**動きの少なさそのものが payload** の breather/landing beat。

**レイアウト**: 暗い背景 + 中央の大きな価値行、その背後に低不透明度の ambient glow。
**モーション**: signature は「**restrained な reveal を1回だけ + 静止ホールド**」。
1行目がフェード+わずかなスケールアップ(95%→100%)で着地し、少し保持したあと
**上へ抜けながら**2行目(補足/言い換え)が下から立ち上がって中央を取り、最後まで
ホールドする(この slide-up クロスフェードが「1回の動き」)。開発フェーズを増やさない・
第2の動きを足さない。**配色**: ほぼ黒のネイビー + 差し色1。**関連 recipe**:
`scale-swap-transition`(1行目→2行目の中心ハンドオフ)/ `discrete-text-sequence`
(2行の受け渡し)/ `ambient-glow-bloom`(背後の soft glow、peak opacity ≤ ~0.4)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"line1","type":"string","label":"Value line","default":"Local-first by design"},
  {"id":"line2","type":"string","label":"Qualifier line","default":"Your footage never leaves the machine."},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:system-ui,sans-serif}
  #glow{position:absolute;top:340px;left:560px;width:800px;height:400px;border-radius:50%;
        background:radial-gradient(circle,#1c3a5e,rgba(11,15,26,0));opacity:0;filter:blur(20px)}
  #line1{position:absolute;top:470px;left:160px;right:160px;margin:0;text-align:center;
         font-size:96px;font-weight:800;color:#fff;opacity:0}
  #line2{position:absolute;top:490px;left:220px;right:220px;margin:0;text-align:center;
         font-size:52px;font-weight:500;color:#9fb3c8;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="glow" class="clip" data-start="0" data-duration="5"></div>
    <h1 id="line1" class="clip" data-start="0" data-duration="5"></h1>
    <p id="line2" class="clip" data-start="0" data-duration="5"></p>
    <script>
      var v = window.__hyperframes.getVariables();
      var l1 = document.getElementById('line1');
      var l2 = document.getElementById('line2');
      l1.textContent = v.line1;
      l2.textContent = v.line2;
      document.getElementById('glow').animate(
        [{opacity:0},{opacity:0.4}],
        {duration:800, delay:200, easing:'ease-out', fill:'both'}
      );
      // the ONE restrained move: line1 settles in, then slide-up crossfades to line2, which holds
      l1.animate(
        [
          {opacity:0, transform:'translateY(0) scale(0.95)', offset:0},
          {opacity:1, transform:'translateY(0) scale(1)', offset:0.12},
          {opacity:1, transform:'translateY(0) scale(1)', offset:0.48},
          {opacity:0, transform:'translateY(-44px) scale(1)', offset:0.6}
        ],
        {duration:5000, easing:'ease-out', fill:'both'}
      );
      l2.animate(
        [
          {opacity:0, transform:'translateY(44px)', offset:0},
          {opacity:0, transform:'translateY(44px)', offset:0.5},
          {opacity:1, transform:'translateY(0)', offset:0.62},
          {opacity:1, transform:'translateY(0)', offset:1}
        ],
        {duration:5000, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```

---

## 8. grid-card-assemble(グリッド・カード集合)

**由来**: `hyperframes-animation` の `grid-card-assemble` blueprint(Key_Feature の
「機能タイルのグリッドが1枚ずつ組み上がる」)。「breadth(いくつある/何ができる)を
一度に見せる」beat。

**レイアウト**: 上に見出し、下に N 枚(既定6枚)のタイルを 3×2 グリッドで配置。
**モーション**: signature は「**staggered cascade で1枚ずつスロットへ組み上がる**」。
各タイルは短い距離だけフェード+スライドして自分の位置へ入る(散らばりも大きな
バウンドもしない=密なグリッドは共有中心からバーストさせない)。組み上がったら静止
ホールド。**配色**: 暗背景 + タイルは面1色 + 枠のアクセント。**関連 recipe**:
`center-outward-expansion`(短経路 into-slot 形)/ `spring-pop-entrance`(smooth-settle
レジスタ。タイルはオーバーシュートさせない)。タイル数を増やすときは
`data-composition-variables` と `.tile` の座標を対で足す。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"heading","type":"string","label":"Heading","default":"Everything in one pipeline"},
  {"id":"t1","type":"string","label":"Tile 1","default":"Cut"},
  {"id":"t2","type":"string","label":"Tile 2","default":"Caption"},
  {"id":"t3","type":"string","label":"Tile 3","default":"Overlay"},
  {"id":"t4","type":"string","label":"Tile 4","default":"BGM"},
  {"id":"t5","type":"string","label":"Tile 5","default":"Shorts"},
  {"id":"t6","type":"string","label":"Tile 6","default":"Render"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0e1116;overflow:hidden;font-family:system-ui,sans-serif}
  #bg{position:absolute;inset:0;background:radial-gradient(circle at 50% 40%,#16202e,#0e1116)}
  #heading{position:absolute;top:210px;left:0;right:0;margin:0;text-align:center;
           font-size:72px;font-weight:800;color:#e6edf3;opacity:0}
  .tile{position:absolute;width:340px;height:200px;border-radius:20px;
        background:#1c2531;border:2px solid #33465e;
        display:flex;align-items:center;justify-content:center;
        font-size:44px;font-weight:700;color:#cfe3ff;opacity:0}
  #t1{left:340px;top:440px}
  #t2{left:790px;top:440px}
  #t3{left:1240px;top:440px}
  #t4{left:340px;top:700px}
  #t5{left:790px;top:700px}
  #t6{left:1240px;top:700px}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="bg" class="clip" data-start="0" data-duration="6"></div>
    <h1 id="heading" class="clip" data-start="0" data-duration="6"></h1>
    <div id="t1" class="tile clip" data-start="0" data-duration="6"></div>
    <div id="t2" class="tile clip" data-start="0" data-duration="6"></div>
    <div id="t3" class="tile clip" data-start="0" data-duration="6"></div>
    <div id="t4" class="tile clip" data-start="0" data-duration="6"></div>
    <div id="t5" class="tile clip" data-start="0" data-duration="6"></div>
    <div id="t6" class="tile clip" data-start="0" data-duration="6"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      document.getElementById('heading').textContent = v.heading;
      document.getElementById('heading').animate(
        [{opacity:0, transform:'translateY(-20px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:500, delay:0, easing:'ease-out', fill:'both'}
      );
      // staggered cascade: each tile fades + slides a short distance directly into its slot
      var ids = ['t1','t2','t3','t4','t5','t6'];
      ids.forEach(function(id, i){
        var el = document.getElementById(id);
        el.textContent = v[id];
        el.animate(
          [{opacity:0, transform:'translateY(28px) scale(0.94)'},
           {opacity:1, transform:'translateY(0) scale(1)'}],
          {duration:420, delay:400 + i*140, easing:'ease-out', fill:'both'}
        );
      });
    </script>
  </div>
</html>
```

---

## 9. comparison-split(対比スプリット・カード)

**由来**: `hyperframes-animation` の `comparison-split` blueprint(Key_Feature の
「同じ重さの2つを**同時に**天秤にかける A/B」)。3つ以上の列挙や逐次ステップには
使わない(それは grid-card-assemble)。

**レイアウト**: 上に概念を置く見出し、下に等幅の2カード(左右対称・50%軸)。背後に
左右で色分けした ambient glow。**モーション**: signature は「**両袖から入る +
mirrored な `rotateY` book-open tilt**」。左カードは左から、右カードは少し遅れて右から、
それぞれ鏡像の rotateY 傾き(本を開く向き)で 0.85→1 に着地し、傾きを保ってホールド。
見出しは上から降りて非対立の T 字を作る。最後に**内側の縁**へ pill バッジがスプリング
ポップで着く(このカード唯一のオーバーシュート=句読点)。**配色**: 暗背景 + 左右2色。
**関連 recipe**: `split-tilt-cards`(signature。entry と idle を別レイヤーに)/
`spring-pop-entrance`(内縁バッジの overshoot)/ `scale-swap-transition`。カメラは静止。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"Cut and caption, together"},
  {"id":"leftLabel","type":"string","label":"Left card","default":"Manual editing"},
  {"id":"rightLabel","type":"string","label":"Right card","default":"CutFlow pipeline"},
  {"id":"leftBadge","type":"string","label":"Left badge","default":"hours"},
  {"id":"rightBadge","type":"string","label":"Right badge","default":"minutes"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f16;overflow:hidden;font-family:system-ui,sans-serif}
  #glowA{position:absolute;top:360px;left:220px;width:520px;height:520px;border-radius:50%;
         background:radial-gradient(circle,#12324f,rgba(11,15,22,0));filter:blur(10px)}
  #glowB{position:absolute;top:360px;left:1180px;width:520px;height:520px;border-radius:50%;
         background:radial-gradient(circle,#123f2c,rgba(11,15,22,0));filter:blur(10px)}
  #title{position:absolute;top:180px;left:0;right:0;margin:0;text-align:center;
         font-size:68px;font-weight:800;color:#eef4ff;opacity:0}
  #stage{position:absolute;top:400px;left:0;width:1920px;height:420px;perspective:1400px}
  .card{position:absolute;top:0;width:620px;height:420px;border-radius:24px;
        display:flex;align-items:center;justify-content:center;
        font-size:52px;font-weight:700;color:#eaf2ff;opacity:0;
        background:linear-gradient(160deg,#1a2434,#131a27)}
  #left{left:250px;box-shadow:40px 24px 60px rgba(0,0,0,0.45)}
  #right{left:1050px;box-shadow:-40px 24px 60px rgba(0,0,0,0.45)}
  .badge{position:absolute;top:560px;padding:14px 34px;border-radius:999px;
         font-size:34px;font-weight:800;color:#04140a;opacity:0}
  #badgeL{left:770px}
  #badgeR{left:980px}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="glowA" class="clip" data-start="0" data-duration="5"></div>
    <div id="glowB" class="clip" data-start="0" data-duration="5"></div>
    <h1 id="title" class="clip" data-start="0" data-duration="5"></h1>
    <div id="stage" class="clip" data-start="0" data-duration="5">
      <div id="left" class="card"></div>
      <div id="right" class="card"></div>
    </div>
    <div id="badgeL" class="badge clip" data-start="0" data-duration="5"></div>
    <div id="badgeR" class="badge clip" data-start="0" data-duration="5"></div>
    <script>
      var v = window.__hyperframes.getVariables();
      var accent = v.accent || '#22c55e';
      document.getElementById('title').textContent = v.title;
      document.getElementById('left').textContent = v.leftLabel;
      document.getElementById('right').textContent = v.rightLabel;
      var bL = document.getElementById('badgeL');
      var bR = document.getElementById('badgeR');
      bL.textContent = v.leftBadge; bR.textContent = v.rightBadge;
      bL.style.background = accent; bR.style.background = accent;
      // title slides down into place (non-conflicting T against the side entries)
      document.getElementById('title').animate(
        [{opacity:0, transform:'translateY(-36px)'},{opacity:1, transform:'translateY(0)'}],
        {duration:600, delay:0, easing:'ease-out', fill:'both'}
      );
      // signature move: mirrored opposite-wing entry with book-open rotateY tilt, held
      document.getElementById('left').animate(
        [{opacity:0, transform:'translateX(-420px) rotateY(34deg) scale(0.85)'},
         {opacity:1, transform:'translateX(0) rotateY(14deg) scale(1)'}],
        {duration:800, delay:400, easing:'ease-out', fill:'both'}
      );
      document.getElementById('right').animate(
        [{opacity:0, transform:'translateX(420px) rotateY(-34deg) scale(0.85)'},
         {opacity:1, transform:'translateX(0) rotateY(-14deg) scale(1)'}],
        {duration:800, delay:600, easing:'ease-out', fill:'both'}
      );
      // inner-edge badges: the lone overshoot, punctuating each card
      var pop = [
        {opacity:0, transform:'scale(0.4)', offset:0},
        {opacity:1, transform:'scale(1.12)', offset:0.7},
        {opacity:1, transform:'scale(1)', offset:1}
      ];
      bL.animate(pop, {duration:420, delay:1600, easing:'ease-out', fill:'both'});
      bR.animate(pop, {duration:420, delay:1880, easing:'ease-out', fill:'both'});
    </script>
  </div>
</html>
```

---

## 10. logo-assemble-lockup(ロゴ組み上げ・ロックアップ)

**由来**: `hyperframes-animation` の `logo-assemble-lockup` blueprint(Product_Intro/
Brand_Outro/CTA の「ブランドマークが部品から自分を組み上げて中央ロックアップに
なる」)。無言のブランド sting、または締めのロックアップ。

**レイアウト**: 中央に mark(SVG)+ 右に wordmark を横並びのロックアップ。**モーション**:
signature は「**mark が部品から組み上がる → ロックアップに解決**」。mark の輪郭を
stroke-draw で描き(stroke-dashoffset を有限アニメで 0 へ)、中の部品(ここでは play 三角)を
スプリングで pop、続けて wordmark を**左→右へ1文字ずつ cascade** させて lockup を完成し
ホールド。**配色**: 暗背景 + アクセント1色の mark + 明色 wordmark。**関連 recipe**:
`svg-path-draw`(mark 輪郭の stroke-draw。`getTotalLength` 相当を静的値で)/
`spring-pop-entrance`(部品 pop + 文字 cascade)/ `discrete-text-sequence`(文字送り)。
文字 stagger は index 由来(乱数なし)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"wordmark","type":"string","label":"Wordmark","default":"CutFlow"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0a0d14;overflow:hidden;font-family:system-ui,sans-serif}
  #bg{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,#111a2b,#0a0d14)}
  #lockup{position:absolute;top:470px;left:0;right:0;height:160px;display:flex;
          align-items:center;justify-content:center;gap:36px}
  #mark{width:150px;height:150px;flex:0 0 auto}
  #ring{fill:none;stroke-width:10;stroke-linecap:round;
        stroke-dasharray:440;stroke-dashoffset:440;
        animation:draw 1.1s ease-out 0.2s both;animation-play-state:paused}
  @keyframes draw{from{stroke-dashoffset:440}to{stroke-dashoffset:0}}
  #tri{opacity:0}
  #wordmark{margin:0;font-size:120px;font-weight:800;color:#f2f6ff;white-space:nowrap;display:flex}
  .glyph{display:inline-block;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="bg" class="clip" data-start="0" data-duration="5"></div>
    <div id="lockup" class="clip" data-start="0" data-duration="5">
      <svg id="mark" viewBox="0 0 160 160">
        <circle id="ring" cx="80" cy="80" r="70"></circle>
        <polygon id="tri" points="66,54 66,106 112,80"></polygon>
      </svg>
      <h1 id="wordmark"></h1>
    </div>
    <script>
      var v = window.__hyperframes.getVariables();
      var accent = v.accent || '#22c55e';
      document.getElementById('ring').style.stroke = accent;
      document.getElementById('tri').setAttribute('fill', accent);
      // part pops in after the mark outline draws itself
      document.getElementById('tri').animate(
        [{opacity:0, transform:'scale(0.5)'},{opacity:1, transform:'scale(1.1)'},{opacity:1, transform:'scale(1)'}],
        {duration:400, delay:1100, easing:'ease-out', fill:'both', transformOrigin:'80px 80px'}
      );
      // wordmark cascades letter-by-letter left to right, resolving into the lockup
      var wm = document.getElementById('wordmark');
      var chars = (v.wordmark || '').split('');
      chars.forEach(function(ch, i){
        var span = document.createElement('span');
        span.className = 'glyph';
        span.textContent = ch === ' ' ? ' ' : ch;
        wm.appendChild(span);
        span.animate(
          [{opacity:0, transform:'translateY(28px)'},{opacity:1, transform:'translateY(0)'}],
          {duration:360, delay:1300 + i*70, easing:'ease-out', fill:'both'}
        );
      });
    </script>
  </div>
</html>
```

---

## 11. typewriter-reveal(タイプライター提示)

**由来**: `hyperframes-animation` の `typewriter-reveal` blueprint(Hook の「等身大の
一文をライブで打ち → 畳んで → ブランドを pop」)。「誰かが今これを打っている」を
エンジンにする shot。

**レイアウト**: 中央に等幅の1行 + 追従カーソル。**モーション**: signature は
「**キャレット付きの1文字ずつタイプオン**」。`steps()` イージングの width アニメで
文字を離散的に出す(seek-safe)。打ち終えたらキャレットが有限回点滅、その後
行が中心へ畳まれ(`scaleX`→0)、入れ替わりに**ブランドがスプリングポップ**して締める。
**フォント**: タイプ行は総称 `monospace`(`ch` 幅が正確に効くため)。**配色**:
暗背景 + アクセントのブランド。**関連 recipe**: `discrete-text-sequence`(タイプオン)/
`context-sensitive-cursor`(キャレット点滅)/ `scale-swap-transition`(畳み→pop の
中心ハンドオフ)/ `spring-pop-entrance`(ブランド pop)。

```html
<!doctype html>
<html data-composition-variables='[
  {"id":"typed","type":"string","label":"Typed line","default":"editing this took all afternoon"},
  {"id":"brand","type":"string","label":"Brand payoff","default":"CutFlow"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head>
<style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:system-ui,sans-serif}
  #line{position:absolute;top:490px;left:0;right:0;height:100px;display:flex;
        align-items:center;justify-content:center}
  #typed{font-family:monospace;font-size:64px;font-weight:500;color:#dfe8f4;
         white-space:nowrap;overflow:hidden;width:0}
  #caret{width:6px;height:70px;margin-left:8px;background:#dfe8f4;
         animation:blink 0.5s steps(1) 2s 6 both;animation-play-state:paused}
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
  #brand{position:absolute;top:450px;left:0;right:0;margin:0;text-align:center;
         font-size:150px;font-weight:800;color:#fff;opacity:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="line" class="clip" data-start="0" data-duration="5">
      <span id="typed"></span>
      <span id="caret"></span>
    </div>
    <h1 id="brand" class="clip" data-start="0" data-duration="5"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      var accent = v.accent || '#22c55e';
      var typed = document.getElementById('typed');
      var text = v.typed || '';
      typed.textContent = text;
      var n = Math.max(text.length, 1);
      // character-by-character type-on (steps easing = discrete reveal, seek-safe)
      typed.animate(
        [{width:'0ch'},{width:n + 'ch'}],
        {duration:1600, delay:200, easing:'steps(' + n + ', end)', fill:'both'}
      );
      // Scene 3: the typed line collapses, the brand spring-pops in its place
      document.getElementById('line').animate(
        [
          {opacity:1, transform:'scaleX(1)', offset:0},
          {opacity:1, transform:'scaleX(1)', offset:0.62},
          {opacity:0, transform:'scaleX(0)', offset:0.72}
        ],
        {duration:5000, easing:'ease-in', fill:'both'}
      );
      var brand = document.getElementById('brand');
      brand.textContent = v.brand;
      brand.style.color = accent;
      brand.animate(
        [
          {opacity:0, transform:'scale(0.6)', offset:0},
          {opacity:0, transform:'scale(0.6)', offset:0.72},
          {opacity:1, transform:'scale(1.08)', offset:0.82},
          {opacity:1, transform:'scale(1)', offset:0.9}
        ],
        {duration:5000, easing:'ease-out', fill:'both'}
      );
    </script>
  </div>
</html>
```
