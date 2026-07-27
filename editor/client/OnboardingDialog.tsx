// 初回の案内と、ヘッダーの「?」から何度でも開ける使い方パネルを兼ねる。
// 「編集フロー」(初めて開いた人が知りたい順序)と「よく使う操作」
// (二度目以降に引きに来るショートカット)を1枚に置き、詳細は
// docs/guides/editor.md へ送る。
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

/** 二度目以降に引きに来る操作。画面を見ながら読む前提なので、説明ではなく
 *  「どこを触るか」だけを書く(詳細は docs/guides/editor.md) */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["⌘S / ⌘Z", "保存 / 元に戻す"],
  ["Delete", "選択したクリップ・素材・テロップを消す"],
  ["ドラッグ", "クリップの移動、端をつまんでトリム"],
  ["⌘ を押しながら", "ドラッグ中だけ吸着(マグネット)を反転"],
  ["スクリプトタブ", "文字を選んで「選択をカット」"],
  ["プレビュー上でドラッグ", "テロップ・素材の位置とサイズ"],
];

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
          <h2 className="onboardingSubhead">よく使う操作</h2>
          <dl className="onboardingKeys">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={what}>
                <dt>{keys}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p className="onboardingMore">
            素材の入れ方・テロップの見た目・承認とレンダーの詳細は
            <code>docs/guides/editor.md</code>
          </p>
          <div className="onboardingActions">
            <DialogClose asChild><Button>編集を始める</Button></DialogClose>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
};
