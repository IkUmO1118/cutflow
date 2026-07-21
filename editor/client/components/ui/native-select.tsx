import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/** Native select retained for exact controlled onChange/value behavior. */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  function NativeSelect({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        data-slot="native-select"
        className={cn(
          "h-7 min-w-0 rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

NativeSelect.displayName = "NativeSelect";
