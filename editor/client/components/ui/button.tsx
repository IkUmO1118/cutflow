import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-solid text-xs font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50!",
  {
    variants: {
      variant: {
        default: "border-primary! bg-primary! text-primary-foreground! hover:bg-primary/80!",
        outline: "border-border! bg-transparent! text-foreground! hover:bg-muted!",
        secondary: "border-transparent! bg-secondary! text-secondary-foreground! hover:bg-secondary/80!",
        ghost: "border-transparent! bg-transparent! text-foreground! hover:bg-muted!",
        destructive: "border-transparent! bg-destructive/10! text-destructive! hover:bg-destructive/20!",
      },
      size: {
        default: "h-7 gap-1 px-2",
        sm: "h-6 gap-1 rounded-sm px-2",
        lg: "h-8 gap-1 px-2.5",
        icon: "size-7 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

/** Native button only; polymorphic composition is deferred until needed. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

Button.displayName = "Button";
