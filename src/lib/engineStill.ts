import { writeFileSync } from "node:fs";
import { createEngineSession } from "./engineSession.ts";
import type { RenderProps } from "./renderPropsTypes.ts";

/** props から sourceUrls を作る（renderEngine.ts と同じ規則） */
export function sourceUrlsOf(props: RenderProps, sourceFile = props.videoFile): Record<string, string> {
  const sourceUrls: Record<string, string> = { [sourceFile]: `/${sourceFile}` };
  for (const o of props.overlays) sourceUrls[o.file] = `/${o.file}`;
  for (const i of props.inserts ?? []) sourceUrls[i.file] = `/${i.file}`;
  for (const b of props.bgm) sourceUrls[b.file] = `/${b.file}`;
  return sourceUrls;
}

/** 1つの props に対してセッションを1つ張り、複数の出力秒の PNG を書く。
 * session の起動コストが高いので、時刻はまとめて渡す */
export async function captureEngineStills(args: {
  dir: string;
  props: RenderProps;
  durationSec: number;
  shots: { outSec: number; outFile: string }[];
}): Promise<void> {
  const session = await createEngineSession(args.dir, {
    props: args.props,
    sourceUrls: sourceUrlsOf(args.props),
  });
  try {
    for (const shot of args.shots) {
      const pngBase64 = await session.renderAndCapture(shot.outSec);
      writeFileSync(shot.outFile, Buffer.from(pngBase64, "base64"));
    }
  } finally {
    await session.close();
  }
}
