// src/engine/runtime/webgpuBackend.ts — 自前 WGSL コンポジタ(M3a Phase3改)。
// opencut-wasm(npm)は esbuild でもブラウザのネイティブ ES Module 機構でも
// ロードできないと判明した（wasm-bindgen "bundler" ターゲット出力の
// `import * as wasm from "*.wasm"` に esbuild が対応しておらず、WASM/ESM
// integration もどのブラウザにも既定で入っていない。母艦§9「M3a Phase5
// 直前・重大発見」ログ）ため、ユーザー判断で自前実装に切替えた。
//
// 公開関数は opencut-wasm と同じ形（initializeGpu/initCompositor/
// getCompositorCanvas/resizeCompositor/uploadTexture/releaseTexture/
// renderFrame）に揃えてあり、compositor.ts/textureCache.ts はほぼ無改造で
// import 元をこちらへ差し替えるだけで済む。
//
// スコープ: CutFlow の descriptor.ts は blendMode="normal"・回転/反転なし・
// GPU側マスク/エフェクトパス無し(blur/spotlight/colorFilter は§2の決定で
// GPU外(canvas2d blit・2パス snapshot)に追い出し済み)しか使わないため、
// 「テクスチャ付き矩形を通常アルファ合成で置くだけ」のパイプライン1本で足りる。
// WebGL2 フォールバックは書かない(v1。§8 の置換判定はもう済んでいるため
// 「欠けたら自前 WGSL」の次の手は無い。WebGPU 非対応環境は Phase5 で実測し
// 必要なら追加する)。
//
// ブラウザ専用(WebGPU 前提)。
import type { Rect } from "../descriptor.ts";

const SHADER_SOURCE = /* wgsl */ `
struct Uniforms {
  canvasSize: vec2f,
  center: vec2f,
  size: vec2f,
  opacity: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var positions = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5),
    vec2f(-0.5, 0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  let local = positions[vi];
  let pixelPos = u.center + local * u.size;
  let ndc = vec2f(
    (pixelPos.x / u.canvasSize.x) * 2.0 - 1.0,
    1.0 - (pixelPos.y / u.canvasSize.y) * 2.0,
  );
  var out: VOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let color = textureSample(tex, samp, in.uv);
  return vec4f(color.rgb, color.a * u.opacity);
}
`;

interface Runtime {
  adapter: GPUAdapter;
  device: GPUDevice;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
}

interface CompositorState {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  width: number;
  height: number;
  textures: Map<string, GPUTexture>;
}

let runtime: Runtime | null = null;
let compositor: CompositorState | null = null;

export async function initializeGpu(): Promise<void> {
  if (runtime) return;
  if (!navigator.gpu) throw new Error("webgpuBackend: navigator.gpu is not available");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("webgpuBackend: no WebGPU adapter available");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: SHADER_SOURCE });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  runtime = { adapter, device, format, pipeline, sampler };
}

function requireRuntime(): Runtime {
  if (!runtime) throw new Error("webgpuBackend: initializeGpu() を先に呼んでください");
  return runtime;
}

export function initCompositor(width: number, height: number): void {
  const rt = requireRuntime();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("webgpuBackend: canvas.getContext('webgpu') に失敗しました");
  context.configure({ device: rt.device, format: rt.format, alphaMode: "opaque" });
  compositor = { canvas, context, width, height, textures: new Map() };
}

function requireCompositor(): CompositorState {
  if (!compositor) throw new Error("webgpuBackend: initCompositor() を先に呼んでください");
  return compositor;
}

export function getCompositorCanvas(): HTMLCanvasElement {
  return requireCompositor().canvas;
}

export function resizeCompositor(width: number, height: number): void {
  const c = requireCompositor();
  const rt = requireRuntime();
  if (c.width === width && c.height === height) return;
  c.canvas.width = width;
  c.canvas.height = height;
  c.width = width;
  c.height = height;
  c.context.configure({ device: rt.device, format: rt.format, alphaMode: "opaque" });
}

export interface UploadTextureOptions {
  id: string;
  source: OffscreenCanvas;
  width: number;
  height: number;
}

export function uploadTexture(options: UploadTextureOptions): void {
  const rt = requireRuntime();
  const c = requireCompositor();
  const existing = c.textures.get(options.id);
  if (existing) existing.destroy();
  const texture = rt.device.createTexture({
    size: [options.width, options.height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  rt.device.queue.copyExternalImageToTexture(
    { source: options.source },
    { texture },
    [options.width, options.height],
  );
  c.textures.set(options.id, texture);
}

export function releaseTexture(id: string): void {
  const c = requireCompositor();
  const texture = c.textures.get(id);
  if (texture) {
    texture.destroy();
    c.textures.delete(id);
  }
}

export interface CompositorLayerInput {
  textureId: string;
  transform: { centerX: number; centerY: number; width: number; height: number };
  opacity: number;
}

export interface CompositorFrameInput {
  width: number;
  height: number;
  clear: { color: [number, number, number, number] };
  items: CompositorLayerInput[];
}

const UNIFORM_FLOATS = 8; // canvasSize(2) + center(2) + size(2) + opacity(1) + pad(1)

export function renderFrame(frame: CompositorFrameInput): void {
  const rt = requireRuntime();
  const c = requireCompositor();
  if (c.width !== frame.width || c.height !== frame.height) resizeCompositor(frame.width, frame.height);

  const encoder = rt.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: c.context.getCurrentTexture().createView(),
        clearValue: {
          r: frame.clear.color[0],
          g: frame.clear.color[1],
          b: frame.clear.color[2],
          a: frame.clear.color[3],
        },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(rt.pipeline);

  for (const item of frame.items) {
    const texture = c.textures.get(item.textureId);
    if (!texture) continue; // uploadTexture 漏れは compositor.ts 側の不具合。ここでは黙って skip する
    const uniformData = new Float32Array(UNIFORM_FLOATS);
    uniformData.set(
      [
        frame.width,
        frame.height,
        item.transform.centerX,
        item.transform.centerY,
        item.transform.width,
        item.transform.height,
        item.opacity,
        0,
      ],
    );
    // 1 draw = 1 専用 uniform buffer(パス内でバッファを使い回すと、
    // writeBuffer が全 draw の後にまとめて反映されてしまい直前の値で
    // 上書きされる。§落とし穴)
    const uniformBuffer = rt.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    rt.device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    const bindGroup = rt.device.createBindGroup({
      layout: rt.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: rt.sampler },
        { binding: 2, resource: texture.createView() },
      ],
    });
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
  }

  pass.end();
  rt.device.queue.submit([encoder.finish()]);
}

/** 計測用: このフレームで実際に upload 済みのテクスチャ数(リーク検知に使える) */
export function textureCount(): number {
  return compositor?.textures.size ?? 0;
}

/** Rect(descriptor.ts)からこのバックエンドの transform 形へ変換するのは
 * compositor.ts 側(quadToTransform)の責務のまま。ここでは Rect 型を
 * 直接は使わないが、compositor.ts が import する型の対称性のため re-export */
export type { Rect };
