// B2(無音/被り回避の音量・duck・切替調整)+ B4(fallback/単調 検出)の
// 検出ロジック。§docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md
//
// fs 非依存の純関数のみ(実 fs/ffmpeg/LLM には一切依存しない)。
// av.probe/sound.json(SoundReport)と bgm.json(Bgm)を入力に取り、`apply`
// が食える @id 宛先の EditOp[] を組み立てる。補正値はすべて SoundReport の
// 実測値(RMS・LUFS・無音区間)からの算術で決まり、LLM には一切書かせない
// (母艦 原則4)。B2/B4 は基本決定論(本ファイルに LLM 呼び出しは無い)。
import type { Bgm, EditOp } from "../types.ts";
import type { SoundReport } from "../stages/av.ts";

export interface BgmFitCfg {
  /** 発話 RMS を BGM がこの dB 下回るまで下げる(被り回避。既定 8) */
  speechHeadroomDb: number;
  /** 無音区間で BGM を下げる量(既定 3) */
  silenceDuckDb: number;
  /** 全体ラウドネス目標(既定 -14。超過で loud 判定) */
  targetLufs: number;
  /** no-fade 判定で付ける fade 秒(既定 1.0) */
  minFadeSec: number;
  /** 単一 file が総尺のこの割合超で monotone(既定 0.9) */
  monotoneCoverRatio: number;
  /** 章がこの数以上あると BGM 単調を警告(既定 3) */
  minChaptersForVariety: number;
  /** track.volumeDb 省略時の実効値(config の render.bgm.volumeDb から
   *  呼び出し側(stage)が解決して渡す。bgmFit.* のユーザー設定ではなく
   *  render 既定の受け渡し用。sound.bgm.spans にトラックが現れない
   *  (av 未反映)ときのフォールバックにのみ使う) */
  defaultVolumeDb: number;
}

/** BGM 調整の1件。refId は対象トラックの @id。suggestion は補正(適用は apply。
 * 同一トラックへ複数 kind が該当しても volumeDb の set は1トラック1本に
 * まとめる= 2本目以降は reason のみで suggestion 無し) */
export interface BgmFitFinding {
  refId: string;
  kind: "speech-overlap" | "silence-float" | "loud" | "no-fade";
  startOutSec: number;
  endOutSec: number;
  currentVolumeDb: number;
  suggestion?: EditOp;
  reason: string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type BgmSpan = SoundReport["bgm"]["spans"][number];
type DuckSpan = SoundReport["bgm"]["duckSpans"][number];
type TrackSample = NonNullable<SoundReport["tracks"]>["samples"][number];

/** [start,end) が duckSpans によって既にどの程度覆われているか(0..1)。
 * B2 不変条件3(二重 duck 回避): 過半が duckSpans で下がっている区間には
 * 追加の volumeDb 補正を出さない(render の duck が既に効くため) */
function duckCoverRatio(start: number, end: number, duckSpans: DuckSpan[]): number {
  const total = end - start;
  if (total <= 0) return 0;
  let covered = 0;
  for (const d of duckSpans) {
    const s = Math.max(start, d.startOutSec);
    const e = Math.min(end, d.endOutSec);
    if (e > s) covered += e - s;
  }
  return covered / total;
}

const DUCK_ALREADY_COVERED_RATIO = 0.5;

function spansOf(bgmSpans: BgmSpan[], file: string): BgmSpan[] {
  return bgmSpans.filter((s) => s.file === file);
}

function samplesWithin(samples: TrackSample[], spans: BgmSpan[]): TrackSample[] {
  return samples.filter((sample) =>
    spans.some((span) => sample.outSec >= span.startOutSec && sample.outSec < span.endOutSec),
  );
}

/** track.id が無い場合は null(呼び出し側の id-stamp 前提チェックに委ねる。
 * materialFit.detectFit の "id 未採番の参照は除外する" と同じ扱い) */
function trackId(track: Bgm["tracks"][number]): string | null {
  return typeof track.id === "string" && track.id !== "" ? track.id : null;
}

/** speech-overlap: BGM が流れている時間帯のうち、tracks.samples が
 * louder==="system"(発話=mic に対し非mic側が勝つ=BGM が被って発話を
 * 覆っている、の実測プロキシ)の区間を「被り」とみなす。sound.json には
 * BGM 自体の RMS チャンネルは無い(mic/system は元収録の2トラック)ため、
 * systemRmsDb を BGM の被りプロキシとして使う簡略化(v1。§7 の
 * 「LLM 化の誘惑を断つ」と同じ精神で、実測から動く一次近似に留める)。
 * 発話 RMS(micRmsDb)を cfg.speechHeadroomDb 下回るところまで BGM を
 * 下げる volumeDb を、系列中の最悪値(最大超過)から算出する。
 * duckSpans が既に過半を覆っている区間は二重に下げないため候補から除く */
function detectSpeechOverlap(
  track: Bgm["tracks"][number],
  id: string,
  spans: BgmSpan[],
  samples: TrackSample[],
  windowSec: number,
  duckSpans: DuckSpan[],
  cfg: BgmFitCfg,
  currentVolumeDb: number,
): BgmFitFinding | null {
  const within = samplesWithin(samples, spans);
  let worstExcess = 0;
  let minSec = Infinity;
  let maxSec = -Infinity;
  for (const s of within) {
    if (s.louder !== "system" || s.systemRmsDb === null) continue;
    const excess = s.systemRmsDb - (s.micRmsDb - cfg.speechHeadroomDb);
    if (excess <= 0) continue;
    if (excess > worstExcess) worstExcess = excess;
    minSec = Math.min(minSec, s.outSec);
    maxSec = Math.max(maxSec, s.outSec);
  }
  if (worstExcess <= 0 || !Number.isFinite(minSec) || !Number.isFinite(maxSec)) return null;
  // 各サンプルは [outSec, outSec+windowSec) の窓を代表するので、duck 重なり
  // 判定・報告区間は windowSec 分だけ末尾へ広げる(単発サンプルでも
  // duckCoverRatio が退化区間(長さ0)にならないようにする)
  maxSec += windowSec;
  if (duckCoverRatio(minSec, maxSec, duckSpans) >= DUCK_ALREADY_COVERED_RATIO) return null;

  const newVolumeDb = round1(currentVolumeDb - worstExcess);
  return {
    refId: id,
    kind: "speech-overlap",
    startOutSec: round2(minSec),
    endOutSec: round2(maxSec),
    currentVolumeDb,
    suggestion: { op: "set", target: `@${id}`, field: "volumeDb", value: newVolumeDb },
    reason:
      `発話に BGM が被っています(${round2(minSec)}s〜${round2(maxSec)}s)。` +
      `発話 RMS を ${cfg.speechHeadroomDb}dB 下回るよう volumeDb を ${currentVolumeDb}dB → ${newVolumeDb}dB へ下げる案`,
  };
}

/** silence-float: 無音区間(発話が無い箇所)に BGM が原音量のまま乗っていると
 * 浮いて聞こえる。duckSpans で既に下がっている無音区間は対象外。
 * v1 は「大半未使用」の material-fit underrun と同じく算術で一意に決まる
 * 固定量(cfg.silenceDuckDb)を下げる案に留める */
function detectSilenceFloat(
  id: string,
  spans: BgmSpan[],
  silences: SoundReport["silences"],
  duckSpans: DuckSpan[],
  cfg: BgmFitCfg,
  currentVolumeDb: number,
): BgmFitFinding | null {
  let minSec = Infinity;
  let maxSec = -Infinity;
  // トラックの各出力断片(spans)ごとに無音区間との厳密な交差を取る(トラックが
  // 複数断片に割れているとき、無関係な断片の境界を誤って拾わないため)
  for (const sil of silences) {
    for (const span of spans) {
      const start = Math.max(sil.outSec, span.startOutSec);
      const end = Math.min(sil.endOutSec, span.endOutSec);
      if (end <= start) continue;
      if (duckCoverRatio(start, end, duckSpans) >= DUCK_ALREADY_COVERED_RATIO) continue;
      minSec = Math.min(minSec, start);
      maxSec = Math.max(maxSec, end);
    }
  }
  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) return null;

  const newVolumeDb = round1(currentVolumeDb - cfg.silenceDuckDb);
  return {
    refId: id,
    kind: "silence-float",
    startOutSec: round2(minSec),
    endOutSec: round2(maxSec),
    currentVolumeDb,
    suggestion: { op: "set", target: `@${id}`, field: "volumeDb", value: newVolumeDb },
    reason:
      `無音区間(${round2(minSec)}s〜${round2(maxSec)}s)に BGM が原音量のまま乗り浮いています。` +
      `volumeDb を ${currentVolumeDb}dB → ${newVolumeDb}dB へ下げる案(${cfg.silenceDuckDb}dB 減)`,
  };
}

/** loud: mix 全体のラウドネスが目標を超過。BGM が寄与主因という前提で、
 * 全 BGM トラックへ超過分の volumeDb 減を一律提案する */
function detectLoud(
  id: string,
  cfg: BgmFitCfg,
  currentVolumeDb: number,
  mix: NonNullable<SoundReport["mix"]>,
): BgmFitFinding | null {
  const excess = mix.integratedLufs - cfg.targetLufs;
  if (excess <= 0) return null;
  const newVolumeDb = round1(currentVolumeDb - excess);
  return {
    refId: id,
    kind: "loud",
    startOutSec: 0,
    endOutSec: 0,
    currentVolumeDb,
    suggestion: { op: "set", target: `@${id}`, field: "volumeDb", value: newVolumeDb },
    reason:
      `全体ラウドネス(${mix.integratedLufs}LUFS)が目標(${cfg.targetLufs}LUFS)を` +
      `${round1(excess)}LU 超過しています。volumeDb を ${currentVolumeDb}dB → ${newVolumeDb}dB へ下げる案`,
  };
}

/** no-fade: 動画の末尾まで流れているトラックに fadeOutSec が無ければ付与を
 * 提案する(sound.bgm.spans 全体の最大 endOutSec を動画終端の近似とする) */
function detectNoFade(
  track: Bgm["tracks"][number],
  id: string,
  spans: BgmSpan[],
  maxEndOutSec: number,
  cfg: BgmFitCfg,
  currentVolumeDb: number,
): BgmFitFinding | null {
  if (track.fadeOutSec !== undefined && track.fadeOutSec > 0) return null;
  const reachesEnd = spans.some((s) => Math.abs(s.endOutSec - maxEndOutSec) < 0.5);
  if (!reachesEnd) return null;
  return {
    refId: id,
    kind: "no-fade",
    startOutSec: round2(Math.max(0, maxEndOutSec - cfg.minFadeSec)),
    endOutSec: round2(maxEndOutSec),
    currentVolumeDb,
    suggestion: { op: "set", target: `@${id}`, field: "fadeOutSec", value: cfg.minFadeSec },
    reason: `動画終端まで BGM が続くのに fadeOutSec が未設定です。${cfg.minFadeSec}s のフェードアウト付与案`,
  };
}

/** SoundReport(silences / tracks.samples / mix / bgm.spans/duckSpans)と
 * bgm.tracks を突き合わせて調整候補を出す純関数。id 未採番のトラックは
 * 除外する(呼び出し側の id-stamp 前提チェックに委ねる。materialFit と同じ
 * 扱い)。1トラックにつき volumeDb の set は高々1本(speech-overlap →
 * silence-float → loud の優先順で先に該当した1件だけ suggestion を持ち、
 * 残りは reason のみ)。fadeOutSec(no-fade)は別フィールドなので独立に出す */
export function detectBgmFit(sound: SoundReport, bgm: Bgm, cfg: BgmFitCfg): BgmFitFinding[] {
  const findings: BgmFitFinding[] = [];
  const duckSpans = sound.bgm.duckSpans;
  const maxEndOutSec = sound.bgm.spans.reduce((m, s) => Math.max(m, s.endOutSec), 0);

  for (const track of bgm.tracks) {
    const id = trackId(track);
    if (id === null) continue;

    const spans = spansOf(sound.bgm.spans, track.file);
    const currentVolumeDb = spans[0]?.volumeDb ?? track.volumeDb ?? cfg.defaultVolumeDb;

    let volumeDbSuggested = false;

    if (spans.length > 0 && sound.tracks) {
      const overlap = detectSpeechOverlap(
        track,
        id,
        spans,
        sound.tracks.samples,
        sound.tracks.windowSec,
        duckSpans,
        cfg,
        currentVolumeDb,
      );
      if (overlap) {
        findings.push(overlap);
        volumeDbSuggested = true;
      }
    }

    if (spans.length > 0) {
      const float = detectSilenceFloat(id, spans, sound.silences, duckSpans, cfg, currentVolumeDb);
      if (float) {
        findings.push(volumeDbSuggested ? { ...float, suggestion: undefined } : float);
        volumeDbSuggested = true;
      }
    }

    if (sound.mix) {
      const loud = detectLoud(id, cfg, currentVolumeDb, sound.mix);
      if (loud) {
        findings.push(volumeDbSuggested ? { ...loud, suggestion: undefined } : loud);
        volumeDbSuggested = true;
      }
    }

    if (spans.length > 0 && maxEndOutSec > 0) {
      const noFade = detectNoFade(track, id, spans, maxEndOutSec, cfg, currentVolumeDb);
      if (noFade) findings.push(noFade);
    }
  }

  return findings;
}

/** B4: 単調 fallback 判定。fallbackActive(bgm.json 無し・収録直下 bgm.* の
 * 全編1曲)か、単一 file が総尺の cfg.monotoneCoverRatio 超を覆っているかを
 * 見て、chapterCount >= cfg.minChaptersForVariety のときだけ「章が複数なのに
 * BGM 単調」と警告する。区間割り・選曲はしない(SD-B1 の責務。ここは検出して
 * plan-bgm へ誘導するだけ)。
 *
 * **カバレッジは `sound.bgm.spans`(出力=カット後秒)から数える**。bgm.json の
 * `tracks[].start/end` は SOURCE(元収録)秒で、cut がかかると縮む(validate は
 * `visibleSec` で写像する)。source 秒を出力秒 totalOutSec で割ると、A/B/A の
 * ように大きくカットする収録で比率が壊れ(例: source 0-400 のうち 350s カット
 * で 400/250=1.6)、多様な BGM を誤って「単調」と誤検出する。sound.bgm.spans は
 * renderProps 経由で既に出力秒へ写像済みなので、cutplan.json を読まずに
 * (契約: cut/承認非干渉)正しい出力カバレッジが得られる。 */
export function detectMonotone(args: {
  fallbackActive: boolean;
  bgmSpans: SoundReport["bgm"]["spans"];
  totalOutSec: number;
  chapterCount: number;
  cfg: BgmFitCfg;
}): { monotone: boolean; message: string } {
  const { fallbackActive, bgmSpans, totalOutSec, chapterCount, cfg } = args;
  if (chapterCount < cfg.minChaptersForVariety) return { monotone: false, message: "" };

  if (fallbackActive) {
    return {
      monotone: true,
      message:
        `bgm.json が無く、収録直下の bgm.* を全編1曲の fallback として流しています。` +
        `章が${chapterCount}件あるのに BGM が単調です。\`plan-bgm <dir>\` で章×テンションの区間割りを作れます。`,
    };
  }

  if (bgmSpans.length === 0 || totalOutSec <= 0) return { monotone: false, message: "" };

  // 出力(カット後)秒でのファイル別カバレッジ(sound.bgm.spans は出力秒)
  const coverByFile = new Map<string, number>();
  for (const span of bgmSpans) {
    const dur = Math.max(0, span.endOutSec - span.startOutSec);
    coverByFile.set(span.file, (coverByFile.get(span.file) ?? 0) + dur);
  }
  for (const [file, coveredSec] of coverByFile) {
    if (coveredSec / totalOutSec > cfg.monotoneCoverRatio) {
      const pct = Math.round((coveredSec / totalOutSec) * 100);
      return {
        monotone: true,
        message:
          `BGM が単一ファイル(${file})で総尺の${pct}%を覆っています。` +
          `章が${chapterCount}件あるのに BGM が単調です。\`plan-bgm <dir>\` で章×テンションの区間割りを作れます。`,
      };
    }
  }
  return { monotone: false, message: "" };
}

/** suggestion を持つ finding を apply パッチ(ops)へ束ねる。suggestion の
 * 無い finding(2件目以降の volumeDb 重複回避)は含めない */
export function buildBgmFitPatch(findings: BgmFitFinding[]): { ops: EditOp[] } {
  const ops: EditOp[] = [];
  for (const f of findings) if (f.suggestion) ops.push(f.suggestion);
  return { ops };
}

/** id-stamp ゲート判定: id を持たないトラックのうち「id さえあれば B2 補正
 * (volumeDb/fadeOutSec の set)が出る」ものが1本でもあるか。detectBgmFit は
 * id 無しトラックを黙って飛ばすので、ここでは一時 id を振って検出し、元々
 * id 無しだったトラックに suggestion が付くかを見る。true のときだけ stage は
 * 「先に id-stamp」で停止する。B4 の monotone だけ・または検出なしのときは
 * id が要らないので停止しない(SD-B2 §B-2: ゲートは「B2 補正が出る見込みの
 * とき」だけ。plan-bgm の出力は id 無しなので、この緩和が無いと通常鎖
 * plan-bgm → av → bgm-fit が常に exit 1 になってしまう)。 */
export function idlessTracksNeedIdStamp(sound: SoundReport, bgm: Bgm, cfg: BgmFitCfg): boolean {
  const idlessTemp = new Set<string>();
  const stamped: Bgm = {
    tracks: bgm.tracks.map((t, i) => {
      if (typeof t.id === "string" && t.id !== "") return t;
      const tempId = `__bgmfit_idless__${i}`;
      idlessTemp.add(tempId);
      return { ...t, id: tempId };
    }),
  };
  if (idlessTemp.size === 0) return false;
  const findings = detectBgmFit(sound, stamped, cfg);
  return findings.some((f) => f.suggestion !== undefined && idlessTemp.has(f.refId));
}
