export const MOBILE_GATE_STORAGE_KEY = "cutflow.editor.mobileGateAcknowledged";
export const MOBILE_GATE_BREAKPOINT = 1024;

export const isMobileGateAcknowledged = (value: string | null): boolean => value === "true";
export const isNarrowEditorViewport = (width: number): boolean => width < MOBILE_GATE_BREAKPOINT;

/** mounted is a one-way session latch: shrinking never tears the editor down. */
export const shouldShowMobileGate = (
  width: number,
  acknowledged: boolean,
  mounted: boolean,
): boolean => !mounted && !acknowledged && isNarrowEditorViewport(width);
