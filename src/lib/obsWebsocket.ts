import { createHash } from "node:crypto";

/**
 * 依存ゼロの obs-websocket v5 クライアント(JSON プロトコル。native
 * WebSocket は Node 22+ に組み込み済みで `ws` パッケージが要らない)。
 * `record --watch`(D3)専用。REQUEST(op:6)/RequestResponse(op:7)の往復と
 * Event(op:5)の購読だけを提供する薄いラッパーで、obs-websocket-js の
 * 機能(msgpack・自動再接続等)は持たない(このリポジトリの「設定は少なく・
 * 依存は最小に」の方針。P0/P3 で実機 OBS に対して動作確認済み)。
 * §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md D3
 */

export class ObsWebSocketError extends Error {}

export interface ObsWebSocketOptions {
  host?: string;
  port?: number;
  password?: string;
}

export interface ObsEvent {
  eventType: string;
  eventData: Record<string, unknown>;
}

export interface ObsWebSocketClient {
  call<T = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<T>;
  /** イベント購読。戻り値を呼ぶと購読解除 */
  onEvent(handler: (event: ObsEvent) => void): () => void;
  close(): void;
}

/** obs-websocket EventSubscription ビットマスク(protocol.md)。
 * record --watch が要るのは Outputs(RecordStateChanged 等)だけ */
const EVENT_SUBSCRIPTION_OUTPUTS = 1 << 6;

function authString(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

interface PendingRequest {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** obs-websocket v5 へ接続し、Identify ハンドシェイクまで完了させる */
export async function connectObsWebSocket(
  opts: ObsWebSocketOptions = {},
): Promise<ObsWebSocketClient> {
  const host = opts.host ?? "localhost";
  const port = opts.port ?? 4455;
  const password = opts.password;
  const ws = new WebSocket(`ws://${host}:${port}`);

  let requestSeq = 0;
  const pending = new Map<string, PendingRequest>();
  const eventHandlers = new Set<(event: ObsEvent) => void>();

  function send(obj: unknown): void {
    ws.send(JSON.stringify(obj));
  }

  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: { op: number; d: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.op === 0) {
        const hello = msg.d as {
          rpcVersion: number;
          authentication?: { salt: string; challenge: string };
        };
        const identify: Record<string, unknown> = {
          rpcVersion: hello.rpcVersion,
          eventSubscriptions: EVENT_SUBSCRIPTION_OUTPUTS,
        };
        if (hello.authentication) {
          if (!password) {
            settled = true;
            rejectReady(
              new ObsWebSocketError(
                "obs-websocket は認証が有効ですが password が指定されていません" +
                  "(OBS の「ツール」→「WebSocket サーバー設定」→「接続情報を表示」で確認できます)",
              ),
            );
            ws.close();
            return;
          }
          identify.authentication = authString(
            password,
            hello.authentication.salt,
            hello.authentication.challenge,
          );
        }
        send({ op: 1, d: identify });
      } else if (msg.op === 2) {
        if (!settled) {
          settled = true;
          resolveReady();
        }
      } else if (msg.op === 5) {
        const d = msg.d as { eventType: string; eventData?: Record<string, unknown> };
        const event: ObsEvent = { eventType: d.eventType, eventData: d.eventData ?? {} };
        for (const h of eventHandlers) {
          try {
            h(event);
          } catch (err) {
            console.error(`obs-websocket イベントハンドラでエラー: ${(err as Error).message}`);
          }
        }
      } else if (msg.op === 7) {
        const d = msg.d as {
          requestId: string;
          requestType: string;
          requestStatus: { result: boolean; code: number; comment?: string };
          responseData?: Record<string, unknown>;
        };
        const p = pending.get(d.requestId);
        if (p) {
          pending.delete(d.requestId);
          if (d.requestStatus.result) p.resolve(d.responseData ?? {});
          else {
            p.reject(
              new ObsWebSocketError(
                `obs-websocket リクエスト失敗(${d.requestType}): ` +
                  `code=${d.requestStatus.code} ${d.requestStatus.comment ?? ""}`,
              ),
            );
          }
        }
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        rejectReady(
          new ObsWebSocketError(
            `obs-websocket(ws://${host}:${port})に接続できません。OBS が起動していて` +
              "WebSocket サーバーが有効か確認してください",
          ),
        );
      }
    });
    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        rejectReady(new ObsWebSocketError("obs-websocket が接続確立前に切断されました"));
      }
      for (const p of pending.values()) {
        p.reject(new ObsWebSocketError("obs-websocket 接続が切断されました"));
      }
      pending.clear();
    });
  });

  return {
    call<T = Record<string, unknown>>(
      requestType: string,
      requestData?: Record<string, unknown>,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const requestId = `req-${++requestSeq}`;
        pending.set(requestId, { resolve: resolve as PendingRequest["resolve"], reject });
        send({ op: 6, d: { requestType, requestId, requestData } });
      });
    },
    onEvent(handler: (event: ObsEvent) => void): () => void {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    close(): void {
      ws.close();
    },
  };
}
