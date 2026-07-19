# Avatar Cloud Network

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/avatar-cloud-network.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Avatars distributed on an elliptical ring around a center hub, connected by SVG
dashed lines, with staggered spring entry — "community"/social-proof reveal.
Serves **grid-card-assemble**. Distinct from `orbit-3d-entry` (continuous
orbit) — this is a static composed reveal that settles and holds.

## 構造 (structure)
- `<svg class="lines">` (`z-index:1`, behind everything) holds center→avatar
  connection lines; `.hub-wrap` holds `.avatar` divs (`z-index:2`) plus `.hub`
  (`z-index:5`, must sit ABOVE the lines converging on it).
- Avatar positions computed once from `angle = i/N × 2π`, ellipse `RADIUS_X/Y`,
  and a `SCREEN_CENTER` that **must equal the hub's actual rendered center**.
- Phases: hub fade → avatar cascade (`back.out` stagger) → lines draw outward
  (`strokeDashoffset → 0`) → optional idle breathing.

## コード骨子 (skeleton)
```css
.lines { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.hub { z-index: 5; } .avatar { z-index: 2; will-change: transform, opacity; }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// CENTER_X/Y baked from the hub's known layout — see seek-safe note.
avatars.forEach((av, i) => tl.from(av, { opacity: 0, scale: 0, duration: 0.5,
  ease: "back.out(1.6)" }, AVATAR_ENTRY_START + i * AVATAR_STAGGER));
lines.forEach((line, i) => tl.to(line, { strokeDashoffset: 0, duration: 0.5,
  ease: "power2.out" }, LINES_START + i * LINE_STAGGER));
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte\*** — the ring geometry is a formula (`angle`, `RADIUS_X/Y`), not a
  runtime measurement, so it's byte-stable **provided** `CENTER_X/CENTER_Y` are
  baked to match the hub's actual rendered center exactly (a static constant
  derived once at authoring time, e.g. from `place-items:center` layout math —
  not a per-frame `getBoundingClientRect`). If the hub position ever comes from
  a live measurement instead, treat it as perceptual-risk and gate behind `__ready`.
- Lines drawn OUTWARD (`strokeDashoffset` → 0) — narrates "hub connects to community."
  `Math.hypot` for line length; `getTotalLength()` not needed for straight lines.
- Hub `z-index` > lines z-index, always — otherwise lines visually pierce through it.
- Idle breathing (optional) is a finite bounded sine `onUpdate`, never `repeat:-1`.
- GSAP required for staggered entries + line draw; timeline paused.

## 値の目安 (value defaults)
- `AVATAR_COUNT` 8–12 (fewer feels sparse, more clutters); `RADIUS_X > RADIUS_Y`
  (ratio 1.5–3.0 reads as depth, ratio 1 reads flat 2D).
- Avatar stagger 0.06–0.10s; line stagger 0.02–0.05s, starting ~0.1–0.2s before
  the last avatar settles so the draw reads as a consequence of the cascade.
- Climax dwell ≥1s after lines complete, so the formed network is readable.
- `AVATAR_SIZE` 80–120px at 1920 wide — small enough that 10+ avatars fit the
  ring without overlap.

## vendor 全文参照 (full detail)
Full recipe (multi-orbit / concentric variant, geographic-glyph variant, avatar
count/radius ranges): vendor `.../rules/avatar-cloud-network.md`.
