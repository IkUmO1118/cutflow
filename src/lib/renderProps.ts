import {
  buildTimeline,
  insertSpans,
  remapInterval,
  toOutputTime,
} from "./timeline.ts";
import type { Config } from "./config.ts";
import {
  capId,
  capNum,
  captionAnchorOf,
  captionPosOf,
  captionStyleOf,
  captionTrack,
  defaultLayerOrder,
  ovId,
  ovNum,
  overlayTrack,
} from "../types.ts";
import type {
  Interval,
  LayerId,
  Manifest,
  Overlays,
  Transcript,
} from "../types.ts";
import type {
  Caption,
  OverlayItem,
  RenderProps,
  Span,
} from "../../remotion/props.ts";

/**
 * 編集ファイル群(元収録秒)からカット後タイムラインの RenderProps を組み立てる。
 * render ステージとエディタのプレビューで共有し、同じ絵が出ることを保証する。
 * ブラウザでも動くよう純粋関数にしてある(ファイル存在チェックは注入)。
 */
export function buildRenderProps(args: {
  manifest: Manifest;
  /** cutplan の keep 区間(時系列順) */
  keeps: Interval[];
  transcript: Transcript;
  overlays: Overlays;
  renderCfg: Config["render"];
  /** 出力解像度(通常は config の screenRegion と同じ) */
  width: number;
  height: number;
  /** publicDir 相対の動画ファイル名(render: cut.mp4 / エディタ: プロキシ) */
  videoFile: string;
  /** true = videoFile がカット前の元収録そのもの(エディタの proxy.mp4)。
   * ベース区間は元収録の秒から再生する。false/省略 = keeps のみを繋いだ
   * 動画(render の cut.mp4)で、区間の再生位置はカット後の秒 */
  videoIsSource?: boolean;
  bgm: RenderProps["bgm"];
  /** 無音検出(cuts.auto.json)の無音区間(元収録の秒)。BGM ダッキングの
   * 発話区間を組み立てるのに使う。null/省略ならダッキングなし */
  silences?: Interval[] | null;
  /** オーバーレイ素材の存在チェック。無い素材は warn して除外する */
  overlayExists: (file: string) => boolean;
  warn: (msg: string) => void;
}): RenderProps {
  const {
    manifest, keeps, transcript, overlays,
    renderCfg, width, height, videoFile, videoIsSource, bgm, silences,
    overlayExists, warn,
  } = args;

  // ベース映像への挿入。素材が無いものは挿入ごと除外する
  // (時間の穴になるより、以降が前へ詰まる方が壊れ方として安全)
  const activeInserts = (overlays.inserts ?? []).filter((ins) => {
    if (overlayExists(ins.file)) return true;
    warn(`挿入素材が見つかりません: ${ins.file}(挿入ごと除外し、以降は前へ詰まります)`);
    return false;
  });
  const timeline = buildTimeline(keeps, activeInserts);
  const captions: Caption[] = transcript.segments
    .flatMap((s) => {
      // 位置・スタイルはここで解決する(セグメント指定 → トラック標準 → 既定)。
      // anchor(座標の解釈)はトラック標準に従い、pos が無ければ意味を持たない
      const pos = captionPosOf(s, overlays);
      const style = captionStyleOf(s, overlays);
      const anchor = captionAnchorOf(s, overlays);
      return remapInterval(s.start, s.end, timeline).map((iv) => ({
        start: iv.start,
        end: iv.end,
        // trim は前後の空白だけ落とす(テキスト内の改行=手動改行は残る)
        text: s.text.trim(),
        track: captionTrack(s),
        ...(pos ? { pos } : {}),
        ...(pos && anchor === "topLeft" ? { anchor } : {}),
        ...(style ? { style } : {}),
      }));
    })
    .filter((c) => c.text.length > 0);

  // overlays.json の演出指定もカット後のタイムラインに変換する。
  // remapInterval は連続区間をまとめるので、割れるのは挿入で途切れる場合
  // だけ。動画素材は startFrom(それまでの表示済み秒数)で続きから再生する
  const overlayItems: OverlayItem[] = (overlays.overlays ?? []).flatMap((o) => {
    if (!overlayExists(o.file)) {
      warn(`オーバーレイ素材が見つかりません: ${o.file}(除外します)`);
      return [];
    }
    let shown = 0;
    return remapInterval(o.start, o.end, timeline).map((iv) => {
      const item: OverlayItem = {
        start: iv.start,
        end: iv.end,
        file: o.file,
        track: overlayTrack(o),
        fit: o.fit ?? "contain",
        ...(shown > 0 ? { startFrom: round2(shown) } : {}),
      };
      shown += iv.end - iv.start;
      return item;
    });
  });
  const remapSpans = (spans?: Interval[]): Span[] =>
    (spans ?? []).flatMap((s) => remapInterval(s.start, s.end, timeline));

  // ベース映像の再生区間。「カット後のどこで、動画内のどの時刻から再生
  // するか」に分割する。動画内の時刻は videoFile が何かで変わる:
  // - render の cut.mp4 は keeps のみの動画 → 挿入なし写像でのカット後時刻
  //   (挿入がなければ全編1区間に繋がり、従来どおりの連続再生)
  // - エディタの proxy.mp4 は元収録そのもの → 元収録の秒。カット境界ごとに
  //   区間が分かれ、Player が飛び飛びに再生する(カット編集の即時反映)
  const keepsOnly = buildTimeline(keeps);
  const segments = timeline.map((e) => ({
    start: round2(e.start + e.offset),
    videoStart: videoIsSource ? e.start : (toOutputTime(e.start, keepsOnly) ?? 0),
    durationSec: round2(e.end - e.start),
  }));
  // 動画内でも連続している区間はまとめる
  const baseSegments: typeof segments = [];
  for (const seg of segments) {
    const last = baseSegments[baseSegments.length - 1];
    if (
      last &&
      near(last.start + last.durationSec, seg.start) &&
      near(last.videoStart + last.durationSec, seg.videoStart)
    ) {
      last.durationSec = round2(last.durationSec + seg.durationSec);
    } else {
      baseSegments.push({ ...seg });
    }
  }
  const insertItems = insertSpans(keeps, activeInserts).map((sp) => {
    const ins = activeInserts[sp.index];
    return {
      start: sp.start,
      end: sp.end,
      file: ins.file,
      fit: ins.fit ?? "contain" as const,
      ...(ins.startFrom ? { startFrom: round2(ins.startFrom) } : {}),
    };
  });

  const durationSec =
    keeps.reduce((sum, k) => sum + (k.end - k.start), 0) +
    activeInserts.reduce((sum, i) => sum + i.durationSec, 0);
  return {
    videoFile,
    bgm: withDucking(bgm, silences ?? null, manifest.durationSec, timeline, renderCfg),
    durationSec: Math.round(durationSec * 100) / 100,
    fps: Math.round(manifest.video.fps) || 30,
    width,
    height,
    canvas: { w: manifest.video.width, h: manifest.video.height },
    screenRegion: manifest.video.screenRegion,
    cameraRegion: manifest.video.cameraRegion,
    wipe: {
      widthPx: renderCfg.wipeWidthPx,
      marginPx: renderCfg.wipeMarginPx,
    },
    // 既定スタイルは config(render.caption*)→ 無ければ描画側の定数。
    // undefined のキーは載せない(props を JSON に書く render.props.json を汚さない)
    caption: {
      fontSizePx: renderCfg.captionFontSizePx,
      ...(renderCfg.captionColor ? { color: renderCfg.captionColor } : {}),
      ...(renderCfg.captionOutlineColor
        ? { outlineColor: renderCfg.captionOutlineColor }
        : {}),
      ...(renderCfg.captionFontFamily
        ? { fontFamily: renderCfg.captionFontFamily }
        : {}),
      ...(renderCfg.captionFontWeight
        ? { fontWeight: renderCfg.captionFontWeight }
        : {}),
    },
    captions,
    overlays: overlayItems,
    wipeFull: remapSpans(overlays.wipeFull),
    hideCaption: remapSpans(overlays.hideCaption),
    layerOrder: normalizeLayerOrder(
      overlays.layerOrder,
      ovCountOf(overlays),
      capCountOf(transcript),
      warn,
    ),
    baseSegments,
    inserts: insertItems,
  };
}

/**
 * BGM に発話ダッキングの区間を添える。無音検出(cuts.auto.json)の補集合=
 * 発話区間をカット後のタイムラインへ写像し、その間だけ Remotion 側が BGM を
 * duckDb 下げる。無音区間が無い(detect 未実行)・ducking 未設定・duckDb: 0
 * のときは何もしない(従来どおり全編一定音量)
 */
function withDucking(
  bgm: RenderProps["bgm"],
  silences: Interval[] | null,
  sourceDurationSec: number,
  timeline: ReturnType<typeof buildTimeline>,
  renderCfg: Config["render"],
): RenderProps["bgm"] {
  const ducking = renderCfg.bgm.ducking;
  if (!bgm || !silences || !ducking || ducking.duckDb === 0) return bgm;

  // 発話区間 = 無音の補集合(元収録の秒)。detect と違いパディングは
  // 付けない(下げ・戻しの余韻は fadeSec が持つ)
  const speech: Interval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < sourceDurationSec) {
    speech.push({ start: cursor, end: sourceDurationSec });
  }

  // カット後タイムラインへ写像し、短い間で BGM が上下して耳につかないよう
  // 近接する区間(戻し切れない fadeSec*2 以下の隙間)はひと続きにする
  const spans = mergeClose(
    speech.flatMap((iv) => remapInterval(iv.start, iv.end, timeline)),
    ducking.fadeSec * 2,
  );
  if (spans.length === 0) return bgm;
  return {
    ...bgm,
    duck: { spans, duckDb: ducking.duckDb, fadeSec: ducking.fadeSec },
  };
}

/** 隙間が gap 以下で隣接する区間をひと続きにまとめる */
function mergeClose(spans: Span[], gap: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** round2 済みの値どうしの比較(浮動小数の誤差を吸収) */
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** overlays のエントリが参照する素材トラックの最大番号(最低1)。
 * 2 で切り上げないこと: 切り上げると空トラックを1本まで減らせなくなる */
export function ovCountOf(overlays: Overlays): number {
  return Math.max(1, ...(overlays.overlays ?? []).map(overlayTrack));
}

/** transcript のセグメントが参照するテロップトラックの最大番号(最低1) */
export function capCountOf(transcript: Transcript): number {
  return Math.max(1, ...transcript.segments.map(captionTrack));
}

/**
 * overlays.json の layerOrder(手書きもあり得る)を検証して完全な並びにする。
 * 不明な値・重複は捨てる。素材トラック(ov<N>)とテロップトラック
 * ("caption" + cap<N>)はそれぞれ 1..N(N = 引数と並び内の最大の大きい方)が
 * 揃うように、欠番は1つ下の番号のトラックの直上へ補い、
 * wipe / caption が無ければ既定の相対順で末尾に補う。
 * 旧式の ovUnder / ovOver は ov1 / ov2 に、cap1 は caption に読み替え、
 * 廃止された "chapter"(旧・章テロップトラック)は黙って捨てる
 */
export function normalizeLayerOrder(
  order: string[] | undefined,
  ovCount: number,
  capCount: number,
  warn?: (msg: string) => void,
): LayerId[] {
  // layerOrder を書いていないプロジェクトは従来どおり素材2トラック構成。
  // テロップ2本目以降(cap2..)は caption の直上に積む
  const result: LayerId[] = [];
  if (!order || order.length === 0) {
    result.push(...defaultLayerOrder(Math.max(2, ovCount)));
  } else {
    for (const raw of order) {
      if (raw === "chapter") continue; // 旧形式との互換(警告なしで無視)
      const alias: Record<string, string> = { ovUnder: "ov1", ovOver: "ov2", cap1: "caption" };
      const id = alias[String(raw)] ?? raw;
      const valid = id === "wipe" || capNum(id) !== null || ovNum(id) !== null;
      if (valid && !result.includes(id as LayerId)) result.push(id as LayerId);
      else warn?.(`overlays.json の layerOrder に不明な値があります(無視): ${String(raw)}`);
    }
  }
  const fill = (
    count: number,
    idOf: (n: number) => LayerId,
    numOf: (id: string) => number | null,
  ) => {
    const n = Math.max(count, ...result.map((id) => numOf(id) ?? 0));
    for (let k = 1; k <= n; k++) {
      if (result.includes(idOf(k))) continue;
      // 1つ下の番号のトラックの直上に置く(1番が無ければ最下段)
      const below = result.findIndex((id) => id === idOf(k - 1));
      result.splice(below + 1, 0, idOf(k));
    }
  };
  fill(ovCount, ovId, ovNum);
  for (const id of ["wipe", "caption"] as const) {
    if (!result.includes(id)) result.push(id);
  }
  fill(capCount, capId, capNum);
  return result;
}
