// scripts/lib/pixelCompare.mjs — 画素比較の共有モジュール(G1 Phase1)。
// scripts/engine-pixel-parity.mjs(R1〜R4 実装)から定数・pageScript()・
// CDP/ヘッドレスChrome起動まわりを逐語抽出したもの(値・コメントは1文字も変えていない)。
// scripts/engine-pixel-gate.mjs(G1)もこのモジュールを再利用する。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureHeadlessShell } from "../../src/lib/browser.ts";

// scripts/lib/pixelCompare.mjs から見た repoRoot(../../ で scripts/lib → repoRoot)
const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// 全体平均の画素差分(参考値。合否には使わない。0-255 スケール)。
// 根拠: R1 Phase2 実測で修正後の diffNormal が両記録とも 8〜12 程度。
// 15.0 はこの baseline に 50% の余裕を加えた値(反転(50+)やレイアウト
// 崩れ(30+)は確実に捕らえるが、局所的な破綻には鈍い。§1.2 参照)。
export const DIFF_THRESHOLD = 15.0;

// タイル分割の合否判定はここに集約(R4 Phase1)。
// ダウンサンプル幅。旧 96px ではワイプ(1920px中375px=19.5%幅)がタイル
// 分割後わずか数pxしか残らず輝度平均のノイズに埋もれる。480px(4倍)に
// 上げると 16 分割で1タイルあたり 30px 幅(9分割で高さ方向も約30px)=
// 900px 程度がタイルの平均に残り、局所的な破綻(内容が丸ごと別物)を
// フォント差程度のノイズから切り分けられる。
export const TILE_DS_W = 480;
// タイル分割数。16×9(グリッド出力時に見やすいアスペクト比)。
export const TILE_COLS = 16;
export const TILE_ROWS = 9;
// タイル最大輝度差の閾値。較正実測(2026-07-28。未修正HEAD=§1.1のID衝突あり):
//   2026-07-12 t=120   : tileDiffMax=126.03(ワイプタイル[13,8])diffNormal=10.92
//   2026-07-21 t=150   : tileDiffMax= 87.07(ワイプタイル[7,8] )diffNormal= 8.76
//   2026-07-21 t=72    : tileDiffMax= 55.07(ワイプタイル[5,8] )diffNormal= 7.81
//   test        t=30   : tileDiffMax= 26.92(ワイプタイル[8,8] )diffNormal= 2.69
//   test        t=50   : tileDiffMax= 27.88(ワイプタイル[7,8] )diffNormal= 2.70
// いずれも最悪タイルは実際のワイプ位置(フレーム右下〜下部)と一致した。
// 全体平均(diffNormal)は2.7〜10.9とR1較正時のbaseline(8〜12)と同水準なのに
// タイル最大は27〜126と大きく外れる=「画面の一部だけが壊れている」を
// タイル分割が的確に切り出せている証拠。20.0 はこの最小値(26.92)にまだ
// 2026-07-29 の G1 golden 12枚で再較正。Remotion の DOM
// `-webkit-text-stroke` と engine の Canvas2D `strokeText` は、同じ同梱
// Noto Sans JP を使っても字幕タイルだけ 31.67〜38.12 になる。40.0 はこの
// 正常なラスタライズ差を通しつつ、実レイアウト破綻の下限 55.07 を落とす。
export const TILE_DIFF_THRESHOLD = 40.0;

export function buildTempConfigWithRemotion(repoConfigPath, tmpDir) {
  const original = readFileSync(repoConfigPath, "utf8");
  const marker = "\nrender:";
  const idx = original.indexOf(marker);
  if (idx === -1) throw new Error("config.yaml に render: セクションが見つかりません");
  const pos = original.indexOf("\n", idx + marker.length);
  if (pos === -1) throw new Error("render: セクションの次の行が見つかりません");
  // render: 行と次の行の間に engineExport: false を挿入
  const modified = original.slice(0, pos) + "\n  engineExport: false" + original.slice(pos);
  if (modified === original) throw new Error("engineExport: false の挿入に失敗しました(元のconfigと同一)");
  const outPath = join(tmpDir, "config.yaml");
  writeFileSync(outPath, modified);
  return outPath;
}

/** frames コマンドが出力した実際の PNG ファイル名の一覧(リクエスト時刻ではなく
 * スナップ後の出力秒がファイル名になる。例: out25.48s.png) */
export function listOutputPngs(copyDir) {
  return readdirSync(copyDir).filter((f) => f.endsWith(".png")).sort();
}

export function copyOutPngs(dir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const framesDir = join(dir, "frames");
  for (const f of readdirSync(framesDir)) {
    if (f.endsWith(".png")) copyFileSync(join(framesDir, f), join(destDir, f));
  }
}

export function startServer(outDir) {
  const mime = (p) =>
    extname(p) === ".png" ? "image/png" :
    extname(p) === ".js" ? "text/javascript" :
    extname(p) === ".html" ? "text/html" :
    "application/octet-stream";

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = join(outDir, decodeURIComponent(url.pathname.slice(1)));
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime(filePath) });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

export async function findHeadlessShell() {
  return ensureHeadlessShell();
}

export async function launchHeadlessShell(execPath) {
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-pixel-parity-chrome-"));
  const proc = spawn(execPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolveWs, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`DevTools listening timeout`)), 15000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); proc.stderr.off("data", onData); proc.stdout.off("data", onData); resolveWs(m[1]); }
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", onData);
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`chrome-headless-shell exited early (${code})`)); });
  });
  return { proc, wsUrl };
}

export function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const eventListeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result ?? msg); }
    } else if (msg.method) {
      for (const cb of eventListeners.get(msg.method) ?? []) cb(msg.params);
    }
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  return {
    async send(method, params = {}) {
      await ready;
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, method, params }));
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 30000);
        pending.set(myId, {
          resolve: (v) => { clearTimeout(timer); res(v); },
          reject: (e) => { clearTimeout(timer); rej(e); },
        });
      });
    },
    on(method, cb) {
      const set = eventListeners.get(method) ?? new Set();
      set.add(cb);
      eventListeners.set(method, set);
    },
    close: () => ws.close(),
  };
}

export async function newPageWs(browserWsUrl) {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

export function pageScript({ remotionUrl, engineUrl, label, outDir, strictTopLeft, tileDsW, tileCols, tileRows }) {
  return `
(async () => {
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load " + url));
      img.src = url;
    });
  }
  const remotionImg = await loadImage(${JSON.stringify(remotionUrl)});
  const engineImg = await loadImage(${JSON.stringify(engineUrl)});
  const W = remotionImg.naturalWidth, H = remotionImg.naturalHeight;

  // 念のため canvas サイズは engine 側に合わせる(remotion を基準に)
  const rc = document.createElement("canvas"); rc.width = W; rc.height = H;
  const ec = document.createElement("canvas"); ec.width = W; ec.height = H;
  rc.getContext("2d").drawImage(remotionImg, 0, 0, W, H);
  ec.getContext("2d").drawImage(engineImg, 0, 0, W, H);

  // engine flipped
  const efc = document.createElement("canvas");
  efc.width = W; efc.height = H;
  const efctx = efc.getContext("2d");
  efctx.save();
  efctx.scale(1, -1);
  efctx.drawImage(ec, 0, -H);
  efctx.restore();

  // グリッド(remotion | engine | engine-flipped)
  const gc = document.createElement("canvas"); gc.width = W * 3; gc.height = H;
  const gctx = gc.getContext("2d");
  gctx.drawImage(rc, 0, 0);
  gctx.drawImage(ec, W, 0);
  gctx.drawImage(efc, W * 2, 0);

  function downsampleTo(c, dsW, dsH) {
    const ds = document.createElement("canvas"); ds.width = dsW; ds.height = dsH;
    ds.getContext("2d").drawImage(c, 0, 0, dsW, dsH);
    return ds.getContext("2d").getImageData(0, 0, dsW, dsH).data;
  }

  function regionData(c, x, y, w, h) {
    const r = document.createElement("canvas"); r.width = w; r.height = h;
    r.getContext("2d").drawImage(c, x, y, w, h, 0, 0, w, h);
    return r.getContext("2d").getImageData(0, 0, w, h).data;
  }

  function lumDiff(dataA, dataB) {
    let sum = 0;
    for (let i = 0; i < dataA.length; i += 4) {
      const la = 0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2];
      const lb = 0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2];
      sum += Math.abs(la - lb);
    }
    return sum / (dataA.length / 4);
  }

  // タイル別輝度差(R4 Phase1)。ダウンサンプル画像を cols×rows のタイルに
  // 割り、各タイル内の輝度平均絶対差を出す。最大値を呼び出し側で拾う
  function tileDiffs(dataA, dataB, dsW, dsH, cols, rows) {
    const tiles = [];
    for (let ty = 0; ty < rows; ty++) {
      const y0 = Math.floor((ty * dsH) / rows);
      const y1 = Math.floor(((ty + 1) * dsH) / rows);
      for (let tx = 0; tx < cols; tx++) {
        const x0 = Math.floor((tx * dsW) / cols);
        const x1 = Math.floor(((tx + 1) * dsW) / cols);
        let sum = 0, count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * dsW + x) * 4;
            const la = 0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2];
            const lb = 0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2];
            sum += Math.abs(la - lb);
            count++;
          }
        }
        tiles.push({ tx, ty, diff: count > 0 ? sum / count : 0 });
      }
    }
    return tiles;
  }

  // 全体平均(参考値。反転検出にも使う)は従来どおり96px幅ダウンサンプルで
  const dataR96 = downsampleTo(rc, 96, Math.round((96 * H) / W));
  const dataE96 = downsampleTo(ec, 96, Math.round((96 * H) / W));
  const dataEF96 = downsampleTo(efc, 96, Math.round((96 * H) / W));
  const diffNormal = lumDiff(dataR96, dataE96);
  const diffFlipped = lumDiff(dataR96, dataEF96);

  // タイル判定は解像度を上げたダウンサンプルで行う(合否の主判定)
  const tileDsH = Math.round((${tileDsW} * H) / W);
  const dataRtile = downsampleTo(rc, ${tileDsW}, tileDsH);
  const dataEtile = downsampleTo(ec, ${tileDsW}, tileDsH);
  const tiles = tileDiffs(dataRtile, dataEtile, ${tileDsW}, tileDsH, ${tileCols}, ${tileRows});
  let worstTile = tiles[0];
  for (const t of tiles) if (t.diff > worstTile.diff) worstTile = t;
  const worstTileRect = {
    x: Math.round((worstTile.tx * W) / ${tileCols}),
    y: Math.round((worstTile.ty * H) / ${tileRows}),
    w: Math.round(W / ${tileCols}),
    h: Math.round(H / ${tileRows}),
  };

  let topleftDiff = null;
  if (${strictTopLeft}) {
    const tlW = Math.min(240, W), tlH = Math.min(40, H);
    const dataRtl = regionData(rc, 0, 0, tlW, tlH);
    const dataEtl = regionData(ec, 0, 0, tlW, tlH);
    topleftDiff = lumDiff(dataRtl, dataEtl);
  }

  return {
    diffNormal,
    diffFlipped,
    topleftDiff,
    tileDiffMax: worstTile.diff,
    worstTile: { tx: worstTile.tx, ty: worstTile.ty, rect: worstTileRect },
    gridDataUrl: gc.toDataURL("image/png"),
  };
})()`;
}
