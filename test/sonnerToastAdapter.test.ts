import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast as realSonnerToast } from "sonner";
import {
  createSonnerToastAdapter,
  MAX_VISIBLE_TOASTS,
  TOAST_TTL_MS,
  type SonnerToastApi,
  type SonnerToastOptions,
  type ToastKind,
} from "../editor/client/toastAdapter.ts";
import {
  announceToastError,
  getToastErrorAnnouncement,
  ToastErrorAnnouncer,
  toastMessage,
} from "../editor/client/toastA11y.ts";

type Call = {
  method: ToastKind | "dismiss";
  message?: string;
  options?: SonnerToastOptions;
  id?: string;
};

const fakeSonner = () => {
  const calls: Call[] = [];
  const show = (method: ToastKind) => (message: string, options: SonnerToastOptions) => {
    calls.push({ method, message, options });
    return options.id;
  };
  const api: SonnerToastApi = {
    info: show("info"),
    success: show("success"),
    error: show("error"),
    progress: (message, options) => {
      calls.push({ method: "progress", message, options });
      return options.id;
    },
    dismiss: (id) => { calls.push({ method: "dismiss", id }); },
  };
  return { calls, adapter: createSonnerToastAdapter(api) };
};

test("Sonner adapter keeps exact TTL defaults, sticky progress, and five visible", () => {
  assert.deepEqual(TOAST_TTL_MS, { info: 4000, success: 4000, error: 8000 });
  assert.equal(MAX_VISIBLE_TOASTS, 5);
  const { calls, adapter } = fakeSonner();
  const ids = [
    adapter.addToast({ kind: "info", message: "i" }),
    adapter.addToast({ kind: "success", message: "s" }),
    adapter.addToast({ kind: "error", message: "e" }),
    adapter.addToast({ kind: "progress", message: "p" }),
  ];
  assert.deepEqual(ids, ["toast-1", "toast-2", "toast-3", "toast-4"]);
  assert.deepEqual(calls.map((call) => call.method), ["info", "success", "error", "progress"]);
  assert.deepEqual(calls.map((call) => call.options?.duration), [4000, 4000, 8000, Infinity]);
  for (const call of calls.slice(0, 3)) {
    assert.equal(Object.hasOwn(call.options ?? {}, "icon"), true);
    assert.equal(call.options?.icon, undefined);
  }
});

test("explicit TTL, action, and closable false map to Sonner options", () => {
  const { calls, adapter } = fakeSonner();
  let acted = 0;
  const id = adapter.addToast({
    kind: "success",
    message: "done",
    ttlMs: 6000,
    closable: false,
    action: { label: "開く", onClick: () => { acted += 1; } },
  });
  assert.equal(id, "toast-1");
  assert.equal(calls[0].options?.duration, 6000);
  assert.equal(calls[0].options?.closeButton, false);
  assert.equal(calls[0].options?.dismissible, false);
  assert.equal(calls[0].options?.action?.label, "開く");
  let prevented = false;
  calls[0].options?.action?.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(acted, 1);
  assert.equal(prevented, true);
  assert.deepEqual(calls[1], { method: "dismiss", id });
  adapter.updateToast(id, { message: "must not resurrect" });
  assert.equal(calls.length, 2);
});

test("progress stays sticky but remains closable and swipe-dismissible by default", () => {
  const { calls, adapter } = fakeSonner();
  adapter.addToast({ kind: "progress", message: "working" });
  adapter.addToast({ kind: "progress", message: "locked", closable: false });
  assert.equal(calls[0].method, "progress");
  assert.equal(calls[0].options?.duration, Infinity);
  assert.equal(calls[0].options?.closeButton, true);
  assert.equal(calls[0].options?.dismissible, true);
  assert.equal(calls[1].options?.closeButton, false);
  assert.equal(calls[1].options?.dismissible, false);
});

test("progress updates and progress-to-result transitions reuse one stable id", () => {
  const { calls, adapter } = fakeSonner();
  const id = adapter.addToast({ kind: "progress", message: "0/2" });
  adapter.updateToast(id, { message: "1/2" });
  adapter.updateToast(id, { kind: "success", message: "2/2", ttlMs: 4000 });
  const errorId = adapter.addToast({ kind: "progress", message: "working" });
  adapter.updateToast(errorId, { kind: "error", message: "failed", ttlMs: 8000 });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["progress", "progress", "success", "progress", "error"],
  );
  assert.deepEqual(calls.map((call) => call.options?.id), [id, id, id, errorId, errorId]);
  assert.deepEqual(
    calls.map((call) => call.options?.duration),
    [Infinity, Infinity, 4000, Infinity, 8000],
  );
  for (const resultCall of [calls[2], calls[4]]) {
    assert.equal(Object.hasOwn(resultCall.options ?? {}, "icon"), true);
    assert.equal(resultCall.options?.icon, undefined);
  }
});

test("Sonner 2.0.7 clears a previous custom icon when an id update owns icon undefined", () => {
  const id = "sonner-icon-merge-contract";
  realSonnerToast("working", { id, icon: "custom-spinner" });
  realSonnerToast.success("done", { id, icon: undefined });
  const latest = realSonnerToast.getHistory().find((item) => item.id === id) as
    | { icon?: unknown; type?: string }
    | undefined;
  assert.ok(latest);
  assert.equal(Object.hasOwn(latest, "icon"), true);
  assert.equal(latest.icon, undefined);
  assert.equal(latest.type, "success");
});

test("dismiss targets the same id and unknown updates are ignored", () => {
  const { calls, adapter } = fakeSonner();
  const id = adapter.addToast({ kind: "error", message: "failed" });
  adapter.updateToast("missing", { message: "ignored" });
  adapter.dismissToast(id);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { method: "dismiss", id });
});

test("Sonner lifecycle callbacks release adapter merge state", () => {
  const { calls, adapter } = fakeSonner();
  const id = adapter.addToast({ kind: "info", message: "temporary" });
  calls[0].options?.onAutoClose();
  adapter.updateToast(id, { message: "must stay gone" });
  assert.equal(calls.length, 1);
});

test("stale lifecycle callbacks cannot delete the latest revision", () => {
  const { calls, adapter } = fakeSonner();
  const id = adapter.addToast({ kind: "progress", message: "0/3" });
  const first = calls[0].options;
  adapter.updateToast(id, { message: "1/3" });
  const second = calls[1].options;
  adapter.updateToast(id, { message: "2/3" });

  first?.onAutoClose();
  second?.onDismiss();
  adapter.updateToast(id, { kind: "success", message: "3/3" });

  assert.equal(calls.length, 4);
  assert.equal(calls[3].method, "success");
  assert.equal(calls[3].options?.id, id);
});

test("action cleanup runs in finally when the user callback throws", () => {
  const { calls, adapter } = fakeSonner();
  const id = adapter.addToast({
    kind: "success",
    message: "done",
    action: { label: "開く", onClick: () => { throw new Error("boom"); } },
  });

  assert.throws(() => calls[0].options?.action?.onClick(), /boom/);
  assert.deepEqual(calls[1], { method: "dismiss", id });
  adapter.updateToast(id, { message: "must not resurrect" });
  assert.equal(calls.length, 2);
});

test("stale actions cannot dismiss a newer revision", () => {
  const { calls, adapter } = fakeSonner();
  let acted = 0;
  const id = adapter.addToast({
    kind: "progress",
    message: "old",
    action: { label: "旧操作", onClick: () => { acted += 1; } },
  });
  const oldAction = calls[0].options?.action;
  adapter.updateToast(id, { message: "new", action: undefined });

  oldAction?.onClick();
  adapter.updateToast(id, { kind: "success", message: "latest" });

  assert.equal(acted, 1);
  assert.equal(calls.some((call) => call.method === "dismiss"), false);
  assert.equal(calls.at(-1)?.message, "latest");
});

test("error visual text is hidden from Sonner polite output while non-errors stay polite", () => {
  const errorHtml = renderToStaticMarkup(toastMessage("error", "失敗しました"));
  const infoHtml = renderToStaticMarkup(toastMessage("info", "保存しました"));
  assert.match(errorHtml, /aria-hidden="true"/);
  assert.doesNotMatch(errorHtml, /role="alert"|aria-live=/);
  assert.equal(errorHtml.match(/失敗しました/g)?.length, 1);
  assert.doesNotMatch(infoHtml, /role="alert"|aria-live=|aria-hidden=/);
});

test("error announcer versions repeated messages and renders one assertive path", () => {
  const before = getToastErrorAnnouncement();
  announceToastError("同じエラー");
  const first = getToastErrorAnnouncement();
  announceToastError("同じエラー");
  const second = getToastErrorAnnouncement();
  assert.equal(first.version, before.version + 1);
  assert.equal(second.version, first.version + 1);
  assert.equal(first.message, second.message);
  assert.notStrictEqual(first, second);

  const html = renderToStaticMarkup(createElement(ToastErrorAnnouncer));
  assert.match(html, /class="ocToastErrorAnnouncer"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /aria-atomic="true"/);
  assert.equal(html.match(/同じエラー/g)?.length, 1);
});

test("client mounts actual Sonner without the custom reducer, timer, or stack", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const hook = read("editor/client/toasts.tsx");
  const toaster = read("editor/client/components/ui/sonner.tsx");
  const a11y = read("editor/client/toastA11y.ts");
  const css = read("editor/client/styles.css");
  const app = read("editor/client/App.tsx");
  assert.match(hook, /import \{ toast \} from "sonner"/);
  assert.doesNotMatch(hook, /useReducer|setTimeout|ToastStack|toastReducer/);
  for (const method of ["info", "success", "error", "dismiss"]) {
    assert.ok(hook.includes(`toast.${method}`), `missing Sonner call ${method}`);
  }
  assert.match(hook, /progress:[\s\S]*toast\(toastMessage\("progress"/);
  assert.doesNotMatch(hook, /toast\.loading/);
  assert.match(hook, /LoaderCircle[\s\S]*ocToastSpinner/);
  assert.match(hook, /LoaderCircle[^>]*aria-hidden/);
  assert.match(hook, /info:[\s\S]*icon: undefined/);
  assert.match(hook, /success:[\s\S]*icon: undefined/);
  assert.match(hook, /error:[\s\S]*announceToastError\(message\)[\s\S]*icon: undefined/);
  assert.match(toaster, /Toaster as Sonner/);
  assert.match(toaster, /position = "bottom-right"/);
  assert.match(toaster, /visibleToasts = MAX_VISIBLE_TOASTS/);
  assert.match(toaster, /closeButton = true/);
  assert.match(toaster, /offset = \{ bottom: 76, right: 16 \}/);
  assert.match(toaster, /mobileOffset = \{ bottom: 76, left: 16, right: 16 \}/);
  assert.match(toaster, /containerAriaLabel = "通知"/);
  assert.match(toaster, /closeButtonAriaLabel: "閉じる"/);
  assert.match(toaster, /<>\s*<Sonner[\s\S]*\/>\s*<ToastErrorAnnouncer \/>\s*<\/>/);
  assert.doesNotMatch(a11y, /className: "ocToastMessage"[^\n]*role: "alert"/);
  assert.match(a11y, /className: "ocToastMessage", "aria-hidden": true/);
  assert.match(a11y, /key: announcement\.version/);
  assert.match(css, /\.ocToastErrorAnnouncer \{[\s\S]*clip-path: inset\(50%\)/);
  assert.match(app, /<Toaster \/>/);
  assert.match(app, /<HeaderBanners/);
  assert.doesNotMatch(app, /ToastStack|const \{\s*toasts[,}]/);
  assert.equal(existsSync(join(root, "editor/client/toastReducer.ts")), false);
});
