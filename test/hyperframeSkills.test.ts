import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const authoringContract = readFileSync(
  join(repoRoot, "docs/hyperframes-skills/authoring-contract.md"),
  "utf8",
);
const hyperframePrompt = readFileSync(join(repoRoot, "prompts/hyperframe.md"), "utf8");
const cardPatterns = readFileSync(join(repoRoot, "docs/hyperframes-skills/card-patterns.md"), "utf8");

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

test("authoring contract fixes the backend selection norms and complete capability map", () => {
  assert.match(authoringContract, /## backend 選択の規範/);
  assert.match(
    authoringContract,
    /CSS\/SVG\/DOM < WAAPI < Anime\.js < Canvas 2D < GSAP core \/ Lottie\(既存素材あり\)[\s\S]*< Raw WebGL\/shader < Three\.js/,
  );
  for (const capability of [
    "fade / translate / scale / rotate / clip / simple stagger",
    "text layout / diagram / UI mock / vector shape",
    "軽量な直列・並列 timeline、複数micro-animation",
    "複雑な直列・並列 timeline、label、反復可能な choreography",
    "AE/bodymovin 素材の再生",
    "2D procedural drawing / 大量の同種プリミティブ",
    "per-pixel shader / GPU particle / procedural texture",
    "真の3D geometry / perspective camera / lighting / depth occlusion",
    "data-driven SVG chart",
    "地図",
  ]) {
    assert.ok(authoringContract.includes(capability), `missing capability row: ${capability}`);
  }
  assert.match(authoringContract, /Raw WebGL\/shader と Three\.js は `gpu-angle` profile で `usable`/);
  assert.match(authoringContract, /Three\.js\(manual\)/);
  assert.match(authoringContract, /実測669884 bytes[\s\S]*THREE\.REVISION === \"160\"/);
  assert.match(authoringContract, /three\.core\.min\.js[\s\S]*SRI非推奨/);
  assert.match(authoringContract, /layoutsubtree[\s\S]*drawElementImage[\s\S]*gl:\"angle\"/);
  assert.match(authoringContract, /### card の過剰設計/);
  assert.match(authoringContract, /### tooling の過剰設計/);
  assert.match(authoringContract, /外部 animation runtime と時間の正本を1つ/);
  assert.match(authoringContract, /DOM\/SVG\/CSS は別 runtime と数えず/);
});

test("hyperframe prompt selects the lightest capable single runtime without adding examples", () => {
  assert.match(hyperframePrompt, /backend 名ではなく必要な表現能力から選び/);
  assert.match(hyperframePrompt, /CSS\/SVG\/DOM\/WAAPI で完結する\s+ならそこで終え/);
  assert.match(hyperframePrompt, /brief の明示、または軽い候補で\s+満たせない固有能力/);
  assert.match(hyperframePrompt, /外部 animation runtime と時間の\s+正本は card ごとに1つ/);
  assert.match(hyperframePrompt, /Lottie は有効な JSON 素材が入力として\s+提供済み/);
  assert.match(hyperframePrompt, /card HTML 冒頭のコメントに1行/);
  assert.doesNotMatch(hyperframePrompt, /brief が明示的に GSAP を必要としていない限り/);
  assert.doesNotMatch(hyperframePrompt, /Three\.js|Anime\.js/);
  assert.doesNotMatch(cardPatterns, /Three\.js|Anime\.js/);
  assert.equal(compositionBlocks(hyperframePrompt).length, 1);
});

test("vendored Three.js adapter is the exact reviewed upstream artifact", () => {
  const adapter = readFileSync(
    join(repoRoot, "remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/adapters/three.md"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(adapter).digest("hex"),
    "9448a3eb9ec3141d2dadcc2bb338cc7cf9abc995b8d869244822c7e0557acbc2",
  );
});
