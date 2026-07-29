// Vendored from getopenscreen v1.7.0 (MIT © 2025 Siddharth Vaddem).
// Source: src/components/video-editor/videoPlayback/zoomTransform.ts — PARTIAL PORT.
// Only the pure functions `computeZoomTransform` and `computeFocusFromTransform` (and
// their param/return interfaces) are vendored, verbatim in body math. The upstream file
// also has pixi.js/pixi-filters-dependent code (`applyZoomTransform`, `MotionBlurState`,
// `getMotionBlurAmountResponse`, `TransformParams`) which is NOT vendored — Remotion has
// no motion-blur equivalent and FrameWright does not depend on pixi.
// Do not edit to "improve" — this is a faithful port. See ./PROVENANCE.md.

export interface AppliedTransform {
	scale: number;
	x: number;
	y: number;
}

interface FocusFromTransformGeometry {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	x: number;
	y: number;
}

interface ZoomTransformGeometry {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	zoomProgress?: number;
	focusX: number;
	focusY: number;
}

export function computeZoomTransform({
	stageSize,
	baseMask,
	zoomScale,
	zoomProgress = 1,
	focusX,
	focusY,
}: ZoomTransformGeometry): AppliedTransform {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0
	) {
		return { scale: 1, x: 0, y: 0 };
	}

	const progress = Math.min(1, Math.max(0, zoomProgress));
	// Focus coords are stage-normalized (0-1 of full canvas), so map directly to stage pixels, not via baseMask.
	const focusStagePxX = focusX * stageSize.width;
	const focusStagePxY = focusY * stageSize.height;
	const stageCenterX = stageSize.width / 2;
	const stageCenterY = stageSize.height / 2;
	const scale = 1 + (zoomScale - 1) * progress;
	const finalX = stageCenterX - focusStagePxX * zoomScale;
	const finalY = stageCenterY - focusStagePxY * zoomScale;

	return {
		scale,
		x: finalX * progress,
		y: finalY * progress,
	};
}

export function computeFocusFromTransform({
	stageSize,
	baseMask,
	zoomScale,
	x,
	y,
}: FocusFromTransformGeometry) {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0 ||
		zoomScale <= 0
	) {
		return { cx: 0.5, cy: 0.5 };
	}

	const stageCenterX = stageSize.width / 2;
	const stageCenterY = stageSize.height / 2;
	const focusStagePxX = (stageCenterX - x) / zoomScale;
	const focusStagePxY = (stageCenterY - y) / zoomScale;

	return {
		cx: focusStagePxX / stageSize.width,
		cy: focusStagePxY / stageSize.height,
	};
}
