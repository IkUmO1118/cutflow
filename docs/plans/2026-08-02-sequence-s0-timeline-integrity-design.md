# S0: 時間軸の一貫性 — 挿入込みタイムラインの不整合と既存バグを潰す

親ドキュメント: `docs/programs/sequence-time-program.md`(シーケンス時間母艦)
状態: **IMPLEMENTED** / 2026-08-02

---

## 0. この段の性格

**機能を1つも足さない。** スキーマも変えない。`docs/usage.md` の仕様表も変わらない。
やるのは「同じプロジェクトに対して、コマンドごとに違う出力秒が計算されている」
状態と、挿入まわりの既存バグ2件を潰すこと。S1 以降はここが正しいことに依存する。

**着手順は T3 → T1 → T2 → T4 → T5 → T6。** T3 が最も実害が大きく、他と独立。

---

## T3【重大】挿入+カットでベース音声(セリフ)が壊れる

### 症状
カットを1つ以上含む cutplan に挿入クリップを1つ以上足して `render` すると、
挿入より後ろのベース区間のセリフが**間違った位置から再生される**か、
**丸ごと無音になる**。挿入が無ければ発生しない。ショート(`--short`)では発生しない。

### 原因(確定)

`src/lib/insertMix.ts:30-38` の型は、`videoStartFrame` を **cut.mp4 の格子**と
明記している:

```ts
/** ベース映像 1 区間の frame 表現。[fromFrame, toFrame) は出力フレーム、
 * videoStartFrame は cut.mp4 の CFR 格子上の開始フレーム。 */
export interface BaseFrameSeg {
  fromFrame: number;
  toFrame: number;
  videoStartFrame: number;
  playbackRate?: number;
}
```

ところが `src/stages/renderEngine.ts:135-150` は props を
`videoFile: manifest.source, videoIsSource: true` で作り直す。すると
`src/lib/renderProps.ts:509-513` により:

```ts
videoStart: videoIsSource
  ? e.sourceStart                              // ← 元収録の秒
  : (toOutputTime(e.sourceStart, keepsOnly) ?? 0),
```

`props.baseSegments[].videoStart` が**元収録の秒**になる。映像側はこれで正しい
(エンジンは `manifest.source` を直接読むため)。しかし音声側
`src/lib/insertMix.ts:166-178` は同じ値で **`cut.mp4` の PCM** を索引する:

```ts
for (const seg of layout.base) {
  const outFrom = frameSampleRange(seg.fromFrame, sr, fps).fromSample;
  const outTo   = frameSampleRange(seg.toFrame,   sr, fps).fromSample;
  const srcFrom = frameSampleRange(seg.videoStartFrame, sr, fps).fromSample;  // ★
  const len = Math.min(outTo - outFrom, cutSampleLen - srcFrom);              // ★
  for (let s = 0; s < len; s++) { ... }
}
```

`cut.mp4` は keep を連結した尺なので、カットがあると `srcFrom` が行き過ぎる。
`srcFrom > cutSampleLen` になった時点で `len` が負になり、その区間は1サンプルも
コピーされない = **無音**。

### なぜ今まで露見しなかったか
- 挿入なし経路(`mixFastAudio`)は `cut.mp4` の音声を丸ごとコピーするだけで
  区間索引をしない(`src/lib/bgmMix.ts:175-178`)
- ショート経路(`src/stages/render.ts:465`)は `videoIsSource` を渡さないため
  `videoStart` が既にカット後の秒
- `test/insertMix.test.ts:50,81` は `baseSegments: [{ start: 1, videoStart: 0, durationSec: 1 }]`
  の**単一区間・videoStart:0** しか使っておらず、この組み合わせを通らない

### 修正方針: `baseSegments` に音声専用の開始位置を持たせる

`videoStart` の意味(`videoIsSource` に依存)を変えずに、**常に cut.mp4 相対**の
`audioStart` を別に持たせる。`insertMix` はこちらだけを見る。

#### 変更1: `src/lib/renderPropsTypes.ts:313-318`

```ts
  baseSegments?: {
    start: number;
    videoStart: number;
    /** cut.mp4 の音声を索引する開始位置(**常にカット後の秒**)。
     * videoIsSource:true のとき videoStart は元収録の秒になるため、
     * 音声ベッド(insertMix)はこちらを使う。省略時は videoStart にフォールバック
     * (旧 render.props.json との互換) */
    audioStart?: number;
    durationSec: number;
    playbackRate?: number;
  }[];
```

#### 変更2: `src/lib/renderProps.ts:508-516`

```ts
  const keepsOnly = buildTimeline(keeps);
  const segments = timeline.map((e) => ({
    start: e.outputStart,
    videoStart: videoIsSource
      ? e.sourceStart
      : (toOutputTime(e.sourceStart, keepsOnly) ?? 0),
    audioStart: toOutputTime(e.sourceStart, keepsOnly) ?? 0,
    durationSec: round2(e.outputEnd - e.outputStart),
    ...(videoIsSource && e.speed !== 1 ? { playbackRate: e.speed } : {}),
  }));
```

`audioStart` は `videoIsSource` に**依らず**常に `toOutputTime(..., keepsOnly)`。
`keepsOnly` は挿入を含まない keep だけのタイムライン = cut.mp4 の時間軸そのもの。

#### 変更3: `src/lib/insertMix.ts:30-38, 71-79, 169`

```ts
export interface BaseFrameSeg {
  fromFrame: number;
  toFrame: number;
  /** cut.mp4 の CFR 格子上の開始フレーム(= 音声索引用) */
  videoStartFrame: number;
  playbackRate?: number;
}
```
(型コメントはそのままで正しい。`baseLayoutOf` の詰め方を変える)

`baseLayoutOf`(`insertMix.ts:71-79`):
```ts
  const base: BaseFrameSeg[] = baseSegsIn.map((seg, i) => {
    const fs = spans.base[i];
    const audioStart = seg.audioStart ?? seg.videoStart;   // ★ 旧 props 互換
    return {
      fromFrame: fs.from,
      toFrame: fs.from + fs.durationInFrames,
      videoStartFrame: Math.round(audioStart * fps),        // ★
      ...(seg.playbackRate !== undefined ? { playbackRate: seg.playbackRate } : {}),
    };
  });
```

`insertMix.ts:169` は無変更(`seg.videoStartFrame` が正しい値になる)。

### 副作用と受容

- `props.baseSegments[].audioStart` が増えるため **`render.props.json` の内容が変わる**。
  `render.key.json` のキャッシュキーもこれを含むので、既存収録は**1回だけフル
  再レンダーになる**。これは受容する(壊れた音声を再利用する方が悪い)。
  この事実をコミットメッセージに書くこと。
- `videoIsSource` が false の経路(ショート)では `audioStart === videoStart` なので
  出力は完全に不変。

### テスト(`test/insertMix.test.ts` に追加)

```ts
test("buildInsertBedPcm: カット+挿入でも cut.mp4 の音声をカット後の位置から取る", () => {
  // keeps [0,10] と [20,30] → cut.mp4 は 20秒。挿入は出力 10s に 2秒。
  // 出力: [0,10]=cut 0-10 / [10,12]=挿入 / [12,22]=cut 10-20
  // videoIsSource:true 相当で videoStart は元収録秒(0 と 20)、
  // audioStart はカット後秒(0 と 10)
});
```
アサーション: 第2ベース区間(出力 12–22 秒)のベッドに、`cutPcm` の
10 秒目以降の値が入っていること(先頭サンプルの値一致で確認)。
`audioStart` を与えない旧形 props でも例外を出さずに動くこと(互換テスト)。

`test/renderProps.test.ts` に追加:
```ts
test("buildRenderProps: audioStart は videoIsSource に依らず常にカット後の秒", () => {
  // keeps [0,10],[20,30] / videoIsSource:true
  // → baseSegments[1].videoStart === 20, baseSegments[1].audioStart === 10
});
```

---

## T4 挿入 + 可変速 keep で render が例外死する

### 症状
`cutplan` の keep に `speed !== 1` があり、かつ挿入が1件以上あると `render` が
例外で落ちる。エラーメッセージはユーザーに原因を示さない。

### 原因
`src/lib/insertMix.ts:58-62`:
```ts
  for (const seg of baseSegsIn) {
    if (seg.playbackRate !== undefined && seg.playbackRate !== 1) {
      return { ok: false, reason: "playbackRate" };
    }
  }
```
→ `mixInsertAudio` が throw(`insertMix.ts:252-257`)。コメントは
「`runFastRender` の try/catch がフルレンダーへ落とす」と書くが、
`runFastRender`/`fastPlan` は**ツリーに存在しない**(`src/lib/colorFilter.ts:30` と
`src/lib/overlayFade.ts:37-50` に古いコメントが残るのみ)。
`src/stages/renderEngine.ts:85-89` に try/catch は無い。
到達条件: `videoIsSource:true` こそが `playbackRate` を props に出す条件
(`renderProps.ts:515`)なので、本編 render は常に到達可能。

### 修正方針: 可変速音声のリサンプルは**実装しない**。前段で止める。

音声の可変速(タイムストレッチ)は品質・決定性の両面で本段の射程外。
代わりに **`validate` で事前にエラーにする**。render まで行かせない。

#### 変更1: `src/stages/validate.ts` — cutplan 検査の末尾に追加

`overlays.inserts` が1件以上あり、かつ `playbackSegmentsOf(cutplan)` に
`speed !== DEFAULT_PLAYBACK_SPEED` の区間があるとき:

```
err("overlays.json", "inserts",
  "挿入クリップと可変速 keep は併用できません(音声ベッドを組み立てられません)。" +
  "挿入を消すか、keep の speed を 1 に戻してください");
```

置き場所: `overlays.json` の `inserts` ループ(`validate.ts:541-557`)の直後。
`playbackKeeps` は同ファイル内で既に構築済み(`validate.ts:350` 付近)。

#### 変更2: `src/lib/insertMix.ts:252-257` の throw メッセージを実態に合わせる

コメントから `runFastRender` への言及を削り、
「`validate` が事前に弾く前提のバックストップ」と書き換える。
throw 自体は残す(防御的)。

### テスト(`test/validate.test.ts`)
```ts
test("validate: 挿入 + 可変速 keep はエラー", () => { ... });
test("validate: 挿入があっても speed が全て 1 ならエラーにならない", () => { ... });
test("validate: 可変速 keep があっても挿入が0件ならエラーにならない", () => { ... });
```

---

## T1 `validate` の時刻写像が挿入を無視している

### 症状
`validate` の「カット内で表示されない」警告と「フェードが長すぎる」警告が、
挿入のあるプロジェクトで `render` と違う計算をする。

### 原因
`src/stages/validate.ts:349-360`:
```ts
  const timeline: TimelineEntry[] | null =
    errors.length === 0 && playbackKeeps.length > 0 ? buildTimeline(playbackKeeps) : null;
```
`buildTimeline(playbackKeeps)` は**第2引数(inserts)を渡していない**。
一方 `src/lib/renderProps.ts:197` は `buildTimelineModel(keeps, activeInserts)`。

### 修正方針

`overlays.inserts` を読み、`buildTimeline(playbackKeeps, inserts)` にする。
あわせて**出力尺 `outputDurationSec` を計算して検査スコープ内で使えるようにする**
(S1/S2 がこれに依存する)。

#### 変更: `src/stages/validate.ts:349-360`

```ts
  // テロップ・演出の「カット内で表示されない」警告に使う時刻写像。
  // 挿入(overlays.inserts)は出力タイムラインを伸ばすので renderProps と同じく
  // 挿入込みで組む(S0-T1。挿入なしなら従来と同一の結果になる)
  const insertSpans = isObj(overlays) && Array.isArray((overlays as Overlays).inserts)
    ? (overlays as Overlays).inserts!
        .filter((o) => isObj(o) && isNum(o.at) && isNum(o.durationSec) && o.durationSec > 0)
        .map((o) => ({ at: o.at, durationSec: o.durationSec }))
    : [];
  const built = errors.length === 0 && playbackKeeps.length > 0
    ? buildTimelineModel(playbackKeeps, insertSpans)
    : null;
  const timeline: TimelineEntry[] | null = built ? built.entries : null;
  /** 出力(カット後・挿入込み)の総尺。S1/S2 の検証がこれを使う */
  const outputDurationSec: number | null = built ? built.durationSec : null;
```

`visible` / `visibleSec`(`validate.ts:352-360`)は無変更でよい
(`timeline` の中身が正しくなるだけ)。

**重要**: `insertSpans` は `errors.length === 0` の判定より前に組んでよいが、
`inserts` の形式検査(`validate.ts:541-557`)より前に走るため、**壊れた要素は
上のフィルタで落とす**。壊れた `inserts` があっても `validate` 自体は落ちない。

`outputDurationSec` はこの段では**まだ誰も使わない**(S1-A2 / S2-B3 が使う)。
未使用変数の lint を避けるため、この段では export せず、S1 で使い始めるまでは
`void outputDurationSec;` ではなく **T1 の時点で S2-B3 の軽い利用を先に入れる**か、
または S1 と同一コミットにする。**推奨: S1 と同じ PR に含める**。

### 副作用
挿入のあるプロジェクトで警告の出方が変わる(= 正しくなる)。
挿入が無いプロジェクトでは `buildTimelineModel(keeps, [])` は
`buildTimeline(keeps)` と同一結果なので**バイト等価**。

### テスト(`test/validate.test.ts`)
```ts
test("validate: 挿入をまたぐ overlay の visibleSec が挿入込みで計算される", () => { ... });
test("validate: 挿入が0件なら警告の出方は従来と同一", () => { ... });
```

---

## T2 `av --range` が挿入を無視している

### 症状
`av <dir> --range 10-25` の「出力秒」と、`frames <dir> --out --t 10` の「出力秒」が
挿入のあるプロジェクトで別の場所を指す。

### 原因
`src/stages/av.ts:128-131`:
```ts
  const timeline = buildTimeline(keeps);
  const totalDurationSec = round2(keeps.reduce((sum, keep) => sum + (keep.end - keep.start), 0));
  const range = normalizeRange(opts.range, totalDurationSec);
  const rangedKeeps = sliceKeepsByOutputRange(timeline, range);
```
挿入を渡していない。`totalDurationSec` も keep の総和で、挿入尺を含まない。

### 修正方針

`av` は**ベース映像と mic/system 音声を対象にする知覚コマンド**であり、
挿入クリップの中身(素材の映像・音声)は対象外。したがって
「挿入区間を対象から外す」のは正しい。**間違っているのは軸の解釈**だけ。

修正: タイムラインを挿入込みで組み、`--range` を挿入込みの出力秒として解釈し、
その範囲に**交差する keep 部分だけ**を対象にする。挿入区間は結果に現れない。

```ts
  // --range は出力(カット後・挿入込み)の秒。挿入区間そのものは av の対象外
  // (ベース映像・mic/system 音声を見るコマンドのため)だが、軸は
  // frames --out / render と一致していなければならない(S0-T2)
  const built = buildTimelineModel(keeps, insertSpansOf(overlays));
  const timeline = built.entries;
  const totalDurationSec = built.durationSec;
  const range = normalizeRange(opts.range, totalDurationSec);
  const rangedKeeps = sliceKeepsByOutputRange(timeline, range);
```

`sliceKeepsByOutputRange`(`av.ts:524-540`)は無変更でよい
(`entry.outputStart` が挿入込みになるだけ)。

`insertSpansOf(overlays)` は T1 と同じロジックなので、
**`src/lib/timeline.ts` に共通ヘルパを置いて両方から使う**:

```ts
/** overlays.inserts を buildTimelineModel が食える形へ正規化する。
 * 壊れた要素(at/durationSec が数値でない・durationSec<=0)は落とす。
 * validate(S0-T1)と av(S0-T2)と renderProps が同じ集合を見るための単一の出所 */
export function insertSpansOf(
  inserts: { at?: unknown; durationSec?: unknown }[] | undefined,
): InsertSpan[] {
  if (!Array.isArray(inserts)) return [];
  return inserts.flatMap((o) =>
    o && typeof o.at === "number" && Number.isFinite(o.at) &&
    typeof o.durationSec === "number" && Number.isFinite(o.durationSec) && o.durationSec > 0
      ? [{ at: o.at, durationSec: o.durationSec }]
      : [],
  );
}
```

**注意**: `renderProps.ts:192-197` は「素材ファイルが存在しない挿入を落とす」
追加のフィルタを持つ(`overlayExists`)。`validate`/`av` はファイル存在を
別途チェックするので、ここでは**存在チェックをしない**。この差は意図的で、
`insertSpansOf` の doc コメントに明記すること。

### 副作用: `av.probe/` のキャッシュキー

`av.probe/` は差分更新型キャッシュで、keep 集合・range・設定が同じなら再利用する。
挿入込みに変わると同じ `--range` が別の keep 集合を指すため、
**キャッシュキーに `insertSpans` を含める**か、**キー形式のバージョンを上げる**。
推奨: キー生成関数に `insertsFingerprint`(`JSON.stringify(insertSpansOf(...))` の
sha256 先頭8桁)を足す。キーが変われば自動的に再計算されるので明示的な
キャッシュ破棄処理は不要。

### テスト(`test/av*.test.ts` または新規 `test/avRange.test.ts`)
```ts
test("sliceKeepsByOutputRange: 挿入込みの出力秒で keep を切り出す", () => { ... });
test("insertSpansOf: 壊れた要素を落とす / 存在しないファイルは落とさない", () => { ... });
```

---

## T5 挿入の `at` 同値時の順序が sort の安定性に暗黙依存

### 原因
`src/lib/timeline.ts:89-91`:
```ts
  const pending = inserts
    .map((ins, index) => ({ ...ins, index }))
    .sort((a, b) => a.at - b.at);
```
`at` が同値のとき順序は `Array.prototype.sort` の安定性任せ。V8 では安定だが、
**仕様として書かれていない**。intro を2本並べる/ending を2本並べる(どちらも
`at: manifest.durationSec`)は S2 で普通の使い方になる。

### 修正
```ts
  const pending = inserts
    .map((ins, index) => ({ ...ins, index }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index));
```
あわせて `src/types.ts` の `inserts[]` の doc コメントに1行追加:
「`at` が同じ挿入が複数あるときは **`overlays.json` に書いた順**に並ぶ」。
`docs/usage.md` の該当行にも同じ1行を足す(5点セットのうち types/usage の2点。
スキーマは変わらないので `schemas/` は無変更)。

### テスト(`test/timeline.test.ts`)
```ts
test("buildTimelineModel: at が同値の挿入は宣言順に並ぶ", () => {
  const built = buildTimelineModel([{ start: 0, end: 10 }], [
    { at: 5, durationSec: 1 },   // index 0
    { at: 5, durationSec: 2 },   // index 1
  ]);
  assert.deepEqual(built.inserts.map((s) => s.index), [0, 1]);
  assert.equal(built.inserts[0].start, 5);
  assert.equal(built.inserts[1].start, 6);
});
```

---

## T6 `thumbnail.t` が恒等写像に暗黙依存している

### 事実
`src/stages/thumbnail.ts:39` は keep を全編にする:
```ts
const keeps = [{ start: 0, end: manifest.durationSec }];
```
`videoIsSource: true`(`thumbnail.ts:60`)。この2つにより
`buildTimelineModel` の出力は `outputStart === sourceStart` の単一 entry になる。
そのうえで `thumbnail.ts:80` は
```ts
const pngBase64 = await session.renderAndCapture(thumb.t);
```
`renderAndCapture(tOut)` は引数を**出力秒**として解釈する
(`src/lib/engineSession.ts:82,131-134`)。**両者が偶然一致している**。

`thumbnail.json` の `t` は仕様上「元収録の秒」(`src/types.ts:958-960`、
`validate.ts:1149-1154` は「frames と違いスナップしないので収録尺内であればよい」)。

### 危険性
S3(映像なしプロジェクト)では keep が全編にならない可能性があり、
また将来 `thumbnail` に overlays の挿入を反映させると恒等性が崩れる。
**崩れても静かに間違った時刻のフレームを出すだけ**で、誰も気づかない。

### 修正方針: 恒等性を**明示的な不変条件**にする

`thumbnail.ts` の keeps 構築の直後に、意図をコードで固定する:

```ts
  // thumbnail.t は「元収録の秒」(types.ts:958)だが renderAndCapture は
  // 出力秒を取る。ここで keeps を全編にすることで写像を恒等にし、両者を
  // 一致させている(S0-T6)。この前提が崩れると静かに別の時刻を撮るため、
  // 恒等であることを実行時に確認する
  const keeps = [{ start: 0, end: manifest.durationSec }];
  const tl = buildTimeline(keeps);
  const mapped = toOutputTime(thumb.t, tl);
  if (mapped === null || Math.abs(mapped - thumb.t) > 0.01) {
    throw new Error(
      `thumbnail: 時刻写像が恒等ではありません(t=${thumb.t} → ${mapped})。` +
        `thumbnail.ts の keeps 構築を見直してください`,
    );
  }
```

**注記のみで実装は変えない。** 将来 S3 でここを触るときの安全網。

### テスト(`test/thumbnail*.test.ts` があれば追加、無ければ本段では省略可)
純関数化されていないため、本段ではガードの追加のみ。

---

## 検証

```sh
npx tsc --noEmit
npm test
npm run gate:pixel      # 描画は触らないので変化なしを確認する用途
```

### 実収録での確認(T3)
1. カットを1つ以上含む収録に、`overlays.json` の `inserts` を1件足す
2. `node src/cli.ts render <dir>`
3. `node src/cli.ts av <dir> --sound-only` で挿入**より後ろ**のベース区間の
   RMS を見る。修正前はゼロ近辺、修正後は通常値になる

### バイト等価の回帰(全段共通の不変条件 §8-1)
挿入を1件も持たない既存収録で:
- `describe --json` の出力が変わらない
- `validate` の警告一覧が変わらない
- `av` の `av.probe/*.json` が(キー変更による再計算後に)同じ内容になる
- `render.props.json` は `audioStart` の分だけ変わる(T3 の受容済み副作用)

---

## この段が S1 以降へ渡すもの

| 渡すもの | 使う段 |
|---|---|
| `insertSpansOf()`(`src/lib/timeline.ts`) | S1-A3, S2-B3, S3 |
| `validate` 内の `outputDurationSec` | S1-A2(output timebase の範囲検査)、S2-B3 |
| 挿入込みで一致した出力秒軸 | S1〜S4 全部 |
| `baseSegments[].audioStart` | S3(音声のみ経路で cut.m4a を索引する) |
