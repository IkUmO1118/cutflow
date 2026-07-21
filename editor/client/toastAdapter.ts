import type { ReactNode } from "react";

export type ToastKind = "info" | "success" | "error" | "progress";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** 0 = sticky. Omitted values use the kind default; progress is always sticky. */
  ttlMs?: number;
  /** Show Sonner's close button. Defaults to true. */
  closable?: boolean;
}

export type ToastPatch = Partial<ToastInput>;

export const TOAST_TTL_MS = {
  info: 4000,
  success: 4000,
  error: 8000,
} as const;

export const MAX_VISIBLE_TOASTS = 5;

export interface SonnerToastOptions {
  id: string;
  duration: number;
  /** Explicit undefined clears a custom icon when Sonner merges an existing id. */
  icon: ReactNode | undefined;
  action?: {
    label: string;
    onClick: (event?: { preventDefault: () => void }) => void;
  };
  closeButton: boolean;
  dismissible: boolean;
  onAutoClose: () => void;
  onDismiss: () => void;
}

export interface SonnerToastApi {
  info: (message: string, options: SonnerToastOptions) => string | number;
  success: (message: string, options: SonnerToastOptions) => string | number;
  error: (message: string, options: SonnerToastOptions) => string | number;
  /** A sticky normal toast with a loading icon, so close/swipe remain available. */
  progress: (message: string, options: SonnerToastOptions) => string | number;
  dismiss: (id: string) => void;
}

const durationOf = (input: ToastInput): number => {
  if (input.kind === "progress") return Infinity;
  if (input.ttlMs !== undefined) return input.ttlMs > 0 ? input.ttlMs : Infinity;
  return TOAST_TTL_MS[input.kind];
};

const showToast = (
  api: SonnerToastApi,
  id: string,
  input: ToastInput,
  onRemove: () => void,
  onAction: (action: ToastAction) => void,
) => {
  const options: SonnerToastOptions = {
    id,
    duration: durationOf(input),
    icon: undefined,
    action: input.action
      ? {
          label: input.action.label,
          onClick: (event) => {
            // Sonner otherwise deletes by id after the callback. Prevent that
            // unguarded deletion and let the revision-aware adapter own cleanup.
            event?.preventDefault();
            onAction(input.action!);
          },
        }
      : undefined,
    closeButton: input.closable !== false,
    dismissible: input.closable !== false,
    onAutoClose: onRemove,
    onDismiss: onRemove,
  };
  switch (input.kind) {
    case "info":
      api.info(input.message, options);
      break;
    case "success":
      api.success(input.message, options);
      break;
    case "error":
      api.error(input.message, options);
      break;
    case "progress":
      api.progress(input.message, options);
      break;
  }
};

/**
 * CutFlow's stable-id toast API over Sonner. The map exists only to merge partial
 * updates; lifecycle, timers, rendering, stacking, and polite output belong to Sonner.
 */
export const createSonnerToastAdapter = (api: SonnerToastApi) => {
  let nextId = 0;
  type CurrentToast = { input: ToastInput; revision: number };
  const current = new Map<string, CurrentToast>();

  const isCurrent = (id: string, revision: number): boolean =>
    current.get(id)?.revision === revision;

  const removeIfCurrent = (id: string, revision: number): boolean => {
    if (!isCurrent(id, revision)) return false;
    current.delete(id);
    return true;
  };

  const showCurrent = (id: string, entry: CurrentToast): void => {
    const remove = () => { removeIfCurrent(id, entry.revision); };
    const act = (action: ToastAction) => {
      try {
        action.onClick();
      } finally {
        // Sonner removes action toasts itself only when the callback returns.
        // Explicit dismissal also handles throws, while the revision guard keeps
        // a stale action/callback from deleting a newer update with the same id.
        if (removeIfCurrent(id, entry.revision)) api.dismiss(id);
      }
    };
    showToast(api, id, entry.input, remove, act);
  };

  const addToast = (input: ToastInput): string => {
    const id = `toast-${++nextId}`;
    const entry = { input, revision: 1 };
    current.set(id, entry);
    showCurrent(id, entry);
    return id;
  };

  const updateToast = (id: string, patch: ToastPatch): void => {
    const previous = current.get(id);
    if (!previous) return;
    const next = {
      input: { ...previous.input, ...patch },
      revision: previous.revision + 1,
    };
    current.set(id, next);
    showCurrent(id, next);
  };

  const dismissToast = (id: string): void => {
    current.delete(id);
    api.dismiss(id);
  };

  return { addToast, updateToast, dismissToast };
};
