// lib/configEdit.ts — エディタの設定画面が config.yaml を書き戻すための純関数群。
// 「コメントを保ったまま該当キーだけ変える」「~ のパスを絶対パス化しない」
// 「書き戻し後の YAML からメモリ上 cfg を取り込み直す(cfg の参照は保つ)」を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  applyConfigEdits,
  syncEditorCfgFromYaml,
  validateConfigPatch,
} from "../src/lib/configEdit.ts";
import {
  DEFAULT_DESCRIBE_PAUSE_MAX,
  DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  DEFAULT_AV_COLS,
  DEFAULT_AV_EVERY_SEC,
  DEFAULT_PERCEPTION_OCR_MAX_LINES,
  DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
  DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
  DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC,
  loadConfig,
  planLoopEnabled,
  planShortsMaxSec,
  resolveAvCfg,
  resolveDescribePausesCfg,
  resolvePerceptionCfg,
  resolvePlanLoopCfg,
} from "../src/lib/config.ts";
import type { Config } from "../src/lib/config.ts";

/** リポジトリ既定の config.yaml を模した fixture(コメント・~ パス入り) */
const RAW = `# cutflow 設定ファイル
# パスの ~ はホームディレクトリに展開されます
recordingsDir: ~/Movies/cutflow

whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja

# カット確認用プレビュー動画
preview:
  # 出力する横幅(px)
  width: 1280

render:
  # 右下ワイプ(カメラ)の横幅(px)
  wipeWidthPx: 480
  wipeMarginPx: 32
  captionFontSizePx: 52
  chapterCardSec: 3
  targetLufs: -14
  # システム音声の扱い
  systemAudio:
    mix: true
    # 合成時のシステム音声の音量(dB)
    volumeDb: 0
  denoise:
    mic: false
    noiseFloorDb: -25
  bgm:
    volumeDb: -22
    fadeOutSec: 2
    ducking:
      duckDb: -8
      fadeSec: 0.4
`;

test("applyConfigEdits: 指定キーだけ変わり、読み戻せる", () => {
  const out = applyConfigEdits(RAW, {
    render: { wipeWidthPx: 400, bgm: { volumeDb: -18 } },
    preview: { width: 960 },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.render.wipeWidthPx, 400);
  assert.equal(cfg.render.bgm.volumeDb, -18);
  assert.equal(cfg.preview.width, 960);
  // 触っていないキーは元のまま
  assert.equal(cfg.render.captionFontSizePx, 52);
  assert.equal(cfg.render.bgm.fadeOutSec, 2);
  assert.deepEqual(cfg.render.bgm.ducking, { duckDb: -8, fadeSec: 0.4 });
});

test("applyConfigEdits: コメントが保持される", () => {
  const out = applyConfigEdits(RAW, { render: { wipeWidthPx: 400 } });
  assert.ok(out.includes("# cutflow 設定ファイル"));
  assert.ok(out.includes("# 右下ワイプ(カメラ)の横幅(px)"));
  assert.ok(out.includes("# 合成時のシステム音声の音量(dB)"));
});

test("applyConfigEdits: ~ のパスが絶対パス化されない", () => {
  const out = applyConfigEdits(RAW, { render: { targetLufs: -16 } });
  assert.ok(out.includes("recordingsDir: ~/Movies/cutflow"));
  assert.ok(out.includes("~/Models/whisper/"));
});

test("applyConfigEdits: 未存在ブロックへの書き込みはブロックごと生成", () => {
  const out = applyConfigEdits(RAW, {
    editor: { defaultImageDurationSec: 6 },
    render: { captionColor: "#ffee00" },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.editor?.defaultImageDurationSec, 6);
  assert.equal(cfg.render.captionColor, "#ffee00");
});

test("applyConfigEdits: null でキーが消える(無いキーへの null は no-op)", () => {
  const withColor = applyConfigEdits(RAW, { render: { captionColor: "#ffee00" } });
  const removed = applyConfigEdits(withColor, { render: { captionColor: null } });
  assert.equal((parse(removed) as Config).render.captionColor, undefined);
  // 元から無いキーへの null は何も起きない
  const noop = applyConfigEdits(RAW, { render: { captionFontFamily: null } });
  assert.equal((parse(noop) as Config).render.captionFontFamily, undefined);
});

test("applyConfigEdits: 子を全部コメントアウトした null スカラーの親でも投げない", () => {
  // `editor:` の中身が全部コメントアウトされ null スカラーになっている config
  const raw = `recordingsDir: ~/Movies/cutflow
editor:
  # maxUploadMb: 2048
  # defaultImageDurationSec: 4
render:
  wipeWidthPx: 480
`;
  // setIn(null スカラーの親)も、そこへの null 削除も投げずに済む
  const set = applyConfigEdits(raw, { editor: { defaultImageDurationSec: 6 } });
  assert.equal((parse(set) as Config).editor?.defaultImageDurationSec, 6);
  const del = applyConfigEdits(raw, { editor: { defaultImageDurationSec: null } });
  assert.equal((parse(del) as Config).editor?.defaultImageDurationSec, undefined);
});

test("applyConfigEdits: 親ブロックごと欠落していても深いキーを生成できる", () => {
  const raw = `recordingsDir: ~/Movies/cutflow
render:
  wipeWidthPx: 480
`;
  // render.bgm / render.bgm.ducking が丸ごと無い状態への深いブロック書き込み
  const out = applyConfigEdits(raw, {
    render: { bgm: { volumeDb: -18, ducking: { duckDb: -10, fadeSec: 0.5 } } },
    editor: { maxUploadMb: 4096 },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.render.bgm.volumeDb, -18);
  assert.deepEqual(cfg.render.bgm.ducking, { duckDb: -10, fadeSec: 0.5 });
  assert.equal(cfg.editor?.maxUploadMb, 4096);
  assert.equal(cfg.render.wipeWidthPx, 480); // 既存キーは保たれる
});

test("applyConfigEdits: systemAudio のブロック更新で兄弟キー・コメントが残る", () => {
  const out = applyConfigEdits(RAW, {
    render: { systemAudio: { mix: false, volumeDb: -6 } },
  });
  const cfg = parse(out) as Config;
  assert.deepEqual(cfg.render.systemAudio, { mix: false, volumeDb: -6 });
  assert.ok(out.includes("# システム音声の扱い"));
  assert.equal(cfg.render.bgm.volumeDb, -22);
});

test("applyConfigEdits: denoise のブロック更新で兄弟キーが残る(未設定時の既定は mic:false/noiseFloorDb:-25)", () => {
  assert.deepEqual((parse(RAW) as Config).render.denoise, { mic: false, noiseFloorDb: -25 });
  const out = applyConfigEdits(RAW, {
    render: { denoise: { mic: true, noiseFloorDb: -18 } },
  });
  const cfg = parse(out) as Config;
  assert.deepEqual(cfg.render.denoise, { mic: true, noiseFloorDb: -18 });
  assert.equal(cfg.render.bgm.volumeDb, -22);
});

test("validateConfigPatch: 正常系は空配列", () => {
  assert.deepEqual(
    validateConfigPatch({
      render: {
        wipeWidthPx: 480,
        captionColor: "#ffffff",
        captionOutlineColor: "none",
        captionFontWeight: null,
        systemAudio: { mix: true, volumeDb: 0 },
        denoise: { mic: false, noiseFloorDb: -25 },
        bgm: { volumeDb: -22, ducking: { duckDb: -8, fadeSec: 0.4 } },
        hardwareAcceleration: "disable",
      },
      preview: { width: 1280 },
      editor: { maxUploadMb: 2048, defaultImageDurationSec: 4 },
    }),
    [],
  );
});

test("validateConfigPatch: hardwareAcceleration は if-possible/disable/null のみ許可", () => {
  assert.deepEqual(
    validateConfigPatch({ render: { hardwareAcceleration: "if-possible" } }),
    [],
  );
  assert.deepEqual(
    validateConfigPatch({ render: { hardwareAcceleration: null } }),
    [],
  );
  assert.ok(
    validateConfigPatch({ render: { hardwareAcceleration: "always" } }).length > 0,
  );
});

test("validateConfigPatch: 範囲外・型違い・未知キーを拒否", () => {
  assert.ok(validateConfigPatch({ preview: { width: 1281 } }).length > 0); // 奇数
  assert.ok(validateConfigPatch({ render: { targetLufs: 0 } }).length > 0);
  assert.ok(validateConfigPatch({ render: { captionFontWeight: 1000 } }).length > 0);
  assert.ok(validateConfigPatch({ render: { wipeWidthPx: "480" } }).length > 0);
  assert.ok(validateConfigPatch({ detect: { silenceDb: -35 } }).length > 0); // 対象外セクション
  assert.ok(validateConfigPatch({ render: { nope: 1 } }).length > 0);
  // 削除(null)を受けないキーへの null
  assert.ok(validateConfigPatch({ render: { wipeWidthPx: null } }).length > 0);
  // ブロック更新の欠けを拒否
  assert.ok(validateConfigPatch({ render: { systemAudio: { mix: true } } }).length > 0);
  assert.ok(
    validateConfigPatch({ render: { bgm: { ducking: { duckDb: -8 } } } }).length > 0,
  );
  assert.ok(validateConfigPatch({ render: { denoise: { mic: true } } }).length > 0);
});

test("validateConfigPatch: denoise は mic/noiseFloorDb のブロック更新のみ許可", () => {
  assert.deepEqual(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -25 } } }),
    [],
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: "true", noiseFloorDb: -25 } } }).length > 0,
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -10 } } }).length > 0,
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -90 } } }).length > 0,
  );
});

test("planShortsMaxSec: 省略時は既定60・指定時はその値", () => {
  assert.equal(planShortsMaxSec({} as Config), DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC);
  assert.equal(planShortsMaxSec({} as Config), 60);
  assert.equal(
    planShortsMaxSec({ planShorts: {} } as Config),
    60,
  );
  assert.equal(
    planShortsMaxSec({ planShorts: { maxDurationSec: 45 } } as Config),
    45,
  );
});

test("syncEditorCfgFromYaml: cfg の参照を保ったままサブツリーを取り込み直す", () => {
  const cfg = parse(RAW) as Config;
  cfg.recordingsDir = "/abs/Movies/cutflow"; // expandHome 済みを模す
  const before = cfg; // クロージャで共有される cfg 自身の参照
  const nextYaml = applyConfigEdits(RAW, {
    render: { wipeWidthPx: 400, captionColor: "#ffee00" },
    preview: { width: 960 },
    editor: { defaultImageDurationSec: 6 },
  });
  syncEditorCfgFromYaml(cfg, nextYaml);
  assert.equal(cfg, before); // cfg 自身は同じ参照(preview/render/proxy が見続ける)
  assert.equal(cfg.render.wipeWidthPx, 400);
  assert.equal(cfg.render.captionColor, "#ffee00");
  assert.equal(cfg.preview.width, 960);
  assert.equal(cfg.editor?.defaultImageDurationSec, 6);
  // render/preview/editor 以外(~ を含むキー)は取り込みで壊されない
  assert.equal(cfg.recordingsDir, "/abs/Movies/cutflow");
});

test("syncEditorCfgFromYaml: null 削除で省略時の既定へ戻る", () => {
  const cfg = parse(RAW) as Config;
  const withColor = applyConfigEdits(RAW, { render: { captionColor: "#ffee00" } });
  syncEditorCfgFromYaml(cfg, withColor);
  assert.equal(cfg.render.captionColor, "#ffee00");
  const removed = applyConfigEdits(withColor, { render: { captionColor: null } });
  syncEditorCfgFromYaml(cfg, removed);
  assert.equal(cfg.render.captionColor, undefined);
});

test("loadConfig: whisper.wordTimestamps 未指定時は false(既存挙動と完全一致)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.wordTimestamps, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: whisper.wordTimestamps: true を指定すればそのまま通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
  wordTimestamps: true
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.wordTimestamps, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: ocr 省略時は languages が [en, ja](既存挙動と完全一致)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.ocr?.languages, ["en", "ja"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: ocr.languages を指定すればそのまま通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
ocr:
  languages: [en]
`,
    );
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.ocr?.languages, ["en"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePerceptionCfg: plan 省略時は全オフ+既定値", () => {
  assert.deepEqual(resolvePerceptionCfg({} as Config), {
    audio: false,
    ocr: false,
    ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: false,
  });
  assert.equal(DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS, 40);
  assert.equal(DEFAULT_PERCEPTION_OCR_MAX_LINES, 6);
});

test("resolvePerceptionCfg: plan.perception 省略時も全オフ+既定値", () => {
  assert.deepEqual(resolvePerceptionCfg({ plan: {} } as Config), {
    audio: false,
    ocr: false,
    ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: false,
  });
});

test("resolvePerceptionCfg: audio だけ指定すれば他は既定のまま", () => {
  assert.deepEqual(
    resolvePerceptionCfg({ plan: { perception: { audio: true } } } as Config),
    {
      audio: true,
      ocr: false,
      ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
      ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
      systemSpeech: false,
    },
  );
});

test("resolvePerceptionCfg: 全項目を明示指定すればそのまま通る", () => {
  assert.deepEqual(
    resolvePerceptionCfg({
      plan: { perception: { audio: true, ocr: true, ocrMaxSegments: 10, ocrMaxLines: 3, systemSpeech: true } },
    } as Config),
    { audio: true, ocr: true, ocrMaxSegments: 10, ocrMaxLines: 3, systemSpeech: true },
  );
});

test("resolvePerceptionCfg: systemSpeech 省略時は false", () => {
  assert.equal(
    resolvePerceptionCfg({ plan: { perception: { audio: true } } } as Config).systemSpeech,
    false,
  );
});

test("resolvePlanLoopCfg: plan/loop 省略時はループ無効の既定値", () => {
  assert.deepEqual(resolvePlanLoopCfg({} as Config), {
    maxIterations: DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
    targetOutDurationSec: null,
    stopWhenAssertionsPass: true,
  });
  assert.equal(DEFAULT_PLAN_LOOP_MAX_ITERATIONS, 0);
  assert.equal(planLoopEnabled({} as Config), false);
  assert.equal(planLoopEnabled({ plan: { loop: { maxIterations: 1 } } } as Config), false);
});

test("resolvePlanLoopCfg: 明示値を解決し maxIterations>=2 だけ有効", () => {
  const cfg = {
    plan: {
      loop: {
        maxIterations: 3,
        targetOutDurationSec: 300,
        stopWhenAssertionsPass: false,
      },
    },
  } as Config;
  assert.deepEqual(resolvePlanLoopCfg(cfg), {
    maxIterations: 3,
    targetOutDurationSec: 300,
    stopWhenAssertionsPass: false,
  });
  assert.equal(planLoopEnabled(cfg), true);
});

test("resolveDescribePausesCfg: describe 省略時は無効+既定値", () => {
  assert.deepEqual(resolveDescribePausesCfg({} as Config), {
    enabled: false,
    max: DEFAULT_DESCRIBE_PAUSE_MAX,
    minSec: DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  });
  assert.equal(DEFAULT_DESCRIBE_PAUSE_MAX, 3);
  assert.equal(DEFAULT_DESCRIBE_PAUSE_MIN_SEC, 0.6);
});

test("resolveDescribePausesCfg: 部分指定で他は既定のまま", () => {
  assert.deepEqual(
    resolveDescribePausesCfg({ describe: { pauses: true } } as Config),
    { enabled: true, max: DEFAULT_DESCRIBE_PAUSE_MAX, minSec: DEFAULT_DESCRIBE_PAUSE_MIN_SEC },
  );
  assert.deepEqual(
    resolveDescribePausesCfg({ describe: { pauses: true, pauseMax: 5, pauseMinSec: 1.2 } } as Config),
    { enabled: true, max: 5, minSec: 1.2 },
  );
});

test("loadConfig: whisper.systemAudio 省略時は false へ defaulting・cfg.describe は生成しない(バイト等価)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  wipeTransitionSec: 0.3
  cutTransition: { type: none, sec: 0.3 }
  captionFontSizePx: 52
  captionColor: "#fff"
  captionOutlineColor: "#000"
  captionFontFamily: sans-serif
  captionFontWeight: 700
  chapterCardSec: 3
  targetLufs: -14
  systemAudio: { mix: true, volumeDb: 0 }
  denoise: { mic: false, noiseFloorDb: -25 }
  bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } }
  hardwareAcceleration: if-possible
  chunkSec: 15
  zoom: { easeSec: 0.4 }
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.systemAudio, false);
    assert.equal(cfg.describe, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan 省略時は cfg.plan が undefined のまま(defaulting しない=バイト等価)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/cutflow
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.plan, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAvCfg: 省略時は既定、指定時は上書き", () => {
  assert.deepEqual(resolveAvCfg({} as Config), {
    everySec: DEFAULT_AV_EVERY_SEC,
    cols: DEFAULT_AV_COLS,
    windowSec: 1,
    scdetThreshold: 8,
    freeze: { noiseDb: -50, durationSec: 1 },
    stripWidthPx: 320,
  });
  assert.deepEqual(
    resolveAvCfg({ av: { everySec: 2, cols: 4, freeze: { noiseDb: -40 } } } as Config),
    {
      everySec: 2,
      cols: 4,
      windowSec: 1,
      scdetThreshold: 8,
      freeze: { noiseDb: -40, durationSec: 1 },
      stripWidthPx: 320,
    },
  );
});

test("syncEditorCfgFromYaml: 外部編集ぶん(パッチ外のキー)も反映される", () => {
  const cfg = parse(RAW) as Config;
  // エディタ起動中に config.yaml が外部編集され wipeMarginPx が変わったと想定。
  // その YAML にパッチ(preview.width)を当てた結果を取り込むと、パッチ外の
  // 外部編集ぶん(wipeMarginPx)もメモリへ反映される
  const externallyEdited = RAW.replace("wipeMarginPx: 32", "wipeMarginPx: 64");
  const nextYaml = applyConfigEdits(externallyEdited, { preview: { width: 960 } });
  syncEditorCfgFromYaml(cfg, nextYaml);
  assert.equal(cfg.preview.width, 960);
  assert.equal(cfg.render.wipeMarginPx, 64);
});
