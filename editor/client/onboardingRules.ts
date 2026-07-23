export const ONBOARDING_STORAGE_KEY = "cutflow.editor.onboarding.v1";
export const isOnboardingSeen = (value: string | null): boolean => value === "true";

export const shouldShowOnboarding = (
  storedValue: string | null,
  projectReady: boolean,
  hasDraftOffer: boolean,
  hasExternalChange: boolean,
  diffPanelOpen: boolean,
): boolean =>
  !isOnboardingSeen(storedValue) &&
  projectReady &&
  !hasDraftOffer &&
  !hasExternalChange &&
  !diffPanelOpen;
