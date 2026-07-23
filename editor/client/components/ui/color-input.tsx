import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export type ColorInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** Native color picker adapter preserving continuous onChange and exact CSS strings. */
export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(function ColorInput(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type="color"
      data-slot="color-input"
      className={cn("ocColorInput", className)}
      {...props}
    />
  );
});

ColorInput.displayName = "ColorInput";
