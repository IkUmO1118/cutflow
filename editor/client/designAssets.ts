import { attachPreparedDesignAssets } from "../../src/lib/design.ts";
import type { DesignProps, PreparedDesignAssets } from "../../src/lib/design.ts";

/** server 検証済み assets を raw resolved design へ attach してから、Player が
 * /media/ で読める URL へ変換する。URL 化済み path は key/source 照合に使わない */
export function designForPlayer(
  design: DesignProps | undefined,
  width: number,
  height: number,
  prepared: PreparedDesignAssets | undefined,
): DesignProps | undefined {
  const attached = attachPreparedDesignAssets(design, width, height, prepared);
  if (!attached) return undefined;
  return {
    ...attached,
    ...(attached.backgroundFile ? { backgroundFile: `media/${attached.backgroundFile}` } : {}),
    ...(attached.assets
      ? {
          assets: {
            ...attached.assets,
            backdropFile: `media/${attached.assets.backdropFile}`,
            screenMaskFile: `media/${attached.assets.screenMaskFile}`,
            ...(attached.assets.cameraShadowFile
              ? { cameraShadowFile: `media/${attached.assets.cameraShadowFile}` }
              : {}),
            ...(attached.assets.cameraMaskFile
              ? { cameraMaskFile: `media/${attached.assets.cameraMaskFile}` }
              : {}),
          },
        }
      : {}),
  };
}
