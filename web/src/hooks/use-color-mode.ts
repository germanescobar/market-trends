import { useEffect, useState } from "react";

export type ColorMode = "light" | "dark" | "system";

const STORAGE_KEY = "market-trends:color-mode";

function applyMode(mode: ColorMode): void {
  const root = document.documentElement;
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", isDark);
}

/** Read the persisted color-mode, or `system` on first load. */
export function readColorMode(): ColorMode {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function useColorMode(): { mode: ColorMode; setMode: (m: ColorMode) => void } {
  const [mode, setMode] = useState<ColorMode>(() => readColorMode());

  useEffect(() => {
    applyMode(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // Track system preference while in `system` mode.
  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyMode("system");
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [mode]);

  return { mode, setMode };
}
