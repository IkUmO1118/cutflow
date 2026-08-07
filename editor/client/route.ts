import { isCanvasPreset } from "../../src/lib/profile.ts";

declare global {
  interface Window {
    __FW_RECORDING_ROOT_MODE__?: "single" | "multi";
  }
}

/** サーバーが index.html に埋め込むモードフラグ。未注入は従来の single 扱い。 */
export function recordingRootMode(): "single" | "multi" {
  return typeof window !== "undefined" && window.__FW_RECORDING_ROOT_MODE__ === "multi" ? "multi" : "single";
}

/** ランチャー配下では API/絶対 media URL を現在のプロジェクトへ束縛する。 */
export function projectPrefix(pathname = location.pathname): string {
  const re = recordingRootMode() === "multi" ? /^\/p\/[^/]+\/[^/]+/ : /^\/p\/[^/]+/;
  const match = re.exec(pathname);
  return match?.[0] ?? "";
}

export function projectPath(path: string, pathname = location.pathname): string {
  if (!path.startsWith("/")) return path;
  return `${projectPrefix(pathname)}${path}`;
}

export function isLauncherRoute(pathname = location.pathname): boolean {
  return projectPrefix(pathname) === "";
}

/** 作成直後の空プロジェクトへ URL で渡したキャンバス。未知値は安全な横長へ戻す。 */
export function initialCanvasFromSearch(search = location.search): string {
  const value = new URLSearchParams(search).get("canvas");
  return value !== null && isCanvasPreset(value) ? value : "landscape";
}
