import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseThemePreference,
  resolveThemePreference,
  themePreferenceLabel,
} from "../editor/client/themeRules.ts";
import {
  isMobileGateAcknowledged,
  isNarrowEditorViewport,
  shouldShowMobileGate,
} from "../editor/client/mobileGateRules.ts";
import {
  isOnboardingSeen,
  shouldShowOnboarding,
} from "../editor/client/onboardingRules.ts";

test("theme preference parsing and effective resolution share the system fallback", () => {
  assert.equal(parseThemePreference(null), "system");
  assert.equal(parseThemePreference(""), "system");
  assert.equal(parseThemePreference("sepia"), "system");
  assert.equal(parseThemePreference("system"), "system");
  assert.equal(parseThemePreference("light"), "light");
  assert.equal(parseThemePreference("dark"), "dark");
  assert.equal(resolveThemePreference("system", false), "light");
  assert.equal(resolveThemePreference("system", true), "dark");
  assert.equal(resolveThemePreference("light", true), "light");
  assert.equal(resolveThemePreference("dark", false), "dark");
  assert.deepEqual(
    ["system", "light", "dark"].map((value) => themePreferenceLabel(value as "system" | "light" | "dark")),
    ["システム", "ライト", "ダーク"],
  );
});

test("mobile gate uses the exact boundary and a one-way mounted latch", () => {
  assert.equal(isNarrowEditorViewport(1023), true);
  assert.equal(isNarrowEditorViewport(1024), false);
  assert.equal(isMobileGateAcknowledged(null), false);
  assert.equal(isMobileGateAcknowledged("false"), false);
  assert.equal(isMobileGateAcknowledged("true"), true);
  assert.equal(shouldShowMobileGate(1023, false, false), true);
  assert.equal(shouldShowMobileGate(1024, false, false), false);
  assert.equal(shouldShowMobileGate(1023, true, false), false);
  assert.equal(shouldShowMobileGate(1023, false, true), false);
});

test("onboarding waits for loaded project and conflict resolution, then honors seen", () => {
  assert.equal(isOnboardingSeen(null), false);
  assert.equal(isOnboardingSeen("true"), true);
  assert.equal(shouldShowOnboarding(null, true, false, false, false), true);
  assert.equal(shouldShowOnboarding("true", true, false, false, false), false);
  assert.equal(shouldShowOnboarding(null, false, false, false, false), false);
  assert.equal(shouldShowOnboarding(null, true, true, false, false), false);
  assert.equal(shouldShowOnboarding(null, true, false, true, false), false);
  assert.equal(shouldShowOnboarding(null, true, false, false, true), false);
});
