import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const FILES = [
  "prompts/hyperframe.md",
  "docs/hyperframes-skills/card-patterns.md",
  "docs/hyperframes-skills/motion-css-waapi.md",
  "docs/hyperframes-skills/authoring-contract.md",
];

function compositionBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```html\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (/data-composition-id/.test(m[1])) out.push(m[1]);
  }
  return out;
}

for (const rel of FILES) {
  const md = readFileSync(join(repoRoot, rel), "utf8");
  const blocks = compositionBlocks(md);
  test(`${rel}: has >=1 composition example`, () => {
    assert.ok(blocks.length > 0, `no composition examples in ${rel}`);
  });
  blocks.forEach((html, i) => {
    test(`${rel} composition[${i}] passes checkComposition (0 errors)`, () => {
      const { errors } = checkComposition(html, { file: `${rel}#${i}` });
      assert.equal(errors.length, 0, JSON.stringify(errors, null, 2));
    });
  });
}
