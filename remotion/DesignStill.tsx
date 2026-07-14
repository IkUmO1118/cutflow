// remotion/DesignStill.tsx — design の時間不変な背景・影・角丸 mask を、
// Main と FAST 基底が共有できる PNG として焼く browser-safe composition。
import { AbsoluteFill, Img, staticFile } from "remotion";
import { CAMERA_SHADOW_CSS, SCREEN_SHADOW_CSS } from "../src/lib/design.ts";
import type { DesignProps } from "../src/lib/design.ts";

export type DesignStillRole = "backdrop" | "screenMask" | "cameraShadow" | "cameraMask";

export type DesignStillDesign = Omit<DesignProps, "assets">;

export type DesignStillProps = {
  width: number;
  height: number;
  role: DesignStillRole;
  design: DesignStillDesign;
};

const mask = (width: number, height: number, radiusPx: number) => (
  <AbsoluteFill
    style={{
      width,
      height,
      backgroundColor: "white",
      borderRadius: radiusPx,
    }}
  />
);

export const DesignStill = ({ width, height, role, design }: DesignStillProps) => {
  if (role === "screenMask") {
    return mask(design.screen.rect.w, design.screen.rect.h, design.screen.radiusPx);
  }
  if (role === "cameraMask") {
    return mask(design.camera.rect.w, design.camera.rect.h, design.camera.radiusPx);
  }
  if (role === "cameraShadow") {
    const { rect, radiusPx, shadow } = design.camera;
    return (
      <AbsoluteFill style={{ backgroundColor: "transparent" }}>
        <div
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            borderRadius: radiusPx,
            ...(shadow ? { boxShadow: CAMERA_SHADOW_CSS } : {}),
          }}
        />
      </AbsoluteFill>
    );
  }

  const { rect, radiusPx, shadow } = design.screen;
  return (
    <AbsoluteFill style={{ backgroundColor: design.backgroundColor }}>
      {design.backgroundFile && (
        <Img
          src={staticFile(design.backgroundFile)}
          style={{ position: "absolute", inset: 0, width, height, objectFit: "cover" }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: radiusPx,
          ...(shadow ? { boxShadow: SCREEN_SHADOW_CSS } : {}),
        }}
      />
    </AbsoluteFill>
  );
};

export const designStillDefaultProps: DesignStillProps = {
  width: 1920,
  height: 1080,
  role: "backdrop",
  design: {
    backgroundColor: "#000000",
    screen: {
      rect: { x: 100, y: 22, w: 1720, h: 968 },
      radiusPx: 24,
      shadow: true,
    },
    camera: {
      rect: { x: 1517, y: 677, w: 375, h: 375 },
      radiusPx: 96,
      shadow: true,
    },
  },
};
