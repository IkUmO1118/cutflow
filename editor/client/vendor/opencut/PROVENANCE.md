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
