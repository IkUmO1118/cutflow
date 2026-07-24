// Vendored from getopenscreen v1.7.0 (MIT © 2025 Siddharth Vaddem).
// Source: src/lib/compositeLayout.ts (reactiveWebcamScale + WEBCAM_REACTIVE_ZOOM_MIN_SCALE, verbatim).
// Do not edit to "improve" — faithful port. See ./PROVENANCE.md.

export const WEBCAM_REACTIVE_ZOOM_MIN_SCALE = 0.35;

export function reactiveWebcamScale(zoomScale: number): number {
  const safe = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  return Math.max(WEBCAM_REACTIVE_ZOOM_MIN_SCALE, Math.min(1, 1 / safe));
}
