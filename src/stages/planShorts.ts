// ショート動画の LLM ハイライト自動選定(plan-shorts コマンド)。
// plan と同じ「番号選択」方式: detect の候補区間に番号を振って LLM に渡し、
// 「各ショートに入れる番号の集合」だけを返させる。時刻は LLM に生成させず、
// 番号 → ranges の変換と尺・番号存在の検証はすべてコード側で行う。
// 生成する全ショートは approved: false 固定(承認は人間の仕事)。

/** LLM 応答スキーマ(prompts/plan-shorts.md の出力形式と対応)。
 * 各ショートに入れる候補区間の番号(ids)だけを受け取り、
 * 番号 → ranges の変換は shortsFromSelection が行う */
export interface ShortSelection {
  name: string;
  ids: number[];
  reason: string;
}

export interface ShortsSelection {
  shorts: ShortSelection[];
}

/**
 * LLM 応答から JSON を取り出してショート選定に整える。plan.ts の parseResponse と
 * 同じ堅牢さ(コードフェンスや前後の説明文が混ざっても最初の { 〜 最後の } を拾う)。
 * 壊れた/欠けたフィールドは握りつぶし、後段(shortsFromSelection)の機械検証に委ねる:
 * - shorts が無い/配列でなければ空配列
 * - ids が配列でなければ空配列、数値以外の要素は落とす
 * - name / reason が文字列でなければ空文字(name の正規化は shortsFromSelection)
 */
export function parseShortsResponse(raw: string): ShortsSelection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan-shorts.raw.txt を確認してください)",
    );
  }
  let parsed: { shorts?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { shorts?: unknown };
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan-shorts.raw.txt を確認してください)",
    );
  }
  const list = Array.isArray(parsed.shorts) ? parsed.shorts : [];
  const shorts: ShortSelection[] = list.map((s) => {
    const o = (s ?? {}) as { name?: unknown; ids?: unknown; reason?: unknown };
    const ids = Array.isArray(o.ids)
      ? o.ids.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
    return {
      name: typeof o.name === "string" ? o.name : "",
      ids,
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  });
  return { shorts };
}
