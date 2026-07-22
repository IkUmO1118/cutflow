# OpenCut design-system provenance

This P0 design-system layer is adapted from OpenCut at the exact revision below.
OpenCut remains a reference implementation; CutFlow's application, data model,
server routes, and editing behavior are not vendored.

| Item | Value |
|---|---|
| Upstream | `https://github.com/OpenCut-app/OpenCut-classic` |
| Commit | `cf5e79e919144200294fb9fed22a222592a0aeea` |
| Token source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/app/globals.css` |
| Button source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/button.tsx` |
| Class utility source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/lib/utils.ts` |
| Editor layout source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/app/editor/%5Bproject_id%5D/page.tsx` |
| Resizable wrapper source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/resizable.tsx` |
| Header composition source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/app/editor/%5Bproject_id%5D/page.tsx` |
| Popover source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/popover.tsx` |
| Tooltip source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/tooltip.tsx` |
| Assets/icon-rail token source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/app/globals.css` |
| Transport button source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/button.tsx` |
| Transport select source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/native-select.tsx` |
| Transport slider source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/slider.tsx` |
| Inspector input source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/input.tsx` |
| Inspector native select source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/native-select.tsx` |
| Inspector slider source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/slider.tsx` |
| Inspector switch source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/switch.tsx` |
| Dialog source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/dialog.tsx` |
| Tabs source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/tabs.tsx` |
| Scroll area source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/scroll-area.tsx` |
| Toggle group source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/toggle-group.tsx` |
| Sonner source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/sonner.tsx` |
| Sonner package source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/package.json` |
| Sonner version | OpenCut baseline `^2.0.7`; CutFlow exact pin `2.0.7` |
| License source | `https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/LICENSE` |

## Adaptation in CutFlow

- `app/globals.css` (classic's token source; adapted into CutFlow's
  `styles.css`): keeps the Tailwind 4 token mapping and light/dark structure,
  adds the requested panel contexts and compact type scale, converts the palette
  to CutFlow's HSL blue language, and prefixes source variables with `--oc-`.
  P5 retires the temporary legacy palette and makes these tokens authoritative.
  (P6.0 corrects an earlier mis-pin to modern OpenCut `5e0696bc` — an
  editor-less rewrite scaffold whose token source lived at `apps/web/src/styles.css`
  — to the real reference, OpenCut classic `cf5e79e9`, whose token source is
  `apps/web/src/app/globals.css`. The P0-P5 adaptation notes below were
  verified to match classic and remain unchanged.)
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
- P4 checkpoint 1 adapts the pinned Dialog, Tabs, ScrollArea, and ToggleGroup
  wrappers through the existing exact-pinned `radix-ui` umbrella package, then
  mounts them on CutFlow-owned surfaces under `.ocAiCommand`, `.ocAiCommandModal`,
  `.ocAiReview`, `.ocDiffReview`, `.ocHyperframeAuthor`, and `.ocSettings`.
  Radix owns focus trapping, the close-auto-focus lifecycle, Escape/outside
  interaction, tab arrow-key navigation, toggle roving focus, and scroll-area
  mechanics. CutFlow explicitly returns focus to each launcher (or the previously
  focused element for review dialogs) when controlled conditional mounting removes
  a dialog. CutFlow remains the
  controlled-state owner: Settings outside/non-field Escape/cancel still rolls
  back to its snapshot unless saving, while field Escape remains available to
  discard the active input draft without dismissing the modal. HyperFrames blocks
  Escape, allows outside dismissal only while idle, and blocks every explicit
  dismiss control while authoring. Visual and diff review block Escape/outside
  dismissal and close only through their explicit cancel controls; visual-review
  actions, including cancel, are disabled while refining. AI command dismissal
  continues to route through its original controlled state.
  AI propose/refine/review payloads, hunk resolution, HyperFrames file gates and
  progress/error states, config patch/save, and AI doctor flow are unchanged.
- P4 checkpoint 2 replaces `toastReducer.ts`, its React reducer/timer, and the
  custom stack renderer with the pinned OpenCut Sonner component vocabulary and
  exact-pinned `sonner` 2.0.7. CutFlow's adapter retains stable ids for in-place
  progress updates and progress-to-result transitions, info/success/error/progress
  kind mapping, sticky progress, explicit TTL overrides, action callbacks, optional
  close controls, and dismiss-by-id. Adapter revisions prevent stale lifecycle or
  action callbacks from deleting a newer update. Actions prevent Sonner's unguarded
  auto-delete and explicitly dismiss the current revision in `finally`, including
  when the application callback throws. Progress uses a sticky normal toast plus a
  loading icon because Sonner's loading type disables close and swipe dismissal;
  every non-progress update owns `icon: undefined` so Sonner's same-id merge clears
  that custom spinner before selecting its success/info/error type icon.
  The Toaster remains bottom-right with at most five visible notifications, explicit
  76px desktop/mobile bottom clearance, and Japanese container/close labels. Error
  text is hidden only from Sonner's polite region and mirrored once into a visually
  hidden assertive sibling announcer. Its monotonic version replaces the child node
  even for repeated identical messages. Durable draft/conflict/proxy/warning states
  remain separate header banners. OpenCut's `next-themes` and Hugeicons integration
  was initially adapted to CutFlow's then-fixed dark shell and already-pinned Lucide
  icons; P5 checkpoint 2 replaces that temporary fixed choice with a local provider.
- P5 checkpoint 1 moves the former `index.html` stylesheet into the single
  Tailwind input while retaining cascade order: imports and tokens, native shell
  fallbacks, scoped P2-P4 skins, then responsive overrides. The temporary palette
  and verified dead selectors are removed. Shared EmptyState and AppStateView
  presentation adds onboarding for empty panels and initial load/error without
  changing callbacks, disabled gates, project data, or editor APIs.
- P5 checkpoint 2 adds a CutFlow-owned system/light/dark provider. A pre-CSS
  bootstrap and the provider share the same storage key, invalid-value fallback,
  OS media-query resolution, root `.dark`, and `colorScheme` contract; media and
  cross-tab storage changes remain live, while Sonner receives the resolved theme.
  The header uses the existing Radix Popover and native radios, preserving browser
  keyboard behavior, dismissal, and focus return. The first-run Radix Dialog writes
  only its local seen key and waits behind loading/error, draft restore, and external
  conflict resolution. At widths below 1024px, `MobileGate` keeps the complete App
  subtree unmounted. Expanding the viewport unlocks only the current mounted session;
  only the explicit Japanese CTA persists acknowledgement, and the one-way latch never
  tears down an already-mounted editor after a later resize. None of these surfaces
  read or write recording JSON or alter server/API/render semantics.
- Tailwind Preflight remains deliberately excluded so native editor fallback rules
  stay authoritative for components not yet expressed as scoped primitives.

## MIT notice

Copyright 2025-2026 OpenCut

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
