import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("Tailwind source excludes Preflight and isolates OpenCut tokens from legacy names", () => {
  const css = read("editor/client/styles.css");
  assert.match(css, /tailwindcss\/theme\.css/);
  assert.match(css, /tailwindcss\/utilities\.css/);
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']/);
  assert.doesNotMatch(css, /tailwindcss\/preflight\.css/);
  assert.doesNotMatch(css, /^\s*--(?:accent|border):/m);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.dark\s*\{/);
  assert.match(css, /\.panel\s*\{/);
  assert.match(css, /\.dark \.panel\s*\{/);
  assert.match(css, /--oc-text-xs:\s*0\.72rem/);
  assert.match(css, /--oc-radius:/);
});

test("the first design-system component is a native CVA Button using cn", () => {
  const button = read("editor/client/components/ui/button.tsx");
  const utils = read("editor/client/lib/utils.ts");
  assert.match(button, /cva\(/);
  assert.match(button, /VariantProps/);
  assert.match(button, /forwardRef<HTMLButtonElement, ButtonProps>/);
  assert.match(button, /ref=\{ref\}/);
  assert.match(button, /Button\.displayName = "Button"/);
  assert.match(button, /<button/);
  assert.match(button, /cn\(buttonVariants/);
  assert.doesNotMatch(button, /Radix|Slot|asChild|ButtonPrimitive/);
  assert.match(utils, /twMerge\(clsx\(inputs\)\)/);
});

test("the header AI launcher keeps its behavior props during the P2 header migration", () => {
  const app = read("editor/client/App.tsx");
  assert.match(app, /<Button\s+variant="secondary"\s+size="sm"\s+className="aiCommandLauncher"\s+disabled=\{aiWorkflowLocked\}/);
  assert.match(app, /title=\{aiWorkflowLocked \? aiWorkflowTitle : anyDirty \? "保存してから AI 一発編集" : "AI 一発編集を開く"\}/);
  assert.match(app, /setAiCommandScope\("global"\);\s+setAiCommandOpen\(true\);/);
  assert.match(app, /\{aiWorkflowLocked \? "編集中" : "AI編集"\}/);
});

test("generated CSS loads after legacy inline CSS under the dark class", () => {
  const html = read("editor/client/index.html");
  assert.match(html, /<html lang="ja" class="dark">/);
  assert.ok(html.indexOf("</style>") < html.indexOf('href="/styles.css"'));
});

test("server integrates the recursive client watcher without reusing the JSON watcher", () => {
  const server = read("editor/server.ts");
  const listenAt = server.indexOf('server.listen(port, "127.0.0.1", ok)');
  const clientWatchAt = server.indexOf('clientWatcher = watch(join(editorDir, "client"), { recursive: true }');
  assert.ok(listenAt >= 0 && clientWatchAt > listenAt);
  assert.match(server, /clientReloader\.schedule\(\)/);
  assert.match(server, /catch \(error\) \{\s+clientReloader\.close\(\);\s+await new Promise<void>\(\(resolveClose\) => server\.close/);
  assert.match(server, /clientWatcher\?\.close\(\)/);
  assert.match(server, /watch\(dir, \(_event, filename\) =>/);
});

test("OpenCut provenance pins exact sources, adaptation, and the MIT notice", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  assert.match(provenance, /5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/);
  const revisionUrl = "https://github.com/OpenCut-app/OpenCut/blob/5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e/";
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/styles.css`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/components/ui/button.tsx`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/lib/utils.ts`));
  assert.ok(provenance.includes(`${revisionUrl}LICENSE`));
  assert.match(provenance, /## Adaptation in CutFlow/);
  assert.match(provenance, /Copyright 2026 OpenCut/);
  assert.match(provenance, /Permission is hereby granted/);
  assert.doesNotMatch(provenance, /verbatim/i);
});

test("Tailwind core and CLI are locked to the same exact version", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies.tailwindcss, pkg.dependencies["@tailwindcss/cli"]);
  assert.match(pkg.dependencies.tailwindcss, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies.tailwindcss, undefined);
  assert.equal(pkg.devDependencies["@tailwindcss/cli"], undefined);
});
