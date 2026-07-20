// plan --cuts-only 系(単発・push ループ・agentic ループの3経路すべて)が共有する
// LLM 応答パーサ。stages/plan.ts と lib/ai/agenticCut.ts の両方から参照される
// ため(plan.ts → agenticCut.ts の import と循環しないよう)独立ファイルに置く。

/** cuts-only 応答の期待スキーマ(prompts/plan-cuts.md の出力形式と対応)。
 * reasonId / keeps は plan.reasonIds.enabled: true のときだけプロンプトが
 * 依頼する任意フィールド(§4.4)。省略時は従来どおり cuts だけを返す
 * (undefined プロパティを持たせず、キー自体が無い=バイト等価・sticky) */
export interface CutsResponse {
  cuts: { id: number; reason: string; reasonId?: string }[];
  /** 切る誘惑があったが残した区間だけを LLM に列挙させたもの(§5)。
   * 省略時 undefined。buildCutplan の第5引数へそのまま渡せる形 */
  keeps?: { id: number; reason: string; reasonId: string }[];
}

/** 応答からJSONオブジェクトを取り出す。コードフェンスや前後の説明文が混ざっても拾う */
export function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan.raw.txt を確認してください)",
    );
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan.raw.txt を確認してください)",
    );
  }
}

/** cuts-only 応答のパース(plan --cuts-only 用。cuts だけが必須)。
 * keeps は応答に含まれているときだけ結果へ載せる(無ければキー自体が無い) */
export function parseCutsResponse(raw: string): CutsResponse {
  const parsed = extractJsonObject(raw) as Partial<CutsResponse>;
  const result: CutsResponse = { cuts: parsed.cuts ?? [] };
  if (parsed.keeps !== undefined) result.keeps = parsed.keeps;
  return result;
}

export const CUTS_RESPONSE_SCHEMA = {
  name: "cutflow_plan_cuts",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["cuts"],
    properties: {
      cuts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason"],
          properties: {
            id: { type: "integer" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
} as const;
