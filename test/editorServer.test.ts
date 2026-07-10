// editor/server.ts — GUI 保存(saveProject)の id 採番ロジック(stampSaveBody)。
// サーバー本体(HTTP・esbuild バンドル)は起動せず、export された純関数だけを
// 固定する(実 UI の round-trip は人間の GUI 実測に委ねる。MEMORY: エディタの
// コードはサーバー再起動まで反映されない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAiReviewCandidateFromStoredProposal,
  loadProject,
  refineRequestKey,
  stampSaveBody,
  validateRefineRequest,
  validateReviewRequest,
} from "../editor/server.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { Config } from "../src/lib/config.ts";
import type { AiRefineRequest, AiReviewRequest, SaveRequest } from "../editor/client/apiTypes.ts";

test("stampSaveBody: idEnabled=false は body をそのまま返す(参照も同一・バイト等価)", () => {
  const body: SaveRequest = {
    cutplan: { approved: false, segments: [{ start: 0, end: 1, action: "keep", reason: "" }] },
  };
  const out = stampSaveBody(body, false, new Set());
  assert.equal(out, body);
});

test("stampSaveBody: idEnabled=true で新規要素(id 無し)に採番する", () => {
  const body: SaveRequest = {
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_aaaaaa", start: 0, end: 1, action: "keep", reason: "" },
        { start: 1, end: 2, action: "keep", reason: "" },
      ],
    },
  };
  const used = new Set<string>(["seg_aaaaaa"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.cutplan!.segments[0].id, "seg_aaaaaa");
  assert.match(out.cutplan!.segments[1].id as string, ID_RE);
});

test("stampSaveBody: idEnabled=true でも既存 id は保持する(round-trip)", () => {
  const body: SaveRequest = {
    transcript: {
      segments: [{ id: "cap_bbbbbb", start: 0, end: 1, text: "hi" }],
    },
  };
  const used = new Set<string>(["cap_bbbbbb"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.transcript!.segments[0].id, "cap_bbbbbb");
});

test("stampSaveBody: overlays の全「指せる配列」に採番する", () => {
  const body: SaveRequest = {
    overlays: {
      overlays: [{ start: 0, end: 1, file: "a.png" }],
      inserts: [{ at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ start: 0, end: 1 }],
      hideCaption: [{ start: 0, end: 1 }],
      zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      blurs: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      captionTracks: [{ track: 1 }],
    },
  };
  const out = stampSaveBody(body, true, new Set());
  assert.match(out.overlays!.overlays![0].id as string, ID_RE);
  assert.match(out.overlays!.inserts![0].id as string, ID_RE);
  assert.match(out.overlays!.wipeFull![0].id as string, ID_RE);
  assert.match(out.overlays!.hideCaption![0].id as string, ID_RE);
  assert.match(out.overlays!.zooms![0].id as string, ID_RE);
  assert.match(out.overlays!.blurs![0].id as string, ID_RE);
  assert.match(out.overlays!.captionTracks![0].id as string, ID_RE);
});

test("stampSaveBody: bgm/shorts にも採番する", () => {
  const body: SaveRequest = {
    bgm: { tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] },
    shorts: {
      shorts: [
        {
          name: "s1",
          approved: false,
          ranges: [{ start: 0, end: 1 }],
          captionTracks: [{ track: 1 }],
        },
      ],
    },
  };
  const out = stampSaveBody(body, true, new Set());
  assert.match(out.bgm!.tracks[0].id as string, ID_RE);
  assert.match(out.shorts!.shorts[0].ranges[0].id as string, ID_RE);
  assert.match(out.shorts!.shorts[0].captionTracks![0].id as string, ID_RE);
});

test("stampSaveBody: bgm/shorts の null(削除シグナル)は idEnabled=true でも保つ", () => {
  const body: SaveRequest = { bgm: null, shorts: null };
  const out = stampSaveBody(body, true, new Set());
  assert.equal(out.bgm, null);
  assert.equal(out.shorts, null);
});

test("stampSaveBody: body に無いドキュメントは undefined のまま(触らない)", () => {
  const body: SaveRequest = {};
  const out = stampSaveBody(body, true, new Set());
  assert.equal(out.cutplan, undefined);
  assert.equal(out.overlays, undefined);
  assert.equal(out.transcript, undefined);
  assert.equal(out.bgm, undefined);
  assert.equal(out.shorts, undefined);
});

test("loadProject: /api/project 相当の payload に planPerception を含む", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-project-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mkv",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1920,
        height: 1080,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-08T00:00:00Z",
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ start: 0, end: 1, text: "hello" }],
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 12, action: "keep", reason: "" }],
    });
    const project = loadProject(dir, {
      render: {} as Config["render"],
      preview: { width: 1280 },
      plan: { perception: { audio: true, ocr: true, systemSpeech: false } },
    } as Config);
    assert.deepEqual(project.planPerception, {
      explicit: true,
      audio: true,
      ocr: true,
      ocrMaxSegments: 40,
      ocrMaxLines: 6,
      systemSpeech: false,
      warnings: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiReviewCandidateFromStoredProposal: acceptedHunkLabels から candidate を再構築し approved は base を保つ", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-review-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
    });
    write("overlays.json", {});
    const candidate = buildAiReviewCandidateFromStoredProposal(dir, {
      baseDocs: {
        cutplan: {
          approved: false,
          segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
        },
        overlays: {},
        transcript: {
          language: "ja",
          model: "test",
          segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
        },
        bgm: null,
        shorts: null,
      },
      proposal: {
        title: "title",
        summary: [],
        patch: { ops: [] },
        applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
        proposedDocs: {
          cutplan: {
            approved: true,
            segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "proposal" }],
          },
          overlays: {},
          transcript: {
            language: "ja",
            model: "test",
            segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
          },
          bgm: null,
          shorts: null,
        },
        review: { frames: [{ axis: "source", atSec: 1, reason: "caption" }], notes: [] },
      },
    }, ["cutplan segments seg_aaaaaa .reason"]);
    assert.equal(candidate.cutplan.approved, false);
    assert.equal(candidate.cutplan.segments[0].reason, "proposal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateReviewRequest: proposalId / acceptedHunkLabels / secondaryObservation 以外を拒否し、重複も弾く", () => {
  const extra = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    extra: true,
  } as unknown as AiReviewRequest);
  assert.match(extra.join(" / "), /proposalId \/ acceptedHunkLabels \/ secondaryObservation だけ/);

  const badSecondary = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    secondaryObservation: "yes",
  } as unknown as AiReviewRequest);
  assert.match(badSecondary.join(" / "), /secondaryObservation は none \/ vlm/);

  const dup = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: ["a", "a"],
  });
  assert.match(dup.join(" / "), /重複/);
});

test("validateRefineRequest: proposalId 必須、unknown key 拒否、重複拒否", () => {
  const missing = validateRefineRequest({
    acceptedHunkLabels: [],
  } as unknown as AiRefineRequest);
  assert.match(missing.join(" / "), /proposalId は空でない文字列/);

  const extra = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    instruction: "字幕を短く",
    extra: true,
  } as unknown as AiRefineRequest);
  assert.match(extra.join(" / "), /proposalId \/ acceptedHunkLabels \/ instruction \/ vlm \/ mode だけ/);

  const dup = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: ["a", "a"],
  });
  assert.match(dup.join(" / "), /重複/);

  const invalidMode = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    mode: "unexpected",
  } as unknown as AiRefineRequest);
  assert.match(invalidMode.join(" / "), /mode は normal \/ warning-fix/);
});

test("refineRequestKey: mode を含み、省略時は normal 扱い", () => {
  const record = {
    proposalId: "p1",
  } as Parameters<typeof refineRequestKey>[0];
  const normal = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["b", "a"],
    instruction: "  字幕を短く  ",
  });
  const warningFix = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["a", "b"],
    instruction: "字幕を短く",
    mode: "warning-fix",
  });
  const explicitNormal = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["a", "b"],
    instruction: "字幕を短く",
    mode: "normal",
  });
  assert.equal(normal, explicitNormal);
  assert.notEqual(normal, warningFix);
  assert.match(warningFix, /"mode":"warning-fix"/);
});

test("buildAiReviewCandidateFromStoredProposal: unknown hunk labels は 400", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-review-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
    });
    write("overlays.json", {});
    assert.throws(
      () =>
        buildAiReviewCandidateFromStoredProposal(dir, {
          baseDocs: {
            cutplan: {
              approved: false,
              segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
            },
            overlays: {},
            transcript: {
              language: "ja",
              model: "test",
              segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
            },
            bgm: null,
            shorts: null,
          },
          proposal: {
            title: "title",
            summary: [],
            patch: { ops: [] },
            applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
            proposedDocs: {
              cutplan: {
                approved: false,
                segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "proposal" }],
              },
              overlays: {},
              transcript: {
                language: "ja",
                model: "test",
                segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
              },
              bgm: null,
              shorts: null,
            },
            review: { frames: [{ axis: "source", atSec: 1, reason: "caption" }], notes: [] },
          },
        }, ["missing-label"]),
      /unknown hunk labels/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
