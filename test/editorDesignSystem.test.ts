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
  const classAt = app.indexOf('className="aiCommandLauncher"');
  const launcher = app.slice(app.lastIndexOf("<Button", classAt), app.indexOf("onClick=", classAt));
  assert.match(launcher, /variant="secondary"/);
  assert.match(launcher, /size="sm"/);
  assert.match(launcher, /className="aiCommandLauncher"/);
  assert.match(launcher, /ref=\{aiCommandLauncherRef\}/);
  assert.match(launcher, /disabled=\{aiWorkflowLocked\}/);
  assert.match(app, /title=\{aiWorkflowLocked \? aiWorkflowTitle : anyDirty \? "保存してから AI 一発編集" : "AI 一発編集を開く"\}/);
  assert.match(app, /setAiCommandScope\("global"\);\s+setAiCommandOpen\(true\);/);
  assert.match(app, /\{aiWorkflowLocked \? "編集中" : "AI編集"\}/);
});

test("editor HTML bootstraps the resolved theme before one generated stylesheet", () => {
  const html = read("editor/client/index.html");
  assert.match(html, /<html lang="ja">/);
  assert.doesNotMatch(html, /<html[^>]+class="dark"/);
  assert.match(html, /<meta name="color-scheme" content="light dark"/);
  assert.ok(html.indexOf("data-cutflow-theme-bootstrap") < html.indexOf('href="/styles.css"'));
  assert.equal((html.match(/<link rel="stylesheet" href="\/styles\.css" \/>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<style\b|<link[^>]+stylesheet[^>]+href=(?!"\/styles\.css")/);
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
  assert.match(provenance, /cf5e79e919144200294fb9fed22a222592a0aeea/);
  const revisionUrl =
    "https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/";
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/app/globals.css`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/components/ui/button.tsx`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/lib/utils.ts`));
  assert.ok(provenance.includes(`${revisionUrl}LICENSE`));
  assert.match(provenance, /## Adaptation in CutFlow/);
  assert.match(provenance, /Copyright 2025-2026 OpenCut/);
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

/** `@layer <name> { … }` のブロック本体を(入れ子の括弧を数えて)全部抜き出す */
function layerBodies(css: string, name: string): string[] {
  const bodies: string[] = [];
  const head = new RegExp(`@layer\\s+${name}\\s*\\{`, "g");
  for (let m = head.exec(css); m; m = head.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    bodies.push(css.slice(from, i - 1));
  }
  return bodies;
}

test("Button variant を上書きする !important は ocOverrides レイヤーの中だけに置く", () => {
  const css = read("editor/client/styles.css");
  // レイヤー宣言順が要。!important 同士はレイヤー順が逆転する(CSS Cascade 5)ので、
  // utilities より前に宣言したレイヤーだけが Tailwind の `!` ユーティリティに勝てる
  const order = /^@layer\s+([^;]+);/m.exec(css)?.[1] ?? "";
  const names = order.split(",").map((s) => s.trim());
  assert.ok(names.indexOf("ocOverrides") >= 0, "ocOverrides レイヤーが宣言されていない");
  assert.ok(
    names.indexOf("ocOverrides") < names.indexOf("utilities"),
    "ocOverrides は utilities より前に宣言する(!important の優先度が逆順のため)",
  );

  const bodies = layerBodies(css, "ocOverrides");
  assert.ok(bodies.length > 0);
  // 状態表示(ループ ON など)の色は必ずレイヤーの中。無レイヤーだと Tailwind の
  // `text-foreground!` / `bg-transparent!` に負けて押しても見た目が変わらない
  const inLayer = bodies.join("\n");
  assert.match(inLayer, /\.ocTransport button\.icon\.active\s*\{/);
  assert.match(inLayer, /\.ocHeader \.settingsBtn\.active/);
  assert.match(inLayer, /\.ocSidePanel \.ocIconRail \[role="tab"\]\.active/);
  assert.match(inLayer, /\.ocInspector \.inspTabBtn\.inspTabBtnIdle/);

  // レイヤー外に色系の !important が残っていないこと(残っていれば黙って無効になる)
  let outside = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const body of bodies) outside = outside.replace(body.replace(/\/\*[\s\S]*?\*\//g, ""), "");
  const stray = outside
    .split("\n")
    .filter((line) => /!important/.test(line) && /(^|[\s;{])(color|background|background-color|border|border-color)\s*:/.test(line));
  assert.deepEqual(stray, []);
});
