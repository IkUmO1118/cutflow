import { isCollection, parse, parseDocument, YAMLMap } from "yaml";
import type { Document } from "yaml";
import { DEFAULT_IMAGE_DURATION_SEC } from "./config.ts";
import type { Config } from "./config.ts";

/**
 * エディタの設定画面(POST /api/config)が config.yaml を書き換えるための
 * パッチ。指定したキーだけを更新する。省略可キー(caption* /
 * defaultImageDurationSec)は null で「キーを削除して既定に戻す」。
 * systemAudio / ducking はブロック全体を渡す(部分マージで
 * 「mix だけあって volumeDb が無い」壊れた形を作らないため)。
 * ここに無いキー(ingest / whisper / detect / llm 等)は GUI から触らせない
 */
export interface ConfigPatch {
  render?: {
    wipeWidthPx?: number;
    wipeMarginPx?: number;
    wipeTransitionSec?: number;
    captionFontSizePx?: number;
    captionColor?: string | null;
    captionOutlineColor?: string | null;
    captionFontFamily?: string | null;
    captionFontWeight?: number | null;
    chapterCardSec?: number;
    targetLufs?: number;
    systemAudio?: { mix: boolean; volumeDb: number };
    bgm?: {
      volumeDb?: number;
      fadeOutSec?: number;
      ducking?: { duckDb: number; fadeSec: number };
    };
    hardwareAcceleration?: "if-possible" | "disable" | null;
  };
  preview?: { width?: number };
  editor?: { maxUploadMb?: number; defaultImageDurationSec?: number | null };
}

/** 数値キーの検査仕様。int は整数必須、even は偶数必須(ffmpeg の yuv420p) */
interface NumRule {
  min: number;
  max: number;
  int?: boolean;
  even?: boolean;
}

const NUM_RULES: Record<string, NumRule> = {
  "render.wipeWidthPx": { min: 100, max: 1920, int: true },
  "render.wipeMarginPx": { min: 0, max: 400, int: true },
  "render.wipeTransitionSec": { min: 0, max: 5 },
  "render.captionFontSizePx": { min: 10, max: 200, int: true },
  "render.captionFontWeight": { min: 100, max: 900, int: true },
  "render.chapterCardSec": { min: 0.5, max: 30 },
  "render.targetLufs": { min: -36, max: -6 },
  "render.systemAudio.volumeDb": { min: -60, max: 20 },
  "render.bgm.volumeDb": { min: -60, max: 12 },
  "render.bgm.fadeOutSec": { min: 0, max: 30 },
  "render.bgm.ducking.duckDb": { min: -60, max: 0 },
  "render.bgm.ducking.fadeSec": { min: 0, max: 5 },
  "preview.width": { min: 320, max: 3840, int: true, even: true },
  "editor.maxUploadMb": { min: 1, max: 100000, int: true },
  "editor.defaultImageDurationSec": { min: 0.5, max: 120 },
};

/** null で「削除して既定に戻す」を受け付けるキー(省略可キーのみ) */
const NULLABLE = new Set([
  "render.captionColor",
  "render.captionOutlineColor",
  "render.captionFontFamily",
  "render.captionFontWeight",
  "render.hardwareAcceleration",
  "editor.defaultImageDurationSec",
]);

/** 文字列キーの最大長(色は CSS カラー、フォントはスタック想定) */
const STR_MAX: Record<string, number> = {
  "render.captionColor": 64,
  "render.captionOutlineColor": 64,
  "render.captionFontFamily": 300,
};

/**
 * ConfigPatch の型・範囲検査。エラーメッセージの配列を返す(空 = 合格)。
 * 未知キーはホワイトリスト方式で拒否する(タイポの黙殺を防ぐ)
 */
export function validateConfigPatch(patch: unknown): string[] {
  const errors: string[] = [];
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return ["パッチはオブジェクトで指定してください"];
  }

  const checkLeaf = (path: string, value: unknown): void => {
    if (value === null) {
      if (!NULLABLE.has(path)) errors.push(`${path}: null は指定できません`);
      return;
    }
    if (path === "render.systemAudio.mix") {
      if (typeof value !== "boolean") errors.push(`${path}: true/false で指定してください`);
      return;
    }
    if (path === "render.hardwareAcceleration") {
      if (value !== "if-possible" && value !== "disable") {
        errors.push(`${path}: "if-possible" か "disable" で指定してください`);
      }
      return;
    }
    if (path in STR_MAX) {
      if (typeof value !== "string" || value.length === 0 || value.length > STR_MAX[path]) {
        errors.push(`${path}: 1〜${STR_MAX[path]}文字の文字列で指定してください`);
      }
      return;
    }
    const rule = NUM_RULES[path];
    if (!rule) {
      errors.push(`${path}: 不明なキーです`);
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${path}: 数値で指定してください`);
      return;
    }
    if (rule.int && !Number.isInteger(value)) errors.push(`${path}: 整数で指定してください`);
    else if (rule.even && value % 2 !== 0) errors.push(`${path}: 偶数で指定してください`);
    else if (value < rule.min || value > rule.max) {
      errors.push(`${path}: ${rule.min}〜${rule.max} の範囲で指定してください`);
    }
  };

  // ブロック(systemAudio / ducking)は全項目必須。それ以外は再帰的に葉を検査
  const walk = (prefix: string, obj: unknown, allowed: string[], blocks: string[]): void => {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      errors.push(`${prefix || "パッチ"}: オブジェクトで指定してください`);
      return;
    }
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!allowed.includes(key)) {
        errors.push(`${path}: 不明なキーです`);
        continue;
      }
      if (blocks.includes(key)) continue; // 下でブロックとして検査
      checkLeaf(path, value);
    }
  };

  const p = patch as ConfigPatch;
  for (const key of Object.keys(p)) {
    if (!["render", "preview", "editor"].includes(key)) {
      errors.push(`${key}: 不明なキーです`);
    }
  }
  if (p.render !== undefined) {
    walk(
      "render",
      p.render,
      [
        "wipeWidthPx", "wipeMarginPx", "wipeTransitionSec", "captionFontSizePx",
        "captionColor", "captionOutlineColor", "captionFontFamily", "captionFontWeight",
        "chapterCardSec", "targetLufs", "systemAudio", "bgm", "hardwareAcceleration",
      ],
      ["systemAudio", "bgm"],
    );
    if (p.render.systemAudio !== undefined) {
      const sa = p.render.systemAudio as unknown;
      if (typeof sa !== "object" || sa === null) {
        errors.push("render.systemAudio: { mix, volumeDb } のブロックで指定してください");
      } else {
        walk("render.systemAudio", sa, ["mix", "volumeDb"], []);
        for (const req of ["mix", "volumeDb"]) {
          if ((sa as Record<string, unknown>)[req] === undefined) {
            errors.push(`render.systemAudio.${req}: ブロック更新では必須です`);
          }
        }
      }
    }
    if (p.render.bgm !== undefined) {
      const bgm = p.render.bgm as unknown;
      if (typeof bgm !== "object" || bgm === null) {
        errors.push("render.bgm: オブジェクトで指定してください");
      } else {
        walk("render.bgm", bgm, ["volumeDb", "fadeOutSec", "ducking"], ["ducking"]);
        const duck = (bgm as Record<string, unknown>).ducking;
        if (duck !== undefined) {
          if (typeof duck !== "object" || duck === null) {
            errors.push("render.bgm.ducking: { duckDb, fadeSec } のブロックで指定してください");
          } else {
            walk("render.bgm.ducking", duck, ["duckDb", "fadeSec"], []);
            for (const req of ["duckDb", "fadeSec"]) {
              if ((duck as Record<string, unknown>)[req] === undefined) {
                errors.push(`render.bgm.ducking.${req}: ブロック更新では必須です`);
              }
            }
          }
        }
      }
    }
  }
  if (p.preview !== undefined) walk("preview", p.preview, ["width"], []);
  if (p.editor !== undefined) {
    walk("editor", p.editor, ["maxUploadMb", "defaultImageDurationSec"], []);
  }
  return errors;
}

/** patch の葉を [パス, 値] の列に展開する(undefined の葉は「触らない」) */
function leavesOf(patch: ConfigPatch): Array<[string[], number | string | boolean | null]> {
  const out: Array<[string[], number | string | boolean | null]> = [];
  const walk = (prefix: string[], obj: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      if (typeof value === "object" && value !== null) {
        walk([...prefix, key], value as Record<string, unknown>);
      } else {
        out.push([[...prefix, key], value as number | string | boolean | null]);
      }
    }
  };
  walk([], patch as unknown as Record<string, unknown>);
  return out;
}

/**
 * setIn する前に、path の親チェーンがすべてマップであることを保証する。
 * `editor:` の子を全部コメントアウトした「null スカラーの親」や、そもそも
 * 無い親へ setIn すると yaml が "Expected YAML collection" で投げるため、
 * 浅い方から順に、欠落・非コレクションの節を空マップへ置き換える
 * (浅い親を先に直すので、深い getIn はその後で成立する)。
 */
function ensureParentMaps(doc: Document, path: string[]): void {
  for (let i = 1; i < path.length; i++) {
    const parentPath = path.slice(0, i);
    const node = doc.getIn(parentPath, true);
    if (node === undefined || !isCollection(node)) {
      doc.setIn(parentPath, new YAMLMap());
    }
  }
}

/**
 * config.yaml のテキストへパッチを適用して新しいテキストを返す純関数。
 * yaml の Document API で該当キーだけを差し替えるので、コメント・
 * レイアウト・`~` のままのパス(recordingsDir 等)はそのまま保たれる。
 * null は「キーを削除して既定に戻す」(元から無いキーへの null は no-op)。
 * 検証は validateConfigPatch が済ませている前提(ここでは形を信用して書く)
 */
export function applyConfigEdits(rawYaml: string, patch: ConfigPatch): string {
  const doc = parseDocument(rawYaml);
  for (const [path, value] of leavesOf(patch)) {
    if (value === null) {
      // 無いキー(親ブロックがコメントアウト・欠落を含む)への削除は no-op。
      // deleteIn は親が非コレクションだと投げるので、存在確認してから消す
      if (doc.hasIn(path)) doc.deleteIn(path);
    } else {
      ensureParentMaps(doc, path);
      doc.setIn(path, value);
    }
  }
  return doc.toString();
}

/**
 * 書き込み後の config.yaml テキストから、エディタが扱う render / preview /
 * editor サブツリーだけをプロセス内の cfg へ取り込み直す。パッチぶんに加えて
 * 外部編集(エディタ起動中の config.yaml 手編集)も同時に反映される。
 *
 * cfg はエディタ起動時に1回だけロードされ、以後のリクエスト・ジョブ
 * (preview / render / proxy)が同じ参照を見るため、**cfg そのものの参照は
 * 保ったまま**サブツリーだけ差し替える。expandHome が触る `~` パス
 * (recordingsDir / whisper.model)はこれらのサブツリーに無いので、
 * 素の parse で安全(絶対パス化されない)。render / preview はブロックごと
 * 消された壊れた YAML でメモリを壊さないよう、存在するときだけ差し替える
 */
export function syncEditorCfgFromYaml(cfg: Config, rawYaml: string): void {
  const parsed = parse(rawYaml) as Partial<Config>;
  if (parsed.render) cfg.render = parsed.render;
  if (parsed.preview) cfg.preview = parsed.preview;
  cfg.editor = parsed.editor; // 省略可。undefined でも resolvedEditorCfg が既定で補う
}

/** エディタ・サーバーがクライアントへ渡す解決済みのエディタ設定 */
export function resolvedEditorCfg(
  cfg: Config,
  defaultMaxUploadMb: number,
): { maxUploadMb: number; defaultImageDurationSec: number } {
  return {
    maxUploadMb: cfg.editor?.maxUploadMb ?? defaultMaxUploadMb,
    defaultImageDurationSec:
      cfg.editor?.defaultImageDurationSec ?? DEFAULT_IMAGE_DURATION_SEC,
  };
}
