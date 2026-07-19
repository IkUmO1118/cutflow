// lib/hyperframeAudit.ts(hyperframe-check の決定論検出)の純関数群を固定する。
// fs/node/ブラウザには一切依存しない。AuditSample[] は手組みのフィクスチャ。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUDIT_THRESHOLDS,
  auditFindings,
  detectDeadZone,
  detectElementOffscreen,
  detectEmptyTerminal,
  detectSeekUnresponsive,
  detectSimultaneousEntry,
  detectTerminalUnfinished,
} from "../src/lib/hyperframeAudit.ts";
import type { AuditInput, AuditSample, ElementState } from "../src/lib/hyperframeAudit.ts";

const T = DEFAULT_AUDIT_THRESHOLDS;

function el(overrides: Partial<ElementState> & { key: string }): ElementState {
  return {
    visible: true,
    opacity: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: "",
    ...overrides,
  };
}

function emptySample(tMs: number): AuditSample {
  return { tMs, elements: [], waapi: [], timelines: [], lottie: [], clipVisibleKeys: [] };
}

function baseInput(samples: AuditSample[], overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    samples,
    durationSec: 4,
    fps: 30,
    canvas: { width: 1920, height: 1080 },
    drivers: { waapi: 0, gsap: 0, lottie: 0, clips: 0 },
    failures: [],
    ...overrides,
  };
}

/* ---------------- detectTerminalUnfinished ---------------- */

test("detectTerminalUnfinished: 単一パス WAAPI が最終フレームで33%しか進んでいなければ warn", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    waapi: [{ key: "a", currentTimeMs: 2000, endTimeMs: 6000, iterations: 1 }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
  assert.equal(findings[0].target, "a");
});

test("detectTerminalUnfinished: ループ(iterations!==1)は対象外", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    waapi: [{ key: "a", currentTimeMs: 2000, endTimeMs: 6000, iterations: 6 }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

test("detectTerminalUnfinished: 単一パス WAAPI が95%完了していれば warn なし", () => {
  const sample: AuditSample = {
    ...emptySample(1900),
    waapi: [{ key: "a", currentTimeMs: 1900, endTimeMs: 2000, iterations: 1 }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

test("detectTerminalUnfinished: GSAP timeline(repeat=0/yoyo=false)が33%進捗なら warn", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    timelines: [{ key: "tl1", progress: 0.33, totalDurationSec: 6, repeat: 0, yoyo: false }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, "tl1");
});

test("detectTerminalUnfinished: GSAP timeline が repeat=-1(無限)なら対象外", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    timelines: [{ key: "tl1", progress: 0.33, totalDurationSec: 6, repeat: -1, yoyo: false }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

test("detectTerminalUnfinished: GSAP timeline が yoyo=true なら対象外", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    timelines: [{ key: "tl1", progress: 0.33, totalDurationSec: 6, repeat: 0, yoyo: true }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

test("detectTerminalUnfinished: GSAP timeline が55%進捗(閾値0.4以上)なら warn なし", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    timelines: [{ key: "tl1", progress: 0.55, totalDurationSec: 6, repeat: 0, yoyo: false }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

test("detectTerminalUnfinished: Lottie(currentFrame/totalFrames)が低進捗なら warn", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    lottie: [{ key: "l1", currentFrame: 1, totalFrames: 6, frameRate: 30 }],
  };
  const findings = detectTerminalUnfinished(baseInput([sample]), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, "l1");
});

/* ---------------- detectEmptyTerminal ---------------- */

test("detectEmptyTerminal: 序盤に on-canvas だったのに終端で全要素が画面外なら info(warn ではない。曖昧なため)", () => {
  const samples = [
    { ...emptySample(0), elements: [el({ key: "box", rect: { x: 100, y: 100, w: 100, h: 100 } })] },
    { ...emptySample(4000), elements: [el({ key: "box", rect: { x: 1920, y: 0, w: 100, h: 100 } })] },
  ];
  const findings = detectEmptyTerminal(baseInput(samples), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "info");
});

test("detectEmptyTerminal: 終端で1つでも on-canvas な要素があれば警告なし", () => {
  const samples = [
    { ...emptySample(0), elements: [el({ key: "box", rect: { x: 100, y: 100, w: 100, h: 100 } })] },
    { ...emptySample(4000), elements: [el({ key: "box", rect: { x: 100, y: 100, w: 100, h: 100 } })] },
  ];
  const findings = detectEmptyTerminal(baseInput(samples), T);
  assert.equal(findings.length, 0);
});

test("detectEmptyTerminal: zero-area 要素しか無ければ everHad が成立せず警告なし", () => {
  const samples = [
    { ...emptySample(0), elements: [el({ key: "defs", rect: { x: 100, y: 100, w: 0, h: 0 } })] },
    { ...emptySample(4000), elements: [el({ key: "defs", rect: { x: 100, y: 100, w: 0, h: 0 } })] },
  ];
  const findings = detectEmptyTerminal(baseInput(samples), T);
  assert.equal(findings.length, 0);
});

/* ---------------- detectElementOffscreen ---------------- */

test("detectElementOffscreen: 終端で画面外の実質コンテンツ要素は info", () => {
  const sample: AuditSample = {
    ...emptySample(4000),
    elements: [el({ key: "box", rect: { x: 1920, y: 0, w: 100, h: 100 } })],
  };
  const findings = detectElementOffscreen(baseInput([sample]), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "info");
  assert.equal(findings[0].target, "box");
});

test("detectElementOffscreen: zero-area 要素は画面外でも報告しない", () => {
  const sample: AuditSample = {
    ...emptySample(4000),
    elements: [el({ key: "defs", rect: { x: 1920, y: 0, w: 0, h: 0 } })],
  };
  const findings = detectElementOffscreen(baseInput([sample]), T);
  assert.equal(findings.length, 0);
});

/* ---------------- detectSeekUnresponsive ---------------- */

function identicalElementSample(tMs: number, text = "hi"): AuditSample {
  return {
    ...emptySample(tMs),
    elements: [el({ key: "box", rect: { x: 10, y: 10, w: 100, h: 100 }, text })],
  };
}

test("detectSeekUnresponsive: text だけ異なるサンプルは「動いている」ので警告なし", () => {
  const samples = [
    identicalElementSample(0, "h"),
    identicalElementSample(1000, "he"),
    identicalElementSample(2000, "hel"),
  ];
  const input = baseInput(samples, { drivers: { waapi: 1, gsap: 0, lottie: 0, clips: 0 } });
  assert.equal(detectSeekUnresponsive(input).length, 0);
});

test("detectSeekUnresponsive: text も含め完全一致なら warn", () => {
  const samples = [identicalElementSample(0), identicalElementSample(1000), identicalElementSample(2000)];
  const input = baseInput(samples, { drivers: { waapi: 1, gsap: 0, lottie: 0, clips: 0 } });
  const findings = detectSeekUnresponsive(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
});

test("detectSeekUnresponsive: ドライバが1つも無ければ状態が同一でも警告なし", () => {
  const samples = [identicalElementSample(0), identicalElementSample(1000)];
  const input = baseInput(samples, { drivers: { waapi: 0, gsap: 0, lottie: 0, clips: 0 } });
  assert.equal(detectSeekUnresponsive(input).length, 0);
});

/* ---------------- detectDeadZone ---------------- */

test("detectDeadZone: 無変化区間が composition 尺の半分を超えると info", () => {
  const samples = [
    identicalElementSample(0),
    identicalElementSample(6000),
    { ...emptySample(10000), elements: [el({ key: "box", rect: { x: 999, y: 10, w: 100, h: 100 } })] },
  ];
  const input = baseInput(samples, { durationSec: 10 });
  const findings = detectDeadZone(input, T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "info");
});

test("detectDeadZone: 無変化区間が閾値以下なら報告なし", () => {
  const samples = [identicalElementSample(0), identicalElementSample(1000)];
  const input = baseInput(samples, { durationSec: 100 });
  assert.equal(detectDeadZone(input, T).length, 0);
});

/* ---------------- detectSimultaneousEntry ---------------- */

function elementsAt(tMs: number, keys: string[]): AuditSample {
  return { ...emptySample(tMs), elements: keys.map((key) => el({ key })) };
}

test("detectSimultaneousEntry: 3要素以上が composition 開始直後にまとめて登場すると info", () => {
  const samples = [elementsAt(0, ["a", "b", "c"])];
  const findings = detectSimultaneousEntry(baseInput(samples), T);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "info");
});

test("detectSimultaneousEntry: 登場がずれていれば報告なし", () => {
  // fps=30, entryEpsilonFrames=2 → epsilon ≈ 66.7ms。500ms 間隔なら十分ずれている
  const samples = [elementsAt(0, ["a"]), elementsAt(500, ["b"]), elementsAt(1000, ["c"])];
  const findings = detectSimultaneousEntry(baseInput(samples), T);
  assert.equal(findings.length, 0);
});

test("detectSimultaneousEntry: 対象要素が最小数未満なら報告なし", () => {
  const samples = [elementsAt(0, ["a", "b"])];
  const findings = detectSimultaneousEntry(baseInput(samples), T);
  assert.equal(findings.length, 0);
});

test("detectSimultaneousEntry: zero-area 要素は登場数に数えない", () => {
  const samples = [
    {
      ...emptySample(0),
      elements: [
        el({ key: "a" }),
        el({ key: "b" }),
        el({ key: "grad", rect: { x: 0, y: 0, w: 0, h: 0 } }),
      ],
    },
  ];
  const findings = detectSimultaneousEntry(baseInput(samples), T);
  assert.equal(findings.length, 0);
});

/* ---------------- auditFindings ---------------- */

test("auditFindings: failures が非空なら常に空配列", () => {
  const sample: AuditSample = {
    ...emptySample(2000),
    waapi: [{ key: "a", currentTimeMs: 2000, endTimeMs: 6000, iterations: 1 }],
  };
  const input = baseInput([sample], { failures: ["boom"] });
  assert.deepEqual(auditFindings(input), []);
});

test("auditFindings: 何も引っかからないクリーンな入力は空配列", () => {
  const input = baseInput([emptySample(0), emptySample(2000)]);
  assert.deepEqual(auditFindings(input), []);
});
