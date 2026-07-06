import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import {
  clearCutplanApproval,
  clearShortApproval,
  writeCutplanApproval,
  writeShortApproval,
} from "../src/lib/approval.ts";
import { APPROVAL_FILE } from "../src/lib/files.ts";
import { run } from "../src/lib/exec.ts";
import { bootstrapProject } from "../src/stages/bootstrap.ts";
import { buildProxy, isProxyStale } from "../src/stages/proxy.ts";
import { preview } from "../src/stages/preview.ts";
import { findBgm, render } from "../src/stages/render.ts";
import { validateDocs } from "../src/stages/validate.ts";
import type { Config } from "../src/lib/config.ts";
import {
  applyConfigEdits,
  resolvedEditorCfg,
  syncEditorCfgFromYaml,
  validateConfigPatch,
} from "../src/lib/configEdit.ts";
import type { ConfigPatch } from "../src/lib/configEdit.ts";
import { loadShorts } from "../src/lib/shorts.ts";
import { hasCamera } from "../src/types.ts";
import type {
  AutoCuts,
  Bgm,
  CutPlan,
  Manifest,
  Overlays,
  Shorts,
  Transcript,
} from "../src/types.ts";
import type {
  ConfigSaveResult,
  DraftData,
  ProjectData,
  SaveRequest,
} from "./client/apiTypes.ts";

/**
 * cutflow エディタのローカルサーバー。
 * - エディタ UI(esbuild でその場バンドルした React アプリ)を配信
 * - 収録フォルダの JSON を読み書きする API(正のデータは既存 JSON のまま。
 *   書くのは overlays.json / transcript.json / cutplan.json だけ)
 * - proxy.mp4(元収録の軽量プロキシ)や素材を Range 対応で配信。
 *   カットは焼き込まず Player が keep 区間を飛び飛びに再生する方式なので、
 *   proxy.mp4 は収録ごとに1回作れば編集中の再生成は不要
 */
export async function startEditor(
  dir: string,
  cfg: Config,
  /** 設定画面(POST /api/config)が書き戻す config.yaml のパス */
  cfgPath: string,
): Promise<void> {
  // 動画ファイルだけの収録フォルダでも開けるように、必須3ファイルのうち
  // 無いものだけ決定的に補う(既存ファイルには触れない)。loadProject の
  // 3点チェックは最終防壁として残す
  await bootstrapProject(dir, cfg);

  const editorDir = dirname(fileURLToPath(import.meta.url));

  // クライアントは起動時に一度だけメモリ上へバンドルする(~100ms)
  const bundle = await build({
    entryPoints: [join(editorDir, "client/index.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: "inline",
    target: "es2022",
  });
  const bundleJs = bundle.outputFiles[0].text;
  const indexHtml = readFileSync(join(editorDir, "client/index.html"), "utf8");

  // 編集 JSON の外部変更(Claude Code や手編集)を検知して SSE で通知する。
  // GUI 自身の保存(/api/save)による変更は selfWroteAt で除外し、
  // 連続イベント(エディタの書き込みは複数イベントになる)は少しまとめる
  const hub: EventHub = { clients: new Set() };
  let changed = new Set<string>();
  let notifyTimer: NodeJS.Timeout | null = null;
  watch(dir, (_event, filename) => {
    if (!filename || !WATCHED_FILES.includes(filename)) return;
    if (Date.now() - (selfWroteAt.get(filename) ?? 0) < 1500) return;
    changed.add(filename);
    notifyTimer ??= setTimeout(() => {
      const files = [...changed];
      changed = new Set();
      notifyTimer = null;
      for (const c of hub.clients) c.write(`data: ${JSON.stringify({ files })}\n\n`);
    }, 200);
  });

  const server = createServer((req, res) => {
    handle(req, res, dir, cfg, cfgPath, { bundleJs, indexHtml }, hub).catch((err: Error) => {
      // HttpError は想定内の拒否(不正な保存=400、大きすぎる素材=413 等)。
      // それ以外は想定外なのでログに残して 500 で返す
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: err.message });
    });
  });
  // レンダーは数分かかることがあり、その間 POST /api/render のレスポンスを
  // 保留する。Node 既定の requestTimeout(5分)で接続が切れないよう無効化する
  // (ローカル単一利用のツールなのでスローロリス対策は不要)
  server.requestTimeout = 0;

  const port = Number(process.env.PORT) || 4310;
  await new Promise<void>((ok, ng) => {
    server.once("error", ng);
    server.listen(port, "127.0.0.1", ok);
  });
  const url = `http://127.0.0.1:${port}`;
  console.log(`エディタ起動: ${url}(対象: ${dir})`);
  console.log("終了は Ctrl+C");
  spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
}

/** クライアントへ特定の HTTP ステータスで返す想定内エラー(400 / 413 等)。
 * handle の外側の catch がステータスを見て返す */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 素材アップロードの上限の既定値(config で editor.maxUploadMb 未指定のとき) */
const DEFAULT_MAX_UPLOAD_MB = 2048;

/** エディタが編集する(=外部変更を監視する)ファイル */
const WATCHED_FILES = ["cutplan.json", "overlays.json", "transcript.json", "shorts.json"];
/** 未保存編集の自動退避先(隠しファイル。素材一覧・外部変更の監視の対象外) */
const DRAFT_FILE = ".editor-draft.json";
/** /api/save が最後に各ファイルを書いた時刻。watch の自己イベント除外用 */
const selfWroteAt = new Map<string, number>();

/** SSE(/api/events)の接続中クライアント */
interface EventHub {
  clients: Set<ServerResponse>;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  cfg: Config,
  cfgPath: string,
  assets: { bundleJs: string; indexHtml: string },
  hub: EventHub,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // DNS rebinding・他サイトからの CSRF 対策。ローカル以外の Host は拒否し、
  // POST は Origin ヘッダがローカルのときだけ通す(ブラウザは POST に必ず
  // Origin を付けるので、悪意あるページからの simple request を遮断できる。
  // Origin の無い curl などの非ブラウザは CSRF の対象外なので通す)
  const local = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  if (!local.test(req.headers.host ?? "")) {
    sendJson(res, 403, { error: `forbidden host: ${req.headers.host ?? "(none)"}` });
    return;
  }
  if (req.method !== "GET" && req.headers.origin !== undefined && !local.test(req.headers.origin)) {
    sendJson(res, 403, { error: `forbidden origin: ${req.headers.origin}` });
    return;
  }

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(assets.indexHtml);
    return;
  }
  if (req.method === "GET" && path === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(assets.bundleJs);
    return;
  }
  if (req.method === "GET" && path === "/api/project") {
    sendJson(res, 200, loadProject(dir, cfg));
    return;
  }
  if (req.method === "GET" && path === "/api/events") {
    // 編集 JSON の外部変更を流す SSE。切断まで開きっぱなしにする
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    hub.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 30000);
    req.on("close", () => {
      clearInterval(ping);
      hub.clients.delete(res);
    });
    return;
  }
  if (req.method === "GET" && path === "/api/peaks") {
    const body = await getPeaks(dir, url.searchParams.get("file"));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }
  if (req.method === "POST" && path === "/api/save") {
    const body = (await readBody(req)) as SaveRequest;
    saveProject(dir, body);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === "/api/draft" && (req.method === "POST" || req.method === "DELETE")) {
    // 未保存編集の自動退避(クラッシュへの保険)。正のデータには触らない
    if (req.method === "POST") {
      const body = (await readBody(req)) as DraftData;
      writeFileSync(join(dir, DRAFT_FILE), JSON.stringify(body, null, 2));
    } else {
      rmSync(join(dir, DRAFT_FILE), { force: true });
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && path === "/api/config") {
    // 設定画面の保存。config.yaml を部分更新(コメント保持)し、プロセス内の
    // cfg も更新する(以後の preview / render / proxy に即反映)。
    // ボディの受信は非同期で、その間にジョブが始まると 409 判定をすり抜けかね
    // ない。先にボディを読み切り、以降は同期処理だけにして書き込みの窓を閉じる
    const patch = (await readBody(req)) as ConfigPatch;
    if (heavyJob || proxyBuilding) {
      throw new HttpError(
        409,
        "書き出し・プロキシ生成の実行中は設定を保存できません。完了までお待ちください",
      );
    }
    const errors = validateConfigPatch(patch);
    if (errors.length > 0) {
      throw new HttpError(400, `設定を保存できません: ${errors.join(" / ")}`);
    }
    // 現在のディスク内容(外部編集ぶんを含む)を土台にパッチを当て、一時ファイル
    // + rename でアトミックに置き換える(並行する CLI が半端な YAML を読まない)。
    // メモリ上の cfg も書き込んだ YAML から取り込み直す(外部編集ぶんも反映)
    const nextYaml = applyConfigEdits(readFileSync(cfgPath, "utf8"), patch);
    const tmp = `${cfgPath}.tmp-${process.pid}`;
    writeFileSync(tmp, nextYaml);
    renameSync(tmp, cfgPath);
    syncEditorCfgFromYaml(cfg, nextYaml);
    const result: ConfigSaveResult = {
      ok: true,
      renderCfg: cfg.render,
      previewCfg: { width: cfg.preview.width },
      editorCfg: resolvedEditorCfg(cfg, DEFAULT_MAX_UPLOAD_MB),
    };
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && path === "/api/upload") {
    const saved = await saveUpload(dir, url.searchParams.get("name") ?? "", req, cfg);
    sendJson(res, 200, saved);
    return;
  }
  if (req.method === "DELETE" && path === "/api/material") {
    // 素材ファイルの削除(materials/ 内のみ。トラバーサルは normalize 後の
    // 前方一致で弾く)。タイムラインで参照中かの判定はクライアント側の仕事
    // (未保存の編集を含めた最新の使用状況を知っているのはクライアントだけ)
    const rel = url.searchParams.get("file") ?? "";
    const abs = normalize(join(dir, rel));
    if (!abs.startsWith(join(resolve(dir), "materials") + sep)) {
      throw new HttpError(400, `materials/ 内のファイルだけ削除できます: ${rel}`);
    }
    if (!existsSync(abs)) throw new HttpError(404, `素材が見つかりません: ${rel}`);
    rmSync(abs);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && path === "/api/proxy") {
    // 二重生成防止: 実行中ならその結果を待って同じレスポンスを返す
    proxyBuilding ??= buildProxy(dir, cfg).finally(() => {
      proxyBuilding = null;
    });
    const out = await proxyBuilding;
    sendJson(res, 200, { ok: true, path: out });
    return;
  }
  if (req.method === "POST" && (path === "/api/preview" || path === "/api/render")) {
    // 承認後のプレビュー生成・最終レンダーを GUI から起動する
    // (承認チェックはヘッダーにあるのに、これまでは実行だけターミナルへ
    //  戻る必要があった)。proxy と同じく長時間サブプロセスを走らせ、
    //  完了までレスポンスを保留する。preview / render は入力ファイル一式を
    //  ディスクから読むので、クライアントは実行前に必ず保存(⌘S)する。
    const stage = path === "/api/preview" ? "preview" : "render";
    if (heavyJob && heavyJob.stage !== stage) {
      sendJson(res, 409, {
        error: `${jaStage(heavyJob.stage)}を実行中です。完了までお待ちください`,
      });
      return;
    }
    heavyJob ??= {
      stage,
      promise: (stage === "preview" ? preview(dir, cfg) : render(dir, cfg)).finally(
        () => {
          heavyJob = null;
        },
      ),
    };
    const out = await heavyJob.promise;
    // レンダーは完成物を Finder で開いて教える(ターミナルへ戻らなくてよい)
    if (stage === "render") spawn("open", ["-R", out], { stdio: "ignore" }).on("error", () => {});
    sendJson(res, 200, { ok: true, path: out });
    return;
  }
  if (req.method === "POST" && path === "/api/reveal") {
    // 完了トーストの「開く」から出力先(final.mp4 / preview.mp4 等)を Finder で
    // 開き直す。render は完了時に自動で開くが、preview や2回目以降のために提供。
    // 収録フォルダ内のパスだけ許す(トラバーサルは resolve 後の前方一致で弾く)
    const rel = url.searchParams.get("file") ?? "";
    const abs = normalize(resolve(dir, rel));
    if (abs !== resolve(dir) && !abs.startsWith(resolve(dir) + sep)) {
      throw new HttpError(400, `収録フォルダ内のパスだけ開けます: ${rel}`);
    }
    if (!existsSync(abs)) throw new HttpError(404, `見つかりません: ${rel}`);
    spawn("open", ["-R", abs], { stdio: "ignore" }).on("error", () => {});
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && path.startsWith("/media/")) {
    serveMedia(req, res, dir, decodeURIComponent(path.slice("/media/".length)));
    return;
  }
  sendJson(res, 404, { error: `not found: ${path}` });
}

/** proxy.mp4 の生成(数十秒かかる)の実行中プロミス。二重生成の防止用 */
let proxyBuilding: Promise<string> | null = null;

/** 実行中の重いジョブ(preview / render)。同時に1つだけ走らせ、同じ stage の
 * 二重起動はプロミスを共有、別 stage の要求は 409 で拒否する */
let heavyJob: { stage: "preview" | "render"; promise: Promise<string> } | null = null;

/** ジョブ名の日本語表記(409 メッセージ用) */
const jaStage = (s: string): string => (s === "render" ? "レンダー" : "プレビュー生成");

function loadProject(dir: string, cfg: Config): ProjectData {
  const readJson = <T>(file: string, fallback: T): T => {
    const p = join(dir, file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  };
  const manifest = readJson<Manifest | null>("manifest.json", null);
  const transcript = readJson<Transcript | null>("transcript.json", null);
  const cutplan = readJson<CutPlan | null>("cutplan.json", null);
  if (!manifest || !transcript || !cutplan) {
    throw new Error(
      `${dir} に manifest/transcript/cutplan が揃っていません。` +
        "先にパイプライン(run)を実行してください",
    );
  }
  // 素材選択やオーバーレイの存在チェック用にフォルダ内の全ファイルを渡す
  const dirFiles = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => {
      const parent = (e.parentPath ?? dir).slice(dir.length).replace(/^\//, "");
      return parent ? `${parent}/${e.name}` : e.name;
    })
    .sort();
  // 前回のセッションの未保存編集(自動退避)。壊れていたら無いものとして扱う
  let draft: DraftData | null = null;
  try {
    draft = readJson<DraftData | null>(DRAFT_FILE, null);
    if (draft && !(draft.cutplan && draft.overlays && draft.transcript)) draft = null;
  } catch {
    draft = null;
  }
  return {
    dir,
    manifest,
    transcript,
    cutplan,
    overlays: readJson<Overlays>("overlays.json", {}),
    dirFiles,
    bgm: readJson<Bgm | null>("bgm.json", null),
    bgmFile: findBgm(dir),
    shorts: loadShorts(dir),
    silences: readJson<AutoCuts | null>("cuts.auto.json", null)?.silences ?? null,
    proxyExists: existsSync(join(dir, "proxy.mp4")),
    proxyStale: isProxyStale(dir, cfg),
    renderCfg: cfg.render,
    previewCfg: { width: cfg.preview.width },
    editorCfg: resolvedEditorCfg(cfg, DEFAULT_MAX_UPLOAD_MB),
    output: { w: manifest.video.screenRegion.w, h: manifest.video.screenRegion.h },
    hasCamera: hasCamera(manifest),
    draft,
  };
}

/** 波形の分解能(1秒あたりのピーク数)。16kHz なら 160 サンプル/ピーク */
const PEAK_RATE = 100;
/** ピークのキャッシュ(キー = 対象の相対パス。"" はマイク音声) */
const peaksCache = new Map<string, { key: string; body: string }>();

/**
 * タイムラインの波形表示用に音声のピーク列を作る。
 * rel なし = マイク音声(manifest.audio.micWav、時刻軸は元収録の秒)。
 * rel あり = 収録フォルダ内の素材・BGM(時刻軸はそのファイル自身の秒。
 * ffmpeg でデコードするので mp3 / mp4 等なんでも可。音声が無い・読めない
 * ファイルは空のピークを返す=クライアントは波形を描かないだけ)
 */
async function getPeaks(dir: string, rel: string | null): Promise<string> {
  let abs: string;
  if (rel) {
    abs = normalize(join(dir, rel));
    if (!abs.startsWith(resolve(dir) + sep) || !existsSync(abs)) {
      throw new Error(`not found: ${rel}`);
    }
  } else {
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as Manifest;
    abs = join(dir, manifest.audio.micWav);
  }
  const st = statSync(abs);
  const key = `${abs}:${st.mtimeMs}:${st.size}`;
  const hit = peaksCache.get(rel ?? "");
  if (hit?.key === key) return hit.body;

  let body: string;
  if (rel) {
    try {
      const pcm = await decodeAudio(abs);
      body = peaksBody(pcmToSamples(pcm), 16000, 1);
    } catch (e) {
      // 音声ストリームなし・非対応コーデック等。波形なしとして扱う
      console.warn(`波形をデコードできません(${rel}): ${(e as Error).message}`);
      body = JSON.stringify({ rate: PEAK_RATE, durationSec: 0, peaks: "" });
    }
  } else {
    const { sampleRate, channels, samples } = readWav(abs);
    body = peaksBody(samples, sampleRate, channels);
  }
  peaksCache.set(rel ?? "", { key, body });
  return body;
}

/**
 * サンプル列 → ピーク列 JSON。1/PEAK_RATE 秒ごとの max|sample| を 0..255 に
 * 正規化。基準は最大値ではなく 99.5 パーセンタイル(それ以上はクリップ)——
 * 机を叩いた等の一発の大音量で喋りの波形が潰れないように
 */
function peaksBody(samples: Int16Array, sampleRate: number, channels: number): string {
  const perBin = sampleRate / PEAK_RATE;
  const frames = Math.floor(samples.length / channels);
  const bins = Math.max(1, Math.ceil(frames / perBin));
  const raw = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    let v = 0;
    for (let c = 0; c < channels; c++) {
      const s = Math.abs(samples[f * channels + c]);
      if (s > v) v = s;
    }
    const b = Math.floor(f / perBin);
    if (v > raw[b]) raw[b] = v;
  }
  const sorted = Float64Array.from(raw).sort();
  const ref = sorted[Math.min(bins - 1, Math.floor(bins * 0.995))];
  const peaks = new Uint8Array(bins);
  for (let b = 0; b < bins; b++) {
    peaks[b] = ref > 0 ? Math.min(255, Math.round((raw[b] / ref) * 255)) : 0;
  }
  return JSON.stringify({
    rate: PEAK_RATE,
    durationSec: frames / sampleRate,
    peaks: Buffer.from(peaks).toString("base64"),
  });
}

/** 素材・BGM の音声を ffmpeg で 16kHz mono s16le に落として受け取る */
function decodeAudio(abs: string): Promise<Buffer> {
  return new Promise((ok, ng) => {
    const p = spawn(
      "ffmpeg",
      ["-v", "error", "-i", abs, "-map", "a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", ng);
    p.on("close", (code) => {
      if (code === 0) ok(Buffer.concat(chunks));
      else ng(new Error(err.trim() || `ffmpeg exit ${code}`));
    });
  });
}

/** 生 PCM バイト列 → Int16Array(2 バイト境界に揃えてからビューを作る) */
function pcmToSamples(buf: Buffer): Int16Array {
  const byteLen = buf.length - (buf.length % 2);
  const aligned = new ArrayBuffer(byteLen);
  new Uint8Array(aligned).set(buf.subarray(0, byteLen));
  return new Int16Array(aligned);
}

/** PCM WAV(ingest が書く 16bit)を読む。チャンクを歩いて fmt と data を探す */
function readWav(abs: string): {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
} {
  const buf = readFileSync(abs);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`WAV ではありません: ${abs}`);
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null =
    null;
  let dataStart = -1;
  let dataLen = 0;
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      dataStart = pos + 8;
      dataLen = Math.min(size, buf.length - dataStart);
    }
    pos += 8 + size + (size % 2); // チャンクは 2 バイト境界に揃う
  }
  if (!fmt || dataStart < 0) throw new Error(`WAV のチャンクが不正です: ${abs}`);
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) {
    throw new Error(
      `波形は 16bit PCM WAV のみ対応です(format=${fmt.format}, bits=${fmt.bits}): ${abs}`,
    );
  }
  // Buffer の byteOffset は 2 バイト境界とは限らないので、揃えてからビューを作る
  const byteLen = dataLen - (dataLen % 2);
  const aligned = new ArrayBuffer(byteLen);
  new Uint8Array(aligned).set(buf.subarray(dataStart, dataStart + byteLen));
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    samples: new Int16Array(aligned),
  };
}

const MATERIAL_EXT = /^\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mp3|m4a|wav|aac|ogg|flac)$/;
const VIDEO_EXT = /^\.(mp4|mov|webm)$/;

/** アップロードのバイト列を通しつつ、累積が上限を超えたら 413 で打ち切る。
 * Content-Length が無い(chunked)場合の歯止め */
async function* limitBytes(
  src: AsyncIterable<Buffer>,
  maxBytes: number,
  maxMb: number,
): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of src) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `素材が上限(${maxMb}MB)を超えています`);
    }
    yield chunk;
  }
}

/**
 * 素材のアップロード。リクエストボディ(生バイト列)を materials/ へ保存し、
 * 動画なら ffprobe で長さを測って返す(エディタが区間の初期長に使う)。
 * 同名ファイルがあれば -2, -3 … と付けて衝突を避ける
 */
async function saveUpload(
  dir: string,
  rawName: string,
  req: IncomingMessage,
  cfg: Config,
): Promise<{ file: string; durationSec: number | null }> {
  // パス区切りや先頭ドットを潰したファイル名だけを使う(トラバーサル対策)
  const safe = basename(rawName).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "");
  const ext = extname(safe).toLowerCase();
  if (!MATERIAL_EXT.test(ext)) {
    throw new Error(`素材にできない拡張子です: ${rawName}(画像か mp4/mov/webm 動画)`);
  }
  // ローカル限定サーバーだが、暴走したアップロードでディスクを埋めない歯止め。
  // Content-Length があれば書き始める前に、無くてもストリーム中で上限を超えたら
  // 弾く(書きかけの不完全ファイルは消す)
  const maxMb = cfg.editor?.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB;
  const maxBytes = maxMb * 1024 * 1024;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `素材が上限(${maxMb}MB)を超えています`);
  }
  const stem = safe.slice(0, -ext.length) || "material";
  mkdirSync(join(dir, "materials"), { recursive: true });
  let name = `${stem}${ext}`;
  for (let i = 2; existsSync(join(dir, "materials", name)); i++) {
    name = `${stem}-${i}${ext}`;
  }
  const abs = join(dir, "materials", name);
  try {
    await pipeline(limitBytes(req, maxBytes, maxMb), createWriteStream(abs));
  } catch (e) {
    rmSync(abs, { force: true }); // 途中まで書いた不完全ファイルを残さない
    throw e;
  }

  let durationSec: number | null = null;
  if (VIDEO_EXT.test(ext)) {
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        abs,
      ]);
      const d = Number.parseFloat(stdout.trim());
      if (Number.isFinite(d) && d > 0) durationSec = Math.round(d * 100) / 100;
    } catch {
      // 長さが取れなくても保存自体は成功として返す
    }
  }
  return { file: `materials/${name}`, durationSec };
}

/** 編集結果の保存。渡されたドキュメントだけを書く(それ以外のファイルは不可侵) */
function saveProject(dir: string, body: SaveRequest): void {
  // 書く前に CLI の validate と同じ純粋検査を通す。GUI が壊れた JSON を書き、
  // preview / render で数分後に気づく事故を防ぐ。ディスクの現状(manifest や
  // 変更していないファイル)に body の変更を重ねた状態を検査する
  const readDisk = (file: string): unknown => {
    const p = join(dir, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  const { errors } = validateDocs(dir, {
    manifest: readDisk("manifest.json"),
    cutplan: body.cutplan ?? readDisk("cutplan.json"),
    transcript: body.transcript ?? readDisk("transcript.json"),
    overlays: body.overlays ?? readDisk("overlays.json"),
    bgm: body.bgm !== undefined ? body.bgm : readDisk("bgm.json"),
    chapters: readDisk("chapters.json"),
    meta: readDisk("meta.json"),
    shorts: body.shorts !== undefined ? body.shorts : readDisk("shorts.json"),
    thumbnail: readDisk("thumbnail.json"),
  });
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ");
    throw new HttpError(400, `保存できません(整合性エラー ${errors.length}件): ${detail}`);
  }

  const write = (file: string, data: CutPlan | Overlays | Transcript | Bgm | Shorts) => {
    selfWroteAt.set(file, Date.now());
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  };
  if (body.cutplan) {
    write("cutplan.json", body.cutplan);
    // 承認レコード(approvals.json)の mint/clear。GUI は「人間が起動した
    // プロセスが人間のチェックで書く」= 分離層の権威側(設計 §1.3 / §8)。
    // approved トグルに応じてハッシュ束縛レコードを作る/消す
    selfWroteAt.set(APPROVAL_FILE, Date.now());
    if (body.cutplan.approved) writeCutplanApproval(dir, body.cutplan, "gui");
    else clearCutplanApproval(dir);
  }
  if (body.overlays) write("overlays.json", body.overlays);
  if (body.transcript) write("transcript.json", body.transcript);
  // BGM: 区間があれば bgm.json を書き、null / 空なら削除して全編1曲(後方互換)へ戻す
  if (body.bgm !== undefined) {
    if (body.bgm && body.bgm.tracks.length > 0) {
      write("bgm.json", body.bgm);
    } else {
      const p = join(dir, "bgm.json");
      if (existsSync(p)) {
        selfWroteAt.set("bgm.json", Date.now());
        rmSync(p);
      }
    }
  }
  // ショート: 1件以上あれば shorts.json を書き、無ければ削除する(bgm と同型)
  if (body.shorts !== undefined) {
    if (body.shorts && body.shorts.shorts.length > 0) {
      write("shorts.json", body.shorts);
      // 各ショートの approved トグルに応じて name 別の承認レコードを mint/clear
      selfWroteAt.set(APPROVAL_FILE, Date.now());
      for (const short of body.shorts.shorts) {
        if (short.approved) writeShortApproval(dir, short, "gui");
        else clearShortApproval(dir, short.name);
      }
    } else {
      const p = join(dir, "shorts.json");
      if (existsSync(p)) {
        selfWroteAt.set("shorts.json", Date.now());
        rmSync(p);
      }
    }
  }
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

/** 収録フォルダのファイル配信。動画のシークに必要な Range リクエスト対応 */
function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  rel: string,
): void {
  const abs = normalize(join(dir, rel));
  if (!abs.startsWith(resolve(dir) + sep) || !existsSync(abs)) {
    sendJson(res, 404, { error: `not found: ${rel}` });
    return;
  }
  const st = statSync(abs);
  const size = st.size;
  // no-store だと <video> 要素ごと・シークごとに同じバイト列を毎回取り直し、
  // カット境界の先読み(premount)が重くなる。再検証付きキャッシュ(no-cache
  // + ETag)なら、ファイルが変わらない限り 304 で済み、proxy.mp4 や素材を
  // 作り直した瞬間に ETag が変わって古いキャッシュは自然に外れる
  const etag = `"${size}-${Math.round(st.mtimeMs)}"`;
  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    // suffix 形式(bytes=-N)は末尾 N バイト。end はファイル末尾へ丸める(RFC 9110)
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    });
    createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": String(size) });
    createReadStream(abs).pipe(res);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
