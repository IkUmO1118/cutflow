export const THEME_STORAGE_KEY = "cutflow.editor.theme";
export const SYSTEM_THEME_MEDIA = "(prefers-color-scheme: dark)";

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

/** Missing and unknown persisted values intentionally follow the OS. */
export const parseThemePreference = (value: string | null): ThemePreference =>
  value === "light" || value === "dark" || value === "system" ? value : "system";

export const resolveThemePreference = (
  preference: ThemePreference,
  systemDark: boolean,
): EffectiveTheme =>
  preference === "system" ? (systemDark ? "dark" : "light") : preference;

export const themePreferenceLabel = (preference: ThemePreference): string => {
  if (preference === "light") return "ライト";
  if (preference === "dark") return "ダーク";
  return "システム";
};
