// lib/hyperframeAudit.ts — HyperFrames カードの render 不要な動的監査
// (hyperframe-check コマンド)の決定論ロジック。
//
// fs/node/ブラウザには一切依存しない純関数のみ。stages/hyperframeAudit.ts が
// headless Chrome で撮った AuditSample[](論理アニメーション状態。ピクセルでは
// ない)を入力に取り、effect-check 家風(常に成功・warn/info のみ・
// 収録フォルダの編集ファイルは書かない)の Finding[] を組み立てる。
//
// 較正(74本の既知合格カードに対する実測)で判明した2つの根本原因を潰した版:
// 1) 終端未完了はメタデータ(endTime>durationSec)ではなく**最終フレームの
//    完了進捗**で判定する(長い timeline を短い窓で見せる意図的な演出と、
//    途中で壊れて止まる欠陥を区別できないため)。
// 2) 画面外判定・renderedVector・simultaneous-entry は zero-area(SVG defs/
//    gradient/filter 等の非表示ヘルパー要素)と full-bleed(背景)要素を対象
//    から除外する(=「実質的なコンテンツ要素」だけを見る)。
//
// commit 2(W2後半): still 抽出時刻の選択(selectStillTimes)+ VLM 応答の
// item→Finding マッパー(vlmItemsToFindings)も、node/ブラウザ非依存の純関数
// としてここに置く(fs アクセス・ffmpeg 起動・LLM 呼び出しは
// stages/hyperframeAudit.ts の責務)。

/** 1要素(#root 配下の id 持ち要素・.clip・data-start 持ち要素)のスナップショット。
 * rect は getBoundingClientRect() 由来(出力px、ビューポート座標系)。
 * text は textContent の正規化(typewriter 等の text 駆動演出を
 * renderedVector に反映させるため) */
export interface ElementState {
  key: string;
  visible: boolean;
  opacity: number;
  rect: { x: number; y: number; w: number; h: number };
  text: string;
}

/** 1つの Web Animation(document.getAnimations())のスナップショット。
 * iterations は Infinity をそのまま保持できる(seek 収集側で "inf" センチネルから復元) */
export interface WaapiState {
  key: string;
  currentTimeMs: number;
  endTimeMs: number;
  iterations: number;
}

/** 1つの GSAP timeline(window.__timelines)のスナップショット。
 * repeat/yoyo は「単一パスで完了すべきか」の判定(ループ/往復は対象外)に使う */
export interface TimelineState {
  key: string;
  progress: number;
  totalDurationSec: number;
  repeat: number;
  yoyo: boolean;
}

/** 1つの Lottie アニメーション(window.__hfLottie)のスナップショット */
export interface LottieState {
  key: string;
  currentFrame: number;
  totalFrames: number;
  frameRate: number;
}

/** 1時刻分の全ドライバ横断スナップショット */
export interface AuditSample {
  tMs: number;
  elements: ElementState[];
  waapi: WaapiState[];
  timelines: TimelineState[];
  lottie: LottieState[];
  clipVisibleKeys: string[];
}

/** カードが宣言しているアニメーションドライバの本数(検出対象の有無の判定に使う) */
export interface DriverCounts {
  waapi: number;
  gsap: number;
  lottie: number;
  clips: number;
}

export interface AuditInput {
  samples: AuditSample[];
  durationSec: number;
  fps: number;
  canvas: { width: number; height: number };
  drivers: DriverCounts;
  /** 致命的な読み込みエラー(window.__hyperframes.__failed の fatal 分)。
   * 非空なら auditFindings は無条件で [] を返す */
  failures: string[];
}

export interface AuditThresholds {
  /** 終端未完了(detectTerminalUnfinished)とみなす、最終フレームでの
   * 完了進捗(0..1)の下限。これ未満なら「壊れて途中で止まっている」。既定 0.4 */
  terminalProgressThreshold: number;
  /** 「可視」とみなす opacity の下限。既定 0.05 */
  offscreenOpacityGate: number;
  /** dead zone とみなす無変化区間の尺(durationSec に対する比率)。既定 0.5 */
  deadZoneMaxFrac: number;
  /** simultaneous-entry の対象とする最小要素数。既定 3 */
  entryMinElements: number;
  /** simultaneous-entry の「同時」とみなす許容フレーム数。既定 2 */
  entryEpsilonFrames: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  terminalProgressThreshold: 0.4,
  offscreenOpacityGate: 0.05,
  deadZoneMaxFrac: 0.5,
  entryMinElements: 3,
  entryEpsilonFrames: 2,
};

export interface Finding {
  kind: string;
  level: "warn" | "info";
  target?: string;
  atSec?: number;
  message: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round0(n: number): number {
  return Math.round(n);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 面積を持つ(SVG defs/gradient/filter 等の非表示ヘルパー要素ではない)か */
function isSubstantive(e: ElementState): boolean {
  return e.rect.w > 0 && e.rect.h > 0;
}

/** 出力キャンバスと交差するか(画面外かどうか) */
function onCanvas(e: ElementState, w: number, h: number): boolean {
  return !(e.rect.x + e.rect.w <= 0 || e.rect.x >= w || e.rect.y + e.rect.h <= 0 || e.rect.y >= h);
}

/** キャンバスをほぼ覆う背景要素か(画面外判定・登場検出の対象から除く) */
function isFullBleed(e: ElementState, w: number, h: number): boolean {
  return e.rect.w * e.rect.h >= 0.95 * w * h && e.rect.x <= 1 && e.rect.y <= 1;
}

/** 「実質的なコンテンツ要素」だけを取り出す: 面積を持ち、full-bleed 背景ではなく、
 * 可視かつ opacity がゲートを超えるもの */
function contentElements(s: AuditSample, w: number, h: number, gate: number): ElementState[] {
  return s.elements.filter((e) => isSubstantive(e) && !isFullBleed(e, w, h) && e.opacity > gate);
}

/** サンプル1件の「描画に効く」正規化ベクトル(seek しても動かない証拠に使う)。
 * WAAPI の raw currentTime は seek のたびに書き換わる入力そのものなので
 * 意図的に除外する(paused-timeline 未配線でも currentTime だけは動いて
 * しまい、seek 無反応を見逃すため)。zero-area 要素(SVG defs 等)は描画に
 * 効かないため対象外。text を含めることで textContent 駆動の演出
 * (typewriter 等)を「動いている」と正しく認識する。要素は key でソートして
 * 順序非依存にする */
export function renderedVector(sample: AuditSample): string {
  const elements = sample.elements
    .filter((e) => isSubstantive(e))
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((e) => ({
      key: e.key,
      visible: e.visible,
      opacity: round3(e.opacity),
      rect: { x: round0(e.rect.x), y: round0(e.rect.y), w: round0(e.rect.w), h: round0(e.rect.h) },
      t: e.text,
    }));
  const timelines = [...sample.timelines]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t) => ({ key: t.key, progress: round4(t.progress) }));
  const lottie = [...sample.lottie]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((l) => ({ key: l.key, currentFrame: l.currentFrame }));
  return JSON.stringify({ elements, timelines, lottie });
}

/** 単一パス(ループ・往復ではない)アニメーションのうち、composition の
 * 最終フレームで完了進捗が閾値未満のものを警告する(「壊れて途中で止まる」
 * 演出の失敗パターン)。ループ(WAAPI iterations!==1)・GSAP の repeat!==0 /
 * yoyo!==false は「1周で終わらなくてよい」設計として対象外。長い timeline を
 * 短い窓で意図的に見せる演出は、その窓の終わりまでに実際に高い進捗へ
 * 達していれば警告しない(進捗が正しい軸で、尺の絶対比較ではない) */
export function detectTerminalUnfinished(input: AuditInput, t: AuditThresholds): Finding[] {
  const last = input.samples[input.samples.length - 1];
  if (!last) return [];
  const out: Finding[] = [];
  const thr = t.terminalProgressThreshold;

  const push = (key: string, progress: number): void => {
    out.push({
      kind: "terminal-unfinished",
      level: "warn",
      target: key,
      atSec: last.tMs / 1000,
      message:
        `"${key}" is only ${Math.round(progress * 100)}% complete at the last frame ` +
        "(single-pass animation runs past the composition end)",
    });
  };

  for (const w of last.waapi) {
    if (w.iterations === 1 && w.endTimeMs > 0) {
      const progress = Math.min(1, w.currentTimeMs / w.endTimeMs);
      if (progress < thr) push(w.key, progress);
    }
  }

  for (const tl of last.timelines) {
    if (tl.repeat === 0 && !tl.yoyo && tl.totalDurationSec > 0) {
      const progress = Math.min(1, tl.progress);
      if (progress < thr) push(tl.key, progress);
    }
  }

  for (const l of last.lottie) {
    if (l.totalFrames > 0) {
      const progress = Math.min(1, l.currentFrame / l.totalFrames);
      if (progress < thr) push(l.key, progress);
    }
  }

  return out;
}

/** composition が「空のフレーム」で終わっていないかを情報として報告する。
 * かつて実質的なコンテンツが画面上にあった(everHad)のに、composition 終端
 * では実質的なコンテンツが1つも画面内に無いとき報告する(zero-area/
 * full-bleed 要素はそもそも対象外なので誤発火しない)。
 * level=info(warn ではない): 画面外終端は本質的に曖昧(意図的な
 * whip/pan 系 transition-out か、壊れた欠陥かを幾何学だけでは区別できない。
 * 較正実測(docs/hyperframes-skills/examples/*.html)で、正当な transition-out
 * カードがこの条件を満たすことを確認済み) */
export function detectEmptyTerminal(input: AuditInput, t: AuditThresholds): Finding[] {
  const { width, height } = input.canvas;
  const last = input.samples[input.samples.length - 1];
  if (!last) return [];
  const onScreen = contentElements(last, width, height, t.offscreenOpacityGate).filter((e) =>
    onCanvas(e, width, height),
  );
  const everHad = input.samples.some((s) =>
    contentElements(s, width, height, t.offscreenOpacityGate).some((e) => onCanvas(e, width, height)),
  );
  if (!(everHad && onScreen.length === 0)) return [];
  return [
    {
      kind: "empty-terminal",
      level: "info",
      atSec: last.tMs / 1000,
      message: "composition ends on an empty frame: all content elements are off-canvas or transparent at the last frame",
    },
  ];
}

/** composition 終端で画面外にある実質的なコンテンツ要素を情報として報告する
 * (pivot/whip 系の意図的な画面外への退場を「欠陥」として warn にはしない。
 * detectEmptyTerminal(warn)とは違い、他に画面内へ残る要素があってもよい
 * 個別要素単位の観測) */
export function detectElementOffscreen(input: AuditInput, t: AuditThresholds): Finding[] {
  const { width, height } = input.canvas;
  const last = input.samples[input.samples.length - 1];
  if (!last) return [];
  return contentElements(last, width, height, t.offscreenOpacityGate)
    .filter((e) => !onCanvas(e, width, height))
    .map((e) => ({
      kind: "element-offscreen-terminal",
      level: "info" as const,
      target: e.key,
      atSec: last.tMs / 1000,
      message: `content element "${e.key}" finishes fully off-canvas`,
    }));
}

/** 宣言されたドライバ(WAAPI/GSAP/Lottie)が1つ以上あるのに、seek で
 * どのサンプル間でも描画状態(renderedVector)が一切変わらないとき警告する
 * (paused-timeline の登録漏れ・配線ミスの兆候)。サンプルが1つ以下では
 * 判定できないので何も返さない */
export function detectSeekUnresponsive(input: AuditInput): Finding[] {
  const driverCount = input.drivers.waapi + input.drivers.gsap + input.drivers.lottie;
  if (driverCount <= 0) return [];
  if (input.samples.length < 2) return [];
  const first = renderedVector(input.samples[0]);
  const allSame = input.samples.every((s) => renderedVector(s) === first);
  if (!allSame) return [];
  return [
    {
      kind: "seek-unresponsive",
      level: "warn",
      message:
        "宣言されたアニメーション(WAAPI/GSAP/Lottie)が seek しても何も動きません" +
        "(paused timeline の登録漏れ・配線ミスの可能性があります)",
    },
  ];
}

/** 連続する同一 renderedVector の最長区間(隣接サンプル間の無変化)を探し、
 * composition 尺に対する比率が閾値を超えるとき情報として報告する
 * (完全な無反応=detectSeekUnresponsive とは別に、途中の停滞だけを拾う) */
export function detectDeadZone(input: AuditInput, t: AuditThresholds): Finding[] {
  if (input.samples.length < 2) return [];
  const vectors = input.samples.map((s) => renderedVector(s));

  let bestStart = 0;
  let bestEnd = 0;
  let runStart = 0;
  for (let i = 1; i <= vectors.length; i++) {
    const brokeRun = i === vectors.length || vectors[i] !== vectors[runStart];
    if (brokeRun) {
      const runEnd = i - 1;
      if (runEnd > runStart && runEnd - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = runEnd;
      }
      runStart = i;
    }
  }

  if (bestEnd <= bestStart) return [];
  const runSec = (input.samples[bestEnd].tMs - input.samples[bestStart].tMs) / 1000;
  if (runSec <= t.deadZoneMaxFrac * input.durationSec) return [];

  return [
    {
      kind: "dead-zone",
      level: "info",
      atSec: input.samples[bestStart].tMs / 1000,
      message:
        `${runSec.toFixed(2)}秒間、描画状態が変化していません` +
        `(composition 尺の${((runSec / input.durationSec) * 100).toFixed(0)}%)`,
    },
  ];
}

/** 各(実質的なコンテンツ)要素の初出(可視&opacity>gate になった最初の tMs)を
 * 求め、しきい値以上の要素数が composition 開始直後にまとめて登場するとき
 * 情報として報告する(一斉に出てくる=間延びしない代わりに個々の登場感が
 * 無いという審美的な観測。zero-area 要素は数えない) */
export function detectSimultaneousEntry(input: AuditInput, t: AuditThresholds): Finding[] {
  if (input.samples.length === 0) return [];
  const epsilonMs = (t.entryEpsilonFrames / input.fps) * 1000;

  const onsets = new Map<string, number>();
  for (const sample of input.samples) {
    for (const e of sample.elements) {
      if (!isSubstantive(e)) continue;
      if (!e.visible || e.opacity <= t.offscreenOpacityGate) continue;
      if (!onsets.has(e.key)) onsets.set(e.key, sample.tMs);
    }
  }

  const early = [...onsets.values()].filter((tMs) => tMs <= epsilonMs);
  if (early.length < t.entryMinElements) return [];

  const span = Math.max(...early) - Math.min(...early);
  if (span >= epsilonMs) return [];

  return [
    {
      kind: "simultaneous-entry",
      level: "info",
      atSec: 0,
      message:
        `${early.length}個の要素が composition 開始からほぼ同時(${epsilonMs.toFixed(0)}ms以内)に登場します` +
        "(個々の登場が感じられない可能性があります)",
    },
  ];
}

/** 6つの決定論検出をまとめて実行する。failures(致命的な読み込みエラー)が
 * 非空なら動的な観測自体が信頼できないため何も返さない(呼び出し側が
 * load-failed の info を別途 1件だけ積む) */
export function auditFindings(
  input: AuditInput,
  t: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
): Finding[] {
  if (input.failures.length > 0) return [];
  return [
    ...detectTerminalUnfinished(input, t),
    ...detectEmptyTerminal(input, t),
    ...detectElementOffscreen(input, t),
    ...detectSeekUnresponsive(input),
    ...detectDeadZone(input, t),
    ...detectSimultaneousEntry(input, t),
  ];
}

/* ------------------------------------------------------------------ */
/* still 抽出時刻の選択 + VLM item→Finding マッパー(ともに純関数)          */
/* ------------------------------------------------------------------ */

/** still 1枚分の抽出仕様。role は "head"/"mid"/"tail"/"finding-<i>" */
export interface StillSpec {
  role: string;
  tSec: number;
}

/** still 抽出の既定上限枚数(effect-check の MAX_VLM_STILLS(4)より少し広め。
 * head/mid/tail の3枚固定 + WARN finding 由来を数枚まで許す) */
export const DEFAULT_MAX_STILLS = 6;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** still 抽出時刻を選ぶ純関数: head(0) / mid(durationSec/2) / tail(最終
 * フレーム相当) の3点に、各 WARN finding の atSec(role: "finding-<i>"。
 * i は findingSecs 配列内の順序)を加える。同一秒(小数2桁で丸めて比較)は
 * 先着優先で dedup し、maxStills(既定 DEFAULT_MAX_STILLS)まで先頭から切る */
export function selectStillTimes(args: {
  durationSec: number;
  fps: number;
  findingSecs: number[];
  maxStills?: number;
}): StillSpec[] {
  const { durationSec, fps, findingSecs } = args;
  const maxStills = args.maxStills ?? DEFAULT_MAX_STILLS;

  const candidates: StillSpec[] = [
    { role: "head", tSec: 0 },
    { role: "mid", tSec: durationSec / 2 },
    { role: "tail", tSec: Math.max(0, durationSec - 1 / fps) },
  ];
  findingSecs.forEach((tSec, i) => candidates.push({ role: `finding-${i}`, tSec }));

  const seen = new Set<number>();
  const deduped: StillSpec[] = [];
  for (const c of candidates) {
    const key = round2(c.tSec);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped.slice(0, maxStills);
}

/** VLM 応答の生 item(index ベース。呼び出し側が JSON schema 検証済みのものを
 * 渡す)を表す */
export interface VlmReviewItem {
  index: number;
  ok: boolean;
  reason: string;
}

/** still 側の参照(role/tSec のみ。VlmReviewItem.index → stills[index] の
 * 対応付けに使う) */
export interface VlmStillRef {
  role: string;
  tSec: number;
}

/** VLM 応答 item[] を stills と突き合わせ、ok:false のものだけ
 * vlm-mismatch の warn Finding へ変換する純関数。index が stills の範囲外の
 * item(壊れた/幻覚の応答)は無害に無視する */
export function vlmItemsToFindings(items: VlmReviewItem[], stills: VlmStillRef[]): Finding[] {
  const out: Finding[] = [];
  for (const item of items) {
    if (item.ok) continue;
    const still = stills[item.index];
    if (!still) continue;
    out.push({
      kind: "vlm-mismatch",
      level: "warn",
      target: still.role,
      atSec: still.tSec,
      message: item.reason,
    });
  }
  return out;
}
