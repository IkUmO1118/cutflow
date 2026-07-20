# AGENTS_CONTRACT.md — CutFlow

Machine-readable contract for any coding agent (backend-agnostic) editing a
CutFlow recording folder. This file is the source of truth for *what is
editable, what is off-limits, and how to write changes safely*. It does not
duplicate the Japanese operational prose in `CLAUDE.md` or `docs/usage.md`;
it distills the contract into enumerations and pointers, kept in sync with
the code by automated drift tests (`test/agentsMd.test.ts`,
`test/schema.test.ts`).

## 1. What CutFlow is

CutFlow is a local-first, video-as-code pipeline. One recording session is
one folder (for example `~/Movies/cutflow/2026-07-02-xxx/`), and the JSON
files inside that folder are the source of truth for the edit. **Editing a
video in this project means editing the JSON files in a recording folder,
not writing code.** Video files themselves are never touched directly.

## 2. Conventions

- **All times are in seconds of the original (raw) recording**, not the
  cut/output timeline. Mapping raw seconds to output seconds is done by the
  tooling (`node src/cli.ts describe <dir>`); never subtract cut durations
  by hand.
- **All coordinates are output pixels.** Caption `pos`, overlay/zoom/blur
  `rect`, and annotation points/rects share one coordinate system: the
  final rendered resolution.

## 3. Editable files

These 8 files are the ones a human or an agent edits directly. Each has a
JSON Schema in `schemas/` (draft 2020-12) that any JSON Schema-aware editor
or validator can attach for structural validation and autocompletion.
Schemas are **not** referenced from the JSON files themselves (no injected
`$schema` key — user data stays byte-for-byte what you wrote); attach them
by filename convention (`<file>.json` ↔ `schemas/<file>.schema.json`) in
your editor/validator config.

| File | Schema | What it decides |
|---|---|---|
| `cutplan.json` | `schemas/cutplan.schema.json` | Which spans of the raw recording survive (`segments[].action: "keep"/"cut"`), each with a human-readable `reason`. Normally segments align to the candidate grid the numbered-selection prompt saw; when `plan.harness.applySplit` (opt-in, default off) is enabled, a segment can also be a word-boundary sub-span produced by the agentic loop's `split_candidate` tool, written only after `validate`+`assert` pass (rolled back otherwise). `segments[].reasonId` (optional, sticky) tags a decision with one of the 13 classification ids in `docs/edit-skills/recipes/*.md` (single source of truth: `src/lib/reasonIds.ts`'s `CUT_REASON_IDS`); `plan.reasonIds.enabled` (config.yaml key, opt-in, default off) lets `plan --cuts-only`'s single-shot path ask the LLM for it (never the loop/harness paths) and also for a bounded `keeps` list (cut-tempting-but-kept spans only). `reasonId` never affects `render`/the approval hash (`cutplanApprovalHash` only looks at keep `[start, end]`) |
| `transcript.json` | `schemas/transcript.schema.json` | Caption text, timing, per-caption position/style/track, and karaoke word timing |
| `overlays.json` | `schemas/overlays.schema.json` | All visual production: material overlays, inserts, camera wipe, zooms, blurs, annotations (arrow/box/spotlight), caption track defaults, layer order, color filter |
| `bgm.json` | `schemas/bgm.schema.json` | Background music placement per time range |
| `chapters.json` | `schemas/chapters.schema.json` | YouTube description chapter markers (not rendered into the video) |
| `meta.json` | `schemas/meta.schema.json` | Draft titles and description text (does not affect the rendered video) |
| `shorts.json` | `schemas/shorts.schema.json` | Vertical short-form video definitions (independent keep-ranges + layout profile) |
| `thumbnail.json` | `schemas/thumbnail.schema.json` | Thumbnail still image source (time + overlaid text) |

Full current state of a project (fully expanded, non-truncated) is always
available machine-readably via:

```sh
node src/cli.ts describe <dir> --json
```

Use that instead of re-deriving project state from the raw JSON files by
hand — it already resolves raw↔output time mapping, caption/track
inheritance, and full titles/prose.

`assertions.json` is a separate, optional intent-declaration file — not one
of the 8 editable files above, and not a generated artifact either. A human
or an agent writes it to declare the expected post-edit state (output
duration, which captions must still be visible, that a secret region stays
blurred, and so on) as plain, git-diffable JSON, and `node src/cli.ts assert
<dir>` checks the current project against it. It has its own schema
(`schemas/assertions.schema.json`) but is intentionally excluded from the
8-file table: no generator command ever writes or overwrites it (unlike
`cutplan.json` et al., which `plan`/`run` regenerate), so it survives
regeneration cycles untouched. It never affects rendering.

## 4. Files you must NOT write

These are intermediate/generated artifacts. They get overwritten or
invalidated by re-running commands, and writing to them yourself creates
false staleness signals or gets silently discarded:

- Fixed-name generated files: `manifest.json`, `cuts.auto.json`,
  `plan.raw.txt`, `plan.loop.json`, `plan-shorts.raw.txt`,
  `plan-materials.raw.txt`, `plan-effects.raw.txt`, `plan-bgm.raw.txt`,
  `render.props.json`,
  `whisper-out.json`, `whisper-out.srt`, `transcript.system.json`,
  `whisper-system-out.json`, `cut.mp4`, `cut.keeps.json`,
  `render.key.json`, `render.report.json` (the machine-readable summary of
  the last `render()` attempt: chosen path — `full-skip` / `chunk-diff` /
  `fast` / `full-remotion` — plus fallback reason, per-stage timings and
  success/failure, cache hits, changed-chunk count, FAST coverage ratio,
  effective concurrency, an input-snapshot hash, an output probe, and an
  overall ok/failed status; a pure local side artifact that is never
  transmitted anywhere; covers the main render only — shorts are future
  work), `preview.mp4`, `proxy.mp4`, `proxy.key.json`,
  `material-fit.suggested.json` (a disposable draft written by
  `material-fit`; an `apply`-compatible patch of `set`/`remove` ops for
  material duration-fit and dangling-reference fixes — apply it yourself
  with `apply --patch`, never write to `overlays.json` directly from it),
  `effect-check.json` (the machine-readable report written by
  `effect-check`: deterministic E4/E5/E3 warnings, still paths, and whether
  VLM secondary review ran), `effect-fix.suggested.json` (a disposable draft
  written by `effect-check`; an `apply`-compatible patch of deterministic
  `set` ops correcting zoom/blur/annotation interactions — apply it
  yourself with `apply --patch`, never write to `overlays.json` directly
  from it), `bgm-fit.json` (the machine-readable report written by
  `bgm-fit`: speech-overlap/silence-float/loud/no-fade findings against
  `av.probe/sound.json`, plus the monotone/fallback verdict), `bgm-fit.suggested.json`
  (a disposable draft written by `bgm-fit`; an `apply`-compatible patch of
  deterministic `set` ops correcting BGM track `volumeDb`/`fadeOutSec` —
  apply it yourself with `apply --patch`, never write to `bgm.json`
  directly from it), `style-check.json` (the machine-readable report written
  by `style-check`: cut/caption/audio deviation findings against a
  `style.probe/<name>.json` profile, each with observed/expected/band/confidence/severity;
  warn/info only, never fail), `hyperframe-place.suggested.json` (a disposable
  draft written by `hyperframe-place`; an `apply`-compatible patch with a
  single `add` op — `target: "overlays.overlays"` or `target:
  "overlays.inserts"` — placing a rendered `materials/hyperframes/<name>.mp4`
  card into the timeline; apply it yourself with `apply --patch`, never write
  to `overlays.json` directly from it)
- Short-name-variable generated files: `cut.<name>.mp4`,
  `cut.<name>.keeps.json`, `render.<name>.props.json`,
  `render.<name>.key.json` (one set per `shorts.json` entry), and
  `hyperframe.<name>.key.json` (one per `hyperframes/<name>.html` card; the
  cache key gating `hyperframe <dir> --name <name>` reuse of
  `materials/hyperframes/<name>.mp4`, same mechanism as `render.key.json`).
  `hyperframes/<name>.html` (the composition source, human/LLM-editable or
  atomically imported from human-provided AE JSON by `hyperframe --embed-lottie`) and
  `hyperframes/<name>.raw.txt` (the LLM's raw response from
  `hyperframe --from-brief`) and `hyperframes/<name>.assets/` (validated source
  PNG/JPEG/GIF/WebP/WOFF2 attachments retained for provenance and retries) are **not**
  generated artifacts in this sense —
  like `materials/` itself, they fall under `fileRole` `"other"` (human/agent
  content, not overwritten by any other command's re-run), and
  `materials/hyperframes/<name>.mp4` is a product on par with `final.mp4`
- Generated directories (entirely regenerated on each run):
  `frames/`, `render.chunks/`, `shorts/`
- `materials.probe/` — a **cache-style** generated directory (unlike the
  ones above, it is *not* wiped on every run; it's a differential cache like
  `render.chunks/`, and deleting the whole directory forces a full
  regeneration). Written by `materials <dir>` (`index.json` plus per-material
  `<slug>.png`/`<slug>.ocr.json`/`<slug>.transcribe.json` sidecars). Distinct
  from `materials/` itself (the human's asset folder, which stays `"other"`)
- `av.probe/` — a **cache-style** generated directory written by `av <dir>`
  (`motion.json`, `sound.json`, `motion.strip.png`). It is not wiped on each
  run; deleting the whole directory forces a full regeneration
- `render.design/` — a cache-style generated directory holding the base-layout
  design background (`config.yaml` `render.design.backgroundFile`) copied into
  the recording folder, which is the Remotion `publicDir`. Written for both
  plain and obs-canvas recordings when the design is enabled and the configured
  path points outside the recording folder (repo-bundled `assets/backgrounds/…`
  or an absolute path).
  Re-fetched from the source file on the next run, so deleting it is always safe.
  Kept out of `materials/` on purpose: the background is never referenced from
  `overlays.json`, so it would be reported as an unused asset forever
- `render.fast/` — a cache-style generated directory written by the render
  fast path: `captions/<key>.png` (per-caption transparent PNGs, content-hashed
  by text + resolved style + position + output resolution); `overlays/<key>.png`
  (per-overlay transparent layer PNGs with fade/opacity stripped, content-hashed
  by file path + mtime/size + fit + rect + output resolution);
  `annotations/<key>.png` (per-annotation transparent layer PNGs for
  static annotations, content-hashed by the resolved annotation fields +
  output resolution). Differential cache
  (not wiped each run); deleting the whole directory forces full regeneration.
- `review.probe/` — a **replace-on-run** generated directory written by
  `review <dir>` (`index.json`, `before/`, `after/`, `ocr/`). It is wiped and
  rebuilt on each review run
- `hyperframe.probe/` — a **cache-style** generated directory written by
  `hyperframe-check <dir> --name <name>` (`<name>/index.json`, one
  subdirectory per audited card). It is not wiped on each run; deleting the
  whole directory forces a full re-audit. Holds the dynamic audit report
  (deterministic findings, driver counts, sample-grid metadata) and, in a
  later commit, still paths and VLM secondary-review results
- `hyperframe-freeze.suggested/` — a **disposable-draft** generated
  directory written by `hyperframe-freeze <dir> --name <name>` (`<name>.html`,
  a skeletonized copy of `hyperframes/<name>.html` with `string`-typed
  `data-composition-variables` defaults reset to their label — or `"Text"`
  if the label is blank — while colors/numbers/layout/motion are kept
  verbatim; `<name>.md`, a one-line usage-gloss placeholder plus the adopt
  command and any evidence). Overwritten on each run, like
  `material-fit.suggested.json`; a human copies the file pair into the
  channel's `hyperframe-seeds/` directory themselves — Cutflow never writes
  there. Requires the source card to already pass `checkComposition` with
  zero errors; unlike the other `*.probe/` caches this is not a heavy
  cache, so it is excluded from `--cache-only` but still swept by
  `--logs-only` (like `frames/`); never touches
  `cutplan.json`/`approvals.json`
- `style.probe/` — a generated directory written by `style-profile`
  (`<name>.json` per `--name`, default `default.json`) under the **channel**
  directory (the parent of the first `--from` path), not necessarily inside
  a single recording folder. Always fully recomputed and overwritten on each
  run (no partial cache). `plan.styleProfile` (config.yaml key, opt-in,
  default off) lets `plan`/`plan --cuts-only` **read** this profile at plan
  time and inject a compact style-policy block into the LLM prompt as a soft
  prior for candidate selection (target avg shot length/aggressiveness,
  caption density/position, hook/CTA) — never raw JSON, never exact
  timestamps, and always subordinate to `brief.md`. Off (default) leaves the
  LLM input byte-identical to before this feature; a missing/unreadable
  profile degrades gracefully (injection skipped, `plan` still runs). v1
  scope is the cut-decision prompts only (not `remeta`, not the
  materials/effects/BGM generators)
- `backups/` (pre-overwrite snapshots) and `.editor-draft.json` (the GUI
  editor's autosaved unsaved draft)
- `rules.suggested.md` (a disposable draft written by `learn`; a human
  reads it and manually merges what they want into `rules.md`)

`hyperframe-seeds/` is a **human-curated channel store**, not a Cutflow
artifact: like `rules.md`, it lives under a recording folder's **parent**
directory (the channel directory), not inside one. It holds frozen
HyperFrames seed cards (`<name>.html` plus an optional `<name>.md` gloss)
that a human has adopted from `hyperframe-freeze.suggested/`. Its `fileRole`
is `"other"` — Cutflow never writes into it. When present,
`hyperframe <dir> --name <name> --from-brief` reads every `*.html` in it and
appends each one that still passes `checkComposition` with zero errors as
additional numbered entries after the fixed
`docs/hyperframes-skills/card-patterns.md` menu (contiguous numbering
starting after the highest fixed pattern number; failing seeds are skipped
with a warning, never an error). An absent or empty store leaves the author
prompt byte-identical to before this feature.

`node src/lib/files.ts` (`GENERATED_FILES` + the generated-name patterns and
directories) is the single source of truth for this list; this file's
enumeration is pinned to it by `test/agentsMd.test.ts`.

## 5. The approval boundary

`approvals.json` is a **third category**: neither an editable file nor a
generated artifact. It holds the approval record that gates `render` — a
sha256 hash of the keep-set (cutplan segments, or a short's ranges) bound to
an `approvedAt` timestamp. Only two things may write it:

- `node src/cli.ts approve <dir>` / `approve <dir> --short <name>`
- The GUI editor's save action (checkbox)

**An agent must never edit `approvals.json` directly, and must never treat
`cutplan.json`'s `approved: true` (or a short's `approved: true`) as
sufficient for render to proceed.** Those booleans are only a *display of
human intent*; the real gate is the hash-bound record in `approvals.json`.
Editing the keep-set after approval invalidates the record automatically
(hash mismatch) — approval never silently survives a content change.
Approval itself is a human action (`approve` is an interactive command that
requires a preview review; it refuses to run non-interactively without
`--yes`).

## 6. Addressing with `@id`

Elements across the editable files (cutplan segments, captions, overlays,
inserts, zooms, blurs, wipes, hide-caption spans, caption track defs,
chapters, BGM tracks, short ranges, thumbnail texts) may carry a stable
`id?` field of the form `<prefix>_<6 lowercase base36 chars>`
(for example `seg_a1b2c3`). IDs are **opt-in and sticky**: a project with no
IDs anywhere behaves byte-identically to before this feature existed; once
any element has an ID, subsequent generation/save steps assign IDs to new
elements and never change existing ones. IDs never affect rendering or the
approval hash — they exist purely for addressing.

Prefix per element kind:

| Kind | Prefix |
|---|---|
| cutplan segment | `seg` |
| caption (transcript segment) | `cap` |
| overlay material | `mat` |
| insert | `ins` |
| annotation | `ann` |
| zoom | `zm` |
| blur region | `bl` |
| wipe-full span | `wf` |
| hide-caption span | `hc` |
| caption track def | `ct` |
| chapter | `ch` |
| BGM track | `bg` |
| short range | `rg` |
| thumbnail text | `tx` |

Discover current IDs with `node src/cli.ts describe <dir> --json`. Assign
IDs to elements that don't have one yet with `node src/cli.ts id-stamp <dir>`.

## 7. How to edit safely: the write path

Two ways to write edits:

1. **Direct JSON editing** (write the file, then always run
   `node src/cli.ts validate <dir>` before moving on).
2. **`apply`** — a checked, atomic write path, and the **recommended**
   route for agent-driven edits. It takes a patch
   (`schemas/apply-patch.schema.json`: `{ ops?: EditOp[], replace?: {...} }`)
   of `@id`-addressed operations (`set` a field, `remove` an element,
   `add` to an allow-listed collection) and/or a whole-file replacement,
   validates the resulting state, and only writes if there are zero
   errors (backing up touched files first). Supports `--dry-run` to see
   the diff without writing. `apply` **cannot** change `approved` — any op
   touching that field is rejected before anything is written.

```sh
node src/cli.ts apply <dir> --dry-run   # preview a patch's effect
node src/cli.ts apply <dir>             # apply it (all-or-nothing)
```

## 8. The verification triad

After any edit, before asking a human to look at output:

1. **`node src/cli.ts validate <dir>`** — structural + invariant checks
   (errors = exit 1, must fix; warnings = exit 0, informational, e.g. a
   stale approval record or stale `frames/` cache).
2. **`node src/cli.ts describe <dir> --json`** — machine-readable, fully
   expanded snapshot of the current edit state (raw↔output time mapping,
   full caption/title text, all production fields).
3. **`node src/cli.ts frames <dir> --t <times>`** — render still frames at
   given raw-recording seconds with the exact final-composite look
   (captions, wipes, overlays, zoom, blur, annotations) to visually
   self-check layout without a full render.

## 9. Re-run guards

`plan` and `run` **must not be re-run** without being explicitly asked to,
because they overwrite `cutplan.json` / `chapters.json` / `meta.json` and
the "chapter" caption track — all of which may hold hand edits. If asked to
redo cut/chapter/title generation while preserving hand-edited cuts, use
`node src/cli.ts remeta <dir>` instead (leaves `cutplan.json` untouched;
backs up `transcript.json`/`chapters.json`/`meta.json` first). If a rerun of
`plan`/`run` is genuinely requested, existing generated output blocks it
without `--force`; with `--force`, hand-edited files are moved to
`backups/<timestamp>/` before being overwritten.

## 10. Commands

| Command | What it does |
|---|---|
| `ingest <dir>` | Parse a recording file into `manifest.json` + extracted mic audio |
| `transcribe <dir>` | Transcribe mic audio with whisper.cpp into `transcript.json` |
| `detect <dir>` | Detect silence to produce cut candidates (`cuts.auto.json`) |
| `plan <dir>` | Generate cut decisions, chapters, and title drafts with an LLM (§9: do not re-run casually) |
| `remeta <dir>` | Regenerate chapters/titles/description only, leaving `cutplan.json` untouched |
| `plan-shorts <dir>` | Draft short-form video picks into `shorts.json` (all `approved: false`) |
| `plan-materials <dir>` | Draft material (B-roll) placements into `overlays.json`'s `overlays[]` (number-selection only; requires `materials <dir> --all` first) |
| `plan-effects <dir>` | Draft effect (zoom/blur/annotation) placements into `overlays.json`'s `zooms`/`blurs`/`annotations` (number + type selection only; coordinates come from perception, not the LLM; requires `frames --ocr` and/or `av <dir>` first) |
| `plan-bgm <dir>` | Draft BGM placements (interval × song, or silence) into `bgm.json`'s `tracks[]` (number selection only; interval boundaries come from deterministic switch-anchors (chapter boundaries + big-cut boundaries), not the LLM; song files come from real audio files in `materials/` or root `bgm.*`) |
| `hyperframe-backends` | Report HyperFrames backend availability without a recording directory or writes. The default output is human-readable; `--json` emits a stable `schemaVersion: 1` projection with four states (`usable`, `material-routed`, `not-wired`, `out`), determinism tiers, CDN pin URL/version, authoring routes, and real render-fixture paths for usable and material-routed backends |
| `hyperframe <dir>` | Generate or render a HyperFrames composition card (a silent, self-contained drawn asset: chapter title / explainer / diagram / kinetic typography), honored entirely by Cutflow's native Remotion interpreter — no HyperFrames runtime or engine code executes. `--from-brief` drafts a single composition HTML into `hyperframes/<name>.html` via LLM (number-selection over a fixed pattern menu in `docs/hyperframes-skills/card-patterns.md`; the raw response is always kept at `hyperframes/<name>.raw.txt`, but the draft is written only if it passes the deterministic check gate with zero errors). Repeatable `--asset <path>` (only with `--from-brief`) accepts PNG/JPEG/GIF/WebP plus WOFF2, verifies extension and magic bytes (and image dimensions), retains sources in `hyperframes/<name>.assets/`, and enforces the configured per-file/total byte limits plus a fixed 1MiB/font limit. Images keep the numbered `__HF_ASSET_n__` contract unchanged; fonts give the LLM only name/MIME/bytes, exact local `@font-face`, family `HFAsset<n>`, and numbered `__HF_FONT_n__` token — never attachment bytes/data URLs. Valid tokens are deterministically replaced with `data:` URLs before the check gate; invented or partial tokens fail without publishing HTML while raw response and attachments remain for retry. Font-free author prompts remain byte-equivalent to the pre-font contract; only supplied WOFF2 enables local embedded `@font-face`. Subsetting is an external operator step and no subset tool is bundled. `--embed-lottie <path>` deterministically converts a human-provided AE/bodymovin JSON plus confined PNG/JPEG/GIF/WebP assets into one canonical SVG/byte card: it rejects remote/absolute/escaping/symlink-escaping assets, verifies image magic bytes, derives dimensions/timing from JSON, embeds `animationData` and image `data:` URLs, requires check 0 errors/0 warnings, and atomically publishes only after full success (`--force` required to replace an existing card; `.lottie`/canvas unsupported). Without either authoring flag, renders the existing `hyperframes/<name>.html` to `materials/hyperframes/<name>.mp4` (check-gated; `--var k=v` / `--width` / `--height` / `--fps` / `--durationSec` override composition variables/dimensions; cached via `hyperframe.<name>.key.json`; published atomically via temp-file render → ffprobe verify → rename). External refs in composition html are banned except a `<script src>` matching the repo's CDN pin table (`src/lib/hyperframeCdn.ts`) with exact `integrity`/`crossorigin="anonymous"`; srcdoc CSP lists the exact pinned URLs (not the whole CDN origin), enforces `connect-src 'none'`, and the check gate rejects dynamic script construction/import. Never touches `cutplan.json`/`approvals.json`. GSAP animation must use a `{paused:true}` timeline registered under the exact composition ID; direct gsap tweens are rejected. Anime.js 3.2.2 is a manual/byte route: every `anime()`/`anime.timeline()` factory sets `autoplay:false`, uses finite loop/time values, and registers its result in initialized `window.__hfAnime[]`; `play`/`restart`/`reverse` are rejected, while the bootstrap pauses and seeks every registered instance in milliseconds. The CDN pin table also includes lottie-web (human-brought AE JSON exports only, LLM does not author Lottie cards); a Lottie card must inline its animation JSON as `animationData`, set `autoplay:false`/`loop:false`, register with `window.__hfLottie`, and embed image assets as `data:` URLs (`path:`/external assets are rejected). Raw WebGL/shader cards self-draw via the `hf-seek` event, require `data-hf-determinism="perceptual"`, and render with the automatically resolved `gpu-angle` profile; non-GPU cards retain the default Chrome launch path. The profile is included in the cache key/sidecar, and a requested-but-null WebGL context fails explicitly instead of publishing a black MP4. Three.js r160 is a manual/perceptual/core-only route on the same `gpu-angle` profile: exact SRI pin plus `data-hf-requires="three"`, synchronous `hf-seek` absolute-second rendering, `preserveDrawingBuffer:true`, fixed pixel ratio, and no self clock/animation loop/loaders/workers/blob URLs. Raw WebGPU/WGSL is a dependency-free manual/perceptual route on `gpu-angle`: `data-hf-requires="webgpu"` checks `navigator.gpu`, a synchronous pre-await `hf-seek` listener retains absolute time, async adapter/device/context/pipeline setup is assigned to `window.__hyperframes.__ready`, device loss and shader compilation fail fatally, and each frame ends in `device.queue.submit(...)`; TypeGPU remains out |
| `hyperframe-place <dir>` | Propose placing a rendered `materials/hyperframes/<name>.mp4` card (requires `hyperframe <dir> --name <name>` first) into the timeline as an `overlays.json` `overlay` (default; `--rect`/`--track` accepted) or `insert` (`--as insert`; no `rect`/`track`). Resolves the clip's duration deterministically — `--duration` flag, else `hyperframe.<name>.key.json`, else `ffprobe` — and writes an `apply`-ready patch draft (`hyperframe-place.suggested.json`) with a single `add` op. Warns (non-blocking) if `--at` falls outside a `cutplan.json` keep segment. Never writes editable files or touches `cutplan.json`/`approvals.json` |
| `hyperframe-check <dir>` | Render-free dynamic audit of a HyperFrames composition card: loads `hyperframes/<name>.html`'s srcdoc in a headless browser, seeks a time grid, and reads logical animation state (not pixels, and excluding zero-area/full-bleed helper elements) to detect terminal-unfinished single-pass animations (judged by last-frame completion progress, not duration metadata), empty-terminal frames, off-screen terminal content elements, seek-unresponsive wiring, dead zones, and simultaneous entries. Deterministic only, always exit 0, warn/info findings only (no fail). If `materials/hyperframes/<name>.mp4` has been rendered, extracts head/mid/tail plus each WARN finding's timestamp as PNG stills via ffmpeg (degrades to a `stillsNote` with no stills, never touching the deterministic findings, if the mp4 is missing or extraction fails), and optionally runs a judgment-only VLM secondary review (same pattern as `effect-check`, no coordinates generated) when a vision route is configured and not disabled by `--no-vlm`/config; `ok:false` items become `vlm-mismatch` warn findings. Writes `hyperframe.probe/<name>/index.json`; never writes editable files or touches `cutplan.json`/`approvals.json` |
| `hyperframe-freeze <dir>` | Turn an already check-passing `hyperframes/<name>.html` card into a reusable seed for next time: writes a disposable skeletonized draft (`hyperframe-freeze.suggested/<name>.{html,md}`) that resets only `string`-typed composition-variable defaults (to their label, or `"Text"` if the label is blank) while keeping colors/numbers/layout/motion verbatim, re-verifies the skeleton still passes `checkComposition` with zero errors, and collects read-only adoption evidence (an `overlays.json` reference to `materials/hyperframes/<name>.mp4`, whether that file has been rendered, and the `hyperframe.probe/<name>/index.json` warn-finding count, if present) into the draft's `.md` sidecar. A human reviews the draft, fills in the one-line usage gloss, and copies the pair into the channel's `hyperframe-seeds/` directory themselves — Cutflow never writes there. Once adopted, the seed appears as an additional numbered pattern (after the fixed `docs/hyperframes-skills/card-patterns.md` menu; failing seeds are skipped with a warning, numbering stays contiguous) in the next `hyperframe --from-brief` author menu. Never touches `cutplan.json`/`approvals.json` |
| `learn <dir>` | Draft channel-rule suggestions from the latest edit into `rules.suggested.md` |
| `ai` | Parent command for AI diagnostics (`ai doctor`) |
| `doctor` | Nested under `ai`; probes configured AI profiles/routes for text, structured output, and image connectivity |
| `ai doctor` | Validate AI profile config and probe text/structured/image connectivity without writing project artifacts |
| `doctor` | Environment preflight (read-only): probes node (>=23.6), ffmpeg, ffprobe, effective-encoder integrity, whisper binary/model, and AI route reachability (reuses `ai doctor`). Required-missing (node/ffmpeg/ffprobe) exits 1; recording/AI-related issues warn (exit 0). `--json` for machine-readable output; `--no-ai` skips network probes. Never touches editable files or `approvals.json` |
| `preview <dir>` | Render a lightweight cut-confirmation video (`preview.mp4`) |
| `validate <dir>` | Structural + invariant checks (run after every JSON edit) |
| `boundary-check <dir>` | Read-only acoustic inspection of every keep endpoint: deterministically decode `manifest.audio.micWav` to mono 8kHz signed PCM16LE, derive a recording-relative RMS threshold from non-overlapping 100ms windows (p5 + 12dB), and count speech-level audio in the following 120ms, including the subset actually discarded by an immediately following cut. Uses no transcript, words, or LLM and writes no report or recording artifact; `--json` emits a byte-deterministic report without paths or timestamps |
| `silence-sweep <dir>` | Read-only deterministic comparison of fixed `silenceDb` thresholds -35/-40/-45/-50 while holding `minSilenceSec`/`padSec`/`minKeepSec` fixed. Reports boundary-check tail-speech count, removed seconds, keep-candidate count, and agreement with every human-final keep start/end boundary, plus H2/H6-proxy verdicts. Decodes boundary PCM once, uses no transcript/words/LLM, and never writes `cuts.auto.json` or any recording artifact; `--json` has no paths or timestamps |
| `floor-calibration <fitDir>` | Fit a recording-relative `silencedetect-occupancy-v1` threshold: find the first 0.5dB grid threshold whose 100ms silencedetect occupancy reaches 5%, evaluate fixed floor offsets 0/3/6/9/12 against V0 tail safety and human-final boundary agreement, then apply the selected offset read-only to each repeated `--verify <dir>`. Threshold estimation stays on the silencedetect amplitude scale; PCM RMS is safety measurement only. Writes no recording/report artifact, uses no LLM, and `--json` contains no paths or timestamps |
| `boundary-direction <dir>` | Read-only comparison of current-config deterministic detect keeps against the hash-matching approved human-final cutplan. Classifies exact, expanded, narrowed, redundant, split-added-cut, touching-extension, added/deleted, joined, and ambiguous boundary structure without nearest-boundary matching; reports keep-set difference durations and H3 direction verdict. Refuses missing/stale approval, uses no transcript/words/LLM, writes no artifact, and `--json` contains no paths or timestamps |
| `compaction-sweep <dir>` | With an enabled operational-floor calibration, hold its effective silence threshold fixed and compare the 36-point Cartesian grid of `minSilenceSec`/`padSec`/`minKeepSec`. Reuses four silencedetect runs and one PCM decode, evaluates V0 tail safety plus V3 rescue/semantic direction, fills gentle/balanced/tight presets, and reports H7. Requires hash-matching approval, writes no artifact, uses no transcript/words/LLM, and deliberately does not implement a two-threshold runtime algorithm |
| `calibration-evaluate <dir>` | Read-only final evaluation of the fixed baseline, calibration-only, and gentle/balanced/tight candidates against every boundary occurrence in the hash-matching approved human-final cutplan. Uses a recording-relative operational floor plus the preselected 12dB offset, reports V0 tail safety, V3 rescue/semantic direction, exact boundary agreement, directional one-sided exact McNemar comparisons, H6, and the pre-registered balanced program verdict. Candidate order and primaries are fixed; it uses no transcript/words/LLM, writes no artifact, and `--json` contains no paths or timestamps |
| `assert <dir>` | Check declared editing intent (`assertions.json`) against the `describe --json` projection; `--visual` also evaluates OCR-based checks |
| `id-stamp <dir>` | Assign stable IDs to addressable elements that don't have one |
| `apply <dir>` | Checked atomic patch application (`@id` ops + whole-file replace) |
| `describe <dir>` | Human-readable timeline summary; `--json` for the full machine-readable projection |
| `frames <dir>` | Render still frames at given times with the final-composite look |
| `frames-serve <dir>` | Long-running frame server (opt-in) that `frames` auto-detects for faster iteration |
| `thumbnail <dir>` | Generate the thumbnail still image from `thumbnail.json` |
| `materials <dir>` | Probe materials (B-roll) for duration/resolution/audio and cross-link references (`materials.probe/index.json`) |
| `material-fit <dir>` | Detect material duration-fit issues (overrun/underrun) and dangling/unused references; write an `apply`-ready patch draft (`material-fit.suggested.json`); requires `materials <dir>` first and `@id`s on overlays/inserts |
| `effect-check <dir>` | Verify zoom/blur/annotation effects: deterministic zoom-interaction (E4) and density (E5) checks always run; deterministic caption/material overlap checks and optional VLM secondary review (E3) inspect composited stills reused from the `frames` path. Writes `effect-check.json` and, when there are deterministic corrections, an `apply`-ready patch draft (`effect-fix.suggested.json`). `--no-vlm` skips the VLM lane; it also auto-skips gracefully when no vision route is configured. Never writes editable files |
| `av <dir>` | Probe kept motion/sound feedback and write `av.probe/` reports |
| `bgm-fit <dir>` | Detect BGM speech-overlap/silence-float/loud/no-fade issues from `av.probe/sound.json` and propose `volumeDb`/`fadeOutSec` corrections as an `apply`-ready patch draft (`bgm-fit.suggested.json`); also detects a monotone single-track/root-`bgm.*` fallback when multiple chapters exist and points to `plan-bgm`. Requires `av <dir>` first; deterministic only (no LLM). Never writes editable files |
| `style-profile` | Extract a deterministic style profile (cut pace, caption density/position, loudness, structure, and — for `own-project` inputs with `plan.raw.txt` — an AI-proposal-vs-human-final correction delta) from one or more `--from <path>` inputs (a recording folder with `manifest.json`+`cutplan.json`, or a bare video file/folder), and write it to `style.probe/<name>.json` under the channel directory (the parent of the first `--from` path). Takes no `<dir>` positional argument. Never writes editable files |
| `style-check <dir>` | Measure how far the recording's current edit (candidate) deviates from a learned style profile's variance bands (cut pace via the profile's shot-length [p10,p90] band, caption coverage/density/position, loudness/silence), and report deviations as warn/info — always exit 0. Requires `style-profile --from <dir>` first; a two-tier band widened by each section's confidence keeps a cold-start (N=1) profile from over-warning. Scoped to cut/caption/audio (profile v1). Writes `style-check.json`; never writes editable files |
| `review <dir>` | Generate a deterministic before/after review bundle and write `review.probe/index.json` |
| `index` | Build the local cross-recording retrieval index |
| `search <query>` | Search recording/material metadata, OCR, and transcripts locally |
| `approve <dir>` | Approve the cutplan (or `--short <name>`) into `approvals.json` (interactive; requires `--yes` non-interactively) |
| `unapprove <dir>` | Revoke an approval record |
| `render <dir>` | Final render; requires a valid approval record (`--short <name>` / `--shorts` for short-form outputs) |
| `clean <dir>` | Delete a recording folder's generated intermediates/caches. Classification derives solely from `src/lib/files.ts` (`GENERATED_FILES` / `fileRole`): only top-level entries whose role is `generated` are removed. Never touches editable files, `approvals.json`, the human `materials/` folder, raw recordings, or products (`final.mp4`/`thumbnail.png`). `--dry-run` lists without deleting; `--cache-only` removes only heavy re-derivable caches (`proxy.mp4`/`cut*.mp4`/`render.chunks/`/`frames/`/`shorts/`/`*.probe/`) and keeps small/expensive-to-regenerate intermediates (`manifest.json`/`cuts.auto.json`/`whisper-out.*`); `--logs-only` removes only logs, disposable drafts, and inspection results (`*.raw.txt`/`plan.loop.json`/`cuts.auto.json`/`*-fit.suggested.json`/`effect-check.json`/`bgm-fit.json`/`style-check.json`/`preview.mp4`/`frames/`) and keeps re-render optimization caches (`cut*.mp4`/`render.*`), `proxy.*`, expensive perceptions (`whisper-out.*`/`transcript.system.json`/`*.probe/`), `manifest.json`, and products (`shorts/`) — mutually exclusive with `--cache-only`; `--json` emits the machine-readable plan (idempotent; always exit 0) |
| `editor <dir>` | Launch the GUI editor |
| `mcp <dir>` | Launch a Model Context Protocol server over stdio, bound to this one recording folder (§11) |
| `run <dir>` | First-time bulk pipeline: ingest → transcribe → detect → plan (§9: do not re-run casually) |

## 11. MCP tools

`node src/cli.ts mcp <dir>` starts a Model Context Protocol server on stdio
(newline-delimited JSON-RPC 2.0), bound at startup to the single recording
folder given as `<dir>`. Any MCP-capable host can attach to it and discover
the tools below via `tools/list`. There is no dependency on any particular
MCP client implementation — the transport is a minimal, self-contained
JSON-RPC 2.0 loop over stdin/stdout (`initialize` / `notifications/initialized`
/ `tools/list` / `tools/call` / `ping`), and stdout carries JSON-RPC only
(all logging goes to stderr).

### Trust model

**The server exposes only "read" (`describe` / `validate` / `frames` /
`materials` / `assert`) and "safe edits outside the approval scope"
(`apply` / `id-stamp`).** `approve`, `unapprove`, `render`, `plan`, `remeta`,
`plan-shorts`, `plan-materials`, `plan-effects`, `plan-bgm`, `run`, `ingest`, `transcribe`, `detect`, `preview`,
`thumbnail`, `editor`, and `frames-serve` are **never** exposed as tools —
there is no generic "run a CLI command" tool either, so there is no way to
reach them through this server. Approval is a human-only action; its actual
substance is the hash-bound record in `approvals.json` (§5). The MCP server
cannot mint that record, cannot flip `approved`, and cannot bypass the
render gate: `cutflow_apply` calls the same `applyEdits`/`planApply`
functions the `apply` CLI command uses, which refuse to touch
`approvals.json` and reject any operation that changes `approved` before
anything is written. The server also cannot leave its bound recording
folder — `<dir>` is fixed once at startup, and no tool takes a `dir`
argument.

### Exposed tools

| Tool | Kind | What it does |
|---|---|---|
| `cutflow_describe` | read | The full machine-readable projection of the current edit state (same payload as `describe <dir> --json`) |
| `cutflow_validate` | read | Structural + invariant checks (same as `validate <dir>`); `isError: true` when there are errors |
| `cutflow_frames` | read (perception) | Render still frames with the final-composite look (same as `frames <dir>`); exactly one of `t` / `captions` / `every` must be given |
| `cutflow_materials` | read | Probe materials (B-roll) and cross-link overlay/insert/bgm references (same as `materials <dir>`) |
| `cutflow_assert` | read (verification) | Check `assertions.json` against the current edit state (same as `assert <dir>`) |
| `cutflow_apply` | safe edit | Checked, atomic `@id`-op / whole-file-replace patch application (same as `apply <dir>`, including `--dry-run` via a `dryRun` argument); cannot change `approved` |
| `cutflow_id_stamp` | safe edit | Assign stable `@id`s to addressable elements that don't have one yet (same as `id-stamp <dir>`); idempotent, `approvals.json` untouched |

Domain-level failures (a `validate` error, an `apply` patch rejected by its
checks) are reported as a normal `tools/call` success result with
`isError: true` and structured JSON content, not as a JSON-RPC protocol
error — this lets a calling agent read the failure and self-correct.
Protocol-level problems (malformed JSON-RPC, an unknown method, an unknown
or malformed tool call) use standard JSON-RPC error codes instead.
