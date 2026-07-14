// FAST spanへ渡す基底映像を構築できるかの純関数ゲート。
// graph実装の有無とは分離し、P1-1では能力だけをモデル化する。
import { completeDesignAssets } from "./design.ts";
import type { DesignAssetRefs } from "./design.ts";
import type { Region } from "../types.ts";
import type { RenderProps } from "../../remotion/props.ts";

export type FastBaseCapability =
  | { ok: true; mode: "composite" }
  | { ok: true; mode: "design"; design: DesignAssetRefs }
  | { ok: true; mode: "plain-identity" }
  | { ok: false; reason: string };

function validRect(rect: Region, bounds: { w: number; h: number }): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x + rect.w <= bounds.w &&
    rect.y + rect.h <= bounds.h
  );
}

export function isPlainIdentityBase(props: RenderProps): boolean {
  return (
    !props.layout &&
    !props.design &&
    !props.cameraRegion &&
    props.canvas.w === props.width &&
    props.canvas.h === props.height &&
    props.screenRegion.x === 0 &&
    props.screenRegion.y === 0 &&
    props.screenRegion.w === props.width &&
    props.screenRegion.h === props.height
  );
}

/**
 * composite、asset完備のdesign、実geometryで証明したplain identityの順に
 * FAST基底能力を解決する。
 */
export function resolveFastBaseCapability(args: {
  props: RenderProps;
  composite: boolean;
}): FastBaseCapability {
  const { props, composite } = args;
  if (composite) return { ok: true, mode: "composite" };

  const design = props.design;
  if (design) {
    const assets = completeDesignAssets(design);
    if (!assets) {
      return { ok: false, reason: "design基底asset不足(backdrop/screenMask/cameraShadow/cameraMask)" };
    }
    if (!validRect(props.screenRegion, props.canvas)) {
      return { ok: false, reason: "design基底のscreenRegionがcanvas範囲外" };
    }
    const output = { w: props.width, h: props.height };
    if (!validRect(design.screen.rect, output)) {
      return { ok: false, reason: "design基底のscreen panelが出力範囲外" };
    }
    if (!props.cameraRegion) {
      return { ok: false, reason: "design基底にcameraRegionがない" };
    }
    if (!validRect(props.cameraRegion, props.canvas)) {
      return { ok: false, reason: "design基底のcameraRegionがcanvas範囲外" };
    }
    if (!validRect(design.camera.rect, output)) {
      return { ok: false, reason: "design基底のcamera panelが出力範囲外" };
    }
    return { ok: true, mode: "design", design: assets };
  }

  if (isPlainIdentityBase(props)) return { ok: true, mode: "plain-identity" };
  return { ok: false, reason: "非composite経路(cut.mp4 が出力解像度でない)" };
}
