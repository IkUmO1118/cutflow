import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** Native range adapter: input/change cadence and controlled value stay intact. */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type="range"
      data-slot="slider"
      className={cn("ocSlider", className)}
      {...props}
    />
  );
});

Slider.displayName = "Slider";
