# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the CLI and pipeline stages, with shared logic in `src/lib/` and MCP code in `src/mcp/`. `editor/` holds the browser-based editor, and `remotion/` holds the render composition. Tests live in `test/`, fixtures in `test/fixtures/`, schemas in `schemas/`, and user-facing docs in `docs/`. Runtime edits happen in a recording folder, not in source code.

## Build, Test, and Development Commands

- `npm test` or `node --test`: runs the Node test suite.
- `npm run typecheck`: runs `tsc --noEmit` for strict TypeScript checking.
- `node src/cli.ts validate <dir>`: validates a recording folder after JSON edits.
- `node src/cli.ts describe <dir> --json`: prints the current project state as machine-readable JSON.
- `node src/cli.ts frames <dir> --t 90,2:30.5`: renders still frames for visual checks.
- `node src/cli.ts render <dir>`: produces the final output after approval.

## Coding Style & Naming Conventions

Use TypeScript ESM (`NodeNext`) with `strict` mode and `react-jsx`. Keep changes small and follow existing repository style: ASCII by default, descriptive names, and schema-backed JSON files. There is no repo-wide formatter or linter configured, so match nearby code and keep diffs minimal.

## Testing Guidelines

The project uses Node’s built-in test runner. Add or update tests under `test/` with names like `feature.test.ts`. Prefer tests that cover CLI behavior, schema validation, and pipeline invariants. When changing JSON workflows, run the relevant command plus `validate` before handing off.

## Commit & Pull Request Guidelines

Git history favors short, scoped messages such as `docs: ...`, `feat(mcp): ...`, and `fix(review): ...`. Keep commits focused. PRs should include a concise summary, the commands you ran, and screenshots or frame captures when UI or render behavior changes.

## Agent-Specific Instructions

Do not edit generated artifacts such as `manifest.json`, `preview.mp4`, `frames/`, or `render.chunks/`. For editing recording data, modify the JSON in the recording folder and re-run `validate`. If you need the authoritative rules for editable files and approval boundaries, read `AGENTS_CONTRACT.md` first.
