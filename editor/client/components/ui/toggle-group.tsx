import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const ToggleGroup = ({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) => (
  <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn("ocToggleGroup", className)} {...props} />
);

export const ToggleGroupItem = ({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) => (
  <ToggleGroupPrimitive.Item
    data-slot="toggle-group-item"
    className={cn("ocToggleGroupItem", className)}
    {...props}
  />
);
