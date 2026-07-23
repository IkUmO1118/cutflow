import { createElement, useSyncExternalStore, type ReactNode } from "react";
import type { ToastKind } from "./toastAdapter.ts";

/**
 * Error text is visually present but excluded from Sonner's polite live region.
 * ToastErrorAnnouncer exposes the same text through one assertive path instead.
 */
export const toastMessage = (kind: ToastKind, message: string): ReactNode =>
  createElement(
    "span",
    kind === "error"
      ? { className: "ocToastMessage", "aria-hidden": true }
      : { className: "ocToastMessage" },
    message,
  );

export interface ToastErrorAnnouncement {
  message: string;
  version: number;
}

let errorAnnouncement: ToastErrorAnnouncement = { message: "", version: 0 };
const errorAnnouncementListeners = new Set<() => void>();

export const announceToastError = (message: string): void => {
  errorAnnouncement = { message, version: errorAnnouncement.version + 1 };
  for (const listener of errorAnnouncementListeners) listener();
};

export const getToastErrorAnnouncement = (): ToastErrorAnnouncement => errorAnnouncement;

const subscribeToToastErrors = (listener: () => void): (() => void) => {
  errorAnnouncementListeners.add(listener);
  return () => { errorAnnouncementListeners.delete(listener); };
};

/** A sibling of Sonner's polite section, so an error has exactly one live path. */
export const ToastErrorAnnouncer = () => {
  const announcement = useSyncExternalStore(
    subscribeToToastErrors,
    getToastErrorAnnouncement,
    getToastErrorAnnouncement,
  );
  return createElement(
    "div",
    {
      className: "ocToastErrorAnnouncer",
      role: "alert",
      "aria-live": "assertive",
      "aria-atomic": true,
    },
    announcement.message
      ? createElement("span", { key: announcement.version }, announcement.message)
      : null,
  );
};
