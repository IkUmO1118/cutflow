# Context-Sensitive Cursor

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/context-sensitive-cursor.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A typewriter's cursor color switches per active text segment (brand accent on a
brand name, dim on a placeholder, success color on completion) so the eye locks
onto what matters. Serves **code-card** and **typewriter**. Builds on the same
`SEQUENCE` array pattern as `discrete-text-sequence`, adding the cursor layer.

## 構造 (structure)
- Same terminal shape as `discrete-text-sequence`: `.prompt` + fixed-width
  `.text-wrap` holding `.text` and `.cursor` (a colored block, not a glyph).
- `SEQUENCE = [{t, text, segment, color}, …]` — a discrete driver picks the
  active entry and writes both `.text` content and `.cursor`'s `background`.
- A second, independent driver drives cursor blink via `sin()` — never CSS.

## コード骨子 (skeleton)
```css
.cursor { display: inline-block; background: {textColor}; } /* overridden per segment */
```
```js
window.__timelines = window.__timelines || {};
const SEQUENCE = [
  { t: 0, text: "", segment: "main", color: "{mainColor}" },
  { t: T_BRAND_IN, text: "{leadInBrandPrefix}", segment: "brand", color: "{brandColor}" },
  { t: T_SUCCESS, text: "{leadInDone}", segment: "success", color: "{successColor}" },
];
function entryAt(t) { for (let i = SEQUENCE.length-1;i>=0;i--) if (t>=SEQUENCE[i].t) return SEQUENCE[i]; return SEQUENCE[0]; }
const tl = gsap.timeline({ paused: true });
const driver = { t: 0 };
tl.to(driver, { t: DURATION, duration: DURATION, ease: "none", onUpdate: () => {
  const e = entryAt(driver.t); textEl.textContent = e.text; cursorEl.style.background = e.color;
} }, 0);
// Blink is a SEPARATE sin-driven tween — see seek-safe note.
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **Blink from timeline time, not wall-clock**: `Math.sin(blink.p)` from a linear
  `onUpdate` driver, never a CSS `@keyframes blink` — CSS animation clocks desync
  from Cutflow's frame-by-frame seek.
- `background` on `.cursor`, not `color` — the cursor is a colored block, so
  `background` is the property that reads as "color."
- `white-space: pre` + monospace — proportional fonts drift the cursor position
  mid-segment; `pre` preserves trailing spaces so the cursor sits at segment end.
- 3-4 segment colors max — more reads as random, defeats the "brand moment pops" goal.
- GSAP required for the two independent onUpdate drivers (text+color, blink);
  timeline paused, finite driver duration equal to `DURATION`.

## 値の目安 (value defaults)
- `DURATION` 4–8s for a single typed line; `SEQUENCE` entry spacing 0.2–0.5s
  between micro-additions, longer between segment swaps.
- `BLINK_CYCLES_PER_SCENE` chosen so the period ≈ 0.6–1.2s (natural caret feel).
- `cursorWidth` 8–24px; too-thin disappears under render compression, too-tall
  visually outranks the text.

## vendor 全文参照 (full detail)
Full recipe (non-blinking-while-typing variant, cursor-height emphasis, palette
guidance): vendor `.../rules/context-sensitive-cursor.md`.
