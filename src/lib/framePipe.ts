import { spawn } from "node:child_process";

export interface FramePipe {
  /** PNG のバイト列を1フレーム分書き込む（背圧を待つ） */
  write(png: Buffer): Promise<void>;
  /** stdin を閉じて ffmpeg の終了を待つ。失敗時は stderr 末尾を含めて throw */
  finish(): Promise<void>;
}

export function startFramePipe(args: { fps: number; outPath: string }): FramePipe {
  const encArgs = [
    "-y", "-v", "error",
    "-f", "image2pipe", "-framerate", String(args.fps), "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", args.outPath,
  ];
  const ffmpegProc = spawn("ffmpeg", encArgs, { stdio: ["pipe", "pipe", "pipe"] });
  const stderrChunks: Buffer[] = [];
  let finished = false;

  ffmpegProc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  const closePromise = new Promise<void>((res, rej) => {
    ffmpegProc.on("close", (code) => {
      finished = true;
      if (code !== 0) {
        rej(new Error(`ffmpeg failed: ${Buffer.concat(stderrChunks).toString().slice(-2000)}`));
      } else {
        res();
      }
    });
    ffmpegProc.on("error", rej);
  });

  return {
    async write(png: Buffer): Promise<void> {
      if (finished) throw new Error("ffmpeg pipe already closed");
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const onError = (error: Error) => {
          ffmpegProc.stdin.off("drain", onDrain);
          rejectWrite(error);
        };
        const onDrain = () => {
          ffmpegProc.stdin.off("error", onError);
          resolveWrite();
        };
        ffmpegProc.stdin.once("error", onError);
        if (!ffmpegProc.stdin.write(png)) {
          ffmpegProc.stdin.once("drain", onDrain);
        } else {
          ffmpegProc.stdin.off("error", onError);
          resolveWrite();
        }
      });
    },

    async finish(): Promise<void> {
      ffmpegProc.stdin.end();
      await closePromise;
    },
  };
}
