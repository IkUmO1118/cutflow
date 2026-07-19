# Scene transitions (collapsed catalog)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ../PROVENANCE.md.
> Collapses upstream `remotion/vendor/.../hyperframes-animation/transitions/` (16 files:
> catalog / overview / TRANSITION-REGISTRY + css-*) into one pointer file.

A transition tells the viewer how two scenes relate: a crossfade says "this
continues," a push slide says "next point," a blur crossfade says "drift with me."
Choose by what the content is doing emotionally, not just technically.

## What Cutflow actually uses this for

Cutflow renders **one card per HTML file** and has no multi-scene sub-composition
runtime. So these transitions are not authored *inside* a card — they describe how
two cards (or a card and the base video) hand off on the **main editing timeline**.
Within a single card, phase changes are hard clip-window cuts (`data-start`/
`data-duration`), never exit tweens. Treat this file as a **vocabulary + selection
guide**; when a transition is implemented in-card as a full-frame overlay, it stays
under the same seek-safe contract as every recipe (pure CSS/WAAPI/GSAP-paused,
transform/opacity/filter/clip-path only, finite repeats, `fromTo` not `from`).

## They are pure-CSS and seek-safe

Every CSS transition here animates scene containers with **opacity / transform /
clip-path / filter** only — all byte-deterministic under absolute-time seek. No
width/height tweens, no infinite repeats. Shader (WebGL) transitions exist upstream
but are **out of scope for Cutflow** (they need the `@hyperframes/shader-transitions`
package + a capture pipeline Cutflow does not ship; a GPU card is `perceptual` tier
anyway). Use the CSS families below.

## Non-negotiable rules (from upstream overview)

1. Every multi-scene handoff uses a transition — no bare jump cuts.
2. Every scene animates IN (`fromTo`, not `from` — `from` animates to current CSS, so
   pairing with `opacity:0` is a 0→0 noop).
3. **Exit animations are banned except on the final scene.** Outgoing content is fully
   visible when the transition starts; the transition IS the exit. Outgoing and
   incoming animate at the **same time T** — that simultaneity is the handoff.
4. Pick **2–3 transition types for the whole piece and repeat them** — repetition reads
   as professional. One primary (60–70% of changes) + 1–2 accents.

## Categories (when to use)

| Category | Transitions | Feel / when |
|---|---|---|
| **Dissolve** | crossfade, blur-crossfade, focus pull, color dip | Calm / premium / "this continues." **blur-crossfade is the universal default** — the blur masks a background-color clash between the two cards. |
| **Push / slide** | push-slide (L/R/U/D), vertical push, elastic push, squeeze | Medium / editorial / "next point." Clean directional movement, like turning a page. |
| **Scale / zoom** | zoom-through, zoom-out, gravity drop, 3D flip | High / dramatic / "hero reveal." Scale + weight extremes. `zoom-through` is the default high-energy pick. |
| **Reveal / mask** | circle iris, diamond iris, diagonal split, clock wipe, shutter | Playful or mechanical, depending on shape. clip-path driven. |
| **Cover** | staggered blocks, horizontal/vertical blinds | Tech / corporate. Full-screen 1920×1080 blocks (NOT thin strips). Blind count scales with energy. |
| **Light** | light leak, overexposure burn, film burn | Warm / retro / analog. Overlays larger than frame; overexposure via `filter:brightness()`. |
| **Distortion** | glitch, chromatic aberration, ripple, VHS tape | Tense / edgy / tech. Chromatic overlays at ~35% normal blend (not `mix-blend-mode:multiply`). |
| **Grid / other** | grid dissolve, morph circle, gravity drop | "Data" feel (grid) or playful. Grid dissolve cycles palette colors per cell. |

## Energy → primary + timing

| Energy | Primary | Duration | Easing |
|---|---|---|---|
| Calm | blur-crossfade, focus pull | 0.5–0.8s | `sine.inOut`, `power1` |
| Medium | push-slide, staggered blocks | 0.3–0.5s | `power2`, `power3` |
| High | zoom-through, overexposure | 0.15–0.3s | `power4`, `expo` |

Narrative position (quick guide): opening = your most distinctive, match mood
(0.4–0.6s); between related points = the primary, consistent (0.3s); topic change =
something different (staggered blocks / shutter / squeeze); climax = boldest accent;
outro = slowest/simplest (crossfade, color dip, 0.6–1.0s).

## Blur intensity by energy

Calm 20–30px / 0.8–1.2s · Medium 8–15px / 0.4–0.6s · High 3–6px / 0.2–0.3s.

## Presets

`snappy` 0.2s power4.inOut · `smooth` 0.4s power2.inOut · `gentle` 0.6s sine.inOut ·
`dramatic` 0.5s power3.in→out · `instant` 0.15s expo.inOut · `luxe` 0.7s power1.inOut.

## Avoid (broken or cheap in CSS)

Star iris (polygon interpolation broken), tilt-shift (no selective CSS blur), lens
flare (visible shape, not optical), hinge/door (distorts too fast). Also avoid
transitions that show a **visible repeating geometric grid** — they read as cheap.

## Full per-transition detail

For the exact GSAP/CSS per transition, read the vendor files (do not re-host here):
`remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/transitions/` —
`catalog.md` (hard rules + routing), `overview.md` (selection), and the per-category
`css-*.md` files (push / radial / 3d / scale / dissolve / cover / light / distortion /
mechanical / grid / other / blur / destruction). `TRANSITION-REGISTRY.md` is the
upstream PLV injector's machine source — informational for Cutflow, not wired.
