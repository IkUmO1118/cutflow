// `framewright record --watch` — OBS の録画ボタンに自動連動し、vendor した
// Swift カーソルヘルパ(src/lib/vendor/openscreen)を録画中だけ起動して
// `<recording>.cursor.json` サイドカーを確定する常駐 watcher(D1/D3/D4)。
//
// 撮影は OBS を主役として維持する(Electron は持ち込まない)。watcher は
// 録画していないときは obs-websocket を監視するだけの軽量な待機状態。
// 対象ディスプレイは D4 の3段自動一致(obs-websocket → 単一ディスプレイ →
// テレメトリ推論)+ `--display <id>` の隠し override。沈黙禁止: どの段で
// 解決したかを必ずログへ出す
//
// §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectObsWebSocket,
  type ObsEvent,
  type ObsWebSocketClient,
} from "../lib/obsWebsocket.ts";
import { ensureCursorHelperBinary } from "../lib/cursorHelperBinary.ts";
import { listDisplays, type DisplayInfo } from "../lib/displayList.ts";
import { absolutePointToNormalized, pickDisplayByTelemetry } from "../lib/cursorGeom.ts";
import {
  compactPauses,
  fitLinearMapping,
  mapHelperTimeToRecTime,
  parseObsTimecodeMs,
  type LinearMapping,
  type Pause,
  type SyncPair,
} from "../lib/cursorSync.ts";
import {
  DEFAULT_OBS_WEBSOCKET_HOST,
  DEFAULT_OBS_WEBSOCKET_PORT,
  DEFAULT_RECORD_SAMPLE_INTERVAL_MS,
  type Config,
} from "../lib/config.ts";

/** サイドカーのファイル名の接尾辞(`<recording base>` + これ)。files.ts の
 * fileRole 分類(D6・P5)もこのパターンを見る */
export const CURSOR_SIDECAR_SUFFIX = ".cursor.json";

/** GetRecordStatus.outputTimecode を定期採取する間隔(ms)。D5 の同期対の
 * サンプリング密度(録画尺に対して十分粗くてよい: offset+drift は線形なので
 * 数十点で足りる) */
const SYNC_POLL_INTERVAL_MS = 2000;

export interface CursorAsset {
  id: string;
  imageDataUrl: string;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  scaleFactor: number;
}

export interface CursorSample {
  recTimeMs: number;
  cx: number;
  cy: number;
  inBounds: boolean;
  cursorType: string | null;
  assetId: string | null;
  leftButtonDown: boolean;
  leftButtonPressed: boolean;
  leftButtonReleased: boolean;
}

/** D4 のどの段で対象ディスプレイを解決したか(沈黙禁止。ログ+サイドカー両方に残す) */
export type DisplayResolvedBy =
  | "override"
  | "obs-websocket"
  | "single-display"
  | "telemetry";

export interface CursorSidecar {
  version: 1;
  provider: "openscreen-mac-cursor-helper";
  display: { id: number | null; resolvedBy: DisplayResolvedBy | "unresolved" };
  sync: { offsetMs: number; driftPpm: number; method: "obs-timecode" };
  pauses: Pause[];
  samples: CursorSample[];
  assets: CursorAsset[];
}

/** ヘルパの sample/ready 行(JSON.parse 済み・unknown) */
interface HelperLine {
  type?: unknown;
  timestampMs?: unknown;
  cx?: unknown;
  cy?: unknown;
  inBounds?: unknown;
  ax?: unknown;
  ay?: unknown;
  cursorType?: unknown;
  assetId?: unknown;
  asset?: unknown;
  leftButtonDown?: unknown;
  leftButtonPressed?: unknown;
  leftButtonReleased?: unknown;
  accessibilityTrusted?: unknown;
  mouseTapReady?: unknown;
}

/** 1回の録画セッションの蓄積状態(OUTPUT_STARTED〜OUTPUT_STOPPED) */
interface RecordingSession {
  displayId: number | null;
  resolvedBy: DisplayResolvedBy;
  child: ChildProcessWithoutNullStreams;
  rawSamples: { helperEpochMs: number; ax: number; ay: number; fields: CursorSample }[];
  assets: Map<string, CursorAsset>;
  syncPairs: SyncPair[];
  pauses: Pause[];
  pauseStart: { recTimeMs: number; wallMs: number } | null;
  syncTimer: ReturnType<typeof setInterval>;
}

/**
 * ヘルパの1行(JSON)を CursorSample へ整形する(純関数寄り。副作用なし)。
 * 不正な行(JSON.parse 失敗・type が sample でない)は null。ax/ay は D4
 * 第3段(テレメトリ推論)専用の生座標で、最終サイドカーの CursorSample には
 * 含めない(呼び出し側が別途保持し、必要なときだけ事後的な再正規化に使う)
 */
export function parseHelperSampleLine(line: string): {
  helperEpochMs: number;
  fields: CursorSample;
  ax: number;
  ay: number;
  asset: CursorAsset | null;
} | null {
  let msg: HelperLine;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg.type !== "sample" || typeof msg.timestampMs !== "number") return null;
  const asset =
    msg.asset && typeof msg.asset === "object"
      ? (msg.asset as CursorAsset)
      : null;
  return {
    helperEpochMs: msg.timestampMs,
    ax: typeof msg.ax === "number" ? msg.ax : 0,
    ay: typeof msg.ay === "number" ? msg.ay : 0,
    fields: {
      recTimeMs: 0, // 同期写像後に上書きする(呼び出し側)
      cx: typeof msg.cx === "number" ? msg.cx : 0,
      cy: typeof msg.cy === "number" ? msg.cy : 0,
      inBounds: msg.inBounds === true,
      cursorType: typeof msg.cursorType === "string" ? msg.cursorType : null,
      assetId: typeof msg.assetId === "string" ? msg.assetId : null,
      leftButtonDown: msg.leftButtonDown === true,
      leftButtonPressed: msg.leftButtonPressed === true,
      leftButtonReleased: msg.leftButtonReleased === true,
    },
    asset,
  };
}

/** obs-websocket RecordStateChanged.outputState の値(protocol.md) */
type OutputState =
  | "OBS_WEBSOCKET_OUTPUT_STARTING"
  | "OBS_WEBSOCKET_OUTPUT_STARTED"
  | "OBS_WEBSOCKET_OUTPUT_STOPPING"
  | "OBS_WEBSOCKET_OUTPUT_STOPPED"
  | "OBS_WEBSOCKET_OUTPUT_PAUSED"
  | "OBS_WEBSOCKET_OUTPUT_RESUMED";

export interface RecordWatchOptions {
  /** `--display <id>`(CGDirectDisplayID)の明示 override。隠しオプション
   * 扱い(母艦 §4)。省略時は D4 の3段自動一致を行う */
  displayId?: number;
}

export interface DisplayResolution {
  /** 録画開始前に決められなかった(D4 第3段=テレメトリ推論待ち)ときは null。
   * ヘルパは primary で spawn し、停止後に再正規化する */
  displayId: number | null;
  resolvedBy: DisplayResolvedBy;
}

/**
 * D4: 対象ディスプレイの3段自動一致(+隠し override)。沈黙禁止のため、
 * どの段で解決したか・解決できなかったかを必ず console へ出す。
 * 副作用は無い(obs-websocket への読み取り専用リクエストのみ)ので
 * `doctor`(D9 capture-display)からも安全に呼べる
 */
export async function resolveTargetDisplay(
  client: ObsWebSocketClient,
  overrideDisplayId: number | undefined,
): Promise<DisplayResolution> {
  if (overrideDisplayId !== undefined) {
    console.error(`対象ディスプレイ: ${overrideDisplayId}(--display 指定)`);
    return { displayId: overrideDisplayId, resolvedBy: "override" };
  }

  // 第1段: obs-websocket の画面キャプチャソースの display_uuid と突き合わせる
  try {
    const scene = await client.call<{ currentProgramSceneName: string }>(
      "GetCurrentProgramScene",
    );
    const items = await client.call<{
      sceneItems: { sourceName: string; inputKind?: string }[];
    }>("GetSceneItemList", { sceneName: scene.currentProgramSceneName });
    const captureItems = items.sceneItems.filter(
      (it) => it.inputKind === "display_capture" || it.inputKind === "screen_capture",
    );
    if (captureItems.length === 1) {
      const settings = await client.call<{ inputSettings: Record<string, unknown> }>(
        "GetInputSettings",
        { inputName: captureItems[0]!.sourceName },
      );
      const uuid = settings.inputSettings.display_uuid;
      if (typeof uuid === "string" && uuid.length > 0) {
        const displays = await listDisplays();
        const matched = displays.find((d) => d.uuid.toLowerCase() === uuid.toLowerCase());
        if (matched) {
          console.error(
            `対象ディスプレイを obs-websocket から解決: id=${matched.id}(display_uuid=${uuid})`,
          );
          return { displayId: matched.id, resolvedBy: "obs-websocket" };
        }
        console.warn(
          `obs-websocket の display_uuid(${uuid})に一致するディスプレイが見つかりません`,
        );
      } else {
        console.warn(
          `画面キャプチャソース"${captureItems[0]!.sourceName}"に display_uuid がありません` +
            "(OBS/ソース種別の違いで未対応の可能性)",
        );
      }
    } else if (captureItems.length > 1) {
      console.warn(`画面キャプチャソースが複数あり一意に決められません(${captureItems.length}件)`);
    } else {
      console.warn("現在のシーンに画面キャプチャ(display_capture/screen_capture)ソースがありません");
    }
  } catch (err) {
    console.warn(`obs-websocket からの対象ディスプレイ解決に失敗しました: ${(err as Error).message}`);
  }

  // 第2段: アクティブなディスプレイが1枚だけならそれを採用
  let displays: DisplayInfo[] = [];
  try {
    displays = await listDisplays();
    if (displays.length === 1) {
      console.error(`アクティブなディスプレイが1枚のみのためそれを採用: id=${displays[0]!.id}`);
      return { displayId: displays[0]!.id, resolvedBy: "single-display" };
    }
  } catch (err) {
    console.warn(`ディスプレイ一覧の取得に失敗しました: ${(err as Error).message}`);
  }

  // 第3段: 録画中のテレメトリから事後的に推論する(onOutputStopped 側で実施)
  console.warn(
    "対象ディスプレイを録画開始前に解決できませんでした。録画中のテレメトリから推論します" +
      "(--display <id> を指定すればこの推論は不要になります)",
  );
  return { displayId: null, resolvedBy: "telemetry" };
}

/** .env から OBS_WEBSOCKET_PASSWORD 等を読めるようにする(src/lib/ai/client.ts の
 * loadRepoEnv と同じ流儀。config.yaml は git 管理下のため平文パスワードを
 * 書かず、環境変数名(passwordEnv)だけを書く) */
function loadRepoEnv(): void {
  const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
  process.loadEnvFile?.(join(repoRoot, ".env"));
}

/** サイドカーをアトミックに書く(tmp→rename。renderReport.ts と同じ流儀) */
function writeCursorSidecar(outPath: string, sidecar: CursorSidecar): void {
  const tmpPath = outPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(sidecar, null, 2));
  renameSync(tmpPath, outPath);
}

async function spawnHelper(
  displayId: number | null,
  sampleIntervalMs: number,
): Promise<ChildProcessWithoutNullStreams> {
  const binPath = await ensureCursorHelperBinary();
  // displayId が null(D4 第3段待ち)のときはヘルパ側が primary へ
  // フォールバックする(main.swift の resolveTargetDisplayBounds)。この場合
  // cx/cy は仮の値で、停止後に ax/ay から再正規化する
  const request = JSON.stringify(
    displayId === null ? { sampleIntervalMs } : { sampleIntervalMs, displayId },
  );
  return spawn(binPath, [request]);
}

/**
 * 常駐 watcher 本体(Ctrl+C まで終了しない)。obs-websocket に接続し、
 * RecordStateChanged を監視。録画が始まるたびヘルパを spawn し、
 * 停止で SIGTERM → サイドカーを確定する
 */
export async function startRecordWatch(
  cfg: Config,
  opts: RecordWatchOptions,
): Promise<void> {
  const host = cfg.record?.obsWebsocket?.host ?? DEFAULT_OBS_WEBSOCKET_HOST;
  const port = cfg.record?.obsWebsocket?.port ?? DEFAULT_OBS_WEBSOCKET_PORT;
  const passwordEnv = cfg.record?.obsWebsocket?.passwordEnv;
  if (passwordEnv) loadRepoEnv();
  const password = passwordEnv ? process.env[passwordEnv] : undefined;
  const sampleIntervalMs = cfg.record?.sampleIntervalMs ?? DEFAULT_RECORD_SAMPLE_INTERVAL_MS;

  console.log(`obs-websocket(${host}:${port})に接続します...`);
  const client = await connectObsWebSocket({ host, port, password });
  console.log("接続しました。");
  console.log("録画待機中(OBS で録画を開始してください。終了は Ctrl+C)");

  let session: RecordingSession | null = null;

  async function onOutputStarted(): Promise<void> {
    if (session) {
      console.warn("録画開始イベントを受けましたが、既存セッションが残っています(無視)");
      return;
    }
    console.log("録画開始を検知。対象ディスプレイを解決します...");
    const resolution = await resolveTargetDisplay(client, opts.displayId);
    console.log("カーソルヘルパを起動します...");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await spawnHelper(resolution.displayId, sampleIntervalMs);
    } catch (err) {
      console.error(
        `カーソルヘルパを起動できませんでした(座標無しで録画は継続します): ${(err as Error).message}`,
      );
      return;
    }
    const s: RecordingSession = {
      displayId: resolution.displayId,
      resolvedBy: resolution.resolvedBy,
      child,
      rawSamples: [],
      assets: new Map(),
      syncPairs: [],
      pauses: [],
      pauseStart: null,
      syncTimer: setInterval(() => void pollSync(s), SYNC_POLL_INTERVAL_MS),
    };
    session = s;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const parsed = parseHelperSampleLine(line);
      if (!parsed) return;
      if (parsed.asset) s.assets.set(parsed.asset.id, parsed.asset);
      s.rawSamples.push({
        helperEpochMs: parsed.helperEpochMs,
        ax: parsed.ax,
        ay: parsed.ay,
        fields: parsed.fields,
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`cursor-helper stderr: ${chunk.toString().trim()}`);
    });
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.warn(`cursor-helper が異常終了しました(code=${code} signal=${signal ?? ""})`);
      }
    });
  }

  async function pollSync(s: RecordingSession): Promise<void> {
    try {
      const status = await client.call<{ outputTimecode: string }>("GetRecordStatus");
      const outputTimecodeMs = parseObsTimecodeMs(status.outputTimecode);
      s.syncPairs.push({ outputTimecodeMs, helperEpochMs: Date.now() });
    } catch (err) {
      console.error(`GetRecordStatus に失敗しました: ${(err as Error).message}`);
    }
  }

  function currentRecTimeMs(s: RecordingSession): number {
    const mapping = fitLinearMapping(s.syncPairs);
    return mapHelperTimeToRecTime(Date.now(), mapping);
  }

  function onPaused(): void {
    if (!session) return;
    session.pauseStart = { recTimeMs: currentRecTimeMs(session), wallMs: Date.now() };
    console.log("一時停止を検知");
  }

  function onResumed(): void {
    if (!session || !session.pauseStart) return;
    const durationMs = Date.now() - session.pauseStart.wallMs;
    session.pauses.push({ recTimeMs: session.pauseStart.recTimeMs, durationMs });
    session.pauseStart = null;
    console.log(`再開を検知(一時停止 ${durationMs}ms)`);
  }

  async function onOutputStopped(outputPath: string | null): Promise<void> {
    const s = session;
    session = null;
    if (!s) {
      console.warn("録画停止イベントを受けましたが、対応するセッションがありません(無視)");
      return;
    }
    clearInterval(s.syncTimer);
    // 未終了の一時停止(RESUMED を受けずに停止した場合)は現在時刻で締める
    if (s.pauseStart) {
      const durationMs = Date.now() - s.pauseStart.wallMs;
      s.pauses.push({ recTimeMs: s.pauseStart.recTimeMs, durationMs });
      s.pauseStart = null;
    }
    s.child.kill("SIGTERM");

    if (!outputPath) {
      console.error(
        "録画ファイルパスを取得できなかったため、cursor.json サイドカーを書けませんでした",
      );
      return;
    }

    // D4 第3段: 録画開始前に対象ディスプレイを決められなかった場合、
    // 蓄積した生座標(ax/ay)からどのディスプレイに最も長く滞在したかを推論し、
    // cx/cy/inBounds を事後的に再正規化する(沈黙禁止: 結果を必ずログへ出す)
    let resolvedDisplayId = s.displayId;
    if (s.resolvedBy === "telemetry" && s.displayId === null) {
      try {
        const displays = await listDisplays();
        const picked = pickDisplayByTelemetry(
          s.rawSamples.map((r) => ({ ax: r.ax, ay: r.ay })),
          displays.map((d) => ({ id: d.id, bounds: d.bounds })),
        );
        if (picked) {
          const matched = displays.find((d) => d.id === picked.id)!;
          console.log(
            `テレメトリ推論で対象ディスプレイを決定: id=${picked.id}` +
              `(in-bounds ${picked.inBoundsCount}/${s.rawSamples.length}件)`,
          );
          resolvedDisplayId = picked.id;
          for (const raw of s.rawSamples) {
            const renorm = absolutePointToNormalized({ ax: raw.ax, ay: raw.ay }, matched.bounds);
            raw.fields.cx = renorm.cx;
            raw.fields.cy = renorm.cy;
            raw.fields.inBounds = renorm.inBounds;
          }
        } else {
          console.warn(
            "テレメトリ推論でも対象ディスプレイを決定できませんでした(サンプル無し?)。" +
              "cx/cy は primary 基準のまま書き出します",
          );
        }
      } catch (err) {
        console.warn(
          `テレメトリ推論に失敗しました(cx/cy は primary 基準のまま書き出します): ${(err as Error).message}`,
        );
      }
    }

    const mapping: LinearMapping = fitLinearMapping(s.syncPairs);
    const mappedSamples = s.rawSamples.map(({ helperEpochMs, fields }) => ({
      ...fields,
      recTimeMs: Math.round(mapHelperTimeToRecTime(helperEpochMs, mapping)),
    }));
    const compacted = compactPauses(mappedSamples, s.pauses);

    const sidecar: CursorSidecar = {
      version: 1,
      provider: "openscreen-mac-cursor-helper",
      display: {
        id: resolvedDisplayId,
        resolvedBy: resolvedDisplayId === null ? "unresolved" : s.resolvedBy,
      },
      sync: { offsetMs: mapping.offsetMs, driftPpm: mapping.driftPpm, method: "obs-timecode" },
      pauses: s.pauses,
      samples: compacted,
      assets: [...s.assets.values()],
    };

    const base = basename(outputPath).replace(/\.[^.]+$/, "");
    const sidecarPath = join(dirname(outputPath), `${base}${CURSOR_SIDECAR_SUFFIX}`);
    writeCursorSidecar(sidecarPath, sidecar);
    console.log(
      `サイドカーを書きました: ${sidecarPath}(サンプル ${sidecar.samples.length}件・` +
        `pause ${sidecar.pauses.length}件・asset ${sidecar.assets.length}件)`,
    );
  }

  client.onEvent((event: ObsEvent) => {
    if (event.eventType !== "RecordStateChanged") return;
    const outputState = event.eventData.outputState as OutputState | undefined;
    const outputPath =
      typeof event.eventData.outputPath === "string" ? event.eventData.outputPath : null;
    if (outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
      void onOutputStarted();
    } else if (outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED") {
      onPaused();
    } else if (outputState === "OBS_WEBSOCKET_OUTPUT_RESUMED") {
      onResumed();
    } else if (outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") {
      void onOutputStopped(outputPath);
    }
  });

  // 開いたままの WebSocket 接続がイベントループを保持するので、ここで
  // ブロックする必要はない(frames-serve と同じ「listen したら return」流儀)。
  // 終了は SIGINT/SIGTERM のみ(ヘルパの SIGTERM 後に自分も exit する)
  const shutdown = (): void => {
    if (session) session.child.kill("SIGTERM");
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    console.log("\n終了します...");
    shutdown();
  });
  process.on("SIGTERM", shutdown);
}
