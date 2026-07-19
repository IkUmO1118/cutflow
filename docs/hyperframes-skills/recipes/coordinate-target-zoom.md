# Coordinate Target Zoom

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/coordinate-target-zoom.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Zoom *into* one non-centered element (a card in a row, a node in a diagram) so it
lands at viewport center. Serves **diagram/labeled** and **comparison-split** (reveal
the layout, then push into the chosen one). ⚠️ This is the recipe most prone to a
byte-determinism hazard in Cutflow — read the seek-safe note before using.

## 構造 (structure)
- Two nested wrappers, separated concerns — **outer** applies `scale` (the zoom),
  **inner** applies `translate(x,y)` (the counter-shift). Never both on one element.
- Inside inner: the `.content` row with the `#target` element among siblings.
- The scene box needs `overflow:hidden` (scaled content leaks past the frame).
- `transform-origin:50% 50%` on the outer — the counter-translate math assumes it.
- Wrap the scene in one `class="clip"`; the wrappers are bare (driven by timeline).

## コード骨子 (skeleton)
Counter-translation is the **negation of the target's offset from center** —
independent of scale: `T = -offset` (NOT `-offset×(S-1)`).
```js
// Measure the real laid-out center ONCE, at setup, behind the readiness hook.
window.__hyperframes.__ready = (async () => {
  await document.fonts.ready;                     // fallback metrics are 10–30px off
  const W=1920,H=1080, r=document.getElementById('target').getBoundingClientRect();
  const offX=r.left+r.width/2-W/2, offY=r.top+r.height/2-H/2;
  const maxS=Math.min(0.88*W/r.width,0.88*H/r.height);   // headroom cap
  const S=Math.min(2.5,maxS);
  const tl=(window.__timelines=window.__timelines||{});
  const t=gsap.timeline({paused:true});
  t.to('#zoom-outer',{scale:S,duration:1.4,ease:'power3.inOut'}, 2.0);
  t.to('#zoom-inner',{x:-offX,y:-offY,duration:1.4,ease:'power3.inOut'}, 2.0); // SAME dur+ease
  window.__timelines['<composition-id>']=t;
})();
```
Symmetric equal-width row only: skip measurement, use
`offX = (index-(N-1)/2)*(CARD_WIDTH+GAP)`.

## seek-safe 注意点 (Cutflow adaptations)
- **⚠️ Measurement + zoom is a byte-determinism hazard (P0).** Reading
  `getBoundingClientRect()` and driving a scale off it produces per-frame anti-alias
  jitter under the renderer's parallel sampling (YMAX~60–120); a static, hand-placed
  layout is byte-stable. Keep the card `data-hf-determinism="byte"` (DOM writes only)
  but expect **perceptual**, not byte-exact, re-render equality when a zoom is measured.
- **Measure ONCE at setup, never per-frame.** Per-frame `getBoundingClientRect` in an
  `onUpdate` desyncs under parallel sampling — forbidden. Gate the async measure behind
  `window.__hyperframes.__ready` so the offset is baked before the timeline registers.
- **`await document.fonts.ready`** before measuring; a 3×+ zoom magnifies fallback-font
  slop into tens of visible px.
- Scale and counter-translate MUST share `duration`+`ease`, or the target drifts mid-zoom.
- Cap the scale from measured size (`0.88×W/width`) — a target filling the frame reads
  as cut-off the instant its center is slightly off.
- GSAP required (pinned CDN + `data-hf-requires="gsap"`); `fromTo`/`to` on a paused
  timeline keyed to the composition id.

## vendor 全文参照 (full detail)
Full recipe (derivation, asymmetric-row trap, multi-target chain, value ranges):
vendor `.../rules/coordinate-target-zoom.md`.
