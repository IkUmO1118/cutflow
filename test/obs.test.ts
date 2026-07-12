import { test } from "node:test";
import assert from "node:assert/strict";
import { firstMeaningfulArg, formatToolEvent, shouldEmitAt } from "../src/lib/obs.ts";

test("formatToolEvent: ai kind は文字列を改変せず AI: purpose= の substring を保つ", () => {
  const detail = "AI: purpose=other route=structured profile=local adapter=codex model=gpt-5.4-mini";
  const line = formatToolEvent({ kind: "ai", label: "AI", detail }, { color: false });
  assert.equal(line, `✦ ${detail}`);
  assert.match(line, /AI: purpose=/);
});

test("formatToolEvent: tool kind は label を padEnd し末尾に秒数が付く", () => {
  const line = formatToolEvent(
    { kind: "tool", label: "ffmpeg", detail: "cut", durationMs: 1800 },
    { color: false },
  );
  assert.equal(line, "⚙ ffmpeg   cut (1.8秒)");
});

test("formatToolEvent: stage kind は detail 省略時も秒数だけ付く", () => {
  const line = formatToolEvent(
    { kind: "stage", label: "Remotion", durationMs: 42300 },
    { color: false },
  );
  assert.equal(line, "▸ Remotion (42.3秒)");
});

test("formatToolEvent: color:false は ANSI を含まない", () => {
  const line = formatToolEvent(
    { kind: "tool", label: "ffmpeg", detail: "cut", durationMs: 1800 },
    { color: false },
  );
  assert.doesNotMatch(line, /\x1b\[/);
});

test("formatToolEvent: color:true は duration に ANSI を含む", () => {
  const line = formatToolEvent(
    { kind: "tool", label: "ffmpeg", detail: "cut", durationMs: 1800 },
    { color: true },
  );
  assert.match(line, /\x1b\[/);
});

test("shouldEmitAt: quiet は何も出さない", () => {
  assert.equal(shouldEmitAt("quiet", "ai"), false);
  assert.equal(shouldEmitAt("quiet", "tool"), false);
  assert.equal(shouldEmitAt("quiet", "stage"), false);
});

test("shouldEmitAt: normal は ai/stage を出し tool は出さない", () => {
  assert.equal(shouldEmitAt("normal", "ai"), true);
  assert.equal(shouldEmitAt("normal", "stage"), true);
  assert.equal(shouldEmitAt("normal", "tool"), false);
});

test("shouldEmitAt: verbose は全 kind を出す", () => {
  assert.equal(shouldEmitAt("verbose", "ai"), true);
  assert.equal(shouldEmitAt("verbose", "stage"), true);
  assert.equal(shouldEmitAt("verbose", "tool"), true);
});

test("firstMeaningfulArg: フラグ値でなくファイル名を拾う(-v error を無視して raw.mp4)", () => {
  assert.equal(firstMeaningfulArg(["-v", "error", "-i", "raw.mp4", "out.png"]), "raw.mp4");
});

test("firstMeaningfulArg: パス区切りを含むトークンは basename を返す", () => {
  assert.equal(firstMeaningfulArg(["-i", "/foo/bar/raw.mkv"]), "raw.mkv");
});

test("firstMeaningfulArg: ファイルらしいトークンが無ければ undefined(フラグ値を拾わない)", () => {
  assert.equal(firstMeaningfulArg(["-v", "error", "-hide_banner"]), undefined);
  assert.equal(firstMeaningfulArg(["-loglevel", "quiet", "-y"]), undefined);
});
