import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  DEFAULT_WIPE_TRANSITION_SEC,
} from "../../src/types.ts";
import type { Config } from "../../src/lib/config.ts";
import type { ConfigPatch } from "../../src/lib/configEdit.ts";
import type { EditorCfg, PlanPerceptionStatus } from "./apiTypes.ts";
import { NumInput } from "./widgets.tsx";
import { FONT_PRESETS } from "./Inspector.tsx";

type RenderCfg = Config["render"];

/** 設定モーダルが編集する値(ProjectData の該当フィールドと同じ形)。
 * App が proj に対して直接パッチを当てるので、編集は即プレビューに反映される */
export interface CfgValues {
  renderCfg: RenderCfg;
  previewCfg: { width: number };
  editorCfg: EditorCfg;
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

  const patch: ConfigPatch = {};
  if (Object.keys(r).length > 0) patch.render = r;
  if (cur.previewCfg.width !== snap.previewCfg.width) {
    patch.preview = { width: cur.previewCfg.width };
  }
  const e: NonNullable<ConfigPatch["editor"]> = {};
  if (cur.editorCfg.maxUploadMb !== snap.editorCfg.maxUploadMb) {
    e.maxUploadMb = cur.editorCfg.maxUploadMb;
  }
  if (cur.editorCfg.defaultImageDurationSec !== snap.editorCfg.defaultImageDurationSec) {
    e.defaultImageDurationSec = cur.editorCfg.defaultImageDurationSec;
  }
  if (Object.keys(e).length > 0) patch.editor = e;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** proxy.mp4 に焼き込まれる設定に触れているか(保存後に再生成を促す) */
export function patchTouchesProxy(patch: ConfigPatch): boolean {
  return (
    patch.render?.targetLufs !== undefined ||
    patch.render?.systemAudio !== undefined ||
    patch.render?.denoise !== undefined ||
    patch.preview?.width !== undefined
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
}: {
  cfg: CfgValues;
  planPerception: PlanPerceptionStatus;
  onChange: (patch: Partial<CfgValues>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) => {
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
  const effColor = r.captionColor ?? CAPTION_DEFAULT_COLOR;
  const effOutline = r.captionOutlineColor ?? CAPTION_DEFAULT_OUTLINE;
  const effFamily = r.captionFontFamily ?? CAPTION_DEFAULT_FONT_FAMILY;
  const effWeight = r.captionFontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT;
  const outlineNone = effOutline === "none";
  const captionDefaultsTouched =
    r.captionColor !== undefined ||
    r.captionOutlineColor !== undefined ||
    r.captionFontFamily !== undefined ||
    r.captionFontWeight !== undefined;
  /** プリセットに無い手書きのフォント種はそのまま選択肢に足して残す */
  const familyOptions = FONT_PRESETS.some((p) => p.value === effFamily)
    ? FONT_PRESETS
    : [...FONT_PRESETS, { label: "(その他)", value: effFamily }];
  const perceptionOn = planPerception.audio || planPerception.ocr || planPerception.systemSpeech;
  const perceptionOcr = planPerception.ocr
    ? `on(max ${planPerception.ocrMaxSegments} segments, ${planPerception.ocrMaxLines} lines)`
    : "off";

  return (
    <div className="settingsModal" role="dialog" aria-label="設定">
      <h3>設定</h3>
      <p className="hint dim" style={{ margin: "0 0 4px" }}>
        全収録フォルダ共通の設定(config.yaml)。変更はプレビューに即反映され、
        「保存」で書き戻します
      </p>

      <h4>AI / plan</h4>
      <div className="field statusField">
        <label>plan の目耳</label>
        <span className={perceptionOn ? "statusPill ok" : "statusPill"}>
          {perceptionOn ? "on" : "off"}
        </span>
        <span className="hint dim">
          audio={planPerception.audio ? "on" : "off"} / ocr={perceptionOcr} /
          systemSpeech={planPerception.systemSpeech ? "on" : "off"}
        </span>
      </div>
      {planPerception.warnings.length > 0 && (
        <div className="field statusField">
          <label>注意</label>
          <span className="hint warnText">{planPerception.warnings.join(" / ")}</span>
        </div>
      )}

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
          <option value={400}>普通 (400)</option>
          <option value={700}>太字 (700)</option>
          <option value={900}>極太 (900)</option>
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
              })
            }
          >
            初期値に
          </button>
        )}
      </div>
      <div className="field">
        <label>章カードの表示秒</label>
        <NumInput
          value={r.chapterCardSec}
          title="plan が章タイトルのテロップを作るときの表示秒数。plan / remeta の実行時のみ反映"
          onCommit={(v) => v !== undefined && patchRender({ chapterCardSec: v })}
        />
        <span className="hint dim">plan / remeta 実行時のみ反映</span>
      </div>

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
