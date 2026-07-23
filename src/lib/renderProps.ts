import {
  buildTimeline,
  buildTimelineModel,
  insertSpans,
  remapInterval,
  remapIntervalPieces,
  toOutputTime,
} from "./timeline.ts";
import type { RemappedPiece, TimelineEntry } from "./timeline.ts";
import type { Config } from "./config.ts";
import type { Profile } from "./profile.ts";
import { remapKeyframesForPiece } from "./keyframes.ts";
import {
  DEFAULT_BLUR_STRENGTH,
  DEFAULT_BOX_RADIUS_PX,
  DEFAULT_BOX_WIDTH_PX,
  DEFAULT_CUT_TRANSITION_SEC,
  DEFAULT_ARROW_HEAD_PX,
  DEFAULT_ARROW_WIDTH_PX,
  DEFAULT_SPOTLIGHT_DIM,
  DEFAULT_SPOTLIGHT_FEATHER_PX,
  DEFAULT_WIPE_TRANSITION_SEC,
  DEFAULT_ZOOM_EASE_SEC,
  DEFAULT_ZOOM_WIPE_SCALE,
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
  Bgm,
  Interval,
  LayerId,
  Manifest,
  Overlays,
  Transcript,
  Annotation,
} from "../types.ts";
import { manifestCompositionFps } from "../types.ts";
import { resolveAnnotation } from "./annotation.ts";
import { resolveDesign } from "./design.ts";
import type {
  Caption,
  OverlayItem,
  RenderProps,
  ResolvedKeyframe,
  Span,
} from "../../remotion/props.ts";

type NumericBaseline = Record<string, number>;

function keyframesForPieces<TValues extends object>(
  keyframes: { at: number; easing?: import("../types.ts").KeyframeEasing; values: TValues }[] | undefined,
  pieces: RemappedPiece[],
  baseline: NumericBaseline,
): { start: number; end: number; keyframes?: ResolvedKeyframe[] }[] {
  return pieces.map((piece) => ({
    start: piece.outputStart,
    end: piece.outputEnd,
    ...(keyframes
      ? {
          keyframes: remapKeyframesForPiece(
            keyframes.map((k) => ({ ...k, values: { ...(k.values as Record<string, number>) } })),
            piece,
            baseline,
          ),
        }
      : {}),
  }));
}

function annotationBaselineOf(a: Annotation): NumericBaseline {
  switch (a.type) {
    case "arrow":
      return {
        fromX: a.from.x,
        fromY: a.from.y,
        toX: a.to.x,
        toY: a.to.y,
        widthPx: a.widthPx ?? DEFAULT_ARROW_WIDTH_PX,
        headPx: a.headPx ?? DEFAULT_ARROW_HEAD_PX,
      };
    case "box":
      return {
        x: a.rect.x,
        y: a.rect.y,
        w: a.rect.w,
        h: a.rect.h,
        widthPx: a.widthPx ?? DEFAULT_BOX_WIDTH_PX,
        radiusPx: a.radiusPx ?? DEFAULT_BOX_RADIUS_PX,
      };
    case "spotlight":
      return {
        x: a.rect.x,
        y: a.rect.y,
        w: a.rect.w,
        h: a.rect.h,
        dim: a.dim ?? DEFAULT_SPOTLIGHT_DIM,
        featherPx: a.featherPx ?? DEFAULT_SPOTLIGHT_FEATHER_PX,
        radiusPx: a.radiusPx ?? 0,
      };
  }
}

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
  /** 出力プロファイル(src/lib/profile.ts の resolveProfile が返すもの)。
   * layout があれば props.layout に、caption があれば captionDefaultPos と
   * caption.fontSizePx(×fontScale)に反映する。省略時は現行と同一の props
   * (横 default・下部中央テロップ) */
  profile?: Profile;
  /** publicDir 相対の動画ファイル名(render: cut.mp4 / エディタ: プロキシ) */
  videoFile: string;
  /** true = videoFile がカット前の元収録そのもの(エディタの proxy.mp4)。
   * ベース区間は元収録の秒から再生する。false/省略 = keeps のみを繋いだ
   * 動画(render の cut.mp4)で、区間の再生位置はカット後の秒 */
  videoIsSource?: boolean;
  /** bgm.json の内容(無ければ null)。tracks[] を出力タイムラインへ写像して
   * 複数の BGM 区間にする。null かつ bgmFallbackFile があればそれを全編1曲
   * として流す(bgm.json 導入前からの後方互換) */
  bgm: Bgm | null;
  /** bgm.json が無いときの後方互換: 収録フォルダ直下の bgm.*(相対パス)。
   * null なら BGM なし。bgm.json があるときは無視される */
  bgmFallbackFile: string | null;
  /** 無音検出(cuts.auto.json)の無音区間(元収録の秒)。BGM ダッキングの
   * 発話区間を組み立てるのに使う。null/省略ならダッキングなし */
  silences?: Interval[] | null;
  /** オーバーレイ・BGM 素材の存在チェック。無い素材は warn して除外する */
  overlayExists: (file: string) => boolean;
  warn: (msg: string) => void;
}): RenderProps {
  const {
    manifest, keeps, transcript, overlays,
    renderCfg, width, height, profile, videoFile, videoIsSource, bgm, bgmFallbackFile, silences,
    overlayExists, warn,
  } = args;
  const layoutCaption = profile?.layout?.caption;

  // ベースレイアウトのデザイン(config.yaml の render.design)。縦プリセット
  // (profile.layout)はパネル合成で別レイアウトなので対象外
  const design = profile?.layout
    ? undefined
    : resolveDesign(renderCfg.design, width, height, !!manifest.video.cameraRegion);
  if (design?.backgroundFile && !overlayExists(design.backgroundFile)) {
    warn(`背景画像が見つかりません: ${design.backgroundFile}(背景色のみで描画します)`);
    delete design.backgroundFile;
  }

  // ベース映像への挿入。素材が無いものは挿入ごと除外する
  // (時間の穴になるより、以降が前へ詰まる方が壊れ方として安全)
  const activeInserts = (overlays.inserts ?? []).filter((ins) => {
    if (overlayExists(ins.file)) return true;
    warn(`挿入素材が見つかりません: ${ins.file}(挿入ごと除外し、以降は前へ詰まります)`);
    return false;
  });
  const builtTimeline = buildTimelineModel(keeps, activeInserts);
  const timeline = builtTimeline.entries;
  const captions: Caption[] = transcript.segments
    .flatMap((s) => {
      // 位置・スタイルはここで解決する(セグメント指定 → トラック標準 → 既定)。
      // anchor(座標の解釈)はトラック標準に従い、pos が無ければ意味を持たない
      const pos = captionPosOf(s, overlays);
      const style = captionStyleOf(s, overlays);
      const anchor = captionAnchorOf(s, overlays);
      const frags = remapInterval(s.start, s.end, timeline);

      // 語を独立に写像する。1語も挿入/カット境界で複数断片に割れうるので
      // flatMap。カット内に完全に入る語は remapInterval が [] を返し自然に消える
      // (= その語は出力に映らないので active 判定の対象外。正しい)。
      // words[] が無い(既定)ときは wordPieces=[] で、下の words 付与も走らない
      // = 従来と 1 バイトも変わらない。
      const wordPieces = (s.words ?? []).flatMap((w) =>
        remapInterval(w.start, w.end, timeline).map((iv) => ({
          text: w.text,
          start: iv.start,
          end: iv.end,
        })),
      );

      return frags.map((iv) => {
        // この断片 [iv.start, iv.end) に重なる語だけを載せ、断片へクリップする。
        // 挿入が語の途中に割り込んだ場合、その語は2つの断片に別々に載り、
        // それぞれの局所時刻でハイライトが進む(断片間で状態は連続しないが、
        // 挿入中はテロップ自体が別の絵なので破綻しない)。
        const words = wordPieces
          .filter((wp) => wp.end > iv.start && wp.start < iv.end)
          .map((wp) => ({
            text: wp.text,
            start: Math.max(wp.start, iv.start),
            end: Math.min(wp.end, iv.end),
          }));
        return {
          start: iv.start,
          end: iv.end,
          // trim は前後の空白だけ落とす(テキスト内の改行=手動改行は残る)
          text: s.text.trim(),
          track: captionTrack(s),
          ...(pos ? { pos } : {}),
          ...(pos && anchor === "topLeft" ? { anchor } : {}),
          ...(style ? { style } : {}),
          ...(words.length > 0 ? { words } : {}),
        };
      });
    })
    .filter((c) => c.text.length > 0);

  // overlays.json の演出指定もカット後のタイムラインに変換する。
  // remapInterval は連続区間をまとめるので、割れるのは挿入で途切れる場合
  // だけ。動画素材は「頭出し(startFrom)+それまでの表示済み秒数」で
  // 続きから再生する。フェードは断片ではなく区間全体の頭/末尾に付くよう、
  // 最初の断片にだけ fadeIn、最後の断片にだけ fadeOut を載せる
  const overlayItems: OverlayItem[] = (overlays.overlays ?? []).flatMap((o) => {
    if (!overlayExists(o.file)) {
      warn(`オーバーレイ素材が見つかりません: ${o.file}(除外します)`);
      return [];
    }
    let shown = 0;
    const pieces = remapIntervalPieces(o.start, o.end, timeline);
    const parts = keyframesForPieces(
      o.keyframes as typeof o.keyframes,
      pieces,
      {
        x: o.rect?.x ?? 0,
        y: o.rect?.y ?? 0,
        w: o.rect?.w ?? width,
        h: o.rect?.h ?? height,
        opacity: o.opacity ?? 1,
      },
    );
    return parts.map((iv, j) => {
      const from = (o.startFrom ?? 0) + shown;
      const item: OverlayItem = {
        start: iv.start,
        end: iv.end,
        file: o.file,
        track: overlayTrack(o),
        fit: o.fit ?? "contain",
        ...(from > 0 ? { startFrom: round2(from) } : {}),
        ...(o.volume ? { volume: o.volume } : {}),
        ...(o.opacity !== undefined && o.opacity !== 1 ? { opacity: o.opacity } : {}),
        // 断片がフェード秒より短いときは断片内で完了する長さへ縮める
        // (断片をまたいでフェードは続かないので、そのままだと挿入境界で
        // 不透明度・音量が中途半端な値から段差でジャンプする)
        ...(j === 0 && o.fadeInSec
          ? { fadeInSec: Math.min(o.fadeInSec, round2(iv.end - iv.start)) }
          : {}),
        ...(j === parts.length - 1 && o.fadeOutSec
          ? { fadeOutSec: Math.min(o.fadeOutSec, round2(iv.end - iv.start)) }
          : {}),
        ...((o.rect || o.keyframes)
          ? {
              rect: {
                x: o.rect?.x ?? 0,
                y: o.rect?.y ?? 0,
                w: o.rect?.w ?? width,
                h: o.rect?.h ?? height,
              },
            }
          : {}),
        ...(iv.keyframes ? { keyframes: iv.keyframes } : {}),
      };
      shown += iv.end - iv.start;
      return item;
    });
  });
  const remapSpans = (spans?: Interval[]): Span[] =>
    (spans ?? []).flatMap((s) => remapInterval(s.start, s.end, timeline));
  // ワイプ全画面は断片ごとに出入りの遷移が走るので、断片のまま渡すと
  // 継ぎ目でワイプが縮んで戻るバウンスが出る。同一区間が挿入で割れた断片は
  // 挿入をまたいでひと続きにし(挿入中はベース映像が無くワイプの器は空 =
  // 見えないので安全)、カットや隣接エントリで出力上つながった区間は
  // まとめる。遷移は区間全体の頭と末尾だけになる(フェードと同じ考え方)
  const wipeSpans = mergeClose(
    (overlays.wipeFull ?? []).flatMap((s) => {
      const parts = remapInterval(s.start, s.end, timeline);
      return parts.length > 0
        ? [{
            start: parts[0].start,
            end: parts[parts.length - 1].end,
            ...(s.transitionSec !== undefined ? { transitionSec: s.transitionSec } : {}),
            ...(s.transitionInSec !== undefined ? { transitionInSec: s.transitionInSec } : {}),
            ...(s.transitionOutSec !== undefined ? { transitionOutSec: s.transitionOutSec } : {}),
          }]
        : [];
    }),
    0.004,
  );

  // ズーム演出もカット後タイムラインへ写像する。重なりは無い前提(validate が
  // エラーにする)ので wipeFull と違い区間どうしのマージはしない
  // (rect が異なるエントリを1本にまとめると情報が失われるため)。
  // 挿入で割れた断片は wipeFull と同じ考え方で先頭〜末尾をひと続きに扱う
  // (挿入中はベース映像が無く見えないので安全)
  const zoomSpans = (overlays.zooms ?? []).flatMap((z) => {
    const parts = remapInterval(z.start, z.end, timeline);
    if (parts.length === 0) return [];
    return [
      {
        start: parts[0].start,
        end: parts[parts.length - 1].end,
        rect: z.rect,
        easeSec: z.easeSec ?? renderCfg.zoom?.easeSec ?? DEFAULT_ZOOM_EASE_SEC,
        ...(z.easeOutSec !== undefined ? { easeOutSec: z.easeOutSec } : {}),
        wipeScale: renderCfg.zoom?.wipeScale ?? DEFAULT_ZOOM_WIPE_SCALE,
      },
    ];
  });

  // 領域ぼかしもカット後タイムラインへ写像する。rect は不変なので
  // マージ不要(zooms と同じく断片ごとに独立エントリのまま。判断5)。
  // wipeFull のような近接マージはしない(blur に遷移が無いため不要)
  const blurSpans = (overlays.blurs ?? []).flatMap((b) =>
    keyframesForPieces(
      b.keyframes as typeof b.keyframes,
      remapIntervalPieces(b.start, b.end, timeline),
      {
        x: b.rect.x,
        y: b.rect.y,
        w: b.rect.w,
        h: b.rect.h,
        strength: b.strength ?? DEFAULT_BLUR_STRENGTH,
      },
    ).map((iv) => ({
      start: iv.start,
      end: iv.end,
      rect: b.rect,
      strength: b.strength ?? DEFAULT_BLUR_STRENGTH,
      ...(iv.keyframes ? { keyframes: iv.keyframes } : {}),
    })),
  );

  // 注釈グラフィック(矢印/囲み/スポットライト)もカット後タイムラインへ
  // 写像する。既定値は resolveAnnotation が埋める(blurs の strength
  // 解決と同じ考え方)。挿入で割れた断片は独立エントリのまま(マージ不要)
  const annotationItems = (overlays.annotations ?? []).flatMap((a) =>
    keyframesForPieces(
      a.keyframes as { at: number; easing?: import("../types.ts").KeyframeEasing; values: object }[] | undefined,
      remapIntervalPieces(a.start, a.end, timeline),
      annotationBaselineOf(a),
    ).map((iv) => {
      const resolved = resolveAnnotation(a, iv.start, iv.end);
      return iv.keyframes ? { ...resolved, keyframes: iv.keyframes } : resolved;
    }),
  );

  // ベース映像の再生区間。「カット後のどこで、動画内のどの時刻から再生
  // するか」に分割する。動画内の時刻は videoFile が何かで変わる:
  // - render の cut.mp4 は keeps のみの動画 → 挿入なし写像でのカット後時刻
  //   (挿入がなければ全編1区間に繋がり、従来どおりの連続再生)
  // - エディタの proxy.mp4 は元収録そのもの → 元収録の秒。カット境界ごとに
  //   区間が分かれ、Player が飛び飛びに再生する(カット編集の即時反映)
  const keepsOnly = buildTimeline(keeps);
  const segments = timeline.map((e) => ({
    start: e.outputStart,
    videoStart: videoIsSource
      ? e.sourceStart
      : (toOutputTime(e.sourceStart, keepsOnly) ?? 0),
    durationSec: round2(e.outputEnd - e.outputStart),
    ...(videoIsSource && e.speed !== 1 ? { playbackRate: e.speed } : {}),
  }));
  // 動画内でも連続している区間はまとめる
  const baseSegments: typeof segments = [];
  for (const seg of segments) {
    const last = baseSegments[baseSegments.length - 1];
    if (
      last &&
      near(last.start + last.durationSec, seg.start) &&
      near(
        last.videoStart + last.durationSec * (last.playbackRate ?? 1),
        seg.videoStart,
      ) &&
      (last.playbackRate ?? 1) === (seg.playbackRate ?? 1)
    ) {
      last.durationSec = round2(last.durationSec + seg.durationSec);
    } else {
      baseSegments.push({ ...seg });
    }
  }
  const insertItems = builtTimeline.inserts.map((sp) => {
    const ins = activeInserts[sp.index];
    return {
      start: sp.start,
      end: sp.end,
      file: ins.file,
      fit: ins.fit ?? "contain" as const,
      ...(ins.startFrom ? { startFrom: round2(ins.startFrom) } : {}),
      ...(ins.volume !== undefined && ins.volume !== 1 ? { volume: ins.volume } : {}),
      ...(ins.fadeInSec ? { fadeInSec: ins.fadeInSec } : {}),
      ...(ins.fadeOutSec ? { fadeOutSec: ins.fadeOutSec } : {}),
    };
  });

  const durationSec = builtTimeline.durationSec;
  const duck = buildDuck(silences ?? null, manifest.durationSec, timeline, renderCfg);
  return {
    videoFile,
    bgm: buildBgm({
      bgm,
      bgmFallbackFile,
      renderCfg,
      timeline,
      durationSec: round2(durationSec),
      duck,
      fileExists: overlayExists,
      warn,
    }),
    durationSec: Math.round(durationSec * 100) / 100,
    fps: manifestCompositionFps(manifest),
    width,
    height,
    canvas: { w: manifest.video.width, h: manifest.video.height },
    screenRegion: manifest.video.screenRegion,
    cameraRegion: manifest.video.cameraRegion,
    wipe: {
      widthPx: renderCfg.wipeWidthPx,
      marginPx: renderCfg.wipeMarginPx,
      // ワイプ全画面の出入りの遷移(秒)。未設定の config では従来より
      // なめらかな既定 0.3 秒にする(0 を書けば瞬時に戻せる)
      transitionSec: renderCfg.wipeTransitionSec ?? DEFAULT_WIPE_TRANSITION_SEC,
    },
    ...(overlays.colorFilter ? { colorFilter: overlays.colorFilter } : {}),
    // ベースレイアウトのデザイン(背景 + 画面パネル + カメラ円)。縦プリセット
    // (layout)経路には載せない=ショートは従来どおりのパネル合成のまま
    ...(design ? { design } : {}),
    ...(profile?.layout ? { layout: { panels: profile.layout.panels } } : {}),
    // 既定スタイルは config(render.caption*)→ 無ければ描画側の定数。
    // undefined のキーは載せない(props を JSON に書く render.props.json を汚さない)
    caption: {
      // 縦プリセットの caption.fontScale があれば既定サイズに掛ける
      fontSizePx: layoutCaption?.fontScale
        ? Math.round(renderCfg.captionFontSizePx * layoutCaption.fontScale)
        : renderCfg.captionFontSizePx,
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
      ...(renderCfg.captionBackground
        ? { background: renderCfg.captionBackground }
        : {}),
    },
    ...(layoutCaption
      ? {
          captionDefaultPos: {
            x: layoutCaption.x,
            y: layoutCaption.y,
            ...(layoutCaption.anchor ? { anchor: layoutCaption.anchor } : {}),
          },
        }
      : {}),
    captions,
    overlays: overlayItems,
    wipeFull: wipeSpans,
    ...(zoomSpans.length > 0 ? { zooms: zoomSpans } : {}),
    ...(blurSpans.length > 0 ? { blurs: blurSpans } : {}),
    ...(annotationItems.length > 0 ? { annotations: annotationItems } : {}),
    ...(renderCfg.cutTransition?.type === "dip-to-black"
      ? {
          cutTransition: { sec: renderCfg.cutTransition.sec ?? DEFAULT_CUT_TRANSITION_SEC },
          cutBoundarySecs: cutBoundarySecsOf(keeps, timeline),
        }
      : {}),
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

/** BGM 区間に共通で載せる発話ダッキング */
type Duck = { spans: Span[]; duckDb: number; fadeSec: number };

/**
 * 発話ダッキングの区間を組み立てる。無音検出(cuts.auto.json)の補集合=
 * 発話区間をカット後のタイムラインへ写像し、その間だけ Remotion 側が BGM を
 * duckDb 下げる。無音区間が無い(detect 未実行)・ducking 未設定・duckDb: 0
 * のときは null(ダッキングなし=全編一定音量)
 */
function buildDuck(
  silences: Interval[] | null,
  sourceDurationSec: number,
  timeline: ReturnType<typeof buildTimeline>,
  renderCfg: Config["render"],
): Duck | null {
  const ducking = renderCfg.bgm.ducking;
  if (!silences || !ducking || ducking.duckDb === 0) return null;

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
  if (spans.length === 0) return null;
  return { spans, duckDb: ducking.duckDb, fadeSec: ducking.fadeSec };
}

/**
 * bgm.json の tracks(元収録の秒)を出力タイムラインの BGM 区間へ写像する。
 * 覆っていない時間は無音(区間を作らない)。挿入で割れた区間はフェードを
 * 最初/最後の断片にだけ載せる(オーバーレイと同じ考え方)。bgm.json が無ければ
 * 収録フォルダ直下の bgm.*(bgmFallbackFile)を全編1曲として流す従来動作。
 * 存在しない素材は warn して飛ばす(= その区間は無音)。
 */
function buildBgm(args: {
  bgm: Bgm | null;
  bgmFallbackFile: string | null;
  renderCfg: Config["render"];
  timeline: ReturnType<typeof buildTimeline>;
  durationSec: number;
  duck: Duck | null;
  fileExists: (file: string) => boolean;
  warn: (msg: string) => void;
}): RenderProps["bgm"] {
  const { bgm, bgmFallbackFile, renderCfg, timeline, durationSec, duck, fileExists, warn } = args;
  const withDuck = <T extends object>(t: T): T & { duck?: Duck } =>
    duck ? { ...t, duck } : t;

  if (bgm && Array.isArray(bgm.tracks)) {
    return bgm.tracks.flatMap((t) => {
      if (!fileExists(t.file)) {
        warn(`BGM 素材が見つかりません: ${t.file}(この区間は無音になります)`);
        return [];
      }
      const parts = remapInterval(t.start, t.end, timeline);
      return parts.map((iv, j) =>
        withDuck({
          file: t.file,
          volumeDb: t.volumeDb ?? renderCfg.bgm.volumeDb,
          start: iv.start,
          end: iv.end,
          ...(t.startFrom ? { startFrom: round2(t.startFrom) } : {}),
          ...(j === 0 && t.fadeInSec
            ? { fadeInSec: Math.min(t.fadeInSec, round2(iv.end - iv.start)) }
            : {}),
          ...(j === parts.length - 1 && t.fadeOutSec
            ? { fadeOutSec: Math.min(t.fadeOutSec, round2(iv.end - iv.start)) }
            : {}),
        }),
      );
    });
  }

  // 後方互換: 収録フォルダ直下の bgm.* を全編1曲でループ再生する。
  // 終端フェードアウトは区間終端(=動画終端)の fadeOutSec で再現する
  if (bgmFallbackFile && durationSec > 0) {
    return [
      withDuck({
        file: bgmFallbackFile,
        volumeDb: renderCfg.bgm.volumeDb,
        start: 0,
        end: durationSec,
        ...(renderCfg.bgm.fadeOutSec ? { fadeOutSec: renderCfg.bgm.fadeOutSec } : {}),
      }),
    ];
  }
  return [];
}

/** 隙間が gap 以下で隣接する区間をひと続きにまとめる */
function mergeClose(spans: Span[], gap: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      s.start - last.end <= gap &&
      last.transitionSec === s.transitionSec &&
      last.transitionInSec === s.transitionInSec &&
      last.transitionOutSec === s.transitionOutSec
    ) {
      last.end = Math.max(last.end, s.end);
    }
    else out.push({ ...s });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** round2 済みの値どうしの比較(浮動小数の誤差を吸収) */
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * dip-to-black の対象境界(カット後の秒)を求める。keep 区間ごとの終端を
 * 実際の出力タイムライン(timeline。挿入があればその尺ぶん後ろへずれる)へ
 * remapInterval で写像し、その終端を境界とする(挿入の尺を無視した単純な
 * keep 累積時間だと、境界より手前に挿入があるプロジェクトで位置がずれる)。
 * 隣り合う keep の end/start が実質一致する(エディタの分割編集直後など、
 * mergeIntervals 未適用で渡ってきた場合を含む)境界は実際には切れていない
 * ので除外する。先頭(0)と末尾は境界に含めない
 */
function cutBoundarySecsOf(keeps: Interval[], timeline: TimelineEntry[]): number[] {
  const bounds: number[] = [];
  for (let i = 0; i < keeps.length - 1; i++) {
    const cur = keeps[i];
    const next = keeps[i + 1];
    if (near(next.start, cur.end)) continue;
    const mapped = remapInterval(cur.start, cur.end, timeline);
    const last = mapped[mapped.length - 1];
    if (last) bounds.push(last.end);
  }
  return bounds;
}

/** Sequence に渡すフレーム区間(from / durationInFrames) */
export interface FrameSpan {
  from: number;
  durationInFrames: number;
}

/**
 * ベース区間と挿入の「出力秒 → フレーム区間」変換(Main.tsx が使う)。
 * from と durationInFrames を区間ごとに独立に丸めると、丸めの向き次第で
 * 境界に1フレームの穴(最下層が無くなり背景の黒が一瞬見える)や
 * 1フレームの重なり(音が 1/fps 秒だけ二重に鳴る)ができる。
 * ベース区間と挿入は出力タイムラインをすき間なく敷き詰めるので、
 * 境界の秒がほぼ一致する(差は round2 の量子化 ±0.005×2 まで)隣接区間は
 * 同じフレーム番号を共有させ、終端が合成の末尾と1フレーム以内で一致する
 * 区間は末尾へ吸着させる。エディタ(Player)と最終レンダーの両方に効く
 */
export function frameSpans(args: {
  baseSegments: { start: number; durationSec: number }[];
  inserts: { start: number; end: number }[];
  fps: number;
  durationInFrames: number;
}): { base: FrameSpan[]; inserts: FrameSpan[] } {
  const pieces = [
    ...args.baseSegments.map((s, i) => ({
      kind: "base" as const,
      i,
      startSec: s.start,
      endSec: s.start + s.durationSec,
    })),
    ...args.inserts.map((ins, i) => ({
      kind: "insert" as const,
      i,
      startSec: ins.start,
      endSec: ins.end,
    })),
  ].sort((a, b) => a.startSec - b.startSec);
  const base: FrameSpan[] = [];
  const inserts: FrameSpan[] = [];
  pieces.forEach((p, k) => {
    const next = pieces[k + 1];
    const from = Math.round(p.startSec * args.fps);
    let end: number;
    if (next && Math.abs(next.startSec - p.endSec) < 0.02) {
      end = Math.round(next.startSec * args.fps);
    } else {
      end = Math.round(p.endSec * args.fps);
      if (Math.abs(end - args.durationInFrames) <= 1) end = args.durationInFrames;
    }
    (p.kind === "base" ? base : inserts)[p.i] = {
      from,
      durationInFrames: Math.max(1, end - from),
    };
  });
  return { base, inserts };
}

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
  // layerOrder を書いていないプロジェクトは素材トラック数なりの構成(素材
  // ゼロ/1本なら V2 は出さない。2本以上は従来どおり)。
  // テロップ2本目以降(cap2..)は caption の直上に積む
  const result: LayerId[] = [];
  if (!order || order.length === 0) {
    result.push(...defaultLayerOrder(Math.max(1, ovCount)));
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
