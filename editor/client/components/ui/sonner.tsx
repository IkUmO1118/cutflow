import { CircleCheck, CircleX, Info } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { MAX_VISIBLE_TOASTS } from "../../toastAdapter.ts";
import { ToastErrorAnnouncer } from "../../toastA11y.ts";

export const Toaster = ({
  theme = "dark",
  position = "bottom-right",
  visibleToasts = MAX_VISIBLE_TOASTS,
  closeButton = true,
  offset = { bottom: 76, right: 16 },
  mobileOffset = { bottom: 76, left: 16, right: 16 },
  containerAriaLabel = "通知",
  ...props
}: ToasterProps) => (
  <>
    <Sonner
      theme={theme}
      position={position}
      visibleToasts={visibleToasts}
      closeButton={closeButton}
      offset={offset}
      mobileOffset={mobileOffset}
      containerAriaLabel={containerAriaLabel}
      className="ocToaster group"
      icons={{
        success: <CircleCheck size={16} aria-hidden />,
        info: <Info size={16} aria-hidden />,
        error: <CircleX size={16} aria-hidden />,
      }}
      toastOptions={{
        closeButtonAriaLabel: "閉じる",
        classNames: {
          toast: "ocToast",
          title: "ocToastTitle",
          actionButton: "ocToastAction",
          closeButton: "ocToastClose",
        },
      }}
      {...props}
    />
    <ToastErrorAnnouncer />
  </>
);
