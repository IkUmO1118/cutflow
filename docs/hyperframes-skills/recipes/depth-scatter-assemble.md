# Depth Scatter ↔ Assemble

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/depth-scatter-assemble.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
N elements (glyphs, cards, logo fragments) fly in from a rotating 3D depth-cloud
and lock into a flat layout. Serves **logo-assemble** and **grid-card-assemble**.
Distinct from `orbit-3d-entry` (settles into a continuous orbit, not a flat
lockup) and `center-outward-expansion` (a flat 2D burst, no depth/tumble).

## 構造 (structure)
- `.scene` (`perspective`) → `.cloud-stage` (`preserve-3d`, rotates) → N `.frag`
  elements, each `position:absolute` at stage center, translated per-index.
- Each `.frag` carries its **flat assembled** offset as `data-target-x/y`; its
  scattered 3D state (`x,y,z,rotationX,rotationY`) is derived purely from its
  index via the golden angle (`i · 2.399…`) — never `Math.random`.
- Resolve is always flat (`z:0, rotationX:0, rotationY:0`); depth ordering inside
  `preserve-3d` is automatic (paint order follows Z).

## コード骨子 (skeleton)
```css
.scene { perspective: 1400px; }
.cloud-stage { transform-style: preserve-3d; will-change: transform; }
.frag { position:absolute; top:50%; left:50%; transform-style:preserve-3d;
        backface-visibility:hidden; will-change:transform,opacity; }
```
```js
const GOLDEN = Math.PI * (3 - Math.sqrt(5));           // even spread, no clumps
frags.forEach((el, i) => {
  const a = i * GOLDEN, depthT = i/(n-1);
  const s = { x: Math.cos(a)*RADIUS, y: Math.sin(a)*RADIUS,
              z: Z_NEAR - depthT*(Z_NEAR-Z_FAR),
              rotationX: Math.sin(a)*TUMBLE, rotationY: Math.cos(a)*TUMBLE };
  gsap.set(el, { xPercent:-50, yPercent:-50, ...s, opacity:0 });   // park BEFORE tweens
  tl.to(el, { x:+el.dataset.targetX, y:+el.dataset.targetY, z:0,
              rotationX:0, rotationY:0, opacity:1,
              duration: 0.9, ease:'power3.out' }, i * 0.05);
});
```

## seek-safe 注意点 (Cutflow adaptations)
- **Every scattered coordinate is index-derived** (golden-angle trig + stepped
  depth) — never `Math.random`/`Date.now`. A randomized cloud renders differently
  each seek and breaks determinism.
- **`gsap.set()` parks each fragment in the cloud BEFORE any tween** — skipping
  this leaves frame 0 showing the assembled layout, then a visible teleport.
- Transform aliases only (`x`,`y`,`z`,`scale`,`rotation*`) — never width/height/left/top.
- Cloud spin (`rotationY` on `.cloud-stage`) and all assembles are finite,
  one-shot — no `repeat`/`yoyo`/infinite.
- Assemble/hand-off only; a scatter-OUT mid-shot reads as an exit — reserve it
  for the composition's final beat.
- GSAP required (per-fragment 3D tween set + shared cloud rotation); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- Element count 4–14 (glyph sets follow word length; fragments/cards stay 4–9).
- `RADIUS` 250–700px, `Z_NEAR`/`Z_FAR` +150..+450 / −150..−500 (a wide band
  gives strong depth; too large against a short `perspective` over-distorts).
- `TUMBLE` peak rotation 40–110° — with `backface-visibility:hidden`, glyphs
  past 90° show blank mid-tween (intended tumble read).
- `STAGGER` 0.03–0.09s per fragment; `n × STAGGER` should stay below
  `ASSEMBLE_DUR` so the cloud collapses as one motion, not a queue.

## Combinations
`orbit-3d-entry` (alternative 3D entrance — settles into orbit instead of a
flat lockup) · `hacker-flip-3d` (per-glyph decode as fragments seat) ·
`center-outward-expansion` (flat 2D cousin, no depth).

## vendor 全文参照 (full detail)
Full recipe (tumble-swap beat-change hand-off, radial letter-explode, parallax
logo-lockup variant): vendor `.../rules/depth-scatter-assemble.md`.
