import * as ResizablePrimitive from "react-resizable-panels";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils.ts";

const ResizablePanelGroup = ({
  className,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Group>) => (
  <ResizablePrimitive.Group
    className={cn("resizablePanelGroup", className)}
    {...props}
  />
);

const ResizablePanel = ({
  style,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Panel>) => (
  <ResizablePrimitive.Panel style={{ overflow: "hidden", ...style }} {...props} />
);

const ResizableHandle = ({
  className,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Separator>) => (
  <ResizablePrimitive.Separator
    className={cn("resizableHandle", className)}
    {...props}
  />
);

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
