# AGENTS_CONTRACT.md — cutflow

Machine-readable contract for any coding agent (backend-agnostic) editing a
cutflow recording folder. This file is the source of truth for *what is
editable, what is off-limits, and how to write changes safely*. It does not
duplicate the Japanese operational prose in `CLAUDE.md` or `docs/usage.md`;
it distills the contract into enumerations and pointers, kept in sync with
the code by automated drift tests (`test/agentsMd.test.ts`,
`test/schema.test.ts`).

## 1. What cutflow is

cutflow is a local-first, video-as-code pipeline. One recording session is
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
| `cutplan.json` | `schemas/cutplan.schema.json` | Which spans of the raw recording survive (`segments[].action: "keep"/"cut"`), each with a human-readable `reason` |
| `transcript.json` | `schemas/transcript.schema.json` | Caption text, timing, per-caption position/style/track, and karaoke word timing |
| `overlays.json` | `schemas/overlays.schema.json` | All visual production: material overlays, inserts, camera wipe, zooms, blurs/mosaic, annotations (arrow/box/spotlight), caption track defaults, layer order, color filter |
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
  `plan.raw.txt`, `plan.loop.json`, `plan-shorts.raw.txt`, `render.props.json`,
  `whisper-out.json`, `whisper-out.srt`, `transcript.system.json`,
  `whisper-system-out.json`, `cut.mp4`, `cut.keeps.json`,
  `render.key.json`, `preview.mp4`, `proxy.mp4`, `proxy.key.json`
- Short-name-variable generated files: `cut.<name>.mp4`,
  `cut.<name>.keeps.json`, `render.<name>.props.json`,
  `render.<name>.key.json` (one set per `shorts.json` entry)
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
- `review.probe/` — a **replace-on-run** generated directory written by
  `review <dir>` (`index.json`, `before/`, `after/`, `ocr/`). It is wiped and
  rebuilt on each review run
- `backups/` (pre-overwrite snapshots) and `.editor-draft.json` (the GUI
  editor's autosaved unsaved draft)
- `rules.suggested.md` (a disposable draft written by `learn`; a human
  reads it and manually merges what they want into `rules.md`)

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
| `learn <dir>` | Draft channel-rule suggestions from the latest edit into `rules.suggested.md` |
| `ai` | Parent command for AI diagnostics (`ai doctor`) |
| `doctor` | Nested under `ai`; probes configured AI profiles/routes for text, structured output, and image connectivity |
| `ai doctor` | Validate AI profile config and probe text/structured/image connectivity without writing project artifacts |
| `preview <dir>` | Render a lightweight cut-confirmation video (`preview.mp4`) |
| `validate <dir>` | Structural + invariant checks (run after every JSON edit) |
| `assert <dir>` | Check declared editing intent (`assertions.json`) against the `describe --json` projection; `--visual` also evaluates OCR-based checks |
| `id-stamp <dir>` | Assign stable IDs to addressable elements that don't have one |
| `apply <dir>` | Checked atomic patch application (`@id` ops + whole-file replace) |
| `describe <dir>` | Human-readable timeline summary; `--json` for the full machine-readable projection |
| `frames <dir>` | Render still frames at given times with the final-composite look |
| `frames-serve <dir>` | Long-running frame server (opt-in) that `frames` auto-detects for faster iteration |
| `thumbnail <dir>` | Generate the thumbnail still image from `thumbnail.json` |
| `materials <dir>` | Probe materials (B-roll) for duration/resolution/audio and cross-link references (`materials.probe/index.json`) |
| `av <dir>` | Probe kept motion/sound feedback and write `av.probe/` reports |
| `review <dir>` | Generate a deterministic before/after review bundle and write `review.probe/index.json` |
| `index` | Build the local cross-recording retrieval index |
| `search <query>` | Search recording/material metadata, OCR, and transcripts locally |
| `approve <dir>` | Approve the cutplan (or `--short <name>`) into `approvals.json` (interactive; requires `--yes` non-interactively) |
| `unapprove <dir>` | Revoke an approval record |
| `render <dir>` | Final render; requires a valid approval record (`--short <name>` / `--shorts` for short-form outputs) |
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
`plan-shorts`, `run`, `ingest`, `transcribe`, `detect`, `preview`,
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
