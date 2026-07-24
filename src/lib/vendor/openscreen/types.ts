// Vendored from getopenscreen v1.7.0 (MIT © 2025 Siddharth Vaddem).
// Source: src/components/video-editor/types.ts (trimmed extract — zoom/cursor-telemetry
// exports only, verbatim bodies; webcam/annotation/blur/crop/speed exports and the
// `@/lib/compositeLayout` import are stripped since this vendor only needs the zoom
// runtime types). See ./PROVENANCE.md.

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;
export type ZoomFocusMode = "manual" | "auto";

export interface ZoomFocus {
	cx: number; // normalized horizontal center (0-1)
	cy: number; // normalized vertical center (0-1)
}

export interface Rotation3D {
	rotationX: number;
	rotationY: number;
	rotationZ: number;
}

export const DEFAULT_ROTATION_3D: Rotation3D = {
	rotationX: 0,
	rotationY: 0,
	rotationZ: 0,
};

export type Rotation3DPreset = "iso" | "left" | "right";

export const ROTATION_3D_PRESETS: Record<Rotation3DPreset, Rotation3D> = {
	iso: { rotationX: -10, rotationY: -16, rotationZ: 0 },
	left: { rotationX: 0, rotationY: -22, rotationZ: 0 },
	right: { rotationX: 0, rotationY: 22, rotationZ: 0 },
};

export const ROTATION_3D_PRESET_ORDER: Rotation3DPreset[] = ["iso", "left", "right"];

/**
 * Origin of a zoom region. "auto" marks zooms from the magic-wand suggest pass;
 * toggling the wand off removes only these. Editing an auto zoom promotes it to
 * "manual" so it survives. Undefined is treated as "manual" for back-compat.
 */
export type ZoomRegionSource = "auto" | "manual";

export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth: ZoomDepth;
	focus: ZoomFocus;
	focusMode?: ZoomFocusMode;
	rotationPreset?: Rotation3DPreset;
	/** Custom scale overriding the preset depth (1.0-5.0, two decimal precision). */
	customScale?: number;
	source?: ZoomRegionSource;
}

export function getRotation3D(region: Pick<ZoomRegion, "rotationPreset">): Rotation3D {
	if (!region.rotationPreset) return DEFAULT_ROTATION_3D;
	return ROTATION_3D_PRESETS[region.rotationPreset];
}

export function isRotation3DIdentity(r: Rotation3D, eps = 0.01): boolean {
	return Math.abs(r.rotationX) < eps && Math.abs(r.rotationY) < eps && Math.abs(r.rotationZ) < eps;
}

export function lerpRotation3D(a: Rotation3D, b: Rotation3D, t: number): Rotation3D {
	return {
		rotationX: a.rotationX + (b.rotationX - a.rotationX) * t,
		rotationY: a.rotationY + (b.rotationY - a.rotationY) * t,
		rotationZ: a.rotationZ + (b.rotationZ - a.rotationZ) * t,
	};
}

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: "move" | "click" | "double-click" | "right-click" | "middle-click" | "mouseup";
	cursorType?:
		| "arrow"
		| "text"
		| "pointer"
		| "crosshair"
		| "open-hand"
		| "closed-hand"
		| "resize-ew"
		| "resize-ns"
		| "not-allowed";
}

export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
	1: 1.25,
	2: 1.5,
	3: 1.8,
	4: 2.2,
	5: 3.5,
	6: 5.0,
};

export const MIN_ZOOM_SCALE = 1.0;
export const MAX_ZOOM_SCALE = 5.0;

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3;

/** Returns the effective zoom scale for a region, preferring customScale over the preset. */
export function getZoomScale(region: ZoomRegion): number {
	if (region.customScale != null) {
		const clamped = Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, region.customScale));
		if (Number.isFinite(clamped)) return clamped;
	}
	return ZOOM_DEPTH_SCALES[region.depth];
}

export function clampFocusToDepth(focus: ZoomFocus, _depth: ZoomDepth): ZoomFocus {
	return {
		cx: clamp(focus.cx, 0, 1),
		cy: clamp(focus.cy, 0, 1),
	};
}

function clamp(value: number, min: number, max: number) {
	if (Number.isNaN(value)) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}
