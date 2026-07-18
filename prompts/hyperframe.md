# hyperframe ステージ用プロンプト
# brief / rules / patterns / width / height / durationSec の各プレースホルダーが実行時に置換される

あなたは、単一の**無音**の HyperFrames カード(章タイトル・説明カード・図解・
kinetic typography のいずれか)を、**自己完結した1個の composition HTML 文字列**
として作成します。この HTML は Cutflow の native interpreter(Remotion 上で
`document.getAnimations()` の絶対時刻 seek により CSS アニメーション+WAAPI
(`element.animate`)だけを解釈する。GSAP などの外部ランタイムは存在しません)
がそのまま render し、Cutflow の check ゲート(`checkComposition`)がそのまま
受理できる形でなければなりません。**音声・ナレーション・BGM は一切含めません**
(このカードは無音の素材として本編に配置されます)。

## 入力: 今回の意図

{{brief}}

## 入力: チャンネルの型(rules.md があれば)

{{rules}}

## 入力: カードパターンの番号メニュー

以下から**1つだけ番号で選んでください**。存在しない構造を自分で発明しては
いけません(番号選択方式は plan-materials / plan-effects と同じ流儀です)。

{{patterns}}

## 入力: 出力仕様

- 出力解像度: `{{width}}` x `{{height}}` px
- 尺: `{{durationSec}}` 秒

## 満たすべき必須ルール(Cutflow の check ゲートがそのまま検査します)

- **CSS アニメーション + WAAPI(`element.animate`)だけを使う**。GSAP・Lottie・
  Three.js 等の外部アニメーションランタイムは使わない。`<script src="...">`
  で外部スクリプトを読み込まない(インラインスクリプトのみ)
- **リモート URL を一切使わない**。`src`/`href`/`srcset`/`poster`/
  `data-composition-src`・CSS `url()`・`@import`・`@font-face` のいずれにも
  `http(s)://` や `//` 始まりの値を書かない。フォントは
  `system-ui, sans-serif`(または `serif` / `monospace`)などの**総称フォント
  ファミリーのみ**を使う(埋め込みカスタムフォントも使わない)
- **非決定的な駆動を一切使わない**: `Math.random`・`Date.now`・
  `performance.now`・`new Date()`・`requestAnimationFrame`・`setInterval` は
  インラインスクリプト内で禁止(検査でエラーになる)。`setTimeout` も避ける
  (壁時計基準で動くため警告対象)
- ルート要素は `data-composition-id`(必須)+ 正の整数の `data-width` /
  `data-height` を持つこと
- `<html>` タグは `data-composition-variables` を**配列形式**で持つこと
  (各要素は `{"id","type","label","default"}` のオブジェクト。オブジェクト
  形式やキー無しは不可)
- 時間制御される要素はすべて `class="clip"` を持ち、`data-start` /
  `data-duration` は非負の数値であること
- アニメーションは**一時停止された状態で登録する**: CSS
  `@keyframes` を使う要素には `animation-play-state: paused` を付ける。
  WAAPI は `element.animate(keyframes, { duration, delay, easing,
  fill: "both" })` の形で呼ぶ(`fill: "both"` を必ず付ける)

## 出力形式

次の JSON **のみ**を出力してください(前後の説明文・コードフェンスは不要):

```json
{
  "html": "<!doctype html>…(composition HTML 全文を1つの文字列として)",
  "variables": [
    { "id": "title", "type": "string", "label": "Title", "default": "Chapter 1" }
  ]
}
```

- `html`: composition の完全な HTML 文字列(上記ルールを満たすもの)
- `variables`: `html` の `data-composition-variables` と**内容が一致する**
  typed variables の配列(`{id, type, label, default}`)。呼び出し側は
  この配列を使って値を差し替えます

## 境界(あなたが決めないこと)

- あなたは**下書きを作るだけ**です。人間がレビューします
- `cutplan.json` / `approvals.json` を書く・承認することは絶対にしません
  (このプロンプトの出力はどの keep 集合にも承認にも触れません)
- 生成したカードを `overlays.json` へ素材として配置するのは**別の適用工程**
  です。あなたはカードそのものだけを出力してください

## 参考: worked example(パターン1: chapter-title)

以下は Cutflow の check ゲートを 0 エラー・0 警告で通過する composition の例です
(構造の参考にしてください。文言・色はこの例をそのまま流用せず、`brief` に
合わせて書き換えてください):

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
