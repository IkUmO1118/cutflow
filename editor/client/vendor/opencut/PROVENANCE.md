# OpenCut design-system provenance

This P0 design-system layer is adapted from OpenCut at the exact revision below.
OpenCut remains a reference implementation; CutFlow's application, data model,
server routes, and editing behavior are not vendored.

| Item | Value |
|---|---|
| Upstream | `https://github.com/OpenCut-app/OpenCut` |
| Commit | `5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e` |
| Token source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/styles.css` |
| Button source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/button.tsx` |
| Class utility source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/lib/utils.ts` |
| Editor layout source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/app/editor/%5Bproject_id%5D/page.tsx` |
| Resizable wrapper source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/resizable.tsx` |
| Header composition source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/app/editor/%5Bproject_id%5D/page.tsx` |
| Popover source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/popover.tsx` |
| Tooltip source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/tooltip.tsx` |
| Assets/icon-rail token source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/styles.css` |
| Transport button source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/button.tsx` |
| Transport select source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/native-select.tsx` |
| Transport slider source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/slider.tsx` |
| Inspector input source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/input.tsx` |
| Inspector native select source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/native-select.tsx` |
| Inspector slider source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/slider.tsx` |
| Inspector switch source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/apps/web/src/components/ui/switch.tsx` |
| License source | `https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/LICENSE` |

## Adaptation in CutFlow

- `styles.css`: keeps the Tailwind 4 token mapping and light/dark structure,
  adds the requested panel contexts and compact type scale, converts the palette
  to CutFlow's HSL blue language, and prefixes source variables with `--oc-` so
  the staged migration cannot overwrite legacy `--accent` or `--border`.
- `components/ui/button.tsx`: keeps the CVA variant/size vocabulary and compact
  interaction treatment, but uses a native `<button>` because P0 needs neither
  Base UI/Radix nor polymorphic `asChild` behavior.
- `lib/utils.ts`: retains the `clsx` plus `tailwind-merge` composition pattern and
  uses CutFlow's TypeScript/ESM import style.
- `components/ui/resizable.tsx` and the `App.tsx` shell retain OpenCut's nested
  vertical(main/timeline) and horizontal(left/viewer/right) panel vocabulary.
  CutFlow pins `react-resizable-panels` 4.12.2 exactly, so the upstream v2
  `PanelGroup`/`PanelResizeHandle` wrapper is adapted to the v4
  `Group`/`Panel`/`Separator` API. CutFlow's existing pixel persistence,
  collapse toggles, maximized/fullscreen behavior, and mounted editor children
  remain authoritative.
- P2 checkpoint 1 adapts OpenCut's compact editor-header composition and its
  shadcn Popover/Tooltip vocabulary. CutFlow uses the `radix-ui` 1.6.4 umbrella
  package and `lucide-react` 1.25.0, both exact-pinned. One root
  `TooltipProvider` serves the header, while the export menu is a controlled
  Popover backed by the existing `exportOpen` state. Its Radix trigger is the
  sole pointer/keyboard toggle owner (no competing child `onClick`), preserving
  Enter/Space activation plus Escape dismissal and focus return. The native approval
  checkbox, approval mutation, render/preview handlers, disabled gates, titles,
  save state, layout toggles, and settings flow remain CutFlow-owned and
  behaviorally unchanged.
- P2 checkpoint 2 adapts the OpenCut token/button vocabulary into an icon rail
  and compact transport without adopting OpenCut's project or media model. The
  rail exposes exactly CutFlow's four existing capabilities (`materials`,
  `script`, `captions`, `shorts`) and retains `tab`/`setTab`, script lazy-load,
  and conditional child mounting. Materials keep OS-file upload, HyperFrames AI
  authoring, normal/generated/pending/unplayable cards, drag ghosts, placement,
  rebuild/delete context actions, and every gate/error/empty state. The
  transport retains CutFlow's scrub/playhead, source/output timing, volume,
  rate, loop, main/short mode, frame/second steps, maximize, fullscreen, and
  keyboard-title semantics; only native controls and existing handlers are
  wrapped or token-skinned. A scoped 1024px multi-row rule prevents overlap while
  the dual-axis Timeline and Inspector remain untouched.
- P2 checkpoint 3 adapts OpenCut's compact properties vocabulary for CutFlow's
  Inspector only. `Input`, `NativeSelect`, `Slider`, `Switch`, and
  the native color adapter retain browser-controlled values and events; the
  Inspector's existing `NumInput`/`NumStepper` retain draft, Enter, blur,
  Escape, empty-value, step, and preset behavior. Continuous range and color
  events still use the original per-field coalesce keys and undo grouping.
  The OpenCut visual vocabulary is applied under `.ocInspector`, so Settings,
  Timeline, AI, server/API, and editor data semantics are not reskinned here.
  All twelve CutFlow selection kinds, project/no-selection, multi-caption, and
  short-caption branches remain mounted through their original callbacks. The
  short approval control intentionally remains a native checkbox rather than a
  switch because it represents a human approval boundary, not a light setting.
- P3 adapts the pinned OpenCut editor-layout and token sources into a dense,
  layered timeline skin under `.ocTimeline`: compact toolbar and zoom controls,
  readable ruler and track headers, semantic clip colors, selected/hover/focus
  states, playhead and snap affordances, and thin scrollbars. CutFlow's existing
  timeline DOM, semantic classes, variable row heights, horizontal virtualization,
  output-time geometry, raw-time write mapping, track ordering, visibility/mute
  controls, pointer/trim/create/drop handlers, titles, and keyboard shortcuts remain
  authoritative. No secondary-button context menu is introduced.
- Tailwind Preflight is deliberately excluded so the existing inline stylesheet
  remains authoritative for components that have not yet migrated.

## MIT notice

Copyright 2026 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
