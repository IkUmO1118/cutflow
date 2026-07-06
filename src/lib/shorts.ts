// shorts.json の読み込み共通ロジック。render(--short/--shorts)・frames(--short)・
// describe が共有する(欠落・name 不一致のエラーメッセージを揃える)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Short, Shorts } from "../types.ts";

/** 収録フォルダの shorts.json を読む(無ければ null) */
export function loadShorts(dir: string): Shorts | null {
  const p = join(dir, "shorts.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Shorts;
}

/** 収録フォルダの shorts.json から name のショートを1件読む。
 * shorts.json 自体が無い/name が見つからないときは明確なエラーを投げる */
export function loadShort(dir: string, name: string): Short {
  const shorts = loadShorts(dir);
  if (!shorts) {
    throw new Error("shorts.json がありません(このフォルダにショートは未定義です)");
  }
  const short = shorts.shorts.find((s) => s.name === name);
  if (!short) {
    throw new Error(
      `ショートが見つかりません: ${name}(shorts.json の name 一覧: ` +
        `${shorts.shorts.map((s) => s.name).join(", ") || "(なし)"})`,
    );
  }
  return short;
}
