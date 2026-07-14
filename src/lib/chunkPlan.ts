import type { OverlayItem, RenderProps } from "../../remotion/props.ts";

/**
 * render チャンク差分レンダー(docs/render-chunk-cache.md)のキャッシュキーを
 * 決める純関数群。render.ts / チャンク境界の carve(chunkCache.ts)から使う。
 * ここは ffmpeg 等の外部コマンドを呼ばない(テストしやすさ優先)。
 */

export interface FileStat {
  mtimeMs: number;
  size: number;
}

/** render.chunks/chunks.key.json の中身。boundaries・各チャンクの
 * chunkVideoKey・audioKey が前回と一致する範囲で、そのチャンクの
 * render.chunks/vNNN.mp4 を再利用してよい(render.ts が判定・更新する) */
export interface ChunksCacheKey {
  fps: number;
  /** final.mp4 の総フレーム数(境界の再利用可否の前提) */
  totalFrames: number;
  /** チャンク境界 [0, b1, …, totalFrames] */
  boundaries: number[];
  /** §3-1 の全域 props だけのキー(1つでも変われば全チャンク無効) */
  globalKey: string;
  /** チャンクごとの chunkVideoKey(boundaries.length - 1 件) */
  chunkVideoKeys: string[];
  /** 音声に効く入力だけのキー(変われば render.chunks/audio.m4a ごと作り直し) */
  audioKey: string;
}

/**
 * オブジェクトキーを再帰的にソートしてから JSON.stringify する。
 * renderKey.ts / cutCache.ts と同じ「JSON.stringify 一致」判定を、
 * オブジェクトの挿入順に依存しない単一の文字列キーとして持ち運べるようにした
 * もの(暗号学的ハッシュは不要。設計文書 §3-3)。
 */
export function stableHash(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 配列の要素順が意味を持たない箇所(区間限定 props の重なり要素)を、
 * 内容の安定な文字列表現で並べ替える。挿入順(手編集での並べ替え)が
 * 変わってもキーが変わらないようにする */
function sortStable<T>(items: T[]): T[] {
  return [...items]
    .map((item) => ({ item, key: JSON.stringify(sortKeysDeep(item)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.item);
}

/**
 * チャンク境界 `[0, b1, …, totalFrames]` を keyframe 位置から選ぶ。
 * cursor から目標長(chunkSec*fps)以上進んだ最初の keyframe を次の境界にする
 * (carve は keyframe でしか正確に切れないため)。keyframe が疎な区間では
 * 目標より長いチャンクになるが、単調増加・被りなしは常に保証する。
 * 該当する keyframe が見つからなければそこで打ち切り、最後は必ず totalFrames。
 */
export function carveBoundaries(
  keyframeFrames: number[],
  totalFrames: number,
  chunkSec: number,
  fps: number,
): number[] {
  const target = Math.max(1, Math.round(chunkSec * fps));
  const keyframes = [...new Set(keyframeFrames)].sort((a, b) => a - b);
  const boundaries = [0];
  let cursor = 0;
  while (cursor < totalFrames) {
    const want = cursor + target;
    if (want >= totalFrames) break;
    const next = keyframes.find((k) => k > cursor && k >= want && k < totalFrames);
    if (next === undefined) break;
    boundaries.push(next);
    cursor = next;
  }
  boundaries.push(totalFrames);
  return boundaries;
}

/**
 * 出力秒区間 `[elemStart, elemEnd)` がチャンク `[fromFrame, toFrame)` と
 * 重なるか。丸めの1フレーム端を吸収するため、判定は `[fromFrame-1,
 * toFrame+1)` で取る(設計文書 §3-2 の安全マージン)。
 */
export function overlapsChunk(
  elemStart: number,
  elemEnd: number,
  fromFrame: number,
  toFrame: number,
  fps: number,
): boolean {
  const s = Math.round(elemStart * fps);
  const e = Math.round(elemEnd * fps);
  return s <= toFrame && e >= fromFrame;
}

/** §3-1: 1つでも変われば全チャンク無効(→ フルレンダー行き)になる props の
 * 射影。baseSegments は keeps・inserts の位置/尺のどちらが変わっても変化する
 * ので、ここに含めることで「全域が変わった」を一括検知できる */
function globalVideoProps(props: RenderProps, cutStat: FileStat) {
  return {
    layerOrder: props.layerOrder ?? null,
    caption: props.caption,
    wipe: props.wipe,
    width: props.width,
    height: props.height,
    canvas: props.canvas,
    screenRegion: props.screenRegion,
    cameraRegion: props.cameraRegion,
    fps: props.fps,
    durationSec: props.durationSec,
    videoFile: props.videoFile,
    baseSegments: props.baseSegments ?? null,
    colorFilter: props.colorFilter ?? null,
    ...(props.design ? { design: props.design } : {}),
    cutStat,
  };
}

/** §3-1 の全域 props だけを対象にしたキー。render.ts はこれを1回だけ比較して
 * 「チャンクパスを試す価値があるか」を安く判定できる(全域が変わっていれば
 * 個々のチャンクキーを再計算するまでもなくフルレンダーへ) */
export function globalVideoKey(props: RenderProps, cutStat: FileStat): string {
  return stableHash(globalVideoProps(props, cutStat));
}

/** overlays[] のうち映像に効く項目だけを射影する(volume は音声のみに効く
 * ので audioKey 側の責務。§3-2) */
function videoOverlayProjection(o: OverlayItem) {
  return {
    start: o.start,
    end: o.end,
    track: o.track,
    file: o.file,
    fit: o.fit,
    startFrom: o.startFrom ?? null,
    opacity: o.opacity ?? null,
    fadeInSec: o.fadeInSec ?? null,
    fadeOutSec: o.fadeOutSec ?? null,
    rect: o.rect ?? null,
    keyframes: o.keyframes ?? null,
  };
}

/** inserts[] のうち映像に効く項目だけを射影する(volume は音声のみ) */
function videoInsertProjection(i: NonNullable<RenderProps["inserts"]>[number]) {
  return {
    start: i.start,
    end: i.end,
    file: i.file,
    fit: i.fit,
    startFrom: i.startFrom ?? null,
    fadeInSec: i.fadeInSec ?? null,
    fadeOutSec: i.fadeOutSec ?? null,
  };
}

/**
 * チャンク `[fromFrame, toFrame)` の絵を決めるキー。§3-1 の全域 props +
 * §3-2 のうちこのチャンクに重なる要素だけ(安定ソート済み)+ 境界そのもの
 * をまとめてハッシュ化する。テロップ1件を変えると、それが乗るチャンクの
 * このキーだけが変わる。
 */
export function chunkVideoKey(
  props: RenderProps,
  fromFrame: number,
  toFrame: number,
  cutStat: FileStat,
  fps: number,
): string {
  const overlaps = (s: number, e: number) => overlapsChunk(s, e, fromFrame, toFrame, fps);
  // カット境界のディップ・トゥ・ブラックは境界点 tb の前後 sec/2 だけに映るので、
  // その範囲がこのチャンクと重なる境界だけを対象にする(重ならないチャンクは
  // cutTransition.sec が変わっても絵が変わらないので、sec 自体もキーに含めない)
  const cutSec = props.cutTransition?.sec ?? 0;
  const cutBoundariesHere = (props.cutBoundarySecs ?? []).filter((tb) =>
    overlaps(tb - cutSec / 2, tb + cutSec / 2),
  );
  const local = {
    captions: sortStable(props.captions.filter((c) => overlaps(c.start, c.end))),
    overlays: sortStable(
      props.overlays.filter((o) => overlaps(o.start, o.end)).map(videoOverlayProjection),
    ),
    inserts: sortStable(
      (props.inserts ?? [])
        .filter((i) => overlaps(i.start, i.end))
        .map(videoInsertProjection),
    ),
    wipeFull: sortStable((props.wipeFull ?? []).filter((s) => overlaps(s.start, s.end))),
    zooms: sortStable((props.zooms ?? []).filter((z) => overlaps(z.start, z.end))),
    // blurs も zooms と同型の時間局所要素。重なるチャンクだけキーが変わる
    // (globalVideoProps には入れない=全域無効化を避ける。§4 タスク6)
    blurs: sortStable((props.blurs ?? []).filter((b) => overlaps(b.start, b.end))),
    annotations: sortStable((props.annotations ?? []).filter((a) => overlaps(a.start, a.end))),
    hideCaption: sortStable((props.hideCaption ?? []).filter((s) => overlaps(s.start, s.end))),
    cutTransition:
      cutBoundariesHere.length > 0 ? { sec: cutSec, boundaries: cutBoundariesHere } : null,
  };
  return stableHash({
    global: globalVideoProps(props, cutStat),
    local,
    bounds: { fromFrame, toFrame, fps },
  });
}

/**
 * 音声に効く入力だけのキー。BGM・overlays/inserts の音声項目・baseSegments・
 * durationSec・fps・cut.mp4 と音声を持つ素材ファイルの mtime/size が対象。
 * これが変わったら音声を作り直す必要があり、部分再利用の得がないので
 * render.ts はフルレンダーへフォールバックする(muteBase/muteBgm はプレビュー
 * 専用で最終レンダーでは常に未指定なのでここには含めない)。
 */
export function audioKey(
  props: RenderProps,
  cutStat: FileStat,
  materialStats: { file: string; mtimeMs: number; size: number }[],
): string {
  const overlaysAudio = sortStable(
    props.overlays.map((o) => ({
      start: o.start,
      end: o.end,
      file: o.file,
      volume: o.volume ?? 0,
      startFrom: o.startFrom ?? null,
      fadeInSec: o.fadeInSec ?? null,
      fadeOutSec: o.fadeOutSec ?? null,
    })),
  );
  const insertsAudio = sortStable(
    (props.inserts ?? []).map((i) => ({
      start: i.start,
      end: i.end,
      file: i.file,
      volume: i.volume ?? 1,
      startFrom: i.startFrom ?? null,
      fadeInSec: i.fadeInSec ?? null,
      fadeOutSec: i.fadeOutSec ?? null,
    })),
  );
  return stableHash({
    bgm: props.bgm,
    overlays: overlaysAudio,
    inserts: insertsAudio,
    baseSegments: props.baseSegments ?? null,
    durationSec: props.durationSec,
    fps: props.fps,
    cutStat,
    materials: [...materialStats].sort((a, b) => a.file.localeCompare(b.file)),
  });
}
