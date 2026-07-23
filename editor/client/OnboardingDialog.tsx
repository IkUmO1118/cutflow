import { Clapperboard, MousePointer2, Save, X } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { ONBOARDING_STORAGE_KEY } from "./onboardingRules.ts";

export {
  ONBOARDING_STORAGE_KEY,
  isOnboardingSeen,
  shouldShowOnboarding,
} from "./onboardingRules.ts";

export const OnboardingDialog = ({
  open,
  onDismiss,
}: {
  open: boolean;
  onDismiss: () => void;
}) => {
  const dismiss = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    } catch {
      // Dismissal still lasts for this mounted session when storage is unavailable.
    }
    onDismiss();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent asChild overlayClassName="onboardingBackdrop">
        <section className="onboardingDialog" aria-label="CutFlow の編集を始める">
          <div className="onboardingHead">
            <div>
              <div className="onboardingKicker">はじめに</div>
              <DialogTitle asChild><h1>CutFlow の編集フロー</h1></DialogTitle>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label="閉じる"><X size={16} aria-hidden /></Button>
            </DialogClose>
          </div>
          <DialogDescription asChild>
            <p className="onboardingLead">元の収録を守りながら、選択・保存・確認の順で仕上げます。</p>
          </DialogDescription>
          <ol className="onboardingSteps">
            <li>
              <MousePointer2 aria-hidden />
              <div><strong>タイムラインで選択</strong><span>クリップを選び、左右のパネルで内容や見た目を編集します。</span></div>
            </li>
            <li>
              <Save aria-hidden />
              <div><strong>⌘S で JSON を保存</strong><span>未保存の変更は自動で下書き退避され、次回起動時に復元できます。</span></div>
            </li>
            <li>
              <Clapperboard aria-hidden />
              <div><strong>プレビュー → 承認 → レンダー</strong><span>結果を確認して承認したあと、最終動画を書き出します。</span></div>
            </li>
          </ol>
          <div className="onboardingActions">
            <DialogClose asChild><Button>編集を始める</Button></DialogClose>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
};
