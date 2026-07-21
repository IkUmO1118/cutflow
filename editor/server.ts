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
import type { FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { renderCfgWithDesign } from "../src/lib/designAsset.ts";
import { resolveDesign } from "../src/lib/design.ts";
import { existingDesignAssets, prepareDesignAssetBundle } from "../src/lib/designStill.ts";
import {
  buildEditorClientAssets,
  createEditorClientReloader,
  editorAssetResponse,
} from "./clientBuild.ts";
import type { MutableEditorClientAssets } from "./clientBuild.ts";
import {
  clearCutplanApproval,
  clearShortApproval,
  writeCutplanApproval,
  writeShortApproval,
} from "../src/lib/approval.ts";
import {
  checkBaseHashes,
  contentHashesOf,
  DOC_FILE,
  fileContentHash,
  hashOfString,
  isExternalChange,
} from "../src/lib/contentVersion.ts";
import { removeEditorServeFile, writeEditorServeFile } from "../src/lib/editorServe.ts";
import { run } from "../src/lib/exec.ts";
import { classifyBrowserDisplayable } from "../src/lib/mediaCodec.ts";
import type { DisplayVerdict, VideoCodecFacts } from "../src/lib/mediaCodec.ts";
import { ensureIds, hasAnyId, ID_PREFIX, usedIdsOf } from "../src/lib/ids.ts";
import { mergeBodyOverDisk } from "../src/lib/applyEdits.ts";
import { bootstrapProjectWithLayout } from "../src/stages/bootstrap.ts";
import { EditorAiError, proposeEditorAi, refineEditorAi } from "../src/stages/editorAi.ts";
import type { AiProposeResponse as EditorAiStageProposeResponse } from "../src/stages/editorAi.ts";
import { reviewSpecOfProposalReview } from "../src/lib/editorAiReview.ts";
import { frames } from "../src/stages/frames.ts";
import { buildProxy, isProxyStale } from "../src/stages/proxy.ts";
import { preview } from "../src/stages/preview.ts";
import { buildPreviewCut } from "../src/stages/previewCut.ts";
import {
  buildPreviewCutCacheKey,
  inspectPreviewCutFreshness,
  previewCutKeepSignature,
} from "../src/lib/previewCutCache.ts";
import { findBgm, render } from "../src/stages/render.ts";
import { reviewEdit } from "../src/stages/review.ts";
import { validateDocs } from "../src/stages/validate.ts";
import { aiDoctor } from "../src/stages/aiDoctor.ts";
import {
  authorHyperframe,
  hyperframeCacheKey,
  renderHyperframe,
  resolveHyperframeBuild,
} from "../src/stages/hyperframe.ts";
import { parseComposition } from "../src/lib/hyperframe.ts";
import { HYPERFRAME_FONT_MAX_BYTES } from "../src/lib/hyperframeAssets.ts";
import { resolveHyperframeRenderProfile } from "../src/lib/hyperframeRenderProfile.ts";
import {
  HYPERFRAME_NAME_RE,
  hyperframeAuthorConflict,
  validateHyperframeAuthorRequest,
} from "../src/lib/hyperframeAuthor.ts";
import { readEditableDocs } from "../src/stages/idStamp.ts";
import { aiProfileStatuses, profileForRoute, resolveAiReviewCfg, resolveAiRuntimeConfig, resolveHyperframeAssetLimits, resolvePerceptionStatus } from "../src/lib/config.ts";
import type { Config } from "../src/lib/config.ts";
import {
  applyConfigEdits,
  resolvedEditorCfg,
  syncEditorCfgFromYaml,
  validateConfigPatch,
} from "../src/lib/configEdit.ts";
import type { ConfigPatch } from "../src/lib/configEdit.ts";
import { loadShorts } from "../src/lib/shorts.ts";
import { hasCamera, manifestCompositionFps } from "../src/types.ts";
import { applyProposalResolution, proposalDiff } from "../src/lib/docDiff.ts";
import { snapshotOfReviewDocs, validateReviewSpec } from "../src/lib/review.ts";
import { supportsImageReview } from "../src/lib/llm.ts";
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
  HyperframeCard,
  HyperframeAuthorRequest,
  HyperframeRenderRequest,
  AiFrameRequest,
  AiProposeRequest,
  AiRefineRequest,
  AiReviewRequest,
  ProjectData,
  PreviewCutRequest,
  PreviewCutResponse,
  SaveRequest,
  ScriptData,
  ScriptSegment,
} from "./client/apiTypes.ts";
import { buildWords } from "../src/stages/transcribe.ts";
import type { WhisperToken } from "../src/stages/transcribe.ts";
import { DEFAULT_SILENCE_CUT_REASON } from "../src/lib/buildCutplan.ts";
import type { EditableDocs } from "../src/lib/ids.ts";
import type { ReviewDocs } from "../src/lib/docDiff.ts";
import type { ReviewSpec } from "../src/lib/review.ts";
import type { DeterministicReviewObservation } from "../src/lib/reviewObservation.ts";
import type { SecondaryObservation } from "../src/lib/vlmObservation.ts";

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
  layout?: "obs-canvas" | "plain" | "auto",
): Promise<void> {
  // 動画ファイルだけの収録フォルダでも開けるように、必須3ファイルのうち
  // 無いものだけ決定的に補う(既存ファイルには触れない)。loadProject の
  // 3点チェックは最終防壁として残す
  await bootstrapProjectWithLayout(dir, cfg, layout);
  await prepareEditorDesignAssets(dir, cfg);

  const editorDir = dirname(fileURLToPath(import.meta.url));

  // JS/CSS/HTML は起動時に全てメモリ上へ生成する。以後の client 変更も
  // 3成果物が揃った revision だけを一括 publish し、失敗時は直前の成功版を配る。
  const assets: MutableEditorClientAssets = {
    current: await buildEditorClientAssets(editorDir, 1),
  };
  const clientReloader = createEditorClientReloader({
    assets,
    build: async (revision) => await buildEditorClientAssets(editorDir, revision),
    onSwap: (next) => console.log(`エディタ UI を再ビルドしました(revision ${next.revision})`),
    onError: (error) => console.error(
      `エディタ UI の再ビルドに失敗しました。revision ${assets.current.revision} を継続配信します。`,
      error,
    ),
  });
  let clientWatcher: FSWatcher | null = null;

  // 編集 JSON の外部変更(Claude Code や手編集)を検知して SSE で通知する。
  // GUI 自身の保存(/api/save)による変更は lastWrittenHash(自分が最後に
  // 書いた内容のハッシュ)との内容一致で除外する(時間窓ではない。§8.3)。
  // 連続イベント(エディタの書き込みは複数イベントになる)は少しまとめる
  const hub: EventHub = { clients: new Set() };
  let changed = new Set<string>();
  let notifyTimer: NodeJS.Timeout | null = null;
  watch(dir, (_event, filename) => {
    if (!filename || !WATCHED_FILES.includes(filename)) return;
    changed.add(filename);
    notifyTimer ??= setTimeout(() => {
      const candidates = [...changed];
      changed = new Set();
      notifyTimer = null;
      // フラッシュ時(書き込み完了後)に現ディスク内容をハッシュし、
      // 自分が最後に書いた内容と違うものだけを「外部変更」として流す。
      const files = candidates.filter((f) =>
        isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
      );
      if (files.length === 0) return;
      invalidateStoredProposals();
      for (const c of hub.clients) c.write(`data: ${JSON.stringify({ files })}\n\n`);
    }, 200);
  });

  const server = createServer((req, res) => {
    handle(req, res, dir, cfg, cfgPath, assets, hub).catch((err: Error) => {
      // HttpError は想定内の拒否(不正な保存=400、大きすぎる素材=413 等)。
      // それ以外は想定外なのでログに残して 500 で返す
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        return;
      }
      if (err instanceof EditorAiError) {
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

  // port conflict 等で listen 自体が失敗した場合に watcher を残さないよう、
  // client の監視は待受成功後にだけ開始する。watch 開始が同期的に失敗した
  // 場合も active server を残さず fail fast する。
  try {
    clientWatcher = watch(join(editorDir, "client"), { recursive: true }, () => {
      clientReloader.schedule();
    });
    clientWatcher.on("error", (error) => {
      console.error("editor/client の監視に失敗しました。", error);
    });
  } catch (error) {
    clientReloader.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw error;
  }

  // 待受情報を収録フォルダの外(~/.cutflow/editor/)へ書く。デタッチ起動でも
  // フォアグラウンド起動でも同じように書くので、`editor <dir> --status` は
  // どちらの起動でも見える。プロセスがどの経路で終わっても最終段で必ず発火する
  // "exit" で同期的に消す(framesServe と同じ判断。async は exit 中に走らない)
  writeEditorServeFile({ dir, port, pid: process.pid, startedAt: new Date().toISOString() });
  process.on("exit", () => {
    clientReloader.close();
    clientWatcher?.close();
    removeEditorServeFile(dir);
  });
  // シグナルで殺された場合、Node は "exit" を発火しない(既定ハンドラはプロセスを
  // そのまま終了させる)。Ctrl+C(SIGINT)と `editor --stop`(SIGTERM)を明示的に
  // 受けて process.exit を呼び、上の "exit" を必ず通して portfile を消す。
  // (framesServe が SIGINT を書かずに済んでいるのは、remotion の openBrowser が
  //  SIGINT リスナーで process.exit を呼んでいるため。エディタにはそれが無い)
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(0));

  const url = `http://127.0.0.1:${port}`;
  console.log(`エディタ起動: ${url}(対象: ${dir})`);
  console.log("終了は Ctrl+C");
  spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
}

/** クライアントへ特定の HTTP ステータスで返す想定内エラー(400 / 413 等)。
 * handle の外側の catch がステータスを見て返す */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 素材アップロードの上限の既定値(config で editor.maxUploadMb 未指定のとき) */
const DEFAULT_MAX_UPLOAD_MB = 2048;
/** brief を含む単発 author request の JSON 上限。 */
const HYPERFRAME_AUTHOR_JSON_OVERHEAD_BYTES = 256 * 1024;

/** エディタが編集する(=外部変更を監視する)ファイル */
const WATCHED_FILES = [
  "cutplan.json",
  "overlays.json",
  "transcript.json",
  "bgm.json",
  "shorts.json",
  "chapters.json",
  "meta.json",
  "thumbnail.json",
];
/** 未保存編集の自動退避先(隠しファイル。素材一覧・外部変更の監視の対象外) */
const DRAFT_FILE = ".editor-draft.json";
/** /api/save が各ファイルに最後に書いた内容ハッシュ(削除は null)。
 *  watch の自己エコー除外に使う(時間窓ではなく内容一致で判定する。§8.3)。
 *  値は "sha256:..."(書いた) / null(自分で削除した) / キー無し(一度も書いていない) */
const lastWrittenHash = new Map<string, string | null>();

/** SSE(/api/events)の接続中クライアント */
interface EventHub {
  clients: Set<ServerResponse>;
}

interface StoredProposal {
  proposalId: string;
  proposal: EditorAiStageProposeResponse;
  normalizedReviewSpec: ReviewSpec;
  baseDocs: ReviewDocs;
  baseDocsHash: string;
  activeShortName: string | null;
  instruction: string;
  parentProposalId: string | null;
  refinementIteration: number;
  lineageExpiresAtMs: number;
  lastReview?: {
    key: { candidateHash: string; specHash: string; acceptedLabelsHash: string };
    acceptedHunkLabels: string[];
    primary: DeterministicReviewObservation;
    secondary?: SecondaryObservation;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_PROPOSALS = 32;
const PROPOSAL_EXPIRED_CODE = "proposal_expired";
const PROPOSAL_STALE_CODE = "proposal_stale";
const SECONDARY_OBSERVATION_UNAVAILABLE_CODE = "SECONDARY_OBSERVATION_UNAVAILABLE";

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  cfg: Config,
  cfgPath: string,
  assets: MutableEditorClientAssets,
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

  const clientAsset = req.method === "GET"
    ? editorAssetResponse(path, assets.current)
    : null;
  if (clientAsset) {
    res.writeHead(200, clientAsset.headers);
    res.end(clientAsset.body);
    return;
  }
  if (req.method === "GET" && path === "/particle_loop_icon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "client/particle_loop_icon.svg"), "utf8"));
    return;
  }
  if (req.method === "GET" && path === "/api/ping") {
    // 生存確認(editor --stop / --status が portfile の pid/port を検証する)。
    // dir も返すのは、portfile が stale で別プロセスが同じ port を掴んでいる
    // ケースを取り違えないため
    sendJson(res, 200, { ok: true, pid: process.pid, dir });
    return;
  }
  if (req.method === "GET" && path === "/api/project") {
    sendJson(res, 200, loadProject(dir, cfg));
    return;
  }
  if (req.method === "GET" && path === "/api/script") {
    // スクリプトタブ(文字ベース編集)の元データ。/api/project に含めないのは
    // whisper-out.json が大きい(数百KB〜)ため=タブを開いたときだけ読む
    sendJson(res, 200, loadScript(dir));
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
  if (req.method === "GET" && path === "/api/media-facts") {
    // materials/ の動画素材を ffprobe して codec を調べる。/api/project に
    // 含めないのは loadProject が sync なため(§design 8.2)。/api/script /
    // /api/peaks と同じ「重い/遅い部分は要求されてから」の流儀
    const mediaCodecFacts = await collectMediaCodecFacts(dir);
    sendJson(res, 200, { mediaCodecFacts });
    return;
  }
  if (req.method === "GET" && path === "/api/hyperframes") {
    sendJson(res, 200, {
      hyperframes: loadHyperframeCards(dir),
      assetLimits: {
        ...resolveHyperframeAssetLimits(cfg),
        fontMaxBytes: HYPERFRAME_FONT_MAX_BYTES,
      },
    });
    return;
  }
  if (req.method === "POST" && path === "/api/hyperframe/author") {
    const assetLimits = resolveHyperframeAssetLimits(cfg);
    const maxBodyBytes = Math.ceil(assetLimits.maxTotalBytes * 4 / 3) +
      HYPERFRAME_AUTHOR_JSON_OVERHEAD_BYTES;
    const body = await readBody(req, maxBodyBytes) as HyperframeAuthorRequest;
    const requestErrors = validateHyperframeAuthorRequest(body);
    if (requestErrors.length > 0) throw new HttpError(400, requestErrors.join(" / "));
    if (Buffer.byteLength(body.brief, "utf8") > HYPERFRAME_AUTHOR_JSON_OVERHEAD_BYTES) {
      throw new HttpError(413, "作りたい内容が長すぎます");
    }
    ensureHyperframeAuthorNameAvailable(dir, body.name);
    await runHeavyJob(
      "hyperframe-author",
      `hyperframe-author:${randomUUID()}`,
      async () => {
        // validation 後〜heavy job 獲得までに agent/別requestが生成する race も
        // 上書きしないよう、唯一の author 実行点で再確認する。
        ensureHyperframeAuthorNameAvailable(dir, body.name);
        await authorHyperframe(dir, cfg, {
          name: body.name,
          brief: body.brief.trim(),
          assets: (body.assets ?? []).map((asset) => ({
            name: asset.name,
            bytes: Buffer.from(asset.data, "base64"),
          })),
        });
        await renderHyperframe(dir, { name: body.name, cliVars: {} });
      },
    );
    const card = loadHyperframeCards(dir).find((item) => item.name === body.name);
    if (!card) throw new Error(`生成後の素材が見つかりません: ${body.name}`);
    sendJson(res, 200, { ok: true, card });
    return;
  }
  if (req.method === "POST" && path === "/api/hyperframe/render") {
    const body = await readBody(req) as HyperframeRenderRequest;
    const requestErrors = validateHyperframeRenderRequest(body);
    if (requestErrors.length > 0) throw new HttpError(400, requestErrors.join(" / "));
    if (!existsSync(join(dir, "hyperframes", `${body.name}.html`))) {
      throw new HttpError(404, `素材「${body.name}」の生成元がありません`);
    }
    const result = await runHeavyJob(
      "hyperframe-render",
      `hyperframe-render:${body.name}`,
      () => renderHyperframe(dir, { name: body.name, cliVars: {} }),
    );
    const card = loadHyperframeCards(dir).find((item) => item.name === body.name);
    if (!card) throw new Error(`作り直した素材が見つかりません: ${body.name}`);
    sendJson(res, 200, { ok: true, card, skipped: result.skipped });
    return;
  }
  if (req.method === "POST" && path === "/api/save") {
    // checkBaseHashes は(src/lib/contentVersion.ts が editor 固有の型に依存
    // しないよう)body を Record<string, unknown> として読む。SaveRequest は
    // interface(index signature 無し)なので、その交差型として cast する
    const body = (await readBody(req)) as SaveRequest & Record<string, unknown>;
    if (heavyJob) {
      throw new HttpError(409, `${jaStage(heavyJob.stage)}を実行中です。完了までお待ちください`);
    }
    // 内容バージョンゲート: baseHashes が付いていれば、書き込み対象ファイルの
    // 現ディスク内容が client が読んだ版と一致するときだけ通す(§8.3)。
    // baseHashes 無し(旧 client / プログラム的呼び出し)は従来どおり無条件。
    const { stale } = checkBaseHashes(dir, body);
    if (stale.length > 0) {
      throw new HttpError(
        409,
        `外部で変更されたファイルがあります: ${stale.join(", ")}`,
        "stale_base",
      );
    }
    saveProject(dir, body);
    invalidateStoredProposals();
    // 書き込み後の新しい内容ハッシュ(削除したファイルは null)。client は
    // reload せずにこれで base を更新する。
    const contentHashes = hashesForBody(dir, body);
    sendJson(res, 200, { ok: true, contentHashes });
    return;
  }
  if (req.method === "POST" && path === "/api/ai/propose") {
    const body = (await readBody(req)) as AiProposeRequest;
    const key = `propose:${sha256Hex(stableCanonicalize(body))}`;
    const record = await runHeavyJob("propose", key, async () => {
      const proposal = await proposeEditorAi(dir, cfg, body);
      const base = currentReviewDocs(dir);
      const spec = reviewSpecOfProposalReview(proposal.review);
      if (!spec) throw new HttpError(400, "比較対象の review.frames がありません");
      const specProblems = validateReviewSpec(spec);
      if (specProblems.length > 0) {
        throw new HttpError(400, specProblems.map((problem) => `${problem.where}: ${problem.message}`).join(" / "));
      }
      return storeProposal(
        proposal,
        body.instruction,
        base,
        spec,
        hashEditableDocsState(currentEditableDocs(dir)),
        body.activeShortName ?? null,
      );
    });
    sendJson(res, 200, { proposalId: record.proposalId, proposal: record.proposal });
    return;
  }
  if (req.method === "POST" && path === "/api/ai/review") {
    const body = (await readBody(req, 4 * 1024 * 1024)) as AiReviewRequest;
    const requestErrors = validateReviewRequest(body);
    if (requestErrors.length > 0) throw new HttpError(400, requestErrors.join(" / "));
    const record = getStoredProposal(body.proposalId);
    const secondaryObservation = body.secondaryObservation === "vlm" ? "vlm" : "none";
    const key = `review:${reviewRequestKey(record, body.acceptedHunkLabels, cfg, secondaryObservation)}`;
    if (proxyBuilding) await proxyBuilding;
    const bundle = await runHeavyJob("review", key, async () => {
      const currentHash = hashEditableDocsState(currentEditableDocs(dir));
      if (currentHash !== record.baseDocsHash) {
        expireStoredProposal(record.proposalId);
        throw new HttpError(409, "proposal の基準状態が変化しました。再提案してください", PROPOSAL_STALE_CODE);
      }
      const candidate = buildAiReviewCandidateFromStoredProposal(dir, record, body.acceptedHunkLabels);
      const bundle = await reviewEdit(
        dir,
        cfg,
        snapshotOfReviewDocs(record.baseDocs),
        snapshotOfReviewDocs(candidate),
        record.normalizedReviewSpec,
        {
          shortName: record.activeShortName ?? undefined,
          secondaryObservation,
        },
      );
      const finalHash = hashEditableDocsState(currentEditableDocs(dir));
      if (finalHash !== record.baseDocsHash) {
        rmSync(join(dir, "review.probe"), { recursive: true, force: true });
        expireStoredProposal(record.proposalId);
        throw new HttpError(409, "proposal の基準状態が変化しました。再提案してください", PROPOSAL_STALE_CODE);
      }
      bundle.key.proposalId = record.proposalId;
      bundle.key.acceptedLabelsHash = acceptedLabelsHash(body.acceptedHunkLabels);
      bundle.key.acceptedLabels = [...new Set(body.acceptedHunkLabels)].sort();
      bundle.key.baseHash = record.baseDocsHash;
      bundle.key.candidateHash = hashReviewDocs(candidate);
      record.lastReview = {
        key: {
          candidateHash: bundle.key.candidateHash,
          specHash: bundle.key.specHash,
          acceptedLabelsHash: bundle.key.acceptedLabelsHash,
        },
        acceptedHunkLabels: [...new Set(body.acceptedHunkLabels)].sort(),
        primary: bundle.observation,
        ...(bundle.secondaryObservation ? { secondary: bundle.secondaryObservation } : {}),
      };
      return bundle;
    });
    sendJson(res, 200, { bundle });
    return;
  }
  if (req.method === "POST" && path === "/api/ai/refine") {
    const body = (await readBody(req, 4 * 1024 * 1024)) as AiRefineRequest;
    const requestErrors = validateRefineRequest(body);
    if (requestErrors.length > 0) throw new HttpError(400, requestErrors.join(" / "));
    const record = getStoredProposal(body.proposalId);
    const additionalInstruction = body.instruction?.trim() || undefined;
    const nextInstruction = refinedInstruction(record.instruction, additionalInstruction);
    const key = `refine:${refineRequestKey(record, body)}`;
    if (proxyBuilding) await proxyBuilding;
    const next = await runHeavyJob("propose", key, async () => {
      const currentHash = hashEditableDocsState(currentEditableDocs(dir));
      if (currentHash !== record.baseDocsHash) {
        expireStoredProposal(record.proposalId);
        throw new HttpError(409, "proposal の基準状態が変化しました。再提案してください", PROPOSAL_STALE_CODE);
      }
      if (body.vlm === true) ensureRefineVlmAvailable(cfg);
      const candidate = buildAiReviewCandidateFromStoredProposal(dir, record, body.acceptedHunkLabels);
      const priorDiff = proposalDiff(record.baseDocs, record.proposal.proposedDocs);
      const acceptedHunkLabels = [...new Set(body.acceptedHunkLabels)].sort();
      const acceptedLabelSet = new Set(acceptedHunkLabels);
      const rejectedHunkLabels = priorDiff.hunks
        .map((hunk) => hunk.address.label)
        .filter((label) => !acceptedLabelSet.has(label))
        .sort();
      const applyWarnings = record.proposal.applyPlan.warnings.map((warning) =>
        `${warning.file} ${warning.where}: ${warning.message}`
      );
      const bundle = await reviewEdit(
        dir,
        cfg,
        snapshotOfReviewDocs(record.baseDocs),
        snapshotOfReviewDocs(candidate),
        record.normalizedReviewSpec,
        {
          shortName: record.activeShortName ?? undefined,
          secondaryObservation: body.vlm === true ? "vlm" : "none",
        },
      );
      if (body.vlm === true && !bundle.secondaryObservation) {
        throw new HttpError(
          422,
          "画像を使った再提案を実行できませんでした。vision provider の設定を確認してください",
          SECONDARY_OBSERVATION_UNAVAILABLE_CODE,
        );
      }
      const finalHash = hashEditableDocsState(currentEditableDocs(dir));
      if (finalHash !== record.baseDocsHash) {
        rmSync(join(dir, "review.probe"), { recursive: true, force: true });
        expireStoredProposal(record.proposalId);
        throw new HttpError(409, "proposal の基準状態が変化しました。再提案してください", PROPOSAL_STALE_CODE);
      }
      const proposal = await refineEditorAi(dir, cfg, {
        mode: body.mode ?? "normal",
        originalInstruction: record.instruction,
        additionalInstruction,
        baseDocs: deepClone(record.baseDocs),
        candidateDocs: snapshotOfReviewDocs(candidate),
        applyWarnings,
        acceptedHunkLabels,
        rejectedHunkLabels,
        priorProposalDiff: priorDiff.hunks.map((hunk) => ({
          label: hunk.address.label,
          kind: hunk.kind,
          current: hunk.mine,
          proposed: hunk.theirs,
        })),
        priorProposal: cloneProposal(record.proposal),
        reviewBundle: {
          observation: deepClone(bundle.observation),
          ...(bundle.secondaryObservation
            ? {
                vlm: {
                  summary: deepClone(bundle.secondaryObservation.summary),
                  observations: deepClone(bundle.secondaryObservation.items),
                  confidence: bundle.secondaryObservation.confidence,
                },
              }
            : {}),
        },
      });
      const spec = reviewSpecOfProposalReview(proposal.review);
      if (!spec) throw new HttpError(400, "比較対象の review.frames がありません");
      const specProblems = validateReviewSpec(spec);
      if (specProblems.length > 0) {
        throw new HttpError(400, specProblems.map((problem) => `${problem.where}: ${problem.message}`).join(" / "));
      }
      return storeProposal(
        proposal,
        nextInstruction,
        record.baseDocs,
        spec,
        record.baseDocsHash,
        record.activeShortName,
        record.proposalId,
        record.refinementIteration + 1,
        record.lineageExpiresAtMs,
      );
    });
    sendJson(res, 200, { proposalId: next.proposalId, proposal: next.proposal });
    return;
  }
  if (req.method === "POST" && path === "/api/ai/frames") {
    const body = (await readBody(req)) as AiFrameRequest;
    if (!Array.isArray(body.times) || body.times.length === 0 || body.times.length > 8) {
      throw new HttpError(400, "frames の確認時刻は 1〜8 件で指定してください");
    }
    const times = body.times.map(Number);
    if (times.some((t) => !Number.isFinite(t) || t < 0)) {
      throw new HttpError(400, "frames の確認時刻は 0 以上の数値で指定してください");
    }
    if (heavyJob) {
      throw new HttpError(409, `${jaStage(heavyJob.stage)}を実行中です。完了までお待ちください`);
    }
    if (proxyBuilding) await proxyBuilding;
    const shots = await frames(
      dir,
      { mode: "times", times, axis: body.axis ?? "source" },
      cfg,
      body.activeShortName ?? undefined,
      body.ocr === true,
      body.fullRes === true,
    );
    sendJson(res, 200, { shots });
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
    await prepareEditorDesignAssets(dir, cfg);
    const result: ConfigSaveResult = {
      ok: true,
      renderCfg: renderCfgWithDesign(dir, cfg),
      ...editorDesignAssets(dir, cfg),
      previewCfg: { width: cfg.preview.width, videoEncoder: cfg.preview.videoEncoder },
      editorCfg: resolvedEditorCfg(cfg, DEFAULT_MAX_UPLOAD_MB),
      aiProfiles: aiProfileStatuses(cfg),
      aiRoutes: resolveAiRuntimeConfig(cfg).routes,
      aiReviewCfg: {
        ...resolveAiReviewCfg(cfg),
        maxRefinements: Math.min(3, Math.max(1, (cfg.editor?.aiReview as { maxRefinements?: number } | undefined)?.maxRefinements ?? 2)),
      },
    };
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && path === "/api/ai/doctor") {
    const body = (await readBody(req)) as { route?: "text" | "structured" | "vision" };
    sendJson(res, 200, await aiDoctor(cfg, { route: body.route }));
    return;
  }
  if (req.method === "POST" && path === "/api/upload") {
    const saved = await saveUpload(dir, url.searchParams.get("name") ?? "", req, cfg);
    sendJson(res, 200, saved);
    return;
  }
  if (req.method === "DELETE" && path === "/api/hyperframe") {
    // AI 生成素材(カード)を丸ごと削除する(source html / raw 応答 / 添付素材 /
    // render 済み MP4 / キャッシュキー)。MP4 だけ消すと一覧に「未 render」の
    // 抜け殻が残るため、ユーザーの「削除」はカード単位で扱う。タイムラインで
    // 参照中かの判定は /api/material と同じくクライアント側の仕事
    const name = url.searchParams.get("name") ?? "";
    if (!HYPERFRAME_NAME_RE.test(name)) {
      throw new HttpError(400, `カード名が不正です: ${name}`);
    }
    const targets = [
      join(dir, "hyperframes", `${name}.html`),
      join(dir, "hyperframes", `${name}.raw.txt`),
      join(dir, "hyperframes", `${name}.assets`),
      join(dir, "materials", "hyperframes", `${name}.mp4`),
      join(dir, `hyperframe.${name}.key.json`),
    ];
    const present = targets.filter((p) => existsSync(p));
    if (present.length === 0) throw new HttpError(404, `カードが見つかりません: ${name}`);
    for (const p of present) rmSync(p, { recursive: true });
    sendJson(res, 200, { ok: true });
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
  if (req.method === "POST" && path === "/api/preview-cut") {
    const body = await readBody(req);
    const result = await executePreviewCutRequest(dir, cfg, body, {
      // proxy build が先に始まっていれば、atomic publish 完了後の stat/key で
      // enqueue する。失敗時はその error を返し、古い proxy は読まない。
      waitForProxy: async () => {
        if (proxyBuilding) await proxyBuilding;
      },
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && path === "/api/proxy") {
    // 二重生成防止: 実行中ならその結果を待って同じレスポンスを返す。
    // promise を preview queue 待機前に登録することで、新しい preview-cut
    // request もこの proxy 完了を待ち、proxy の読み書きが重ならない。
    proxyBuilding ??= (async () => {
      await previewCutQueue.waitForIdle();
      return await buildProxy(dir, cfg);
    })().finally(() => {
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
    const out = await runHeavyJob(stage, stage, () =>
      stage === "preview" ? preview(dir, cfg) : render(dir, cfg),
    ) as string;
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

type PreviewCutBuildResult = Awaited<ReturnType<typeof buildPreviewCut>>;

/**
 * preview cut は入力 key ごとに同一 promise を共有し、異 key は要求順に直列化する。
 * tail は失敗を吸収して次の task へ進むため、1件の ffmpeg failure で queue は壊れない。
 */
export class PreviewCutRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly byKey = new Map<string, Promise<PreviewCutBuildResult>>();

  enqueue(key: string, task: () => Promise<PreviewCutBuildResult>): Promise<PreviewCutBuildResult> {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const run = this.tail.then(task);
    let shared!: Promise<PreviewCutBuildResult>;
    shared = run.finally(() => {
      if (this.byKey.get(key) === shared) this.byKey.delete(key);
    });
    this.byKey.set(key, shared);
    this.tail = shared.then(() => undefined, () => undefined);
    return shared;
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }
}

const previewCutQueue = new PreviewCutRequestQueue();

export function validatePreviewCutRequest(dir: string, body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["request body は {cutplan} の JSON object で指定してください"];
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(record).length !== 1 || !("cutplan" in record)) {
    errors.push("request body は cutplan だけを指定してください");
  }
  if (!record.cutplan || typeof record.cutplan !== "object" || Array.isArray(record.cutplan)) {
    errors.push("cutplan は JSON object で指定してください");
    return errors;
  }
  try {
    const validation = validateDocs(
      dir,
      mergeBodyOverDisk(dir, { cutplan: record.cutplan as CutPlan }),
    );
    errors.push(...validation.errors.map((error) =>
      `${error.file} ${error.where}: ${error.message}`
    ));
  } catch (error) {
    errors.push(`cutplan を検証できません: ${(error as Error).message}`);
  }
  return errors;
}

export function previewCutRequestKey(args: {
  dir: string;
  cfg: Config;
  cutplan: CutPlan;
  proxyMtimeMs?: number;
  proxySize?: number;
}): string {
  const manifest = JSON.parse(
    readFileSync(join(args.dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const proxyStat = args.proxyMtimeMs === undefined || args.proxySize === undefined
    ? statSync(join(args.dir, "proxy.mp4"))
    : null;
  return JSON.stringify(buildPreviewCutCacheKey({
    cfg: args.cfg,
    cutplan: args.cutplan,
    proxyMtimeMs: args.proxyMtimeMs ?? proxyStat!.mtimeMs,
    proxySize: args.proxySize ?? proxyStat!.size,
    compositionFps: manifestCompositionFps(manifest),
  }));
}

export interface PreviewCutEndpointDependencies {
  queue?: PreviewCutRequestQueue;
  waitForProxy?: () => Promise<void>;
  proxyExists?: () => boolean;
  proxyStale?: () => boolean;
  build?: typeof buildPreviewCut;
}

/** HTTP層から分離したC2 endpoint本体。テストでも同じvalidation/queueを通す。 */
export async function executePreviewCutRequest(
  dir: string,
  cfg: Config,
  body: unknown,
  deps: PreviewCutEndpointDependencies = {},
): Promise<PreviewCutResponse> {
  const requestErrors = validatePreviewCutRequest(dir, body);
  if (requestErrors.length > 0) throw new HttpError(400, requestErrors.join(" / "));
  const request = body as PreviewCutRequest;
  await deps.waitForProxy?.();

  const proxyPath = join(dir, "proxy.mp4");
  if (!(deps.proxyExists ?? (() => existsSync(proxyPath)))()) {
    throw new HttpError(409, "proxy.mp4 がありません。プロキシ生成の完了後に再試行してください");
  }
  let stale: boolean;
  try {
    stale = (deps.proxyStale ?? (() => isProxyStale(dir, cfg)))();
  } catch {
    stale = true;
  }
  if (stale) {
    throw new HttpError(409, "proxy.mp4 が古いか生成情報が壊れています。プロキシを再生成してください");
  }

  const key = previewCutRequestKey({ dir, cfg, cutplan: request.cutplan });
  const result = await (deps.queue ?? previewCutQueue).enqueue(
    key,
    () => (deps.build ?? buildPreviewCut)(dir, cfg, request.cutplan),
  );
  return {
    ok: true,
    path: result.path,
    keepSignature: previewCutKeepSignature(request.cutplan),
    reused: result.reused,
  };
}

export interface HyperframeCardSources {
  htmlByName: Record<string, string>;
  htmlErrors?: Record<string, string>;
  mp4Names: string[];
  sidecarByName?: Record<string, string>;
  sidecarErrors?: Record<string, string>;
}

/** HTML source と render 済み MP4 の和集合をカード状態へ解決する純関数。
 * 鮮度は renderHyperframe と同じ build 解決・cache key レシピで判定する。 */
export function buildHyperframeCards(sources: HyperframeCardSources): HyperframeCard[] {
  const htmlNames = [
    ...Object.keys(sources.htmlByName),
    ...Object.keys(sources.htmlErrors ?? {}),
  ];
  const names = [...new Set([...htmlNames, ...sources.mp4Names])]
    .sort((a, b) => a.localeCompare(b));
  const renderedNames = new Set(sources.mp4Names);

  return names.map((name) => {
    const htmlExists = htmlNames.includes(name);
    const rendered = renderedNames.has(name);
    const card: HyperframeCard = {
      name,
      ...(rendered ? { mp4Path: `materials/hyperframes/${name}.mp4` } : {}),
      htmlExists,
      rendered,
      stale: false,
    };
    const htmlReadError = sources.htmlErrors?.[name];
    if (htmlReadError) {
      return {
        ...card,
        stale: rendered,
        error: `素材「${name}」の生成元を読み込めません: ${htmlReadError}`,
      };
    }

    const sidecarReadError = sources.sidecarErrors?.[name];
    if (sidecarReadError) {
      return {
        ...card,
        stale: rendered && htmlExists,
        error: `素材「${name}」の生成情報を読み込めません: ${sidecarReadError}`,
      };
    }
    let sidecar: Record<string, unknown> | undefined;
    const sidecarText = sources.sidecarByName?.[name];
    if (sidecarText !== undefined) {
      try {
        const parsed: unknown = JSON.parse(sidecarText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("JSON object ではありません");
        }
        sidecar = parsed as Record<string, unknown>;
      } catch (error) {
        return {
          ...card,
          stale: rendered && htmlExists,
          error: `素材「${name}」の生成情報が壊れています: ${(error as Error).message}`,
        };
      }
    }

    const metadata = sidecarMetadata(sidecar);
    if (!htmlExists) return { ...card, ...metadata };

    try {
      const html = sources.htmlByName[name];
      const parsed = parseComposition(html);
      const build = resolveHyperframeBuild({ parsed, cliVars: {} });
      if (!build.ok) throw new Error(build.error);
      const details = {
        durationSec: build.durationSec,
        width: build.width,
        height: build.height,
      };
      if (!rendered) return { ...card, ...details };
      if (!sidecar) {
        return {
          ...card,
          ...details,
          stale: true,
          error: `素材「${name}」の生成情報がありません`,
        };
      }
      if (typeof sidecar.key !== "string") {
        return {
          ...card,
          ...details,
          stale: true,
          error: `素材「${name}」の生成情報が不正です`,
        };
      }
      const expectedKey = hyperframeCacheKey({
        htmlSha256: sha256Hex(html),
        variables: build.variables,
        width: build.width,
        height: build.height,
        fps: build.fps,
        durationSec: build.durationSec,
        codec: "h264",
        hardwareAcceleration: "none",
        profile: resolveHyperframeRenderProfile(html),
      });
      return { ...card, ...details, stale: sidecar.key !== expectedKey };
    } catch (error) {
      return {
        ...card,
        ...metadata,
        stale: rendered,
        error: `素材「${name}」の生成元を解析できません: ${(error as Error).message}`,
      };
    }
  });
}

function sidecarMetadata(sidecar: Record<string, unknown> | undefined):
  Pick<HyperframeCard, "durationSec" | "width" | "height"> {
  if (!sidecar) return {};
  return {
    ...(typeof sidecar.durationSec === "number" && Number.isFinite(sidecar.durationSec) && sidecar.durationSec > 0
      ? { durationSec: sidecar.durationSec }
      : {}),
    ...(typeof sidecar.width === "number" && Number.isInteger(sidecar.width) && sidecar.width > 0
      ? { width: sidecar.width }
      : {}),
    ...(typeof sidecar.height === "number" && Number.isInteger(sidecar.height) && sidecar.height > 0
      ? { height: sidecar.height }
      : {}),
  };
}

/** GET /api/hyperframes の filesystem adapter。個別ファイルの破損・read error は
 * sources の error へ変換し、他カードの一覧を巻き込まない。 */
export function loadHyperframeCards(dir: string): HyperframeCard[] {
  const htmlDir = join(dir, "hyperframes");
  const mp4Dir = join(dir, "materials", "hyperframes");
  const htmlByName: Record<string, string> = {};
  const htmlErrors: Record<string, string> = {};
  const htmlNames = existsSync(htmlDir)
    ? readdirSync(htmlDir).filter((file) => extname(file).toLowerCase() === ".html")
    : [];
  for (const file of htmlNames) {
    const name = file.slice(0, -extname(file).length);
    try {
      htmlByName[name] = readFileSync(join(htmlDir, file), "utf8");
    } catch (error) {
      htmlErrors[name] = (error as Error).message;
    }
  }
  const mp4Names = existsSync(mp4Dir)
    ? readdirSync(mp4Dir)
        .filter((file) => extname(file).toLowerCase() === ".mp4")
        .map((file) => file.slice(0, -extname(file).length))
    : [];
  const sidecarByName: Record<string, string> = {};
  const sidecarErrors: Record<string, string> = {};
  for (const name of new Set([...Object.keys(htmlByName), ...Object.keys(htmlErrors), ...mp4Names])) {
    const keyPath = join(dir, `hyperframe.${name}.key.json`);
    if (!existsSync(keyPath)) continue;
    try {
      sidecarByName[name] = readFileSync(keyPath, "utf8");
    } catch (error) {
      sidecarErrors[name] = (error as Error).message;
    }
  }
  return buildHyperframeCards({ htmlByName, htmlErrors, mp4Names, sidecarByName, sidecarErrors });
}

/** POST /api/hyperframe/render は name 以外を受けず、CLI と同じ文字集合に
 * 固定する。型が string でも trim による暗黙補正はしない。 */
export function validateHyperframeRenderRequest(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["body は {name} の JSON object で指定してください"];
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];
  const unknown = Object.keys(record).filter((key) => key !== "name");
  if (unknown.length > 0) errors.push("name だけを指定してください");
  if (typeof record.name !== "string" || !HYPERFRAME_NAME_RE.test(record.name)) {
    errors.push("ファイル名は英数字・.・_・- のみで指定してください");
  }
  return errors;
}

/** editor author は上書き不可。HTML / MP4 / sidecar のいずれかがあれば409。 */
export function ensureHyperframeAuthorNameAvailable(dir: string, name: string): void {
  const conflict = hyperframeAuthorConflict({
    name,
    htmlNames: existsSync(join(dir, "hyperframes", `${name}.html`)) ? [name] : [],
    mp4Names: existsSync(join(dir, "materials", "hyperframes", `${name}.mp4`)) ? [name] : [],
    sidecarNames: existsSync(join(dir, `hyperframe.${name}.key.json`)) ? [name] : [],
  });
  if (conflict) {
    throw new HttpError(409, `素材「${name}」は既に存在します。別のファイル名を指定してください`);
  }
}

type HeavyJobStage =
  | "preview"
  | "render"
  | "review"
  | "propose"
  | "hyperframe-render"
  | "hyperframe-author";

/** 実行中の重いジョブ(preview / render / review)。同時に1つだけ走らせ、
 * 同じ key の二重起動はプロミスを共有、別 key は 409 で拒否する */
let heavyJob: { stage: HeavyJobStage; key: string; promise: Promise<unknown> } | null = null;

const proposalStore = new Map<string, StoredProposal>();

/** ジョブ名の日本語表記(409 メッセージ用) */
const jaStage = (s: HeavyJobStage): string =>
  s === "render"
    ? "レンダー"
    : s === "hyperframe-author"
      ? "AI素材の生成"
    : s === "hyperframe-render"
      ? "素材の作り直し"
    : s === "review"
      ? "比較生成"
      : s === "propose"
        ? "AI提案生成"
        : "プレビュー生成";

async function runHeavyJob<T>(
  stage: HeavyJobStage,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  if (heavyJob) {
    if (heavyJob.key !== key) {
      throw new HttpError(409, `${jaStage(heavyJob.stage)}を実行中です。完了までお待ちください`);
    }
    return await heavyJob.promise as T;
  }
  const promise = task().finally(() => {
    if (heavyJob?.key === key) heavyJob = null;
  });
  heavyJob = { stage, key, promise };
  return await promise;
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function cloneProposal<T>(value: T): T {
  return deepClone(value);
}

function currentEditableDocs(dir: string): EditableDocs & { meta: unknown | null } {
  const docs = readEditableDocs(dir);
  return {
    ...docs,
    meta: existsSync(join(dir, "meta.json"))
      ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))
      : null,
  };
}

function stableCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableCanonicalize(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashEditableDocsState(docs: EditableDocs & { meta: unknown | null }): string {
  return sha256Hex(stableCanonicalize({
    bgm: docs.bgm,
    chapters: docs.chapters,
    cutplan: docs.cutplan,
    meta: docs.meta,
    overlays: docs.overlays,
    shorts: docs.shorts,
    thumbnail: docs.thumbnail,
    transcript: docs.transcript,
  }));
}

function hashReviewDocs(docs: ReviewDocs): string {
  return sha256Hex(stableCanonicalize(docs));
}

function pruneExpiredProposals(now = Date.now()): void {
  for (const [proposalId, record] of proposalStore) {
    if (record.expiresAtMs <= now) proposalStore.delete(proposalId);
  }
}

function invalidateStoredProposals(): void {
  proposalStore.clear();
}

function evictOldestProposalIfNeeded(): void {
  if (proposalStore.size < MAX_STORED_PROPOSALS) return;
  let oldest: StoredProposal | null = null;
  for (const record of proposalStore.values()) {
    if (!oldest || record.createdAtMs < oldest.createdAtMs) oldest = record;
  }
  if (oldest) proposalStore.delete(oldest.proposalId);
}

function storeProposal(
  proposal: Awaited<ReturnType<typeof proposeEditorAi>>,
  instruction: string,
  baseDocs: ReviewDocs,
  normalizedReviewSpec: ReviewSpec,
  baseDocsHash: string,
  activeShortName: string | null,
  parentProposalId: string | null = null,
  refinementIteration = 0,
  lineageExpiresAtMs?: number,
): StoredProposal {
  pruneExpiredProposals();
  evictOldestProposalIfNeeded();
  const now = Date.now();
  const expiresAtMs = lineageExpiresAtMs ?? (now + PROPOSAL_TTL_MS);
  const record: StoredProposal = {
    proposalId: randomUUID(),
    proposal: cloneProposal(proposal),
    normalizedReviewSpec: deepClone(normalizedReviewSpec),
    baseDocs: deepClone(baseDocs),
    baseDocsHash,
    activeShortName,
    instruction,
    parentProposalId,
    refinementIteration,
    lineageExpiresAtMs: expiresAtMs,
    createdAtMs: now,
    expiresAtMs,
  };
  proposalStore.set(record.proposalId, record);
  return record;
}

function getStoredProposal(proposalId: string): StoredProposal {
  pruneExpiredProposals();
  const record = proposalStore.get(proposalId);
  if (!record || record.expiresAtMs <= Date.now()) {
    proposalStore.delete(proposalId);
    throw new HttpError(410, "proposal は期限切れです。再提案してください", PROPOSAL_EXPIRED_CODE);
  }
  return record;
}

function expireStoredProposal(proposalId: string): void {
  proposalStore.delete(proposalId);
}

function currentReviewDocs(dir: string) {
  const docs = readEditableDocs(dir);
  if (!docs.cutplan || !docs.transcript) {
    throw new HttpError(400, "review の元になる編集ファイルが不足しています");
  }
  return {
    cutplan: docs.cutplan,
    overlays: docs.overlays ?? {},
    transcript: docs.transcript,
    bgm: docs.bgm ?? null,
    shorts: docs.shorts ?? null,
  };
}

function acceptedLabelsHash(labels: string[]): string {
  return sha256Hex(JSON.stringify([...new Set(labels)].sort()));
}

function refinedInstruction(originalInstruction: string, additionalInstruction: string | undefined): string {
  if (!additionalInstruction) return originalInstruction;
  const base = originalInstruction.trim();
  const refinement = `Refinement instruction:\n${additionalInstruction}`;
  return base ? `${base}\n\n${refinement}` : refinement;
}

function reviewRequestKey(record: StoredProposal, acceptedHunkLabels: string[], cfg: Config, secondaryObservation: "none" | "vlm" = "none"): string {
  const runtime = resolveAiRuntimeConfig(cfg);
  const visionProfile = runtime.routes.vision ? profileForRoute(runtime, "vision") : null;
  return JSON.stringify({
    proposalId: record.proposalId,
    acceptedLabelsHash: acceptedLabelsHash(acceptedHunkLabels),
    secondaryObservation,
    visionProfile: visionProfile?.name ?? null,
    visionModel: visionProfile?.model ?? null,
  });
}

export function validateReviewRequest(body: AiReviewRequest): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    return ["request body が不正です"];
  }
  const keys = Object.keys(body).sort();
  const allowedKeys = new Set(["acceptedHunkLabels", "proposalId", "secondaryObservation"]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    errors.push("request body は proposalId / acceptedHunkLabels / secondaryObservation だけを指定してください");
  }
  if (typeof body.proposalId !== "string" || body.proposalId.trim() === "") {
    errors.push("proposalId は空でない文字列で指定してください");
  }
  if (!Array.isArray(body.acceptedHunkLabels)) {
    errors.push("acceptedHunkLabels は配列で指定してください");
    return errors;
  }
  const labels = body.acceptedHunkLabels.filter((label): label is string => typeof label === "string");
  if (labels.length !== body.acceptedHunkLabels.length) {
    errors.push("acceptedHunkLabels は文字列配列で指定してください");
  }
  if (new Set(labels).size !== labels.length) {
    errors.push("acceptedHunkLabels に重複があります");
  }
  if (
    "secondaryObservation" in body &&
    body.secondaryObservation !== undefined &&
    body.secondaryObservation !== "none" &&
    body.secondaryObservation !== "vlm"
  ) {
    errors.push("secondaryObservation は none / vlm で指定してください");
  }
  return errors;
}

export function validateRefineRequest(body: AiRefineRequest): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    return ["request body が不正です"];
  }
  const keys = Object.keys(body).sort();
  const allowedKeys = new Set(["acceptedHunkLabels", "instruction", "mode", "proposalId", "vlm"]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    errors.push("request body は proposalId / acceptedHunkLabels / instruction / vlm / mode だけを指定してください");
  }
  if (typeof body.proposalId !== "string" || body.proposalId.trim() === "") {
    errors.push("proposalId は空でない文字列で指定してください");
  }
  if (!Array.isArray(body.acceptedHunkLabels)) {
    errors.push("acceptedHunkLabels は配列で指定してください");
    return errors;
  }
  const labels = body.acceptedHunkLabels.filter((label): label is string => typeof label === "string");
  if (labels.length !== body.acceptedHunkLabels.length) {
    errors.push("acceptedHunkLabels は文字列配列で指定してください");
  }
  if (new Set(labels).size !== labels.length) {
    errors.push("acceptedHunkLabels に重複があります");
  }
  if ("instruction" in body && body.instruction !== undefined && typeof body.instruction !== "string") {
    errors.push("instruction は文字列で指定してください");
  }
  if ("vlm" in body && body.vlm !== undefined && typeof body.vlm !== "boolean") {
    errors.push("vlm は true / false で指定してください");
  }
  if ("mode" in body && body.mode !== undefined && body.mode !== "normal" && body.mode !== "warning-fix") {
    errors.push("mode は normal / warning-fix で指定してください");
  }
  return errors.filter((error, index, all) => all.indexOf(error) === index);
}

export function refineRequestKey(record: StoredProposal, body: AiRefineRequest): string {
  return JSON.stringify({
    proposalId: record.proposalId,
    acceptedLabelsHash: acceptedLabelsHash(body.acceptedHunkLabels),
    instruction: body.instruction?.trim() ?? "",
    vlm: body.vlm === true,
    mode: body.mode ?? "normal",
  });
}

function ensureRefineVlmAvailable(cfg: Config): void {
  const aiReview = resolveAiReviewCfg(cfg);
  if (!aiReview.vlm) {
    throw new HttpError(
      422,
      "画像を使った再提案は config editor.aiReview.vlm=false のため実行できません",
      SECONDARY_OBSERVATION_UNAVAILABLE_CODE,
    );
  }
  if (!supportsImageReview(cfg)) {
    throw new HttpError(
      422,
      "現在の AI provider は画像を使った再提案に対応していません",
      SECONDARY_OBSERVATION_UNAVAILABLE_CODE,
    );
  }
}

function validateReviewCandidate(dir: string, candidate: ReturnType<typeof currentReviewDocs>): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const validate = validateDocs(dir, {
    manifest,
    cutplan: candidate.cutplan,
    transcript: candidate.transcript,
    overlays: candidate.overlays,
    bgm: candidate.bgm,
    chapters: null,
    meta: null,
    shorts: candidate.shorts,
    thumbnail: null,
  });
  return validate.errors.map((error) => `${error.file} ${error.where}: ${error.message}`);
}

export function buildAiReviewCandidateFromStoredProposal(
  dir: string,
  record: Pick<StoredProposal, "baseDocs" | "proposal">,
  acceptedHunkLabels: string[],
): ReturnType<typeof currentReviewDocs> {
  const labels = [...new Set(acceptedHunkLabels)].sort();
  const diff = proposalDiff(record.baseDocs, record.proposal.proposedDocs);
  const knownLabels = new Set(diff.hunks.map((hunk) => hunk.address.label));
  const unknown = labels.filter((label) => !knownLabels.has(label));
  if (unknown.length > 0) throw new HttpError(400, `unknown hunk labels: ${unknown.join(", ")}`);
  const resolution = new Map(diff.hunks.map((hunk) => [
    hunk,
    labels.includes(hunk.address.label) ? "theirs" : "mine",
  ] as const));
  const candidate = applyProposalResolution(record.baseDocs, record.proposal.proposedDocs, diff, resolution);
  const candidateErrors = validateReviewCandidate(dir, candidate);
  if (candidateErrors.length > 0) throw new HttpError(400, candidateErrors.join(" / "));
  return candidate;
}

/** スクリプトタブ用の全文スクリプト(元収録の秒)。whisper の生出力
 * (whisper-out.json)が「AI が編集する前のベース」の正のデータで、segment の
 * 組み立ては transcribe.ts と同じ規則(ms→秒・trim・空文字除外。captionSplit は
 * 通さない=テロップ粒度ではなく発話1文の粒度)。tokens(-ojf)があれば
 * buildWords で語単位タイミングも付ける。whisper-out.json が無い古い収録では
 * 現在の transcript.json から代替する(テロップ編集の影響を受けるが、
 * 表示・シーク・カットは成立する) */
export function loadScript(dir: string): ScriptData {
  const whisperPath = join(dir, "whisper-out.json");
  if (existsSync(whisperPath)) {
    const whisper = JSON.parse(readFileSync(whisperPath, "utf8")) as {
      transcription: Array<{
        offsets: { from: number; to: number };
        text: string;
        tokens?: WhisperToken[];
      }>;
    };
    // words の時刻が DTW で音響に固定されているか(whisper -dtw の t_dtw)。
    // 1トークンでも有効なら DTW 実行(buildWords が t_dtw 優先で組む)
    const aligned = whisper.transcription.some((t) =>
      (t.tokens ?? []).some((tok) => typeof tok.t_dtw === "number" && tok.t_dtw >= 0),
    );
    const segments = whisper.transcription
      .map((t) => {
        const seg: ScriptSegment = {
          start: t.offsets.from / 1000,
          end: t.offsets.to / 1000,
          text: t.text.trim(),
        };
        const words = buildWords(t.tokens);
        if (words.length > 0) seg.words = words;
        return seg;
      })
      .filter((s) => s.text.length > 0);
    return { source: "whisper", segments, aligned };
  }
  const transcriptPath = join(dir, "transcript.json");
  const transcript = existsSync(transcriptPath)
    ? (JSON.parse(readFileSync(transcriptPath, "utf8")) as Transcript)
    : null;
  const segments = (transcript?.segments ?? [])
    .map((s) => {
      const seg: ScriptSegment = { start: s.start, end: s.end, text: s.text };
      if (s.words && s.words.length > 0) seg.words = s.words;
      return seg;
    })
    .filter((s) => s.text.trim().length > 0);
  return { source: "transcript", segments };
}

export function loadPreviewCutState(
  dir: string,
  cfg: Config,
  cutplan: CutPlan,
  proxyState?: { exists: boolean; stale: boolean },
): ProjectData["previewCut"] {
  let keepSignature = "";
  try {
    keepSignature = previewCutKeepSignature(cutplan);
    const proxyExists = proxyState?.exists ?? existsSync(join(dir, "proxy.mp4"));
    const proxyStale = proxyState?.stale ?? isProxyStale(dir, cfg);
    if (!proxyExists || proxyStale) return { ready: false, keepSignature };
    const proxyStat = statSync(join(dir, "proxy.mp4"));
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as Manifest;
    const currentKey = buildPreviewCutCacheKey({
      cfg,
      cutplan,
      proxyMtimeMs: proxyStat.mtimeMs,
      proxySize: proxyStat.size,
      compositionFps: manifestCompositionFps(manifest),
    });
    return {
      ready: inspectPreviewCutFreshness({
        dir,
        currentKey,
        proxyFresh: true,
      }).fresh,
      keepSignature,
    };
  } catch {
    // proxy key / preview sidecar / stat / cutplan のどれが壊れていても、
    // project load 自体は止めず従来の source-domain preview へ劣化する。
    return { ready: false, keepSignature };
  }
}

export function loadProject(dir: string, cfg: Config): ProjectData {
  const aiRuntime = resolveAiRuntimeConfig(cfg);
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
  // plain / obs-canvas 共通で、デザインの背景取り込み(render.design/ への
  // コピー)は dirFiles を読む前に済ませる。後にすると、初回だけコピー前の
  // 一覧が渡ってクライアントの overlayExists が「背景画像が見つかりません」
  // と誤判定し、背景が落ちる
  const designRenderCfg = renderCfgWithDesign(dir, cfg);

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
  const proxyExists = existsSync(join(dir, "proxy.mp4"));
  let proxyStale = false;
  try {
    proxyStale = proxyExists && isProxyStale(dir, cfg);
  } catch {
    proxyStale = true;
  }
  return {
    dir,
    manifest,
    transcript,
    cutplan,
    overlays: readJson<Overlays>("overlays.json", {}),
    contentHashes: contentHashesOf(dir),
    dirFiles,
    bgm: readJson<Bgm | null>("bgm.json", null),
    bgmFile: findBgm(dir),
    shorts: loadShorts(dir),
    silences: readJson<AutoCuts | null>("cuts.auto.json", null)?.silences ?? null,
    silenceCutReason: cfg.detect?.silenceCutReason ?? DEFAULT_SILENCE_CUT_REASON,
    proxyExists,
    proxyStale,
    previewCut: loadPreviewCutState(dir, cfg, cutplan, {
      exists: proxyExists,
      stale: proxyStale,
    }),
    renderCfg: designRenderCfg,
    ...editorDesignAssets(dir, cfg, manifest, designRenderCfg),
    previewCfg: { width: cfg.preview.width, videoEncoder: cfg.preview.videoEncoder },
    editorCfg: resolvedEditorCfg(cfg, DEFAULT_MAX_UPLOAD_MB),
    output: { w: manifest.video.screenRegion.w, h: manifest.video.screenRegion.h },
    hasCamera: hasCamera(manifest),
    draft,
    planPerception: resolvePerceptionStatus(cfg),
    aiProfiles: aiProfileStatuses(cfg),
    aiRoutes: aiRuntime.routes,
    aiReviewCfg: {
      ...resolveAiReviewCfg(cfg),
      maxRefinements: Math.min(3, Math.max(1, (cfg.editor?.aiReview as { maxRefinements?: number } | undefined)?.maxRefinements ?? 2)),
    },
  };
}

function resolvedEditorDesign(
  dir: string,
  cfg: Config,
  manifest?: Manifest,
  renderCfg?: Config["render"],
) {
  const currentManifest = manifest ?? JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const currentRenderCfg = renderCfg ?? renderCfgWithDesign(dir, cfg);
  const width = currentManifest.video.screenRegion.w;
  const height = currentManifest.video.screenRegion.h;
  const design = resolveDesign(currentRenderCfg.design, width, height, hasCamera(currentManifest));
  return design ? { dir, design, width, height } : undefined;
}

function editorDesignAssets(
  dir: string,
  cfg: Config,
  manifest?: Manifest,
  renderCfg?: Config["render"],
): { designAssets?: NonNullable<ProjectData["designAssets"]> } {
  const resolved = resolvedEditorDesign(dir, cfg, manifest, renderCfg);
  if (!resolved) return {};
  const prepared = existingDesignAssets(resolved);
  return prepared ? { designAssets: prepared } : {};
}

async function prepareEditorDesignAssets(dir: string, cfg: Config): Promise<void> {
  const resolved = resolvedEditorDesign(dir, cfg);
  if (!resolved) return;
  await prepareDesignAssetBundle({
    ...resolved,
    warn: (message) => console.warn(`警告: ${message}`),
  });
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

/**
 * 動画素材の codec 事実(ffprobe)を取り出す。v:0(最初の映像ストリーム)だけ
 * 見る。ffprobe が無い(ENOENT→run が投げる)・非ゼロ終了(allowFailure で
 * stdout 空)・JSON が壊れている・ストリームが無い、いずれも空 {} を返し
 * classifyBrowserDisplayable 側で「表示可能(degrade)」に落ちる。ここは
 * 絶対にブロックしない・500 にしない(サムネイル表示の脇道でしかないため)
 */
async function probeVideoCodec(abs: string): Promise<VideoCodecFacts> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,profile",
      "-of", "json",
      abs,
    ], { allowFailure: true });
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string; pix_fmt?: string; profile?: string }> };
    const s = parsed.streams?.[0] ?? {};
    return { codecName: s.codec_name, pixFmt: s.pix_fmt, profile: s.profile };
  } catch (e) {
    console.warn(`codec を判定できません(${abs}): ${(e as Error).message}`);
    return {};
  }
}

/** codec 判定のレシピ版。argv / classifier / pixfmt gate を変えたら上げる */
const CODEC_RECIPE_V = 1;
/** codec facts + verdict のキャッシュ(キー = 対象の絶対パス。値は mtime+size+
 * レシピ版で無効化するので、素材の差し替え・レシピ変更を再起動なしで拾える) */
const codecCache = new Map<string, { key: string; facts: VideoCodecFacts; verdict: DisplayVerdict }>();

async function getCodecVerdict(abs: string): Promise<{ facts: VideoCodecFacts; verdict: DisplayVerdict }> {
  const st = statSync(abs);
  const key = `${st.mtimeMs}:${st.size}:v${CODEC_RECIPE_V}`;
  const hit = codecCache.get(abs);
  if (hit?.key === key) return { facts: hit.facts, verdict: hit.verdict };
  const facts = await probeVideoCodec(abs);
  const verdict = classifyBrowserDisplayable(facts);
  codecCache.set(abs, { key, facts, verdict });
  return { facts, verdict };
}

/**
 * materials/ 配下の動画素材の codec を調べ、ブラウザで表示できないものだけを
 * 疎な map で返す(displayable なもの・判定不能なものは載らない)。
 * GET /api/media-facts が使う。画像・音声は対象外(codec 問題が無い)
 */
async function collectMediaCodecFacts(dir: string): Promise<Record<string, { codec: string; reason: string }>> {
  const materialsDir = join(dir, "materials");
  if (!existsSync(materialsDir)) return {};
  const videoFiles = readdirSync(materialsDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && VIDEO_EXT.test(extname(e.name).toLowerCase()))
    .map((e) => {
      const parent = (e.parentPath ?? materialsDir).slice(materialsDir.length).replace(/^\//, "");
      const rel = parent ? `${parent}/${e.name}` : e.name;
      return `materials/${rel}`;
    });
  const entries = await Promise.all(
    videoFiles.map(async (rel) => {
      const { verdict } = await getCodecVerdict(join(dir, rel));
      return [rel, verdict] as const;
    }),
  );
  const facts: Record<string, { codec: string; reason: string }> = {};
  for (const [rel, verdict] of entries) {
    if (!verdict.browserDisplayable && verdict.reason) {
      facts[rel] = { codec: verdict.codec, reason: verdict.reason };
    }
  }
  return facts;
}

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

/**
 * GUI 保存(saveProject)の id 採番。id 有効なプロジェクト(disk 上の既存
 * 編集ファイルのいずれかに id がある)でのみ、body に含まれる各ドキュメントの
 * 「指せる配列」へ ensureIds を適用する(既存 id はクライアントの round-trip で
 * 保持済み前提。GUI が生成した新要素にだけ新規採番)。id 無効なら body を
 * そのまま返す(pass-through=バイト等価)。純関数(fs 非依存)。
 */
export function stampSaveBody(
  body: SaveRequest,
  idEnabled: boolean,
  used: Set<string>,
): SaveRequest {
  if (!idEnabled) return body;

  const cutplan = body.cutplan
    ? { ...body.cutplan, segments: ensureIds(body.cutplan.segments, ID_PREFIX.cutSegment, used) }
    : body.cutplan;

  const transcript = body.transcript
    ? {
        ...body.transcript,
        segments: ensureIds(body.transcript.segments, ID_PREFIX.caption, used),
      }
    : body.transcript;

  const overlays = body.overlays
    ? {
        ...body.overlays,
        overlays: body.overlays.overlays
          ? ensureIds(body.overlays.overlays, ID_PREFIX.material, used)
          : body.overlays.overlays,
        inserts: body.overlays.inserts
          ? ensureIds(body.overlays.inserts, ID_PREFIX.insert, used)
          : body.overlays.inserts,
        wipeFull: body.overlays.wipeFull
          ? ensureIds(body.overlays.wipeFull, ID_PREFIX.wipeFull, used)
          : body.overlays.wipeFull,
        hideCaption: body.overlays.hideCaption
          ? ensureIds(body.overlays.hideCaption, ID_PREFIX.hideCaption, used)
          : body.overlays.hideCaption,
        zooms: body.overlays.zooms
          ? ensureIds(body.overlays.zooms, ID_PREFIX.zoom, used)
          : body.overlays.zooms,
        blurs: body.overlays.blurs
          ? ensureIds(body.overlays.blurs, ID_PREFIX.blur, used)
          : body.overlays.blurs,
        captionTracks: body.overlays.captionTracks
          ? ensureIds(body.overlays.captionTracks, ID_PREFIX.captionTrack, used)
          : body.overlays.captionTracks,
      }
    : body.overlays;

  // bgm/shorts は null(削除シグナル)を pass-through する(?. と ?? はここでは
  // 使わない: null と undefined を区別する SaveRequest の契約を保つ)
  const bgm = body.bgm
    ? { ...body.bgm, tracks: ensureIds(body.bgm.tracks, ID_PREFIX.bgmTrack, used) }
    : body.bgm;

  const shorts = body.shorts
    ? {
        ...body.shorts,
        shorts: body.shorts.shorts.map((s) => ({
          ...s,
          ranges: ensureIds(s.ranges, ID_PREFIX.range, used),
          captionTracks: s.captionTracks
            ? ensureIds(s.captionTracks, ID_PREFIX.captionTrack, used)
            : s.captionTracks,
        })),
      }
    : body.shorts;

  return { ...body, cutplan, transcript, overlays, bgm, shorts };
}

/** body が書いた/削除したファイルの保存後の内容ハッシュ(削除は null)。
 *  /api/save の 200 応答に載せ、client の base 更新に使う(§8.3)。
 *  export はテスト用(test/saveProject.test.ts)。 */
export function hashesForBody(dir: string, body: SaveRequest): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, file] of Object.entries(DOC_FILE)) {
    if (body[key as keyof SaveRequest] !== undefined) {
      out[file] = fileContentHash(dir, file); // 書いた→hash / 削除→null
    }
  }
  return out;
}

/** 編集結果の保存。渡されたドキュメントだけを書く(それ以外のファイルは不可侵)。
 * export はテスト用(test/saveProject.test.ts。HTTP サーバは起動せず直接呼ぶ) */
export function saveProject(dir: string, body: SaveRequest): void {
  // 書く前に CLI の validate と同じ純粋検査を通す。GUI が壊れた JSON を書き、
  // preview / render で数分後に気づく事故を防ぐ。ディスクの現状(manifest や
  // 変更していないファイル)に body の変更を重ねた状態を検査する。
  // 「ディスク現状へ body を重ねる」写像は CLI apply と共有する
  // mergeBodyOverDisk(src/lib/applyEdits.ts §論点3)に抽出済み。SaveRequest は
  // ApplyBody の構造的サブセット(chapters/thumbnail キーを持たないため
  // 常にディスク現状にフォールバックする=挙動不変)
  const { errors } = validateDocs(dir, mergeBodyOverDisk(dir, body));
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ");
    throw new HttpError(400, `保存できません(整合性エラー ${errors.length}件): ${detail}`);
  }

  // id が有効なプロジェクト(disk 上の既存編集ファイルのいずれかに id がある)
  // でのみ、GUI が生成した新要素(id 無し)に採番する。既存 id はクライアントの
  // round-trip で保持済み前提(ensureIds は id 有りをそのまま通す)。
  // id 無効なら stampedBody は body と同一参照(pass-through=バイト等価)
  const idDocs = readEditableDocs(dir);
  const idEnabled = hasAnyId(idDocs);
  const stampedBody = stampSaveBody(body, idEnabled, usedIdsOf(idDocs));

  const write = (file: string, data: CutPlan | Overlays | Transcript | Bgm | Shorts) => {
    const json = JSON.stringify(data, null, 2);
    lastWrittenHash.set(file, hashOfString(json)); // 書いた内容のハッシュを記録
    writeFileSync(join(dir, file), json);
  };
  if (stampedBody.cutplan) {
    write("cutplan.json", stampedBody.cutplan);
    // 承認レコード(approvals.json)の mint/clear。GUI は「人間が起動した
    // プロセスが人間のチェックで書く」= 分離層の権威側(設計 §1.3 / §8)。
    // approved トグルに応じてハッシュ束縛レコードを作る/消す。approvals.json
    // は WATCHED_FILES に無く watch は発火しないので lastWrittenHash は不要
    if (stampedBody.cutplan.approved) writeCutplanApproval(dir, stampedBody.cutplan, "gui");
    else clearCutplanApproval(dir);
  }
  if (stampedBody.overlays) write("overlays.json", stampedBody.overlays);
  if (stampedBody.transcript) write("transcript.json", stampedBody.transcript);
  // BGM: 区間があれば bgm.json を書き、null / 空なら削除して全編1曲(後方互換)へ戻す
  if (stampedBody.bgm !== undefined) {
    if (stampedBody.bgm && stampedBody.bgm.tracks.length > 0) {
      write("bgm.json", stampedBody.bgm);
    } else {
      const p = join(dir, "bgm.json");
      if (existsSync(p)) {
        lastWrittenHash.set("bgm.json", null);
        rmSync(p);
      }
    }
  }
  // ショート: 1件以上あれば shorts.json を書き、無ければ削除する(bgm と同型)
  if (stampedBody.shorts !== undefined) {
    if (stampedBody.shorts && stampedBody.shorts.shorts.length > 0) {
      write("shorts.json", stampedBody.shorts);
      // 各ショートの approved トグルに応じて name 別の承認レコードを mint/clear
      for (const short of stampedBody.shorts.shorts) {
        if (short.approved) writeShortApproval(dir, short, "gui");
        else clearShortApproval(dir, short.name);
      }
    } else {
      const p = join(dir, "shorts.json");
      if (existsSync(p)) {
        lastWrittenHash.set("shorts.json", null);
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

async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new HttpError(413, "request body が大きすぎます");
    chunks.push(buf);
  }
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
