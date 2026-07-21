// 演出判断の状況分類(docs/edit-skills/effects/recipes/<id>.md)の単一の出所。
// effectReasonId の schema / validate / prompt injection はすべてこの列挙から派生する。

/** 順序は effects/README.md の「見せる/隠す/指す/何もしない」と一致させる。 */
export const EFFECT_REASON_IDS = [
  "tiny-target",
  "focus-shift",
  "secret-exposure",
  "attention-scatter",
  "already-legible",
  "concept-talk",
  "motion-carries",
] as const;

export type EffectReasonId = (typeof EFFECT_REASON_IDS)[number];
export type EffectReasonFamily = "zoom" | "blur" | "annotation" | "none";

/** recipe の系を plan-effects の effect enum へ正規化した対応。 */
export const EFFECT_REASON_ID_FAMILY: Record<EffectReasonId, EffectReasonFamily> = {
  "tiny-target": "zoom",
  "focus-shift": "zoom",
  "secret-exposure": "blur",
  "attention-scatter": "annotation",
  "already-legible": "none",
  "concept-talk": "none",
  "motion-carries": "none",
};

/** プロンプトへ注入する一行定義。recipe 本文を実行時に読まない。 */
export const EFFECT_REASON_ID_LABEL: Record<EffectReasonId, string> = {
  "tiny-target": "小さくて読めない具体物を話者が指示語で指す",
  "focus-shift": "説明対象が画面内を移り、隣接ズームで追う",
  "secret-exposure": "秘匿情報が画面に映る",
  "attention-scatter": "対象が一点に収まらず、囲み・矢印で注視を導く",
  "already-legible": "画面が既に十分読める",
  "concept-talk": "概念・導入のトークで具体物を指していない",
  "motion-carries": "画面の動き自体が注意を導く",
};

export interface EffectReasonIdDiscriminatorPair {
  a: EffectReasonId;
  b: EffectReasonId;
  discriminator: string;
}

/** G2対比。表層が同じで処置が逆になる境目だけを注入する。 */
export const EFFECT_REASON_ID_DISCRIMINATOR: readonly EffectReasonIdDiscriminatorPair[] = [
  {
    a: "tiny-target",
    b: "already-legible",
    discriminator: "弁別子は現在の出力解像度で読めるか。読めるなら none(already-legible)、読めず発話が具体物を指すなら zoom(tiny-target)",
  },
  {
    a: "attention-scatter",
    b: "motion-carries",
    discriminator: "弁別子は画面の動きが注意を導くか散らすか。自明なら none(motion-carries)、散るなら annotation(attention-scatter)",
  },
];
