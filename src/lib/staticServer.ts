// src/lib/staticServer.ts — 収録フォルダを安全に HTTP 配信する共有実装。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

export type StaticServerRoute = {
  path: string;
  file: string;
  contentType: string;
};

export type StaticServer = {
  server: Server;
  port: number;
};

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
};

function mime(p: string): string {
  return MIME[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
}

function sendFile(
  filePath: string,
  contentType: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const st = statSync(filePath);
  const size = st.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(size),
  });
  createReadStream(filePath).pipe(res);
}

export function startStaticServer(publicRoot: string, routes: StaticServerRoute[] = []): Promise<StaticServer> {
  const absDir = resolve(publicRoot);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find((candidate) => candidate.path === url.pathname);
      if (route) {
        const data = readFileSync(route.file);
        res.writeHead(200, { "Content-Type": route.contentType, "Content-Length": String(data.length) });
        res.end(data);
        return;
      }
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const filePath = join(publicRoot, rel);
      const abs = normalize(filePath);
      if (!abs.startsWith(absDir + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!existsSync(abs)) {
        res.writeHead(404);
        res.end();
        return;
      }
      sendFile(abs, mime(abs), req, res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    resolveServer({ server, port: addr.port });
  }));
}
