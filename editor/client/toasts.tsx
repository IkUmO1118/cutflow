import { useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  createSonnerToastAdapter,
  type SonnerToastApi,
} from "./toastAdapter.ts";
import { announceToastError, toastMessage } from "./toastA11y.ts";

/**
 * CutFlow's existing add/update/dismiss surface backed by Sonner. Stable ids keep
 * progress message updates and progress→success/error transitions in one toast.
 */
export function useToasts() {
  const adapterRef = useRef<ReturnType<typeof createSonnerToastAdapter> | null>(null);
  if (!adapterRef.current) {
    const api: SonnerToastApi = {
      info: (message, options) => toast.info(toastMessage("info", message), {
        ...options,
        icon: undefined,
      }),
      success: (message, options) => toast.success(toastMessage("success", message), {
        ...options,
        icon: undefined,
      }),
      error: (message, options) => {
        announceToastError(message);
        return toast.error(toastMessage("error", message), {
          ...options,
          icon: undefined,
        });
      },
      progress: (message, options) => toast(toastMessage("progress", message), {
        ...options,
        icon: <LoaderCircle className="ocToastSpinner" size={16} aria-hidden />,
      }),
      dismiss: (id) => { toast.dismiss(id); },
    };
    adapterRef.current = createSonnerToastAdapter(api);
  }
  return adapterRef.current;
}
