# Kinetic Beat Slam

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/kinetic-beat-slam.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Percussive text-forward pieces (taglines, manifestos, hype intros): short phrases
slam in one at a time on a steady beat, each with a *different* entrance, then lock
into a finale. Serves **kinetic-typography** and **titlecard-reveal**. The "rhythmic
vs generic" levers are: one shared beat array, distinct entrances per phrase, and
optional rhythm chrome (metronome ticks).

## 構造 (structure)
- One `class="clip"` stage; each phrase is a child `.kbs-line` (an accented `.verb`
  span inside). Bare elements — visibility is the finale, not per-line clips.
- Optional `.kbs-metronome i` ticks pinned bottom-center as rhythm chrome.
- Finale = all phrases locked in a centered/left stack; z-index only for overlap.
- This card needs GSAP (multi-tween timeline with per-phrase easing vocabulary);
  a single fade would be pure WAAPI, but the varied entrances earn the timeline.

## コード骨子 (skeleton)
```js
// GSAP path: pinned <script src> + data-hf-requires="gsap" on root.
// KEY MUST equal the card's data-composition-id (NOT the literal "main").
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const PULSE = 0.4, BEATS = [PULSE*1, PULSE*5, PULSE*9];   // ONE grid drives all
tl.fromTo('#p1',{scale:1.5,filter:'blur(16px)',opacity:0},
                {scale:1,filter:'blur(0px)',opacity:1,duration:0.5,ease:'power4.out'}, BEATS[0]);
tl.fromTo('#p2',{x:-320,opacity:0},{x:0,opacity:1,duration:0.45,ease:'expo.out'}, BEATS[1]);
tl.fromTo('#p3',{y:90,rotation:6,opacity:0},{y:0,rotation:0,opacity:1,duration:0.55,ease:'circ.out'}, BEATS[2]);
// finale breath — FINITE repeat, floor + max(0,…) so it never overshoots / goes -1
const cycle=1.6, holdDur=15-(BEATS[2]+0.7);
tl.to('.kbs-stage',{scale:1.01,duration:cycle/2,yoyo:true,ease:'sine.inOut',
      repeat:Math.max(0,Math.floor(holdDur/cycle)-1)}, BEATS[2]+0.7);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **`fromTo` not `from`** — `from` animates to current CSS, so a t=0 seek is wrong;
  `fromTo` makes the start state explicit.
- **No infinite repeats** on the finale breath: `Math.max(0, Math.floor(dur/cycle)-1)`
  — `ceil` overshoots the clip window and a negative repeat becomes GSAP `-1` (infinite).
- **Never `tl.play()`** — the timeline stays paused; Cutflow drives it by absolute seek.
- **Fonts**: upstream leans on embedded display faces (Archivo Black, League Gothic).
  Those are NOT embeddable in Cutflow — use a heavy generic weight
  (`font-weight:800/900`, `system-ui`/`sans-serif`) or the card silently falls back.
- **GSAP required**: pin the `<script src>` exactly (url+integrity+`crossorigin`),
  declare `data-hf-requires="gsap"`, register the paused timeline under the
  composition id. Stays **byte** tier (DOM style writes only).
- No exit animations except a final-scene fade — inside one card, phases hard-cut via
  clip windows, not `tl.to(...,opacity:0)`.

## 値の目安 (value defaults)
- Use ≥3 distinct easings across the piece (entrances are its tone of voice).
- Beat spacing 1.2–1.8s reads as a confident pulse; hit duration 0.35–0.6s.
- Vary the motion axis per phrase (scale / x / y+rotate); reuse the ease family.
- Exactly one accent hue (the verbs); the rest mono white/near-black.

## Combinations
`3d-text-depth-layers` (extruded depth on slammed words) · `css-marker-patterns`
(finale underline/circle) · `sine-wave-loop` (the finale breath).

## vendor 全文参照 (full detail)
Full recipe (easing table, beat spacing, rhythm-chrome variants): vendor
`.../rules/kinetic-beat-slam.md`.
