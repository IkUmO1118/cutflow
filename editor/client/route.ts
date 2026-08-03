import { isCanvasPreset } from "../../src/lib/profile.ts";

/** ランチャー配下では API/絶対 media URL を現在の /p/<name> に束縛する。 */
export function projectPrefix(pathname = location.pathname): string {
  const match = /^\/p\/[^/]+/.exec(pathname);
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
