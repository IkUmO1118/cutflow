import { useState } from "react";
import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  DEFAULT_CUT_TRANSITION_SEC,
  DEFAULT_ZOOM_EASE_SEC,
  DEFAULT_WIPE_TRANSITION_SEC,
} from "../../src/types.ts";
import type { CaptionBackground } from "../../src/types.ts";
import type { AiAdapterKind, AiConfig, AiProvider, Config } from "../../src/lib/config.ts";
import type { ConfigPatch } from "../../src/lib/configEdit.ts";
import type { AiDoctorResult, AiProfileStatus, EditorCfg, PlanPerceptionStatus } from "./apiTypes.ts";
import { NumInput, PctSlider, joinColor, splitColor } from "./widgets.tsx";
import { CAPTION_WEIGHT_OPTIONS, FONT_PRESETS } from "./Inspector.tsx";

type RenderCfg = Config["render"];
type PreviewCfg = { width: number; videoEncoder?: "libx264" | "videotoolbox" };
type AiReviewCfg = { vlm: boolean; maxImages: number; maxRefinements: number };
type MainAiAdapter = Extract<AiAdapterKind, "claude-code" | "codex" | "openai" | "anthropic">;
const DEFAULT_CAPTION_BACKGROUND: CaptionBackground = { color: "#000000" };

export interface AiSettingsValue {
  adapter: MainAiAdapter | "custom";
  model: string;
  visionRoute: boolean;
  review: AiReviewCfg;
}

/** 設定モーダルが編集する値(ProjectData の該当フィールドと同じ形)。
 * App が proj に対して直接パッチを当てるので、編集は即プレビューに反映される */
export interface CfgValues {
  renderCfg: RenderCfg;
  previewCfg: PreviewCfg;
  editorCfg: EditorCfg;
  aiCfg: AiSettingsValue;
}

/**
 * モーダルを開いた時点(snap)と現在(cur)の差分から POST /api/config の
 * パッチを組む。差分が無ければ null。省略可キー(caption*)は「snap に
 * あって cur に無い」を null(=キー削除で既定に戻す)として送る。
 * systemAudio / ducking はブロックごと比較してブロックごと送る
 */
export function buildConfigPatch(snap: CfgValues, cur: CfgValues): ConfigPatch | null {
  const s = snap.renderCfg;
  const c = cur.renderCfg;
  const r: NonNullable<ConfigPatch["render"]> = {};
  for (const k of [
    "wipeWidthPx", "wipeMarginPx", "captionFontSizePx", "chapterCardSec", "targetLufs",
  ] as const) {
    if (c[k] !== s[k]) r[k] = c[k];
  }
  // 省略可の数値キー(UI は常に数値を入れるので null 削除は使わない)
  if (c.wipeTransitionSec !== s.wipeTransitionSec && c.wipeTransitionSec !== undefined) {
    r.wipeTransitionSec = c.wipeTransitionSec;
  }
  for (const k of ["captionColor", "captionOutlineColor", "captionFontFamily"] as const) {
    if (c[k] !== s[k]) r[k] = c[k] ?? null;
  }
  if (c.captionFontWeight !== s.captionFontWeight) {
    r.captionFontWeight = c.captionFontWeight ?? null;
  }
  if (JSON.stringify(c.captionBackground) !== JSON.stringify(s.captionBackground)) {
    r.captionBackground = c.captionBackground ?? null;
  }
  if (JSON.stringify(c.systemAudio) !== JSON.stringify(s.systemAudio)) {
    r.systemAudio = c.systemAudio ?? { mix: false, volumeDb: 0 };
  }
  if (JSON.stringify(c.denoise) !== JSON.stringify(s.denoise)) {
    r.denoise = c.denoise ?? { mic: false, noiseFloorDb: -25 };
  }
  const bgm: NonNullable<NonNullable<ConfigPatch["render"]>["bgm"]> = {};
  if (c.bgm.volumeDb !== s.bgm.volumeDb) bgm.volumeDb = c.bgm.volumeDb;
  if (c.bgm.fadeOutSec !== s.bgm.fadeOutSec) bgm.fadeOutSec = c.bgm.fadeOutSec;
  if (JSON.stringify(c.bgm.ducking) !== JSON.stringify(s.bgm.ducking)) {
    bgm.ducking = c.bgm.ducking ?? { duckDb: 0, fadeSec: 0.4 };
  }
  if (Object.keys(bgm).length > 0) r.bgm = bgm;
  if (JSON.stringify(c.cutTransition) !== JSON.stringify(s.cutTransition)) {
    r.cutTransition = c.cutTransition ?? { type: "none", sec: DEFAULT_CUT_TRANSITION_SEC };
  }
  if (c.hardwareAcceleration !== s.hardwareAcceleration) {
    r.hardwareAcceleration = c.hardwareAcceleration ?? null;
  }
  if (JSON.stringify(c.zoom) !== JSON.stringify(s.zoom)) {
    r.zoom = c.zoom ?? { easeSec: DEFAULT_ZOOM_EASE_SEC };
  }

  const patch: ConfigPatch = {};
  if (Object.keys(r).length > 0) patch.render = r;
  if (cur.previewCfg.width !== snap.previewCfg.width) {
    patch.preview = { ...(patch.preview ?? {}), width: cur.previewCfg.width };
  }
  if (cur.previewCfg.videoEncoder !== snap.previewCfg.videoEncoder) {
    patch.preview = { ...(patch.preview ?? {}), videoEncoder: cur.previewCfg.videoEncoder };
  }
  const e: NonNullable<ConfigPatch["editor"]> = {};
  if (cur.editorCfg.maxUploadMb !== snap.editorCfg.maxUploadMb) {
    e.maxUploadMb = cur.editorCfg.maxUploadMb;
  }
  if (cur.editorCfg.defaultImageDurationSec !== snap.editorCfg.defaultImageDurationSec) {
    e.defaultImageDurationSec = cur.editorCfg.defaultImageDurationSec;
  }
  if (cur.editorCfg.defaultShortRangeSec !== snap.editorCfg.defaultShortRangeSec) {
    e.defaultShortRangeSec = cur.editorCfg.defaultShortRangeSec;
  }
  if (JSON.stringify(cur.aiCfg.review) !== JSON.stringify(snap.aiCfg.review)) {
    e.aiReview = cur.aiCfg.review;
  }
  if (Object.keys(e).length > 0) patch.editor = e;
  if (
    cur.aiCfg.adapter !== "custom" &&
    (
      cur.aiCfg.adapter !== snap.aiCfg.adapter ||
      cur.aiCfg.model !== snap.aiCfg.model ||
      cur.aiCfg.visionRoute !== snap.aiCfg.visionRoute
    )
  ) {
    patch.ai = buildSingleProviderAiConfig(cur.aiCfg);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function buildSingleProviderAiConfig(ai: AiSettingsValue): AiConfig {
  const adapter = ai.adapter as AiProvider;
  const profile = {
    adapter,
    ...(ai.model.trim() ? { model: ai.model.trim() } : {}),
  };
  return {
    profiles: { local: profile },
    routes: {
      text: "local",
      structured: "local",
      ...(ai.visionRoute ? { vision: "local" } : {}),
    },
  };
}

/** proxy.mp4 に焼き込まれる設定に触れているか(保存後に再生成を促す) */
export function patchTouchesProxy(patch: ConfigPatch): boolean {
  return (
    patch.render?.targetLufs !== undefined ||
    patch.render?.systemAudio !== undefined ||
    patch.render?.denoise !== undefined ||
    patch.preview?.width !== undefined ||
    patch.preview?.videoEncoder !== undefined
  );
}

/** proxy へ焼き込まれる設定の行に出す注記 */
const PROXY_HINT = "プレビューへの反映にはプロキシの再生成が必要(保存後に案内が出ます)";

/**
 * 設定モーダル(ヘッダーの「設定」/ ⌘,)。config.yaml のエディタ・出力関連の
 * 設定を編集する。編集は onChange 経由で即プレビューに反映され(ライブ)、
 * 「保存」で config.yaml に書き戻す。キャンセルは App 側がモーダルを開いた
 * 時点のスナップショットへ戻す。状態はすべて App(proj)が持つ表示専用部品
 */
export const SettingsModal = ({
  cfg,
  planPerception,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
  aiProfiles,
  aiDoctor,
  aiDoctorBusy,
  onAiDoctor,
}: {
  cfg: CfgValues;
  planPerception: PlanPerceptionStatus;
  onChange: (patch: Partial<CfgValues>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  aiProfiles: AiProfileStatus[];
  aiDoctor: AiDoctorResult[] | null;
  aiDoctorBusy: boolean;
  onAiDoctor: (route?: "text" | "structured" | "vision") => void;
}) => {
  const [tab, setTab] = useState<"ai" | "look" | "audio" | "editor">("ai");
  const r = cfg.renderCfg;
  /** render のキーを差し替える(undefined 指定でキーごと消す=既定に戻す) */
  const patchRender = (p: Partial<RenderCfg>) => {
    const next = { ...r, ...p };
    for (const k of Object.keys(p) as (keyof RenderCfg)[]) {
      if (p[k] === undefined) delete next[k];
    }
    onChange({ renderCfg: next });
  };

  const sysAudio = r.systemAudio ?? { mix: false, volumeDb: 0 };
  const denoise = r.denoise ?? { mic: false, noiseFloorDb: -25 };
  const ducking = r.bgm.ducking ?? { duckDb: 0, fadeSec: 0.4 };
  const cutTransition = r.cutTransition ?? { type: "none", sec: DEFAULT_CUT_TRANSITION_SEC };
  const zoom = r.zoom ?? { easeSec: DEFAULT_ZOOM_EASE_SEC };
  const hardwareAcceleration = r.hardwareAcceleration ?? "if-possible";
  const videoEncoder = cfg.previewCfg.videoEncoder ?? "videotoolbox";
  const effColor = r.captionColor ?? CAPTION_DEFAULT_COLOR;
  const effOutline = r.captionOutlineColor ?? CAPTION_DEFAULT_OUTLINE;
  const effFamily = r.captionFontFamily ?? CAPTION_DEFAULT_FONT_FAMILY;
  const effWeight = r.captionFontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT;
  const outlineNone = effOutline === "none";
  const captionBg = r.captionBackground;
  const captionBgColor = captionBg ? splitColor(captionBg.color) : null;
  const captionDefaultsTouched =
    r.captionColor !== undefined ||
    r.captionOutlineColor !== undefined ||
    r.captionFontFamily !== undefined ||
    r.captionFontWeight !== undefined ||
    r.captionBackground !== undefined;
  /** プリセットに無い手書きのフォント種はそのまま選択肢に足して残す */
  const familyOptions = FONT_PRESETS.some((p) => p.value === effFamily)
    ? FONT_PRESETS
    : [...FONT_PRESETS, { label: "(その他)", value: effFamily }];
  const perceptionOn = planPerception.audio || planPerception.ocr || planPerception.systemSpeech;
  const mainAi = cfg.aiCfg;
  const canUseVisionWithMain =
    mainAi.adapter === "openai" || mainAi.adapter === "anthropic";
  const currentVisionProfile = aiProfiles.find((profile) =>
    profile.capabilities.imageInput && profile.name !== "local",
  );
  const visionEnabled = mainAi.review.vlm && (mainAi.visionRoute || !!currentVisionProfile);
  const planItems = [
    ["音声の間", planPerception.audio ? "on" : "off"],
    ["画面OCR", planPerception.ocr ? `on / ${planPerception.ocrMaxSegments}区間` : "off"],
    ["システム音声", planPerception.systemSpeech ? "on" : "off"],
  ] as const;
  const doctorStatusOf = (item: AiDoctorResult): "ok" | "warn" | "error" | "skip" => {
    const statuses = Object.values(item.checks).map((check) => check.status);
    if (statuses.includes("error")) return "error";
    if (statuses.includes("warn")) return "warn";
    if (statuses.some((status) => status === "ok")) return "ok";
    return "skip";
  };

  return (
    <div className="settingsModal" role="dialog" aria-label="設定">
      <h3>設定</h3>
      <p className="hint dim" style={{ margin: "0 0 4px" }}>
        全収録フォルダ共通の設定(config.yaml)。変更はプレビューに即反映され、
        「保存」で書き戻します
      </p>

      <div className="settingsTabs" role="tablist" aria-label="設定カテゴリ">
        {[
          ["ai", "AI / plan"],
          ["look", "見た目"],
          ["audio", "音声"],
          ["editor", "エディタ"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id as typeof tab)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "ai" && (
        <>
      <h4>AI / plan</h4>
      <div className="field">
        <label>主AI</label>
        <select
          value={mainAi.adapter}
          title="編集提案・plan・structured output に使うAI。customはconfig.yamlの高度な設定を保持します"
          onChange={(e) => {
            const adapter = e.target.value as AiSettingsValue["adapter"];
            onChange({
              aiCfg: {
                ...mainAi,
                adapter,
                model: adapter === "claude-code" || adapter === "codex" ? "auto" : mainAi.model,
                visionRoute:
                  adapter === "openai" || adapter === "anthropic" ? mainAi.visionRoute : false,
              },
            });
          }}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="openai">OpenAI API</option>
          <option value="anthropic">Anthropic API</option>
          <option value="custom">高度な設定(config.yaml)</option>
        </select>
        <input
          value={mainAi.model}
          disabled={mainAi.adapter === "custom"}
          title="API provider はモデル名を明示。Claude Code / Codex は auto でCLI既定"
          onChange={(e) => onChange({ aiCfg: { ...mainAi, model: e.target.value } })}
          style={{ flex: 1, minWidth: 160 }}
        />
      </div>
      <div className="field">
        <label>AI画像確認</label>
        <input
          type="checkbox"
          checked={mainAi.review.vlm}
          title="before/after still を画像対応providerへ送って、AI編集の検証・再調整に使う"
          onChange={(e) =>
            onChange({
              aiCfg: {
                ...mainAi,
                review: { ...mainAi.review, vlm: e.target.checked },
                visionRoute: e.target.checked && canUseVisionWithMain ? true : mainAi.visionRoute,
              },
            })
          }
        />
        <span className="hint dim">
          {mainAi.review.vlm
            ? mainAi.visionRoute || currentVisionProfile
              ? "有効"
              : "vision route が必要"
            : "無効"}
        </span>
        <NumInput
          value={mainAi.review.maxImages}
          title="画像確認で送るstill枚数。多いほど確認は増えるが遅くなります"
          onCommit={(v) =>
            v !== undefined &&
            onChange({
              aiCfg: {
                ...mainAi,
                review: { ...mainAi.review, maxImages: Math.round(v) },
              },
            })
          }
        />
        <span className="hint dim">枚</span>
      </div>
      <div className="field">
        <label>AI再調整の上限</label>
        <NumInput
          value={mainAi.review.maxRefinements}
          title="AI提案を観測結果で再調整できる最大回数。増やしすぎると迷走しやすいため最大3"
          onCommit={(v) =>
            v !== undefined &&
            onChange({
              aiCfg: {
                ...mainAi,
                review: { ...mainAi.review, maxRefinements: Math.round(v) },
              },
            })
          }
        />
        <span className="hint dim">1〜3</span>
      </div>
      {mainAi.adapter !== "custom" && mainAi.review.vlm && !canUseVisionWithMain && !currentVisionProfile && (
        <div className="field statusField">
          <label>画像確認</label>
          <span className="hint warnText">
            Claude Code / Codex 単体では画像確認は使えません。編集AIはそのまま使えます
          </span>
        </div>
      )}
      <div className="settingsCardGrid">
        <div className="settingsCard">
          <div className="settingsCardHead">
            <span>plan の目耳</span>
            <span className={perceptionOn ? "statusPill ok" : "statusPill"}>
              {perceptionOn ? "on" : "off"}
            </span>
          </div>
          <div className="settingsKv">
            {planItems.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {planPerception.warnings.length > 0 && (
            <p className="hint warnText">{planPerception.warnings.join(" / ")}</p>
          )}
        </div>

        <div className="settingsCard">
          <div className="settingsCardHead">
            <span>AI provider</span>
            <span className={visionEnabled ? "statusPill ok" : "statusPill"}>
              {visionEnabled ? "vision on" : "text only"}
            </span>
          </div>
          <div className="providerList">
            {aiProfiles.map((profile) => (
              <div key={profile.name} className="providerRow">
                <div>
                  <strong>{profile.name}</strong>
                  <span>{profile.adapter} / {profile.model}</span>
                </div>
                <div className="providerCaps">
                  <span>{profile.capabilities.structuredOutput}</span>
                  <span>{profile.capabilities.imageInput ? `画像 ${profile.capabilities.maxImages}枚` : "画像なし"}</span>
                  <span>{profile.credential}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="settingsActions">
            <button type="button" onClick={() => onAiDoctor()} disabled={aiDoctorBusy}>
              {aiDoctorBusy ? "接続確認中…" : "接続確認"}
            </button>
            <button type="button" onClick={() => onAiDoctor("vision")} disabled={aiDoctorBusy}>
              visionのみ確認
            </button>
          </div>
          {aiDoctor && aiDoctor.length > 0 && (
            <div className="doctorGrid">
              {aiDoctor.map((item) => (
                <div key={item.profile} className={`doctorRow ${doctorStatusOf(item)}`}>
                  <strong>{item.profile}</strong>
                  <span>text {item.checks.text.status}</span>
                  <span>json {item.checks.structured.status}</span>
                  <span>image {item.checks.image.status}</span>
                  <span>auth {item.checks.credential.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

        </>
      )}

      {tab === "look" && (
        <>
      <h4>出力の見た目</h4>
      <div className="field">
        <label>ワイプ幅 / 余白 (px)</label>
        <NumInput
          value={r.wipeWidthPx}
          title="右下ワイプ(カメラ)の横幅。1920x1080 基準"
          onCommit={(v) => v !== undefined && patchRender({ wipeWidthPx: Math.round(v) })}
        />
        <NumInput
          value={r.wipeMarginPx}
          title="字幕・テロップの画面端からの余白。ワイプの位置には影響しない"
          onCommit={(v) => v !== undefined && patchRender({ wipeMarginPx: Math.round(v) })}
        />
      </div>
      <div className="field">
        <label>ワイプ全画面の遷移 (秒)</label>
        <NumInput
          value={r.wipeTransitionSec ?? DEFAULT_WIPE_TRANSITION_SEC}
          title="ワイプ全画面(wipeFull)の出入りにかける秒数。0 で瞬時に切り替え"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ wipeTransitionSec: Math.min(5, Math.max(0, v)) })
          }
        />
        <span className="hint dim">0 で瞬時</span>
      </div>
      <div className="field">
        <label>カット境界</label>
        <select
          value={cutTransition.type ?? "none"}
          title="keep境界の見た目。dip-to-black は黒フェードを重ねます"
          onChange={(e) =>
            patchRender({
              cutTransition: {
                ...cutTransition,
                type: e.target.value as "none" | "dip-to-black",
              },
            })
          }
        >
          <option value="none">瞬時に切り替え</option>
          <option value="dip-to-black">黒フェード</option>
        </select>
        <NumInput
          value={cutTransition.sec ?? DEFAULT_CUT_TRANSITION_SEC}
          title="黒フェードの往復秒数。type=none では使われません"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ cutTransition: { ...cutTransition, sec: Math.min(3, Math.max(0, v)) } })
          }
        />
        <span className="hint dim">秒</span>
      </div>
      <div className="field">
        <label>ズーム遷移 (秒)</label>
        <NumInput
          value={zoom.easeSec ?? DEFAULT_ZOOM_EASE_SEC}
          title="ズーム演出の既定イーズ秒。個別ズームの easeSec があればそちらを優先"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ zoom: { ...zoom, easeSec: Math.min(3, Math.max(0, v)) } })
          }
        />
        <span className="hint dim">個別指定が優先</span>
      </div>
      <div className="field">
        <label>字幕サイズ (px)</label>
        <NumInput
          value={r.captionFontSizePx}
          title="スタイル未指定テロップのフォントサイズ"
          onCommit={(v) =>
            v !== undefined && patchRender({ captionFontSizePx: Math.round(v) })
          }
        />
      </div>
      <div className="field">
        <label>テロップ既定 文字色 / 縁色</label>
        <input
          type="color"
          value={effColor}
          title="個別・トラック標準の指定が無いテロップの文字色"
          onChange={(e) => patchRender({ captionColor: e.target.value })}
        />
        <input
          type="color"
          value={outlineNone ? "#000000" : effOutline}
          disabled={outlineNone}
          title="個別・トラック標準の指定が無いテロップの縁取り色"
          onChange={(e) => patchRender({ captionOutlineColor: e.target.value })}
        />
        <label className="hint" style={{ width: "auto" }}>
          <input
            type="checkbox"
            checked={outlineNone}
            onChange={(e) =>
              patchRender({
                captionOutlineColor: e.target.checked ? "none" : undefined,
              })
            }
          />
          縁なし
        </label>
      </div>
      <div className="field">
        <label>テロップ既定 フォント</label>
        <select
          value={effFamily}
          style={{ flex: 1, minWidth: 0 }}
          title="個別・トラック標準の指定が無いテロップのフォント種"
          onChange={(e) =>
            patchRender({
              captionFontFamily:
                e.target.value === CAPTION_DEFAULT_FONT_FAMILY
                  ? undefined
                  : e.target.value,
            })
          }
        >
          {familyOptions.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={effWeight}
          title="個別・トラック標準の指定が無いテロップの太さ"
          onChange={(e) => {
            const w = Number(e.target.value);
            patchRender({
              captionFontWeight: w === CAPTION_DEFAULT_FONT_WEIGHT ? undefined : w,
            });
          }}
        >
          {CAPTION_WEIGHT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {captionDefaultsTouched && (
          <button
            className="linkish"
            title="テロップ既定の色・縁・フォント・太さを初期値(白文字・青縁・ゴシック)に戻す"
            onClick={() =>
              patchRender({
                captionColor: undefined,
                captionOutlineColor: undefined,
                captionFontFamily: undefined,
                captionFontWeight: undefined,
                captionBackground: undefined,
              })
            }
          >
            初期値に
          </button>
        )}
      </div>
      <div className="field">
        <label>テロップ既定 背景帯</label>
        <input
          type="checkbox"
          checked={!!captionBg}
          title="個別・トラック標準の指定が無いテロップの背後に帯を敷く"
          onChange={(e) =>
            patchRender({
              captionBackground: e.target.checked
                ? { ...DEFAULT_CAPTION_BACKGROUND }
                : undefined,
            })
          }
        />
        {captionBg && captionBgColor && (
          <>
            <input
              type="color"
              value={captionBgColor.hex}
              title="背景帯の色"
              onChange={(e) =>
                patchRender({
                  captionBackground: {
                    ...captionBg,
                    color: joinColor(e.target.value, captionBgColor.alpha),
                  },
                })
              }
            />
            <span className="hint dim">不透明度</span>
            <PctSlider
              pct={Math.round(captionBgColor.alpha * 100)}
              title="背景帯の透け具合"
              onChange={(pct) =>
                patchRender({
                  captionBackground: {
                    ...captionBg,
                    color: joinColor(captionBgColor.hex, pct / 100),
                  },
                })
              }
            />
          </>
        )}
      </div>
      {captionBg && (
        <div className="field">
          <label>背景帯 余白 / 角丸 (px)</label>
          <NumInput
            value={captionBg.paddingPx}
            allowEmpty
            placeholder={String(Math.round(r.captionFontSizePx * 0.35))}
            title="背景帯の横方向余白。縦方向はこの半分。空欄=フォントサイズの0.35倍"
            onCommit={(v) =>
              patchRender({
                captionBackground: {
                  ...captionBg,
                  paddingPx: v !== undefined ? Math.max(0, Math.round(v)) : undefined,
                },
              })
            }
          />
          <NumInput
            value={captionBg.radiusPx}
            allowEmpty
            placeholder="8"
            title="背景帯の角丸。空欄=8"
            onCommit={(v) =>
              patchRender({
                captionBackground: {
                  ...captionBg,
                  radiusPx: v !== undefined ? Math.max(0, Math.round(v)) : undefined,
                },
              })
            }
          />
        </div>
      )}
      <div className="field">
        <label>章カードの表示秒</label>
        <NumInput
          value={r.chapterCardSec}
          title="plan が章タイトルのテロップを作るときの表示秒数。plan / remeta の実行時のみ反映"
          onCommit={(v) => v !== undefined && patchRender({ chapterCardSec: v })}
        />
        <span className="hint dim">plan / remeta 実行時のみ反映</span>
      </div>

        </>
      )}

      {tab === "audio" && (
        <>
      <h4>音声</h4>
      <div className="field">
        <label>ラウドネス目標 (LUFS)</label>
        <NumInput
          value={r.targetLufs}
          title={`音声ラウドネス正規化の目標値。YouTube の基準は -14。${PROXY_HINT}`}
          onCommit={(v) => v !== undefined && patchRender({ targetLufs: v })}
        />
        <span className="hint dim">要プロキシ再生成</span>
      </div>
      <div className="field">
        <label>システム音声</label>
        <input
          type="checkbox"
          checked={sysAudio.mix}
          title={`収録にシステム音声トラックがあればマイクと合成して出力に入れる。${PROXY_HINT}`}
          onChange={(e) =>
            patchRender({ systemAudio: { ...sysAudio, mix: e.target.checked } })
          }
        />
        <span className="hint dim">合成する / 音量(dB)</span>
        <NumInput
          value={sysAudio.volumeDb}
          title={`合成時のシステム音声の音量(dB)。0 で原音量。${PROXY_HINT}`}
          onCommit={(v) =>
            v !== undefined && patchRender({ systemAudio: { ...sysAudio, volumeDb: v } })
          }
        />
        <span className="hint dim">要プロキシ再生成</span>
      </div>
      <div className="field">
        <label>マイクのノイズ除去</label>
        <input
          type="checkbox"
          checked={denoise.mic}
          title={`マイク音声にノイズ除去(ffmpeg afftdn)をかける。システム音声は対象外。${PROXY_HINT}`}
          onChange={(e) =>
            patchRender({ denoise: { ...denoise, mic: e.target.checked } })
          }
        />
        <span className="hint dim">かける / ノイズフロア(dB)</span>
        <NumInput
          value={denoise.noiseFloorDb}
          title="afftdn のノイズフロア(dB)。下げるほど控えめ、上げるほど強い"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ denoise: { ...denoise, noiseFloorDb: v } })
          }
        />
        <span className="hint dim">要プロキシ再生成</span>
      </div>
      <div className="field">
        <label>BGM 音量 (dB) / フェード (秒)</label>
        <NumInput
          value={r.bgm.volumeDb}
          title="BGM の音量(dB)。0 で原音量。声より 20dB 前後小さくするのが目安"
          onCommit={(v) =>
            v !== undefined && patchRender({ bgm: { ...r.bgm, volumeDb: v } })
          }
        />
        <NumInput
          value={r.bgm.fadeOutSec}
          title="動画終端でのフェードアウト秒数"
          onCommit={(v) =>
            v !== undefined && patchRender({ bgm: { ...r.bgm, fadeOutSec: v } })
          }
        />
      </div>
      <div className="field">
        <label>ダッキング (dB) / 遷移 (秒)</label>
        <NumInput
          value={ducking.duckDb}
          title="発話中に BGM をさらに下げる量(dB)。0 でダッキング無効"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ bgm: { ...r.bgm, ducking: { ...ducking, duckDb: v } } })
          }
        />
        <NumInput
          value={ducking.fadeSec}
          title="下げ・戻しにかける秒数"
          onCommit={(v) =>
            v !== undefined &&
            patchRender({ bgm: { ...r.bgm, ducking: { ...ducking, fadeSec: v } } })
          }
        />
        <span className="hint dim">0 dB で無効</span>
      </div>

        </>
      )}

      {tab === "editor" && (
        <>
      <h4>エディタ</h4>
      <div className="field">
        <label>プレビュー幅 (px)</label>
        <NumInput
          value={cfg.previewCfg.width}
          title={`preview.mp4 とプロキシの横幅。偶数のみ。${PROXY_HINT}`}
          onCommit={(v) =>
            v !== undefined && onChange({ previewCfg: { width: Math.round(v) } })
          }
        />
        <span className="hint dim">要プロキシ再生成</span>
      </div>
      <div className="field">
        <label>プレビューエンコード</label>
        <select
          value={videoEncoder}
          title={`proxy.mp4 / preview.mp4 のビデオエンコーダ。${PROXY_HINT}`}
          onChange={(e) =>
            onChange({
              previewCfg: {
                ...cfg.previewCfg,
                videoEncoder: e.target.value as "libx264" | "videotoolbox",
              },
            })
          }
        >
          <option value="videotoolbox">高速・省容量(macOS)</option>
          <option value="libx264">互換性優先(libx264)</option>
        </select>
        <span className="hint dim">要プロキシ再生成</span>
      </div>
      <div className="field">
        <label>最終レンダー</label>
        <select
          value={hardwareAcceleration}
          title="Remotion合成段のハードウェアエンコード利用"
          onChange={(e) =>
            patchRender({
              hardwareAcceleration: e.target.value as "if-possible" | "disable",
            })
          }
        >
          <option value="if-possible">可能なら高速化</option>
          <option value="disable">互換性優先</option>
        </select>
      </div>
      <div className="field">
        <label>素材の既定尺 (秒)</label>
        <NumInput
          value={cfg.editorCfg.defaultImageDurationSec}
          title="画像素材・尺の分からない素材をタイムラインに置いたときの長さ"
          onCommit={(v) =>
            v !== undefined &&
            onChange({
              editorCfg: { ...cfg.editorCfg, defaultImageDurationSec: v },
            })
          }
        />
      </div>
      <div className="field">
        <label>ショート既定尺 (秒)</label>
        <NumInput
          value={cfg.editorCfg.defaultShortRangeSec}
          title="ショートを新規追加するとき、選択範囲も再生位置も無い場合に使う既定レンジ"
          onCommit={(v) =>
            v !== undefined &&
            onChange({
              editorCfg: { ...cfg.editorCfg, defaultShortRangeSec: v },
            })
          }
        />
      </div>
      <div className="field">
        <label>アップロード上限 (MB)</label>
        <NumInput
          value={cfg.editorCfg.maxUploadMb}
          title="素材アップロード1ファイルの上限。暴走したアップロードでディスクを埋めない歯止め"
          onCommit={(v) =>
            v !== undefined &&
            onChange({ editorCfg: { ...cfg.editorCfg, maxUploadMb: Math.round(v) } })
          }
        />
      </div>

        </>
      )}

      <div className="foot">
        {error && <span className="error">{error}</span>}
        <button onClick={onCancel} disabled={saving}>
          キャンセル
        </button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
};
