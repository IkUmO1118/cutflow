// lib/hyperframe.ts — HyperFrames 作図契約(spec)の最小パーサ+マージ+
// srcdoc ビルダー。remotion/HyperFrame.tsx(ブラウザバンドル)から import
// されるため **node: の import は一切禁止**(annotation.ts と同じ流儀。
// node 専用ロジックは annotationStill.ts のように分離する)。
//
// parseComposition は汎用の HTML パーサではない。HyperFrames の作図契約が
// 定める限られた属性(data-composition-id / data-width / data-height /
// data-composition-variables / data-start / data-duration /
// data-hf-determinism)だけを対象にした契約スコープの属性リーダーで、
// 任意の HTML を安全に扱う設計ではない。
// Node には DOMParser が無いため正規表現で該当属性を拾う。厳密なスキーマ
// 検証(不正な contract のはじき方)は C2 の責務(このファイルはそこまで
// やらない)。

export interface VarDecl {
  id: string;
  type: string;
  label?: string;
  default?: unknown;
}

/** HyperFrame コンポジションのサンプル契約(1920x1080・30fps・4秒)。
 * remotion/HyperFrame.tsx の defaultProps と scripts/hyperframe-verify.ts の
 * 両方から共有される(.tsx から node が直接 import できないため、ここ
 * (browser-safe な .ts)を唯一の置き場にする) */
export const SAMPLE_HTML = `<!doctype html>
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"CutFlow"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head><style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:sans-serif}
  #box{position:absolute;top:480px;left:0;width:120px;height:120px;border-radius:12px;animation:slide 4s linear both;animation-play-state:paused}
  @keyframes slide{from{transform:translateX(0)}to{transform:translateX(800px)}}
  #title{position:absolute;top:200px;left:120px;font-size:96px;font-weight:800;color:#fff;opacity:0}
</style></head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="box" class="clip" data-start="0" data-duration="4"></div>
    <h1 id="title"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      var t = document.getElementById('title');
      t.textContent = v.title;
      document.getElementById('box').style.background = v.accent;
      t.animate([{opacity:0},{opacity:1}], {duration:2000, easing:'linear', fill:'both'});
    </script>
  </div>
</html>`;

export interface ParsedComposition {
  /** data-composition-id(必須。文書中のどこにも無ければ throw) */
  compositionId: string;
  /** data-width(Number化。無い/NaN なら undefined) */
  width?: number;
  /** data-height(Number化。無い/NaN なら undefined) */
  height?: number;
  /** data-composition-variables の JSON 配列。無い/パース失敗なら [] */
  variables: VarDecl[];
  /** data-start と data-duration を両方持つ要素すべてについて
   * max(start + duration) を取ったもの。該当要素が無ければ undefined */
  intrinsicDurationSec?: number;
  /** data-hf-determinism の寛容パース(B0)。"perceptual" のときだけ
   * "perceptual"、それ以外(既定・不在・不正値)は "byte"。属性値の
   * 厳密な検証(byte|perceptual 以外を弾く)は checkComposition の
   * Rule 7 が担う(このパーサは throw しない) */
  determinismTier: "byte" | "perceptual";
}

function htmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** 属性値を拾う: attr="..." / attr='...' の両方に対応した最小マッチ */
function findAttr(html: string, attr: string): string | undefined {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(html);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2];
}

export function parseComposition(html: string): ParsedComposition {
  const rawVars = findAttr(html, "data-composition-variables");
  let variables: VarDecl[] = [];
  if (rawVars !== undefined) {
    try {
      const parsed = JSON.parse(htmlUnescape(rawVars));
      if (Array.isArray(parsed)) variables = parsed as VarDecl[];
    } catch {
      variables = [];
    }
  }

  const compositionId = findAttr(html, "data-composition-id");
  if (compositionId === undefined) {
    throw new Error("composition root missing data-composition-id");
  }

  const widthRaw = findAttr(html, "data-width");
  const heightRaw = findAttr(html, "data-height");
  const width = widthRaw !== undefined && Number.isFinite(Number(widthRaw)) ? Number(widthRaw) : undefined;
  const height = heightRaw !== undefined && Number.isFinite(Number(heightRaw)) ? Number(heightRaw) : undefined;

  // data-start / data-duration は同じ要素タグ内に共起する前提(契約スコープ)。
  // タグを1つずつ走査し、両方を持つ要素だけを対象にする
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let intrinsicDurationSec: number | undefined;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const tag = tagMatch[0];
    const s = findAttr(tag, "data-start");
    const d = findAttr(tag, "data-duration");
    if (s === undefined || d === undefined) continue;
    const sNum = Number(s);
    const dNum = Number(d);
    if (!Number.isFinite(sNum) || !Number.isFinite(dNum)) continue;
    const end = sNum + dNum;
    intrinsicDurationSec = intrinsicDurationSec === undefined ? end : Math.max(intrinsicDurationSec, end);
  }

  const tierRaw = findAttr(html, "data-hf-determinism");
  const determinismTier = tierRaw === "perceptual" ? "perceptual" : "byte";

  return { compositionId, width, height, variables, intrinsicDurationSec, determinismTier };
}

/**
 * 宣言(decls)の default を土台に instanceOverrides・cliOverrides を順に
 * 重ねる。優先度は低→高で default < instance < cli。override にしか無い
 * キーはそのまま素通しする
 */
export function mergeVariables(
  decls: VarDecl[],
  instanceOverrides?: Record<string, unknown>,
  cliOverrides?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of decls) {
    if (d.default !== undefined) out[d.id] = d.default;
  }
  if (instanceOverrides) {
    for (const [k, v] of Object.entries(instanceOverrides)) out[k] = v;
  }
  if (cliOverrides) {
    for (const [k, v] of Object.entries(cliOverrides)) out[k] = v;
  }
  return out;
}

/**
 * author HTML の <head> 先頭にブートストラップ <script> を注入した srcdoc を
 * 返す純関数(同じ引数 → 常に同じ文字列)。ブートストラップは author の
 * インラインスクリプトより先に実行され、window.__hyperframes を用意する:
 * - getVariables()/__seek(tMs): 既存。__seek は .clip 要素の可視性を
 *   data-start/data-duration の窓で切り替え、Web Animations を対象フレーム
 *   時刻へ pause+シークする(CSS/WAAPI 駆動カード向け)
 * - __seek(tMs) は加えて GSAP(window.__timelines)・Lottie
 *   (window.__hfLottie)のシーク、および hf-seek CustomEvent の dispatch
 *   (GPU/WebGL 自己描画カード向け。detail.time は秒)も行う(B1)
 * - __isReady(): フォント読み込み・data-hf-requires の必須ライブラリ・
 *   Lottie の読み込み完了・任意の window.__hyperframes.__ready を待つ
 *   Promise を返す(B1)
 * - __failed: window の error/unhandledrejection から集めた致命エラーの列
 *   (B1。Remotion 側(HyperFrame.tsx)が cancelRender の判断に使う)
 */
export function buildIframeSrcdoc(html: string, variables: Record<string, unknown>): string {
  const json = JSON.stringify(variables).replace(/<\//g, "<\\/");
  const bootstrap =
    "<script>" +
    "(function(){" +
    `var __vars = ${json};` +
    "function seek(tMs){" +
    "try{" +
    "var tSec = tMs/1000;" +
    // --- clip 可視性(verbatim。変更しない) ---
    "var clips = document.querySelectorAll('.clip');" +
    "for (var i=0;i<clips.length;i++){" +
    "var el = clips[i];" +
    "var s = parseFloat(el.getAttribute('data-start')||'0')*1000;" +
    "var draw = el.getAttribute('data-duration');" +
    "var dur = (draw==null) ? Infinity : parseFloat(draw)*1000;" +
    "el.style.visibility = (tMs >= s && tMs < s+dur) ? '' : 'hidden';" +
    "}" +
    // --- Web Animations(verbatim。変更しない) ---
    "var anims = document.getAnimations();" +
    "for (var j=0;j<anims.length;j++){ var a=anims[j]; try{ a.pause(); a.currentTime=tMs; }catch(e){} }" +
    // --- GSAP timelines(window.__timelines。ms→秒で totalTime) ---
    "var tls = window.__timelines;" +
    "if (tls) for (var k in tls){" +
    "if (!tls.hasOwnProperty(k)) continue;" +
    "var tl = tls[k];" +
    "if (!tl) continue;" +
    "try{" +
    "tl.pause();" +
    // GSAP 3.x の same-time-seek nudge: totalTime() を同じ値で連続呼び
    // 出すと no-op になることがあるため、わずかに先の時刻へ寄せてから
    // 目標時刻へ戻す(二重呼び出しが必須)
    "tl.totalTime(tSec+0.001, true);" +
    "tl.totalTime(tSec, true);" +
    "}catch(e){}" +
    "}" +
    // --- Lottie(window.__hfLottie。ms・isFrame=false) ---
    "var las = window.__hfLottie;" +
    "if (las && las.length) for (var m=0;m<las.length;m++){" +
    "var an = las[m];" +
    "if (!an) continue;" +
    "var rdy = (an.isLoaded===true) || (typeof an.totalFrames==='number' && an.totalFrames>0);" +
    "if (rdy){ try{ an.goToAndStop(tMs, false); }catch(e){} }" +
    "}" +
    // --- hf-seek CustomEvent(GPU/WebGL 自己描画カード向け。秒・重複排除) ---
    "if (__lastSeekMs !== tMs){" +
    "__lastSeekMs = tMs;" +
    "try{ window.dispatchEvent(new CustomEvent('hf-seek', {detail:{time: tSec}})); }catch(e){}" +
    "}" +
    "}catch(err){}" +
    "}" +
    "var __lastSeekMs = null;" +
    "function pushFail(msg, fatal){ HF.__failed.push({ message: String(msg), fatal: fatal !== false }); }" +
    "var HF = { getVariables:function(){return __vars;}, __seek: seek, __isReady: whenReady, __failed: [], __ready: undefined };" +
    "window.__hyperframes = HF;" +
    // --- エラーチャンネル(card script より前にインストール) ---
    "window.addEventListener('error', function(e){" +
    "var target = e && e.target;" +
    "if (target && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')){" +
    "pushFail('failed to load resource: ' + (target.src || target.href || target.tagName), true);" +
    "}else{" +
    "pushFail((e && e.message) || 'script error', true);" +
    "}" +
    "}, true);" +
    "window.addEventListener('unhandledrejection', function(e){" +
    "var reason = e && e.reason;" +
    "pushFail((reason && reason.message) || ('unhandled rejection: ' + String(reason)), true);" +
    "});" +
    // --- readiness gate ---
    "function animsReady(){" +
    "var las = window.__hfLottie;" +
    "if (!las || !las.length) return true;" +
    "for (var i=0;i<las.length;i++){" +
    "var an = las[i];" +
    "if (!an) continue;" +
    "var ok = (an.isLoaded===true) || (typeof an.totalFrames==='number' && an.totalFrames>0);" +
    "if (!ok) return false;" +
    "}" +
    "return true;" +
    "}" +
    "function requiresCheck(){" +
    "var el = document.querySelector('[data-hf-requires]');" +
    "if (!el) return;" +
    "var toks = (el.getAttribute('data-hf-requires')||'').split(/[\\s,]+/);" +
    "var g = {gsap:'gsap', three:'THREE', lottie:'lottie'};" +
    "for (var i=0;i<toks.length;i++){" +
    "var tok = toks[i];" +
    "if (!tok) continue;" +
    "var name = g[tok] || tok;" +
    "if (typeof window[name] === 'undefined') pushFail('required library \"'+tok+'\" (window.'+name+') is not defined', true);" +
    "}" +
    "}" +
    "function whenReady(){" +
    "if (HF.__readyPromise) return HF.__readyPromise;" +
    "HF.__readyPromise = new Promise(function(resolve){" +
    "requiresCheck();" +
    "var start = Date.now(), TIMEOUT = 10000;" +
    "function poll(){" +
    "if (animsReady()){" +
    "var cr = HF.__ready;" +
    "if (cr && typeof cr.then === 'function'){" +
    "cr.then(function(){ resolve(); }, function(err){" +
    "pushFail((err && err.message) || 'card __ready rejected', true);" +
    "resolve();" +
    "});" +
    "}else resolve();" +
    "return;" +
    "}" +
    "if (Date.now()-start > TIMEOUT){" +
    "pushFail('readiness timed out after '+TIMEOUT+'ms', true);" +
    "resolve();" +
    "return;" +
    "}" +
    "setTimeout(poll, 32);" +
    "}" +
    "var fr = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();" +
    "fr.then(poll, poll);" +
    "});" +
    "return HF.__readyPromise;" +
    "}" +
    "})();" +
    "</script>";

  const headOpenRe = /<head[^>]*>/i;
  const headCloseRe = /<\/head>/i;
  const htmlOpenRe = /<html[^>]*>/i;

  if (headCloseRe.test(html)) {
    const headOpenMatch = headOpenRe.exec(html);
    if (headOpenMatch) {
      const idx = headOpenMatch.index + headOpenMatch[0].length;
      return html.slice(0, idx) + bootstrap + html.slice(idx);
    }
    // <head> 開きタグが見つからないが </head> はある(通常起こらないが保険)
    return html.replace(headCloseRe, `${bootstrap}</head>`);
  }

  const htmlOpenMatch = htmlOpenRe.exec(html);
  if (htmlOpenMatch) {
    const idx = htmlOpenMatch.index + htmlOpenMatch[0].length;
    const headBlock = `<head>${bootstrap}</head>`;
    return html.slice(0, idx) + headBlock + html.slice(idx);
  }

  // <html> すら無い断片。先頭に差し込む
  return `<head>${bootstrap}</head>` + html;
}
