import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const EXAMPLES_DIR = join(repoRoot, "docs/hyperframes-skills/examples");

const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".html"));

test("docs/hyperframes-skills/examples: has >=1 converted card", () => {
  assert.ok(files.length > 0, `no example cards in ${EXAMPLES_DIR}`);
});

for (const file of files) {
  test(`docs/hyperframes-skills/examples/${file} passes checkComposition (0 errors, 0 warnings)`, () => {
    const html = readFileSync(join(EXAMPLES_DIR, file), "utf8");
    const { errors, warnings } = checkComposition(html, {
      file: `docs/hyperframes-skills/examples/${file}`,
    });
    assert.equal(errors.length, 0, JSON.stringify(errors, null, 2));
    assert.equal(warnings.length, 0, JSON.stringify(warnings, null, 2));
  });
}
