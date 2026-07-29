import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  compareRemux,
  remuxCandidateName,
  readManifestSource,
  detectRemuxDuplicate,
  assertRemuxDuplicateStillSafe,
} from "../src/lib/remuxDup.ts";
import { planCleanWithRemuxDup, executeClean } from "../src/stages/clean.ts";
import type { MaterialProbe } from "../src/lib/ffmpeg.ts";

/** 実測値(2026-07-21 の収録)を模した「同一内容の remux 複製」ペア */
const MKV: MaterialProbe = {
  durationSec: 645.733,
  width: 3840,
  height: 1080,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  audioCodec: "aac",
};
const MP4: MaterialProbe = { ...MKV, durationSec: 645.633 };
const MKV_BYTES = 3238800928;
const MP4_BYTES = 3239231074;

test("compareRemux: 実測の mkv/mp4 ペア(尺差 0.1s・サイズ差 0.02%)は複製と判定する", () => {
  assert.deepEqual(compareRemux(MKV, MP4, MKV_BYTES, MP4_BYTES), { dup: true });
});

test("compareRemux: 映像 codec / 解像度 / fps / 音声が1つでも違えば複製ではない", () => {
  const cases: [string, MaterialProbe][] = [
    ["codec", { ...MP4, videoCodec: "hevc" }],
    ["幅", { ...MP4, width: 1920 }],
    ["高さ", { ...MP4, height: 720 }],
    ["fps", { ...MP4, fps: 60 }],
    ["音声有無", { ...MP4, hasAudio: false, audioCodec: undefined }],
    ["音声 codec", { ...MP4, audioCodec: "opus" }],
  ];
  for (const [label, cand] of cases) {
    const v = compareRemux(MKV, cand, MKV_BYTES, MP4_BYTES);
    assert.equal(v.dup, false, `${label} が違うのに複製と判定された`);
  }
});

test("compareRemux: 尺が tolerance を超えて違えば複製ではない", () => {
  const v = compareRemux(MKV, { ...MP4, durationSec: 600 }, MKV_BYTES, MP4_BYTES);
  assert.equal(v.dup, false);
});

test("compareRemux: 内容が同じでもサイズが大きく違えば複製ではない(再エンコード品を残す)", () => {
  // 同 codec・同解像度・同尺だが 1/10 のサイズ = 配布用に絞った別ファイル
  const v = compareRemux(MKV, MP4, MKV_BYTES, Math.round(MKV_BYTES / 10));
  assert.equal(v.dup, false);
  assert.match((v as { reason: string }).reason, /サイズ/);
});

test("compareRemux: 短尺はコンテナ差で相対 8% ずれても複製と判定する(絶対量の二段目)", () => {
  // 実測: 1秒の mkv(16275B)と remux mp4(17683B)= 相対 8.0% / 絶対 1.4KB。
  // 相対だけで判定すると取りこぼす短尺を、絶対量 1MB の枝が拾う
  assert.deepEqual(compareRemux(MKV, MP4, 16275, 17683), { dup: true });
});

test("compareRemux: 絶対差が 1MB を超え かつ 相対 5% を超えたときだけ弾く", () => {
  // 絶対差は大きいが相対では誤差(大きなファイル同士)→ 複製
  assert.deepEqual(compareRemux(MKV, MP4, 1_000_000_000, 1_002_000_000), { dup: true });
  // 相対も絶対も超える → 複製ではない
  assert.equal(compareRemux(MKV, MP4, 100_000_000, 10_000_000).dup, false);
});

test("compareRemux: 映像/音声ストリームが読めないときは複製と判定しない", () => {
  assert.equal(compareRemux({ hasAudio: false }, MP4, 1, 1).dup, false);
  assert.equal(compareRemux(MKV, { ...MP4, durationSec: undefined }, 1, 1).dup, false);
  assert.equal(compareRemux(MKV, { ...MP4, fps: undefined }, 1, 1).dup, false);
});

test("remuxCandidateName: 非 mp4 コンテナからだけ <base>.mp4 を導く", () => {
  assert.equal(remuxCandidateName("2026-07-21 13-43-33.mkv"), "2026-07-21 13-43-33.mp4");
  assert.equal(remuxCandidateName("rec.MKV"), "rec.mp4");
  assert.equal(remuxCandidateName("rec.mov"), "rec.mp4");
  // ★元収録が mp4 のときは null: 「消す側が元収録」になり得る経路を作らない
  assert.equal(remuxCandidateName("rec.mp4"), null);
  assert.equal(remuxCandidateName("rec.MP4"), null);
  // パス区切りを含む source は扱わない(収録フォルダ直下の名前だけが対象)
  assert.equal(remuxCandidateName("sub/rec.mkv"), null);
  assert.equal(remuxCandidateName("../rec.mkv"), null);
  assert.equal(remuxCandidateName("noext"), null);
});

test("readManifestSource: manifest が無い/壊れている/source が無いときは null", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    assert.equal(readManifestSource(dir), null); // 無い
    writeFileSync(join(dir, "manifest.json"), "not json");
    assert.equal(readManifestSource(dir), null); // 壊れている
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ dir }));
    assert.equal(readManifestSource(dir), null); // source が無い
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mkv" }));
    assert.equal(readManifestSource(dir), "a.mkv");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertRemuxDuplicateStillSafe: manifest が消す側を指していたら throw する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    writeFileSync(join(dir, "a.mkv"), "x");
    writeFileSync(join(dir, "a.mp4"), "x");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mkv" }));
    assertRemuxDuplicateStillSafe(dir, "a.mp4"); // 正常系は throw しない

    // ★ plan から実行までの間に manifest が差し替わった = 消す側が元収録になった
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mp4" }));
    assert.throws(() => assertRemuxDuplicateStillSafe(dir, "a.mp4"), /元収録そのもの/);

    // ★ 元収録が既に無い(先に消された)なら消さない
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "gone.mkv" }));
    assert.throws(() => assertRemuxDuplicateStillSafe(dir, "a.mp4"), /見つからない/);

    // ★ 生成物名に化けた候補は remux 複製として扱わない
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mkv" }));
    assert.throws(() => assertRemuxDuplicateStillSafe(dir, "cut.mp4"), /扱えません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRemuxDuplicate: 複製が無い/manifest が無いときは null(ffprobe を呼ばない)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    assert.equal(await detectRemuxDuplicate(dir), null); // manifest 無し
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mkv" }));
    writeFileSync(join(dir, "a.mkv"), "x");
    assert.equal(await detectRemuxDuplicate(dir), null); // 複製が無い(掃除済み)
    // 元収録が mp4 = 複製側を特定できない
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mp4" }));
    writeFileSync(join(dir, "a.mp4"), "x");
    assert.equal(await detectRemuxDuplicate(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRemuxDuplicate: ffprobe が中身を読めないファイルは複製と判定しない(残す)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "a.mkv" }));
    writeFileSync(join(dir, "a.mkv"), "not a video");
    writeFileSync(join(dir, "a.mp4"), "not a video either");
    const reasons: string[] = [];
    assert.equal(await detectRemuxDuplicate(dir, (r) => reasons.push(r)), null);
    assert.equal(reasons.length, 1); // 「なぜ残したか」が伝わる
    assert.ok(existsSync(join(dir, "a.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** ffmpeg/ffprobe が使える環境か(無ければ実素材を使う統合テストは skip) */
function hasFfmpeg(): boolean {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

test("統合: 実 mkv とその remux mp4 を clean が消し、別内容の mp4 は残す", { skip: !hasFfmpeg() && "ffmpeg/ffprobe が無い" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "ignore" });
    // 1秒の映像+音声を mkv で作り、ストリームコピーで mp4 へ remux(= OBS と同じ関係)
    ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", join(dir, "rec.mkv")]);
    ff(["-i", join(dir, "rec.mkv"), "-c", "copy", join(dir, "rec.mp4")]);
    // 別内容(尺違い)の mp4。名前が違うので候補にすらならないが、残ることを確かめる
    ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
        "-c:v", "libx264", join(dir, "other.mp4")]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "rec.mkv" }));
    writeFileSync(join(dir, "cutplan.json"), "{}");

    const plan = await planCleanWithRemuxDup(dir);
    const dup = plan.targets.find((t) => t.category === "remux-dup");
    assert.ok(dup, "remux 複製が検出されていない");
    assert.equal(dup.relPath, "rec.mp4");
    assert.equal(dup.remuxSource, "rec.mkv");
    assert.equal(dup.bytes, statSync(join(dir, "rec.mp4")).size);

    executeClean(dir, plan);
    assert.equal(existsSync(join(dir, "rec.mp4")), false, "remux 複製が消えていない");
    // ★ 元収録・編集ファイル・無関係な mp4 は残る
    assert.ok(existsSync(join(dir, "rec.mkv")));
    assert.ok(existsSync(join(dir, "cutplan.json")));
    assert.ok(existsSync(join(dir, "other.mp4")));
    // 冪等: 2回目は複製が無いので対象ゼロ
    const second = await planCleanWithRemuxDup(dir);
    assert.equal(second.targets.filter((t) => t.category === "remux-dup").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("統合: 同尺・同codec でもサイズが大きく違う mp4 は残す(再エンコード品の保護)", { skip: !hasFfmpeg() && "ffmpeg/ffprobe が無い" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "ignore" });
    // 絶対差の枝(1MB)も超える差を作る。testsrc は圧縮が効きすぎて -b:v を指定しても
    // 小さくなるので、ノイズを載せて可逆(-qp 0)で焼く
    ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
        "-vf", "noise=alls=90:allf=t+u", "-c:v", "libx264", "-qp", "0", join(dir, "rec.mkv")]);
    // 同じ内容を極端に低いビットレートで再エンコード = 配布用の軽いコピー
    ff(["-i", join(dir, "rec.mkv"), "-c:v", "libx264", "-b:v", "40k", join(dir, "rec.mp4")]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "rec.mkv" }));

    const reasons: string[] = [];
    const plan = await planCleanWithRemuxDup(dir, { onSkip: (r) => reasons.push(r) });
    assert.equal(plan.targets.filter((t) => t.category === "remux-dup").length, 0);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /サイズ/);
    executeClean(dir, plan);
    assert.ok(existsSync(join(dir, "rec.mp4")), "再エンコード品が消された");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planCleanWithRemuxDup: --logs-only では remux 複製を対象にしない", { skip: !hasFfmpeg() && "ffmpeg/ffprobe が無い" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-remux-"));
  try {
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "ignore" });
    ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1", "-c:v", "libx264", join(dir, "rec.mkv")]);
    ff(["-i", join(dir, "rec.mkv"), "-c", "copy", join(dir, "rec.mp4")]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "rec.mkv" }));

    const logs = await planCleanWithRemuxDup(dir, { logsOnly: true });
    assert.equal(logs.targets.filter((t) => t.category === "remux-dup").length, 0);
    // 既定と --cache-only では対象になる
    for (const opts of [undefined, { cacheOnly: true }]) {
      const p = await planCleanWithRemuxDup(dir, opts);
      assert.equal(p.targets.filter((t) => t.category === "remux-dup").length, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
