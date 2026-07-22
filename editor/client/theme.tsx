import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  SYSTEM_THEME_MEDIA,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveThemePreference,
} from "./themeRules.ts";
import type { EffectiveTheme, ThemePreference } from "./themeRules.ts";

export {
  SYSTEM_THEME_MEDIA,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveThemePreference,
  themePreferenceLabel,
} from "./themeRules.ts";
export type { EffectiveTheme, ThemePreference } from "./themeRules.ts";

type ThemeContextValue = {
  preference: ThemePreference;
  effectiveTheme: EffectiveTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const readPreference = (): ThemePreference => {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
};

const systemPrefersDark = (): boolean =>
  typeof matchMedia === "function" && matchMedia(SYSTEM_THEME_MEDIA).matches;

/** Keep token selection, native controls, and browser chrome on one resolved theme. */
export const applyEffectiveTheme = (
  theme: EffectiveTheme,
  root: HTMLElement = document.documentElement,
): void => {
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const effectiveTheme = resolveThemePreference(preference, systemDark);

  useEffect(() => {
    const query = matchMedia(SYSTEM_THEME_MEDIA);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreferenceState(parseThemePreference(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => applyEffectiveTheme(effectiveTheme), [effectiveTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The in-memory choice still works when storage is unavailable.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, effectiveTheme, setPreference }),
    [preference, effectiveTheme, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme は ThemeProvider の内側で使ってください");
  return value;
};
