import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = ({
  className,
  overlayClassName,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string }) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("ocDialogOverlay", overlayClassName)}
    />
    <DialogPrimitive.Content
      data-slot="dialog-content"
      className={cn("ocDialogContent", className)}
      {...props}
    />
  </DialogPrimitive.Portal>
);
