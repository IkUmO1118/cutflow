// docs/edit-skills/(cut-recipes。P1 の成果物)と src/lib/reasonIds.ts(P2 の単一の
// 出所)の間のドリフト検知テスト。§docs/plans/2026-07-20-cut-knowledge-p1-p2-design.md
// §7(機械検査 K5)の P2 分。test/schema.test.ts と同じ「読むだけの consumer」方針
// (production コードは変更しない)。
//
// T-a: 全単射(CUT_REASON_IDS ⇔ recipes/*.md のファイル名)
// T-c: 必須節(各 recipe が固定見出しを全て・この順で持つ)
// T-d: フェンス規約(反例節に ```json フェンスが無い)
// T-e: 正例の閉包(recipe 中の全 ```json フェンスが {id, reasonId, reason} で
//      reasonId が CUT_REASON_IDS に閉じる)
// T-f: 相互リンクの閉包(「紛らわしい隣」節に現れる id が全て CUT_REASON_IDS に
//      閉じる。加えて13分類全てが少なくとも1回参照される=孤立ノードが無い)
// T-k: examples の内部整合(P5-3。hermetic・実収録に依存しない): 判断 JSON の
//      id/reasonId が見出し `### #<id> <reasonId>` と一致し、`## ` セクション
//      内で元秒(text フェンス先頭の [start-...])が単調増加、id は文書全体で
//      重複しない
// T-l: examples の語彙閉包 + カバレッジ表の全単射(hermetic): 全判断 JSON の
//      reasonId が CUT_REASON_IDS に閉じ、「分類カバレッジ」節の表に挙がる
//      id 集合と完全一致する
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CUT_REASON_IDS, REASON_ID_LABEL } from "../src/lib/reasonIds.ts";
import { CUT_PATTERN_IDS, CUT_PATTERN_INJECTION, BLUEPRINT_BLOCKS } from "../src/lib/cutPatterns.ts";

const EDIT_SKILLS_DIR = join(import.meta.dirname, "..", "docs", "edit-skills");
const RECIPES_DIR = join(EDIT_SKILLS_DIR, "recipes");
const EXAMPLES_DIR = join(EDIT_SKILLS_DIR, "examples");

function recipeFileNames(): string[] {
  return readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".md"));
}

function recipeSource(id: string): string {
  return readFileSync(join(RECIPES_DIR, `${id}.md`), "utf8");
}

/* ------------------------------------------------------------------ */
/* T-a: 全単射                                                         */
/* ------------------------------------------------------------------ */

test("T-a: 全単射: CUT_REASON_IDS ⇔ docs/edit-skills/recipes/*.md のファイル名", () => {
  const files = recipeFileNames()
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const ids = [...CUT_REASON_IDS].sort();
  assert.deepEqual(files, ids);
  assert.equal(CUT_REASON_IDS.length, 13, "13分類であること");
});

/* ------------------------------------------------------------------ */
/* T-b(P6): 接地行の語彙閉包                                            */
/* ------------------------------------------------------------------ */

/** front-matter の `> 接地: …` 行の許可語彙(README「craft knowledge の
 * 扱い(P6)」の5種。P6 設計書 §4.1)。トークンは ` + ` または ` · ` で連結。 */
const GROUND_TOKEN_RE = /^(実データ\(.+\)|rules\.md(\(.+\))?|想定(\(.+\))?|craft|観測: .+)$/;

function groundingLine(src: string): string {
  const m = src.match(/^> 接地: (.+)$/m);
  assert.ok(m, "接地行(`> 接地: …`)が見つかりません");
  return m![1];
}

test("T-b: 接地行の語彙閉包: 全 recipe の `> 接地:` 行が許可語彙(実データ(…)/rules.md/想定/craft/観測: …)のみで構成される", () => {
  for (const id of CUT_REASON_IDS) {
    const line = groundingLine(recipeSource(id));
    const tokens = line
      .split(/\s*[+·]\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
    assert.ok(tokens.length > 0, `${id}.md: 接地行が空です`);
    for (const t of tokens) {
      assert.match(
        t,
        GROUND_TOKEN_RE,
        `${id}.md: 接地行のトークン "${t}" が許可語彙(実データ(…)/rules.md/想定/craft/観測: …)に含まれません`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* T-c: 必須節                                                         */
/* ------------------------------------------------------------------ */

/** recipe 1本が(このid順で)必ず持つ固定見出し。
 * docs/edit-skills/README.md「recipe 1本の型(固定節構成)」の正確な文字列 */
const REQUIRED_HEADINGS = [
  "## 一行定義",
  "## 判定シグナル",
  "### 語彙(transcript)",
  "### 時間・格子(候補の形)",
  "### 音(plan.perception.audio)",
  "### 画面(plan.perception.ocr / frames)",
  "## 既定の処置",
  "## 反例(この分類を当てない場合)",
  "## 紛らわしい隣",
  "## worked example",
];

test("T-c: 必須節: 各 recipe が固定見出しを全て、この順で持つ", () => {
  for (const id of CUT_REASON_IDS) {
    const src = recipeSource(id);
    assert.ok(src.startsWith(`# ${id}\n`), `${id}.md の先頭が "# ${id}" ではありません`);
    let cursor = -1;
    for (const heading of REQUIRED_HEADINGS) {
      const idx = src.indexOf(`\n${heading}\n`, cursor);
      assert.ok(idx > cursor, `${id}.md に見出し "${heading}" が(この順で)見つかりません`);
      cursor = idx + 1;
    }
  }
});

/* ------------------------------------------------------------------ */
/* フェンス抽出ヘルパ(T-d/T-e 共用)                                     */
/* ------------------------------------------------------------------ */

/** "## 反例(この分類を当てない場合)" の見出しから次の "## " 見出しまでを
 * 反例ブロックとして切り出す(README のフェンス規約と同じ切り出し方) */
function counterExampleBlock(src: string): string {
  const start = src.indexOf("## 反例(この分類を当てない場合)");
  assert.ok(start >= 0, "反例節の見出しが見つかりません");
  const rest = src.slice(start + "## 反例(この分類を当てない場合)".length);
  const nextIdx = rest.indexOf("\n## ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

/** 文中の全 ```json ... ``` フェンスの中身(パース前の生文字列)を返す */
function jsonFences(src: string): string[] {
  return [...src.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------------ */
/* T-d: フェンス規約                                                    */
/* ------------------------------------------------------------------ */

test("T-d: フェンス規約: 反例節に ```json フェンスが無い", () => {
  for (const id of CUT_REASON_IDS) {
    const block = counterExampleBlock(recipeSource(id));
    assert.equal(jsonFences(block).length, 0, `${id}.md の反例節に \`\`\`json フェンスがあります`);
  }
});

/* ------------------------------------------------------------------ */
/* T-e: 正例の閉包                                                      */
/* ------------------------------------------------------------------ */

test("T-e: 正例の閉包: recipe 中の全 ```json フェンスが {id, reasonId, reason} で reasonId が CUT_REASON_IDS に閉じる", () => {
  for (const id of CUT_REASON_IDS) {
    const src = recipeSource(id);
    const fences = jsonFences(src);
    assert.ok(fences.length > 0, `${id}.md に worked example の \`\`\`json フェンスがありません`);
    for (const raw of fences) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        assert.fail(`${id}.md の \`\`\`json フェンスがパースできません: ${(e as Error).message}\n${raw}`);
      }
      assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${id}.md: 判断 JSON はオブジェクトです`);
      const obj = parsed as Record<string, unknown>;
      assert.deepEqual(Object.keys(obj).sort(), ["id", "reason", "reasonId"], `${id}.md: 判断 JSON のキーは {id, reasonId, reason} に限られます`);
      assert.ok(
        (CUT_REASON_IDS as readonly string[]).includes(obj.reasonId as string),
        `${id}.md: 判断 JSON の reasonId "${obj.reasonId}" が CUT_REASON_IDS にありません`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* T-f: 相互リンクの閉包                                                 */
/* ------------------------------------------------------------------ */

/** "## 紛らわしい隣" の見出しから次の "## " 見出しまでを切り出す */
function relatedBlock(src: string): string {
  const start = src.indexOf("## 紛らわしい隣");
  assert.ok(start >= 0, "紛らわしい隣節の見出しが見つかりません");
  const rest = src.slice(start + "## 紛らわしい隣".length);
  const nextIdx = rest.indexOf("\n## ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

/** バッククォートで囲まれた、分類 id の文法(^[a-z][a-z0-9-]*$)に一致する
 * トークンだけを拾う(rules.md 等のドット入り語は id 文法に一致しないため
 * 自然に除外される) */
function backtickedIdLikeTokens(block: string): string[] {
  return [...block.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
}

test("T-f: 相互リンクの閉包: 「紛らわしい隣」節に現れる id が全て CUT_REASON_IDS に閉じる", () => {
  const referenced = new Set<string>();
  for (const id of CUT_REASON_IDS) {
    const block = relatedBlock(recipeSource(id));
    const tokens = backtickedIdLikeTokens(block);
    assert.ok(tokens.length > 0, `${id}.md の「紛らわしい隣」節に id 参照がありません`);
    for (const t of tokens) {
      assert.ok(
        (CUT_REASON_IDS as readonly string[]).includes(t),
        `${id}.md の「紛らわしい隣」節が未知の id "${t}" を参照しています(統廃合の書き残しの可能性)`,
      );
      referenced.add(t);
    }
  }
  for (const id of CUT_REASON_IDS) {
    assert.ok(referenced.has(id), `${id} がどの recipe の「紛らわしい隣」からも参照されていません(孤立ノード)`);
  }
});

/* ------------------------------------------------------------------ */
/* T-g(P6-T6): REASON_ID_LABEL ⇔ README 13分類表の一行定義の完全一致       */
/* ------------------------------------------------------------------ */

/** README.md の「### 系: …」表から `id → 一行定義` を抽出する
 * (`| [\`id\`](recipes/id.md) | 一行定義 | 接地 |` 形式の行だけを拾う)。 */
function readmeLabelTable(): Map<string, string> {
  const src = readFileSync(join(EDIT_SKILLS_DIR, "README.md"), "utf8");
  const map = new Map<string, string>();
  for (const m of src.matchAll(/^\| \[`([a-z][a-z0-9-]*)`\]\(recipes\/[a-z0-9-]+\.md\) \| (.+?) \| [^|]+ \|$/gm)) {
    map.set(m[1], m[2]);
  }
  return map;
}

test("T-g: REASON_ID_LABEL ⇔ README 13分類表の一行定義が完全一致する", () => {
  const table = readmeLabelTable();
  assert.deepEqual([...table.keys()].sort(), [...CUT_REASON_IDS].sort(), "README 13分類表の id 集合が CUT_REASON_IDS と一致しません");
  for (const id of CUT_REASON_IDS) {
    assert.equal(
      table.get(id),
      REASON_ID_LABEL[id],
      `${id}: REASON_ID_LABEL とREADME 13分類表の一行定義が一致しません`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* T-m(pattern 部分。P3-5): CUT_PATTERN_INJECTION の recipes 閉包・        */
/* general = 13分類全部。§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md §6 */
/* ------------------------------------------------------------------ */

test("T-m(pattern): CUT_PATTERN_INJECTION の全 recipes が CUT_REASON_IDS に閉じる", () => {
  for (const patternId of CUT_PATTERN_IDS) {
    for (const recipeId of CUT_PATTERN_INJECTION[patternId].recipes) {
      assert.ok(
        (CUT_REASON_IDS as readonly string[]).includes(recipeId),
        `pattern "${patternId}" の recipes に未知の id "${recipeId}" があります`,
      );
    }
  }
});

test("T-m(pattern): general.recipes は13分類全部(P2 とバイト等価にする制約)", () => {
  assert.deepEqual([...CUT_PATTERN_INJECTION.general.recipes], [...CUT_REASON_IDS]);
});

test("T-m(pattern): tool-demo.recipes は tangent/failure-and-fix を含まない11分類", () => {
  const recipes = CUT_PATTERN_INJECTION["tool-demo"].recipes;
  assert.equal(recipes.length, 11);
  assert.ok(!recipes.includes("tangent"));
  assert.ok(!recipes.includes("failure-and-fix"));
  assert.ok(recipes.includes("demo-wait"));
  assert.ok(recipes.includes("dead-air"));
});

test("T-m(pattern): docs/edit-skills/patterns.md の見出しが CUT_PATTERN_IDS と全単射", () => {
  const src = readFileSync(join(EDIT_SKILLS_DIR, "patterns.md"), "utf8");
  for (const id of CUT_PATTERN_IDS) {
    assert.match(src, new RegExp(`^## \`${id}\`$`, "m"), `patterns.md に見出し "## \`${id}\`" がありません`);
  }
  // 見出しに現れる `<id>` トークンのうち CUT_PATTERN_IDS に無いものが無いこと
  // (統廃合の書き残し検知。generic な id 文法のトークンだけを拾う)
  const headingIds = [...src.matchAll(/^## `([a-z][a-z0-9-]*)`$/gm)].map((m) => m[1]);
  for (const id of headingIds) {
    assert.ok(
      (CUT_PATTERN_IDS as readonly string[]).includes(id),
      `patterns.md の見出し "## \`${id}\`" が CUT_PATTERN_IDS に無い(統廃合の書き残しの可能性)`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* T-m(blueprint 部分。P4-2): CUT_PATTERN_INJECTION の非空 blueprint が    */
/* blueprints.md の `` ## `<id>` `` 見出しと全単射                        */
/* ------------------------------------------------------------------ */

test("T-m(blueprint): 全 blueprint(空文字を除く)が docs/edit-skills/blueprints.md の見出しと全単射", () => {
  const src = readFileSync(join(EDIT_SKILLS_DIR, "blueprints.md"), "utf8");
  const headingIds = [...src.matchAll(/^## `([a-z][a-z0-9-]*)`$/gm)].map((m) => m[1]).sort();
  const referenced = [...new Set(CUT_PATTERN_IDS.map((p) => CUT_PATTERN_INJECTION[p].blueprint).filter((b) => b !== ""))].sort();
  assert.deepEqual(headingIds, referenced);
});

test("T-m(blueprint): BLUEPRINT_BLOCKS の key が参照される全 blueprint id を持ち、各ブロックが8行以内", () => {
  for (const patternId of CUT_PATTERN_IDS) {
    const blueprint = CUT_PATTERN_INJECTION[patternId].blueprint;
    if (blueprint === "") continue;
    const block = BLUEPRINT_BLOCKS[blueprint];
    assert.ok(block, `BLUEPRINT_BLOCKS に "${blueprint}" がありません`);
    assert.ok(block.length <= 8, `BLUEPRINT_BLOCKS["${blueprint}"] は8行以内(実際 ${block.length}行)`);
    for (const line of block) {
      assert.doesNotMatch(line, /\d+秒/, `blueprint "${blueprint}" は尺の秒数を書かない規約に反します: "${line}"`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* T-k / T-l(P5-3): docs/edit-skills/examples/*.md の内部整合・語彙閉包    */
/* ------------------------------------------------------------------ */

function exampleFileNames(): string[] {
  return existsSync(EXAMPLES_DIR) ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".md")) : [];
}

function exampleSource(name: string): string {
  return readFileSync(join(EXAMPLES_DIR, name), "utf8");
}

interface ExampleEntry {
  id: number;
  headingReasonId: string;
  /** この entry が属する `## ` セクションの見出し文字列 */
  section: string;
  /** text フェンス内で最初に現れる [start-...] の start(秒)。無ければ null */
  start: number | null;
  json: Record<string, unknown>;
}

/** ファイル1本を `## `(セクション)→ `### #<id> ...`(entry)の階層でパースする。
 * entry は直後の最初の ```text フェンスと最初の ```json フェンスを持つ前提
 * (docs/edit-skills/examples/*.md の固定節構成・§4.2 のフォーマット)。 */
function parseExamples(src: string): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  let currentSection = "(不明)";
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^## (.+)$/);
    if (h2) {
      currentSection = h2[1];
      continue;
    }
    const h3 = lines[i].match(/^### #(\d+) ([a-z][a-z0-9-]*)/);
    if (!h3) continue;
    const id = Number(h3[1]);
    const headingReasonId = h3[2];
    const rest = lines.slice(i + 1).join("\n");
    const textFence = rest.match(/```text\n([\s\S]*?)```/);
    const jsonFence = rest.match(/```json\n([\s\S]*?)```/);
    assert.ok(textFence, `#${id} に \`\`\`text フェンスがありません`);
    assert.ok(jsonFence, `#${id} に \`\`\`json フェンスがありません`);
    const startMatch = textFence![1].match(/\[(\d+(?:\.\d+)?)-/);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(jsonFence![1]);
    } catch (e) {
      throw new Error(`#${id} の json フェンスがパースできません: ${(e as Error).message}`);
    }
    entries.push({
      id,
      headingReasonId,
      section: currentSection,
      start: startMatch ? Number(startMatch[1]) : null,
      json,
    });
  }
  return entries;
}

test("T-k: examples の内部整合(id/reasonId が見出しと判断JSONで一致・id重複なし・セクション内で元秒が単調増加)", () => {
  for (const file of exampleFileNames()) {
    const entries = parseExamples(exampleSource(file));
    assert.ok(entries.length > 0, `${file} に判断エントリがありません`);

    const seenIds = new Set<number>();
    for (const e of entries) {
      assert.equal(e.json.id, e.id, `${file} #${e.id}: json.id が見出しの id と不一致`);
      assert.equal(
        e.json.reasonId,
        e.headingReasonId,
        `${file} #${e.id}: json.reasonId が見出しの reasonId と不一致`,
      );
      assert.ok(!seenIds.has(e.id), `${file}: id ${e.id} が2回以上現れています`);
      seenIds.add(e.id);
    }

    const bySection = new Map<string, ExampleEntry[]>();
    for (const e of entries) {
      const arr = bySection.get(e.section) ?? [];
      arr.push(e);
      bySection.set(e.section, arr);
    }
    for (const [section, es] of bySection) {
      let prev = -Infinity;
      for (const e of es) {
        assert.ok(e.start !== null, `${file} #${e.id}(セクション "${section}"): text フェンスに元秒 [start-...] がありません`);
        assert.ok(
          e.start! >= prev,
          `${file} #${e.id}(セクション "${section}"): 元秒が単調増加ではありません(${e.start} < ${prev})`,
        );
        prev = e.start!;
      }
    }
  }
});

/** "## 分類カバレッジ" 節のテーブルの1列目(`` `<id>` ``)を抽出する */
function coverageTableIds(src: string): string[] {
  const start = src.indexOf("## 分類カバレッジ");
  assert.ok(start >= 0, "分類カバレッジ節の見出しが見つかりません");
  const rest = src.slice(start);
  return [...rest.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)].map((m) => m[1]);
}

test("T-l: examples の語彙閉包 + カバレッジ表の全単射(全判断JSONのreasonIdがCUT_REASON_IDSに閉じ、カバレッジ表と完全一致)", () => {
  for (const file of exampleFileNames()) {
    const src = exampleSource(file);
    const entries = parseExamples(src);
    const usedIds = new Set(entries.map((e) => e.json.reasonId as string));
    for (const id of usedIds) {
      assert.ok(
        (CUT_REASON_IDS as readonly string[]).includes(id),
        `${file}: 判断 JSON の reasonId "${id}" が CUT_REASON_IDS にありません`,
      );
    }
    const tableIds = new Set(coverageTableIds(src));
    assert.deepEqual(
      [...usedIds].sort(),
      [...tableIds].sort(),
      `${file}: 判断 JSON の reasonId 集合とカバレッジ表の id 集合が一致しません`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 実収録との照合(任意。ローカルにこの収録が無ければ skip。落ちない)      */
/* ------------------------------------------------------------------ */

const RECORDING_2026_07_12 = join(homedir(), "Movies", "cutflow", "2026-07-12");

test("実収録照合: examples/2026-07-12-tool-demo.md の抜粋が cutplan.json の実データと一致する", (t) => {
  if (!existsSync(join(RECORDING_2026_07_12, "cutplan.json"))) {
    t.skip(`ローカルに ${RECORDING_2026_07_12} が無いため skip(このマシン固有の任意検査)`);
    return;
  }
  const cutplan = JSON.parse(readFileSync(join(RECORDING_2026_07_12, "cutplan.json"), "utf8")) as {
    segments: { start: number; end: number; action: string; reason: string }[];
  };
  const src = exampleSource("2026-07-12-tool-demo.md");
  const entries = parseExamples(src);
  for (const e of entries) {
    const text = exampleSourceSliceFor(src, e.id);
    const m = text.match(/\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]/);
    if (!m) continue; // 想定/合成の抜粋は無い(この記録は全件実データ)ので通常は必ずマッチする
    const [start, end] = [Number(m[1]), Number(m[2])];
    const seg = cutplan.segments.find((s) => Math.abs(s.start - start) < 0.01 && Math.abs(s.end - end) < 0.01);
    assert.ok(seg, `#${e.id}: cutplan.json に区間 [${start}-${end}] が見つかりません`);
  }
});

/** id の見出しから次の `### ` または `## ` までのソース断片を返す(実収録照合専用の軽量ヘルパ) */
function exampleSourceSliceFor(src: string, id: number): string {
  const headingIdx = src.search(new RegExp(`^### #${id} `, "m"));
  assert.ok(headingIdx >= 0, `#${id} の見出しが見つかりません`);
  const rest = src.slice(headingIdx);
  const nextIdx = rest.slice(1).search(/^#{2,3} /m);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1);
}
