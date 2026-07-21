import { useCallback, useEffect, useRef, useState } from "react";
import type { CutPlan } from "../../src/types.ts";
import type { PreviewCutResponse } from "./apiTypes.ts";

export const PREVIEW_CUT_DEBOUNCE_MS = 1500;

export type PreviewCutRebakeState =
  | { status: "idle" }
  | { status: "waiting" | "building"; keepSignature: string }
  | { status: "failed"; keepSignature: string; error: string };

export interface PreviewCutRebakeInput {
  cutplan: CutPlan | null;
  keepSignature: string;
  ready: boolean;
  readySignature: string;
  enabled: boolean;
  /** proxy 再生成時に進め、同一 keep でも過去の失敗/成功と別 target にする。 */
  sourceVersion: number;
}

interface PreviewCutRebakeControllerOptions {
  request: (cutplan: CutPlan) => Promise<PreviewCutResponse>;
  onState: (state: PreviewCutRebakeState) => void;
  onReady: (response: PreviewCutResponse) => void;
  debounceMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * debounce と非同期世代競合をReactから分離した小さな状態機械。
 * update は同じkeep署名ならsnapshotだけ更新し、timerは延長しない。
 */
export class PreviewCutRebakeController {
  private readonly request: PreviewCutRebakeControllerOptions["request"];
  private readonly onState: PreviewCutRebakeControllerOptions["onState"];
  private readonly onReady: PreviewCutRebakeControllerOptions["onReady"];
  private readonly debounceMs: number;
  private readonly schedule: NonNullable<PreviewCutRebakeControllerOptions["schedule"]>;
  private readonly cancel: NonNullable<PreviewCutRebakeControllerOptions["cancel"]>;
  private timer: unknown = null;
  private generation = 0;
  private targetKey: string | null = null;
  private latestInput: PreviewCutRebakeInput | null = null;
  private disposed = false;

  constructor(options: PreviewCutRebakeControllerOptions) {
    this.request = options.request;
    this.onState = options.onState;
    this.onReady = options.onReady;
    this.debounceMs = options.debounceMs ?? PREVIEW_CUT_DEBOUNCE_MS;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  update(input: PreviewCutRebakeInput): void {
    if (this.disposed) return;
    this.latestInput = input;
    const ready = input.ready && input.readySignature === input.keepSignature;
    const nextTarget = input.enabled && input.cutplan && !ready
      ? `${input.sourceVersion}:${input.keepSignature}`
      : null;
    if (nextTarget === this.targetKey) return;

    this.targetKey = nextTarget;
    this.generation += 1;
    this.clearTimer();
    if (nextTarget === null) {
      this.onState({ status: "idle" });
      return;
    }
    const generation = this.generation;
    this.onState({ status: "waiting", keepSignature: input.keepSignature });
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.launch(generation, nextTarget);
    }, this.debounceMs);
  }

  retry(): void {
    const input = this.latestInput;
    if (!input || !input.cutplan || !input.enabled ||
        (input.ready && input.readySignature === input.keepSignature)) return;
    const targetKey = `${input.sourceVersion}:${input.keepSignature}`;
    this.targetKey = targetKey;
    this.generation += 1;
    this.clearTimer();
    void this.launch(this.generation, targetKey);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private isCurrent(generation: number, targetKey: string, signature: string): boolean {
    return !this.disposed && generation === this.generation &&
      targetKey === this.targetKey && signature === this.latestInput?.keepSignature;
  }

  private async launch(generation: number, targetKey: string): Promise<void> {
    const input = this.latestInput;
    if (!input?.cutplan || !this.isCurrent(generation, targetKey, input.keepSignature)) return;
    const signature = input.keepSignature;
    const snapshot = structuredClone(input.cutplan);
    this.onState({ status: "building", keepSignature: signature });
    try {
      const response = await this.request(snapshot);
      if (!this.isCurrent(generation, targetKey, signature)) return;
      if (response.keepSignature !== signature) {
        this.onState({
          status: "failed",
          keepSignature: signature,
          error: "生成結果が現在のカットと一致しませんでした",
        });
        return;
      }
      this.onReady(response);
      this.onState({ status: "idle" });
    } catch (error) {
      if (!this.isCurrent(generation, targetKey, signature)) return;
      this.onState({
        status: "failed",
        keepSignature: signature,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function usePreviewCutRebake(args: PreviewCutRebakeInput & {
  request: (cutplan: CutPlan) => Promise<PreviewCutResponse>;
  onReady: (response: PreviewCutResponse) => void;
}): { state: PreviewCutRebakeState; retry: () => void } {
  const [state, setState] = useState<PreviewCutRebakeState>({ status: "idle" });
  const onReadyRef = useRef(args.onReady);
  onReadyRef.current = args.onReady;
  const controllerRef = useRef<PreviewCutRebakeController | null>(null);

  useEffect(() => {
    const controller = new PreviewCutRebakeController({
      request: args.request,
      onState: setState,
      onReady: (response) => onReadyRef.current(response),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [args.request]);

  useEffect(() => {
    controllerRef.current?.update({
      cutplan: args.cutplan,
      keepSignature: args.keepSignature,
      ready: args.ready,
      readySignature: args.readySignature,
      enabled: args.enabled,
      sourceVersion: args.sourceVersion,
    });
  }, [
    args.cutplan,
    args.keepSignature,
    args.ready,
    args.readySignature,
    args.enabled,
    args.sourceVersion,
    args.request,
  ]);

  const retry = useCallback(() => controllerRef.current?.retry(), []);
  return { state, retry };
}
