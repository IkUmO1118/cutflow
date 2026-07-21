import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">;

/** Native checkbox adapter with switch semantics; checked/onChange stay browser-owned. */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn("ocSwitch", className)}
      {...props}
    />
  );
});

Switch.displayName = "Switch";
