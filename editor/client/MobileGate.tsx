import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MonitorSmartphone } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import {
  MOBILE_GATE_BREAKPOINT,
  MOBILE_GATE_STORAGE_KEY,
  isMobileGateAcknowledged,
  shouldShowMobileGate,
} from "./mobileGateRules.ts";

export {
  MOBILE_GATE_BREAKPOINT,
  MOBILE_GATE_STORAGE_KEY,
  isMobileGateAcknowledged,
  isNarrowEditorViewport,
  shouldShowMobileGate,
} from "./mobileGateRules.ts";

const acknowledgedFromStorage = (): boolean => {
  try {
    return isMobileGateAcknowledged(localStorage.getItem(MOBILE_GATE_STORAGE_KEY));
  } catch {
    return false;
  }
};

/**
 * App stays completely unmounted behind this gate. Viewport expansion unlocks
 * only this session; only the explicit CTA persists acknowledgement.
 */
export const MobileGate = ({ children }: { children: ReactNode }) => {
  const [acknowledged] = useState(acknowledgedFromStorage);
  const [mounted, setMounted] = useState(
    () => !shouldShowMobileGate(window.innerWidth, acknowledged, false),
  );

  useEffect(() => {
    if (mounted) return;
    const onResize = () => {
      if (window.innerWidth >= MOBILE_GATE_BREAKPOINT) setMounted(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mounted]);

  if (mounted || acknowledged) return children;

  const continueAnyway = () => {
    try {
      localStorage.setItem(MOBILE_GATE_STORAGE_KEY, "true");
    } catch {
      // Continue for this session even if storage is unavailable.
    }
    setMounted(true);
  };

  return (
    <main className="mobileGate">
      <div className="mobileGateCard">
        <div className="mobileGateIcon" aria-hidden><MonitorSmartphone size={26} /></div>
        <h1>広い画面での編集をおすすめします</h1>
        <p>
          CutFlow のタイムライン編集は横幅 1024px 以上を想定しています。
          この案内を表示している間はエディタを起動せず、収録フォルダの JSON データにも影響しません。
        </p>
        <Button onClick={continueAnyway}>それでも表示</Button>
      </div>
    </main>
  );
};
