import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  toastReducer,
  type Toast,
  type ToastInput,
  type ToastPatch,
} from "./toastReducer.ts";

/**
 * 右下スタックのトースト機構。純関数 toastReducer(add/update/dismiss/expire)を
 * useReducer で駆動し、自動消滅は「最も近い expiresAt に合わせた単一タイマー」で
 * まとめて expire を発火する(トーストごとに setTimeout を持たないので、更新・
 * 削除でタイマーがずれ落ちる余地が無い=effect のクリーンアップで確実に解除)。
 *
 * addToast は id を返す。progress→success の差し替えはこの id を保持して
 * updateToast(id, {kind:"success", ttlMs}) で行う(消して出し直さない=積み位置が
 * 飛ばない)。時計は注入可能(既定 Date.now)。
 */
export function useToasts(clock: () => number = Date.now) {
  const [toasts, dispatch] = useReducer(toastReducer, [] as Toast[]);
  const idRef = useRef(0);

  const addToast = useCallback(
    (t: ToastInput): string => {
      const id = `toast-${++idRef.current}`;
      dispatch({
        type: "add",
        toast: { closable: true, ...t, id },
        now: clock(),
      });
      return id;
    },
    [clock],
  );

  const updateToast = useCallback(
    (id: string, patch: ToastPatch): void => {
      dispatch({ type: "update", id, patch, now: clock() });
    },
    [clock],
  );

  const dismissToast = useCallback((id: string): void => {
    dispatch({ type: "dismiss", id });
  }, []);

  // 最も近い expiresAt に一度だけタイマーを張り、発火時に expire → 再スケジュール。
  // toasts が変わるたびに張り直す(cleanup で前のタイマーを解除)。
  useEffect(() => {
    const times = toasts
      .map((t) => t.expiresAt)
      .filter((x): x is number => x != null);
    if (times.length === 0) return;
    const delay = Math.max(0, Math.min(...times) - clock());
    const h = setTimeout(() => dispatch({ type: "expire", now: clock() }), delay);
    return () => clearTimeout(h);
  }, [toasts, clock]);

  return { toasts, addToast, updateToast, dismissToast };
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const isError = toast.kind === "error";
  return (
    <div
      className={`toast ${toast.kind}`}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      {toast.kind === "progress" && <span className="spin" aria-hidden />}
      <span className="msg">{toast.message}</span>
      {toast.action && (
        <button className="act" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      )}
      {toast.closable !== false && (
        <button
          className="x"
          aria-label="閉じる"
          title="閉じる"
          onClick={() => onDismiss(toast.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** 画面右下のトースト・スタック(新しいものが下=隅側)。 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toastStack" role="region" aria-label="通知">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
