// src/lib/designAssetHtml.ts — design 静的資産を Remotion なしの HTML 文字列にする。
import { CAMERA_SHADOW_CSS, SCREEN_SHADOW_CSS, type DesignProps } from "./design.ts";

export type DesignStillRole = "backdrop" | "screenMask" | "cameraShadow" | "cameraMask";

export type DesignStillDesign = Omit<DesignProps, "assets">;

export type DesignStillProps = {
  width: number;
  height: number;
  role: DesignStillRole;
  design: DesignStillDesign;
};

export function designStillCanvas(
  role: DesignStillRole,
  design: DesignStillDesign,
  width: number,
  height: number,
): { width: number; height: number } {
  if (role === "screenMask") return { width: design.screen.rect.w, height: design.screen.rect.h };
  if (role === "cameraMask") return { width: design.camera.rect.w, height: design.camera.rect.h };
  return { width, height };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function px(value: number): string {
  return `${value}px`;
}

function fillStyle(extra: string): string {
  return `position:absolute;top:0px;left:0px;right:0px;bottom:0px;width:100%;height:100%;display:flex;flex-direction:column${extra}`;
}

function mask(width: number, height: number, radiusPx: number): string {
  return `<div style="${fillStyle(`;width:${px(width)};height:${px(height)};background-color:white;border-radius:${px(radiusPx)}`)}"></div>`;
}

export function designStillHtml(args: {
  role: DesignStillRole;
  design: DesignStillDesign;
  width: number;
  height: number;
  backgroundSrc?: string;
}): string {
  const { role, design, width, height, backgroundSrc } = args;
  let body: string;
  if (role === "screenMask") {
    body = mask(design.screen.rect.w, design.screen.rect.h, design.screen.radiusPx);
  } else if (role === "cameraMask") {
    body = mask(design.camera.rect.w, design.camera.rect.h, design.camera.radiusPx);
  } else if (role === "cameraShadow") {
    const { rect, radiusPx, shadow } = design.camera;
    const shadowStyle = shadow ? `;box-shadow:${CAMERA_SHADOW_CSS}` : "";
    body = `<div style="${fillStyle(";background-color:transparent")}"><div style="position:absolute;left:${px(rect.x)};top:${px(rect.y)};width:${px(rect.w)};height:${px(rect.h)};border-radius:${px(radiusPx)}${shadowStyle}"></div></div>`;
  } else {
    const { rect, radiusPx, shadow } = design.screen;
    const image = design.backgroundFile && backgroundSrc
      ? `<img src="${escapeHtml(backgroundSrc)}" style="position:absolute;inset:0;width:${px(width)};height:${px(height)};object-fit:cover">`
      : "";
    const shadowStyle = shadow ? `;box-shadow:${SCREEN_SHADOW_CSS}` : "";
    body = `<div style="${fillStyle(`;background-color:${escapeHtml(design.backgroundColor)}`)}">${image}<div style="position:absolute;left:${px(rect.x)};top:${px(rect.y)};width:${px(rect.w)};height:${px(rect.h)};border-radius:${px(radiusPx)}${shadowStyle}"></div></div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head><body>${body}</body></html>`;
}
