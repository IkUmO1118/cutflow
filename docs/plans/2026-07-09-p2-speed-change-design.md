# P2 速度変更 実装設計書

*2026-07-09 / 実装担当: gpt-5.4 想定*

対象:

- `docs/reviews/2026-07-06-ai-native-nle-diagnosis-2026-07-08-update.html`
  の P2「速度変更」
- 同レビューの「速度変更とキーフレームは独立した重い設計課題」という診断

この文書は、実装者が新しい仕様判断をせずに実装できることを優先する。型、時間写像、
音声処理、Editor、承認、cache、実装順、テスト条件を正本として固定する。

関連設計:

- `docs/plans/2026-07-09-p2-keyframe-foundation-design.md`

キーフレーム設計より先に速度変更を実装してもよい。ただし両方を同じ PR に入れない。
速度変更は timeline の傾きを変え、キーフレームはその timeline を利用する側だからである。

---

## 0. 結論

v1 では `cutplan.json` の keep segment に optional な `speed` を追加する。

```json
{
  "id": "seg_a1b2c3",
  "start": 12,
  "end": 18,
  "action": "keep",
  "reason": "操作手順をテンポアップ",
  "speed": 2
}
```

- `speed` は再生倍率。`2` は2倍速、`0.5` は半速。
- 許可範囲は `0.25 <= speed <= 4`。
- 省略時は `1`。`speed: 1` も許可する。
- 1つの segment 内は定速。
- 音声は速度に追従し、音程を維持する。
- 速度変更区間はベース映像、マイク、システム音声を同じ倍率で処理する。
- caption、overlay、blur、annotation、BGM等の raw time anchor は同じ非線形 timeline へ
  写像される。
- insert は独立クリップなので常に1倍速。
- shorts は v1 では速度変更非対応。

最終 render / preview は ffmpeg で速度を焼き込む。Editor は全尺 `proxy.mp4` を
Remotion `<OffthreadVideo playbackRate={speed}>` で区間再生する。

---

## 1. 目的

### 1.1 ユーザー価値

- 操作待ちや単調な手順を速めてテンポを上げられる。
- 重要な操作をスローにして見せられる。
- 映像と声を同期したまま速度変更できる。
- 速度変更後も字幕、素材、ぼかし、注釈が元収録の内容に追従する。
- GUI で clip ごとに倍率を設定し、保存前に実時間でプレビューできる。

### 1.2 技術的な目的

- raw time から output time への写像を区分線形として一元化する。
- ffmpeg、Remotion、Editor、describe、frames、review が同じ速度 segment を使う。
- 速度変更を cut の一属性として承認 hash と cache に含める。
- speed 未指定のプロジェクトを従来と同じ出力にする。

### 1.3 成功条件

- 2倍速の10秒区間が出力5秒、0.5倍速の10秒区間が出力20秒になる。
- 映像と音声の長さが一致し、音程が維持される。
- caption / word timing / overlay等が正しい output time に現れる。
- Editor Player と preview / final render の境界・尺が一致する。
- speed 変更で既存 approval が失効する。
- speed 未指定時の `cut.mp4`、props、duration、hashが導入前と同じになる。

---

## 2. 非対象

v1 では次を実装しない。

- 速度ランプ、連続的に変化する speed keyframe
- 逆再生
- `speed: 0`、フリーズフレーム
- フレーム補間、オプティカルフロー、スローモーション補間
- 音程も速度に合わせて変えるモード
- 音声をミュートして映像だけ速度変更するモード
- J / L cut のような映像と音声の別速度・別境界
- insert 素材の速度変更
- material overlay 動画自体の速度変更
- BGM の速度変更
- shorts の速度変更
- speed を持つ segment の自動生成
- AI による倍率の自動決定
- source segment の並べ替え

速度ランプはキーフレーム基盤があっても v1 に追加しない。非線形積分、音声分割、
Editor seek の複雑さが定速 segment と大きく異なるため、別設計とする。

---

## 3. 最優先の不変条件

### 3.1 後方互換

- `speed` 省略は厳密に `1`。
- `speed` が全 segment で省略または1なら、ffmpeg filter graph は従来と同じ文字列にする。
- speed 1 に不要な `setpts=PTS/1` / `atempo=1` を追加しない。
- speed 無しの `TimelineEntry` の output time は従来と一致する。
- GUI save は `speed: 1` を自動追加しない。入力に明示されていた `speed: 1` は保持してよい。
- generated props に `playbackRate: 1` を無条件追加しない。

### 3.2 A/V同期

- 1 segment の映像とマイク音声は必ず同じ speed。
- システム音声を mix する場合も同じ speed。
- 音声を先に mix してから1回だけ `atempo` する。
- video/audio concat の各入力は同じ意図上の duration を持つ。
- 最終 duration は映像基準ではなく共通 timeline から算出する。

### 3.3 時刻の正本

- editable JSON の全時刻は引き続き元収録秒。
- `speed` は raw 区間の時間密度だけを変える。
- output duration は `(rawEnd - rawStart) / speed`。
- insert の duration は speed の影響を受けず、そのまま加算する。
- Remotion props の時刻はすべて速度適用後の output 秒。

### 3.4 承認

速度は視聴内容と尺を変えるため、cut approval の対象に含める。

- speed 変更後に以前の approval record で render してはいけない。
- `cutplan.approved` boolean は従来どおりゲートではない。
- `approvals.json` を直接変更しない。

### 3.5 Node制約

Node 23 type stripping 制約を守る。TypeScript enum、namespace、parameter property を使わない。

---

## 4. データモデル

### 4.1 `PlanSegment.speed`

`src/types.ts`:

```ts
export const MIN_PLAYBACK_SPEED = 0.25;
export const MAX_PLAYBACK_SPEED = 4;
export const DEFAULT_PLAYBACK_SPEED = 1;

export interface PlanSegment {
  id?: string;
  start: number;
  end: number;
  action: "keep" | "cut";
  reason: string;
  /** keep 区間の再生倍率。省略時1。cut segment には指定不可 */
  speed?: number;
}
```

### 4.2 なぜ `cutplan.json` か

速度は `overlays.json` の視覚演出ではなく、ベース A/V clip の時間構造を変える。

- keep segment と同じ start/end を持つ。
- cut と速度の境界を同じ clip UI で編集する。
- `cut.mp4` の生成入力になる。
- approval の対象になる。
- output timeline の基礎になる。

独立 `speedChanges[]` にすると、keep境界との交差分割、重なり優先順位、approval hash の
別管理が必要になるため採用しない。

### 4.3 cut segment

`action: "cut"` に `speed` を書くことは禁止し、validate error とする。出力に存在しない
区間へ speed を設定しても意味がなく、後で keep に戻したときの隠れた設定になるため。

### 4.4 segment分割

1つの keep 内で途中から速度を変える場合、keep segment を分割する。

```json
[
  {
    "id": "seg_aaaaaa",
    "start": 10,
    "end": 15,
    "action": "keep",
    "reason": "通常",
    "speed": 1
  },
  {
    "id": "seg_bbbbbb",
    "start": 15,
    "end": 25,
    "action": "keep",
    "reason": "操作待ち",
    "speed": 2
  }
]
```

GUI split 時は左 segment が元 ID を保持し、右 segment は新 ID を採番する既存規則へ合わせる。
speed は左右へコピーする。

---

## 5. 正規化された再生segment

### 5.1 共通型

`src/lib/timeline.ts` または新規 `src/lib/playback.ts` に置く。本書では
`src/lib/timeline.ts` に置く。

```ts
export interface PlaybackSegment {
  start: number; // raw seconds
  end: number;   // raw seconds
  speed: number;
}
```

### 5.2 builder

```ts
export function playbackSegmentsOf(cutplan: CutPlan): PlaybackSegment[];
```

規則:

1. `action === "keep"` だけを取る。
2. `speed ?? 1` を具体値にする。
3. start 昇順にする。元配列を mutate しない。
4. `start/end` が同じ隣接 segment は、speed が同じ場合だけ結合する。
5. speed が異なる隣接 segment は絶対に結合しない。
6. overlap は validate 済み前提だが、関数は overlap を勝手に解決しない。

### 5.3 `mergeIntervals` との関係

速度対応経路で `mergeIntervals(keepSegments)` を使ってはいけない。speed 境界が消えるためである。

残す用途:

- shorts ranges。v1 は速度非対応。
- speed を無視した純粋な集合比較が必要な既存処理。

置き換える用途:

- main render
- preview
- render snapshot
- describe main timeline
- frames
- review
- assert
- av
- Editor main timeline
- cut cache key
- approval hash

---

## 6. 区分線形 timeline

### 6.1 `TimelineEntry` の置換

現在の `offset` は傾き1の写像しか表せない。speed 対応後に残すと誤用が起きるため、
互換 field として温存しない。

```ts
export interface TimelineEntry {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  speed: number;
}
```

既存 `start` / `end` / `offset` は削除し、全コンパイルエラーを修正する。`offset` を optional に
して通す実装は禁止する。弱いモデルが古い式 `t + offset` を使い続ける事故を防ぐためである。

### 6.2 `buildTimeline`

```ts
export function buildTimeline(
  segments: PlaybackSegment[],
  inserts: InsertSpan[] = [],
): TimelineEntry[];
```

segment `[s,e)`、speed `r`、現在 output cursor `o` の entry:

```ts
{
  sourceStart: s,
  sourceEnd: e,
  outputStart: o,
  outputEnd: o + (e - s) / r,
  speed: r
}
```

output値は既存どおり小数第2位へ丸める。ただし cursor の内部加算は丸め前の double で行い、
entryへ格納するときだけ丸める。segmentごとに丸めた値を次の cursor へ再利用すると、
長尺・多数segmentで誤差が累積するため禁止する。

### 6.3 insert

insert は raw anchor `at` の手前へ置く。

- segment途中の insert は raw `at` で entry を分割する。
- 前半と後半は同じ speed。
- insert span は output cursor に `durationSec` をそのまま足す。
- insert 自体は `TimelineEntry` に含めず、既存 `insertSpans` の返り値で管理する。

### 6.4 source -> output

```ts
export function sourceToOutputTime(
  sourceTime: number,
  timeline: TimelineEntry[],
): number | null {
  const e = containingSourceEntry(sourceTime);
  if (!e) return null;
  return round2(
    e.outputStart + (sourceTime - e.sourceStart) / e.speed,
  );
}
```

既存 API 名 `toOutputTime` は保ってもよい。内部式と型は上記へ置換する。

### 6.5 output -> source

```ts
export function outputToSourceTime(
  outputTime: number,
  timeline: TimelineEntry[],
): number | null {
  const e = containingOutputEntry(outputTime);
  if (!e) return null; // insert上
  return round2(
    e.sourceStart + (outputTime - e.outputStart) * e.speed,
  );
}
```

既存 API 名 `toSourceTime` は保ってよい。

### 6.6 区間写像

`remapInterval(start,end,timeline)` は各 entry との raw 交差 `[s,e)` を次へ変換する。

```ts
outStart = entry.outputStart + (s - entry.sourceStart) / entry.speed;
outEnd = entry.outputStart + (e - entry.sourceStart) / entry.speed;
```

従来どおり:

- 完全 cut は `[]`。
- insertで出力時間が離れる場合は別区間。
- カット後に隣接する区間は、速度が同じでも異なっていても output 上で連続なら結合してよい。
  表示spanとしては穴が無いためである。

ただしキーフレーム設計の `remapIntervalPieces` は entry単位を維持し、結合しない。

### 6.7 `RemappedPiece`

キーフレーム設計を先に実装済みなら、次へ拡張する。

```ts
export interface RemappedPiece {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  speed: number;
}
```

sourceとoutputの長さが同じという旧前提を削除する。

### 6.8 snap

`snapToOutput`:

- keep内なら通常変換。
- cut内なら直後 entry の `outputStart`。
- 後続entryがなければ null。

### 6.9 duration helper

呼び出し側で `last.end + last.offset` を書かせない。

```ts
export function timelineDuration(timeline: TimelineEntry[]): number {
  return timeline.length === 0
    ? 0
    : timeline[timeline.length - 1].outputEnd;
}
```

insertが末尾にある場合も含める必要があるため、実際には builder が
`durationSec` を返す形を採用してよい。

推奨:

```ts
export interface BuiltTimeline {
  entries: TimelineEntry[];
  inserts: { start: number; end: number; index: number }[];
  durationSec: number;
}

export function buildTimelineModel(
  segments: PlaybackSegment[],
  inserts?: InsertSpan[],
): BuiltTimeline;
```

既存 `buildTimeline` / `insertSpans` はこの model の薄い wrapper にする。同じ walk を2回せず、
durationの末尾insert取りこぼしを防ぐ。

---

## 7. ffmpeg A/V処理

### 7.1 video filter

segment `i`:

```text
speed == 1:
[0:v]trim=start=S:end=E,setpts=PTS-STARTPTS[vI]

speed != 1:
[0:v]trim=start=S:end=E,setpts=(PTS-STARTPTS)/R[vI]
```

`setpts=PTS/R` ではなく `(PTS-STARTPTS)/R` とする。trim後の開始PTSを必ず0へ揃える。

### 7.2 audio filter

音声は `atempo` を使い、音程を維持する。

```text
speed == 1:
... atrim, asetpts ...

speed != 1:
... atrim, asetpts, [denoise/mix], atempo=R ...
```

システム音声有り:

1. mic trim
2. mic denoise
3. system trim
4. system volume
5. amix
6. atempo

micとsystemへ別々にatempoを掛けてからmixしない。丸めやfilter latency差で同期を崩す可能性を
減らし、filter graphを単純にするためである。

### 7.3 `atempo` chain

v1範囲は0.25〜4。環境差を避け、1つの `atempo` に0.5未満や2超を渡さない。

```ts
export function atempoFilters(speed: number): number[] {
  if (speed === 1) return [];
  const out: number[] = [];
  let remaining = speed;
  while (remaining < 0.5) {
    out.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2) {
    out.push(2);
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-9) out.push(remaining);
  return out;
}
```

期待:

- 0.25 -> `[0.5, 0.5]`
- 0.5 -> `[0.5]`
- 1 -> `[]`
- 2 -> `[2]`
- 4 -> `[2, 2]`
- 3 -> `[2, 1.5]`

filter string は `atempo=2,atempo=1.5`。

### 7.4 `keepAudioParts` の変更

引数を `Interval[]` から `PlaybackSegment[]` へ変える。

```ts
export function keepAudioParts(
  source: AudioSource,
  segments: PlaybackSegment[],
): string[];
```

speed 1 の unit test の期待文字列を変えない。

### 7.5 loudness測定

`measuredLoudnormFilter` も同じ `PlaybackSegment[]` を受け取る。1pass目の測定対象へ
atempo適用後の音声を渡す。

理由:

- speed変更で発話密度とピーク配置が変わる。
- 実測対象と最終 `cut.mp4` の音声を一致させる既存不変条件を維持する。

### 7.6 concat

全segmentのretime後に現在と同じ `concat=n=N:v=1:a=1` を使う。

ffmpegの映像・音声filter結果に僅かなduration差が出る可能性がある。次を守る。

- 各segmentで video/audioを同じ倍率にする。
- 全体に `-shortest` を追加して誤魔化さない。
- integration testで期待durationとの差を1 frame以下、A/V duration差を20ms以下に固定する。
- 超える場合は実装を直し、silence padやtrimで隠さない。

### 7.7 frame rate

output fpsは元fpsを維持する。

- 2倍速はsource frameを間引く。
- 0.5倍速はframeを複製する。
- motion interpolationはしない。
- `fps` filterを追加しない。encoderの既存挙動を維持する。

### 7.8 hardware

`cutFullRes` の video encoderは既存設定を変えない。速度変更のために
hardware acceleration方針を同時変更しない。

---

## 8. preview / proxy / final render

### 8.1 `preview`

`src/stages/preview.ts`:

- `playbackSegmentsOf(cutplan)` を使う。
- video filterへ `setpts / speed`。
- `keepAudioParts` と loudness測定へ同じsegments。
- scaleはconcat後で維持。
- `preview.keeps.json` の内容を速度込みにする。

推奨生成key:

```json
[
  { "start": 10, "end": 15, "speed": 1 },
  { "start": 15, "end": 25, "speed": 2 }
]
```

ファイル名は既存互換のため変更しない。

### 8.2 `proxy`

`proxy.mp4` は全尺1倍の軽量source proxyのまま変更しない。

- speedを焼き込まない。
- proxy cache keyにcutplan/speedを含めない。
- 速度変更のたびにproxyを再生成しない。
- Editor側の `playbackRate` で即時反映する。

### 8.3 `cut.mp4`

`cutFullRes` がspeedを焼き込む。`cut.mp4` はcut + speed + base audio mix +
loudness normalize済みの連続mediaとなる。

### 8.4 final Remotion

final renderでは `cut.mp4` が既にretime済みなので、ベース映像へ再度 `playbackRate` を
掛けない。`playbackRate` は `videoIsSource: true` のEditor proxy経路だけ。

---

## 9. RenderProps

### 9.1 base segment

匿名型を明示interfaceへ切り出す。

```ts
export interface BaseSegment {
  start: number;       // output seconds
  videoStart: number;  // videoFile内seconds
  durationSec: number; // output duration
  /** source proxyを直接再生するEditor経路だけ。1は省略 */
  playbackRate?: number;
}
```

### 9.2 final render経路

`videoIsSource !== true`:

- `videoFile` はspeed焼き込み済み `cut.mp4`。
- `videoStart` はinsertを除いたretimed base timelineの秒。
- `durationSec` はoutput duration。
- `playbackRate` は載せない。

### 9.3 Editor proxy経路

`videoIsSource === true`:

- `videoFile` はraw全尺相当の `proxy.mp4`。
- `videoStart` はraw source start。
- `durationSec = rawDuration / speed`。
- speedが1でなければ `playbackRate: speed`。

### 9.4 insertによる分割

speed 2のraw `[10,20)` にraw `at=14` のinsertがある場合:

- 前半 source `[10,14)` -> output duration 2秒
- insert -> durationそのまま
- 後半 source `[14,20)` -> output duration 3秒

Editor:

```json
[
  { "start": 0, "videoStart": 10, "durationSec": 2, "playbackRate": 2 },
  { "start": 2 + INSERT, "videoStart": 14, "durationSec": 3, "playbackRate": 2 }
]
```

final:

- `videoStart` はretimed `cut.mp4` 内の0秒、2秒。
- playbackRate無し。

### 9.5 `CroppedVideo`

追加:

```ts
playbackRate?: number;
```

`OffthreadVideo`へ条件付きで渡す。

```tsx
<OffthreadVideo
  ...
  {...(playbackRate !== undefined ? { playbackRate } : {})}
  preservePitch
/>
```

screenとcamera、blur再描画は同じ `renderBase` / `BaseSegment` を共有するため、
すべて同じsource frameになる。

`preservePitch` はEditor previewの音声に明示する。最終renderはffmpeg `atempo` 済み。

### 9.6 continuous fast path

現在の `continuous` 判定へ speed条件を追加する。

```ts
const continuous =
  baseSegs.length === 1 &&
  baseSegs[0].start === 0 &&
  baseSegs[0].videoStart === 0 &&
  baseSegs[0].playbackRate === undefined;
```

Editorで全尺1segment・speed 2の場合にcontinuous pathへ入り、playbackRateを落としてはならない。

### 9.7 frame span

`frameSpans` は `durationSec` が既にoutput尺なので計算式を変えない。
`videoStart * fps` はsource media frame、`durationSec * fps` はoutput frameであることを
コメントに明記する。

---

## 10. 他要素の時刻

### 10.1 caption

caption `[start,end)` を新しい `remapInterval` でoutputへ写像する。

- 2倍速区間内のcaption durationは半分。
- speed境界をまたぐcaptionは傾きが変わるため、entryごとのpieceへ分けてから、
  output上で隣接するpieceを結合してよい。
- textは同じ。

### 10.2 karaoke words

wordごとに同じ `remapInterval` を使う。

- wordの開始・終了がspeedで圧縮・伸長される。
- `mode: fill` の進行もoutput word durationへ追従する。
- speed境界をまたぐwordはpieceを結合してよい。

### 10.3 caption animation

`CaptionAnim.durationSec` はoutput秒の演出durationとして維持する。speedに反比例させない。

例: caption本体が2倍速で短くなっても `durationSec: 0.3` は0.3秒。
既存の「短い場合は半分へ縮める」規則が適用される。

### 10.4 overlays / blur / annotation / zoom / wipe

start/end anchorはrawなので、新timelineでoutput spanへ写像する。

- static geometryは変わらない。
- span durationはspeedに従う。
- fade/ease秒はoutput秒として維持する。
- speed境界自体で同じ要素を不必要に二重描画しない。

キーフレーム実装済みの場合:

- raw `keyframes[].at` は `sourceToOutputTime` で写像する。
- `RemappedPiece.speed` を使ってboundary sampleのoutput時刻を作る。
- source curveの値はraw時刻で評価してからoutputへ運ぶ。
- speed変更はanimationの値を変えず、進行に使う時間だけ圧縮・伸長する。

### 10.5 material overlay動画

material動画自体は1倍速で再生する。親spanのstart/endだけがspeed timelineへ写像される。

- speed 2区間に置かれた6 raw秒のmaterial spanはoutput 3秒表示。
- material mediaはその3秒間を1倍で再生し、3秒分だけ進む。
- `startFrom` の断片間加算は**outputで実際に表示した秒数**を使う。
- base sourceのspeedをmaterialの `playbackRate` へコピーしない。

### 10.6 BGM

BGM media自体は1倍速。track start/endだけをspeed timelineへ写像する。

- loopはoutput durationに対して行う。
- fade/duck秒はoutput秒。
- BGMをspeedに合わせてピッチ変更しない。

### 10.7 ducking

rawの発話 / 無音区間を新timelineへ写像する。speed 2ならduck区間も半分になる。
attack/release等の設定秒はoutput秒として維持する。

### 10.8 insert

- insertは1倍。
- base timelineをそのdurationだけ後ろへずらす。
- caption等は既存仕様どおりinsert中に分断される。
- speed segmentの倍率をinsertへ継承しない。

---

## 11. Schemaとvalidate

### 11.1 Schema

`schemas/cutplan.schema.json` の segment propertyへ追加:

```json
"speed": {
  "type": "number",
  "minimum": 0.25,
  "maximum": 4
}
```

JSON Schemaだけでは `action: cut` のspeed禁止を簡潔に保ちにくい場合、runtime validateで
強制する。Schemaに `if/then` を追加してもよいが、runtime testは必須。

`schemas/examples/cutplan.max.json` に0.5、1、2の例を含める。

### 11.2 validate error

- speedがnumberでない。
- NaN / Infinity。JSON経由では通常来ないがhelper unit testで固定する。
- speed < 0.25。
- speed > 4。
- `action: "cut"` にspeedがある。
- speed境界を作るkeep segment同士がoverlapする。

### 11.3 warning

- speed < 0.5: フレーム補間なしでカクつく可能性。
- speed > 2: 声が聞き取りづらくなる可能性。
- speed変更後のoutput segmentが0.1秒未満。
- 1秒未満の範囲に3個以上のspeed境界。
- captionがspeed変更により0.2秒未満になる。

warningはrenderを止めない。

### 11.4 既存segment検査

validateがkeepをmergeして overlap / gapを検査している箇所では、集合検査と再生segment検査を
分ける。

- cut/keep coverage検査:従来ロジック。
- playback sequence: `playbackSegmentsOf`。
- output duration / caption visibility: speed-aware timeline。

---

## 12. 承認

### 12.1 hash payload

現在のkeep tuple `[start,end]` を次へ変更する。

```ts
type ApprovedPlaybackSegment = [start: number, end: number, speed: number];
```

正規化:

- start/endは既存どおり小数第3位。
- speedも小数第3位へ丸める。
- 隣接 segmentはspeedが同じ場合だけmerge。
- speed省略とspeed 1は同じpayload。

例:

```json
[
  [0, 10, 1],
  [10, 20, 2]
]
```

### 12.2 hash migration

speed機能導入で、speedを使っていない既存projectのapprovalまで一斉失効させない。

そのためpayload versionを明示する。

推奨:

```ts
function cutplanApprovalPayload(cutplan: CutPlan): unknown {
  const segments = playbackSegmentsOf(cutplan);
  const hasNonDefaultSpeed = segments.some((s) => s.speed !== 1);
  if (!hasNonDefaultSpeed) {
    return normalizeLegacyKeeps(segments);
  }
  return {
    version: 2,
    playback: normalizePlaybackSegments(segments),
  };
}
```

- 全speedが1なら旧 `[start,end][]` payloadを維持し、既存hashと一致。
- 非1 speedが1件でもあればversion 2 payload。
- speedを1へ戻すとlegacy hashへ戻るが、元keep集合が同じなら以前の承認が再び有効になる。

最後の挙動を避けたい場合でも approval recordへ世代を追加しない。approvalは内容hashであり、
同じ内容へ戻せば再有効になる既存思想と一致する。

### 12.3 shorts

short approval hashは変更しない。short rangesにspeedが無いため。

---

## 13. cache

### 13.1 cut cache

`CutCacheKey.keeps` を `playback` へ変更すると既存key JSONが読めなくなるが、generated artifact
なので再生成でよい。ただしspeed無しでも不要な再生成を避けるなら次の形を採る。

```ts
export interface CutCacheKey {
  keeps: { start: number; end: number; speed?: number }[];
  ...
}
```

- speed 1は省略。
- speed無しprojectは従来 `keeps` JSONと同じ。
- speed非1だけ `{start,end,speed}`。

`buildCutCacheKey` は `PlaybackSegment[]` を受ける。

### 13.2 preview stale key

`preview.keeps.json` にspeed非1を含める。speed変更でpreviewをstaleにする。
speed 1は省略すれば既存keyと互換。

### 13.3 render full-skip

speed変更で `cut.mp4` のmtime/sizeとprops durationが変わるため既存render keyは失効する。
追加処理は不要。ただしcut cacheがspeedを含むことが前提。

### 13.4 chunk cache

speedは `cut.mp4` と全timelineを変え、音声にも効く。

- chunk差分renderは使用しない。
- `globalVideoKey` がcut stat / base timeline変化で不一致になる。
- `audioKey` もcut stat / baseSegments / duration変化で不一致。
- 自動的にfull renderへfallback。

speed変更を局所chunkだけで処理しようとしない。

### 13.5 proxy cache

変更しない。proxyはraw全尺のまま。

---

## 14. describe / assert / frames

### 14.1 describe JSON

`keeps[]`:

```ts
interface KeepEntry {
  index: number;
  start: number;
  end: number;
  speed: number;
  sourceDurationSec: number;
  outputDurationSec: number;
  outStart: number;
  outEnd: number;
}
```

後方互換のため既存 `durationSec` を残す場合はraw durationを維持し、
`outputDurationSec` を追加する。`durationSec` の意味を黙ってoutputへ変更しない。

summary:

```json
{
  "sourceKeptSec": 30,
  "outDurationSec": 22,
  "speedChangedSegmentCount": 2
}
```

既存 `keptSec` はsource kept durationとして維持する。

### 14.2 human-readable describe

speed 1は従来表示を変えない。非1だけ次を追加する。

```text
keep 元 00:15.00–00:25.00 (10.0秒) x2.00 → 出力 00:12.00–00:17.00 (5.0秒)
```

### 14.3 assert

`outputDurationSec` はspeed-aware props durationを使うため既存assertが自然に対応する。

caption visibility:

- output intervalは新timeline。
- `mustIncludeCaption` のtext判定は変更なし。

必要なら将来assertへspeed期待値を足すがv1の必須ではない。

### 14.4 frames

CLIの `--t` は契約どおりraw time。

- raw `t` -> speed-aware output time。
- cut内なら従来のerror / snap規則。
- insertのoutput timeを直接指定する既存方法があれば維持。
- frame file metadataへraw/outputの両方を記録する。

2倍速segment中のraw 2秒差はoutput 1秒差になる。

### 14.5 review

speed変更proposalのbefore/afterはdurationが変わる。比較frameはraw anchorを共有し、
beforeとafterそれぞれのtimelineで別output timeへ写像する。

同じoutput秒を両側へ使ってはいけない。映っているsource内容が変わるため。

structure observationへ追加:

- output duration差
- changed speed segment IDs
- 各segmentのbefore/after speed

review clip duration上限はoutput秒で適用する。

---

## 15. AV probe

`av` は実際の最終見え方・聞こえ方を観測するためspeed対応が必要。

### 15.1 filter

`src/lib/avFilters.ts` は `PlaybackSegment[]` を受け、`keepAudioParts` と同じatempo済み音声を
観測する。

### 15.2 motion

motion sampleのoutput frameをsourceへ逆写像する。

- speed 2では隣接output sample間のsource移動量が大きい。
- speed 0.5では同一/近接source frameが増える。
- probe metadataにraw sample timeとoutput sample timeを両方持つ。

### 15.3 sound

- sound windowはoutput秒。
- source抽出時はspeed segment境界で分割。
- atempo後の波形を測定。
- speed変更前のraw audioを測って代用しない。

### 15.4 review observation

`av.probe` stale keyへnormalized playback segmentsを含める。speed変更でprobeをstaleにする。

---

## 16. Editor

### 16.1 timeline clip幅

keep clipの表示幅はoutput duration `(end-start)/speed`。

- 速度変更後、後続clipはrippleして左右へ移動する。
- raw start/endは変えない。
- cut markerのoutput位置も新timelineから求める。
- caption / overlay trackも新timelineで再配置する。

### 16.2 Inspector

keep clip選択時に「再生速度」を追加する。

UI:

- select presets: `0.25x`, `0.5x`, `0.75x`, `1x`, `1.25x`, `1.5x`, `2x`, `3x`, `4x`
- number input: min 0.25, max 4, step 0.05
- 「標準に戻す」でpropertyを削除
- source duration
- output duration

入力中:

- finiteでない値はcommitしない。
- blur中の一時文字列はlocal state。
- Enter / blurでcommit。
- clampせず範囲外errorを表示する。黙って0.1を0.25へ変えない。

### 16.3 segment split

速度変更範囲を作る手順:

1. 既存のplayhead splitを使って開始点で分割。
2. 終了点で分割。
3. 中央clipを選びspeed設定。

v1で「範囲を選んで速度変更」専用gestureを追加しない。

split処理:

- speedを両側へコピー。
- reasonを両側へコピーする既存規則。
- IDは片側保持、片側新規。

### 16.4 trim / move

- trimはraw start/endを更新する。
- clipのoutput幅はspeedで再計算。
- moveがraw時刻を更新する既存挙動ならspeedを保持。
- speedを変えてもraw start/endは変えない。

### 16.5 undo / redo

speed変更1回を1 history entryにする。number inputの連続変更は
`speed:<segment-id-or-index>` でcoalesceする。

### 16.6 Player

Editor `buildRenderProps(... videoIsSource: true)` がbase segmentへplaybackRateを載せる。

- screen/cameraは同じrate。
- 非mutedな先頭videoだけ音声を出す。
- `preservePitch` をtrue。
- speed境界ごとに別Sequence。
- 次Sequenceを既存premountで先読みする。
- `acceptableTimeShiftInSeconds` はまず既存0.2を維持する。

Safariでspeed境界のseek/audio gapが問題になる場合も、初期実装で定数を全体変更しない。
再現testと計測を追加した別修正にする。

### 16.7 playhead

Player frameはoutput frame。表示するraw時刻は `toSourceTime`。

- insert上はraw null。
- speed 2ではoutput 1 frame進むごとにraw `2/fps` 秒進む。
- raw時刻表示は小数第2位へ丸める既存規則。

### 16.8 waveform

既存waveformがproxy raw時間を前提にしている場合:

- clip内のraw waveformを切り出す。
- CSS幅をoutput durationへ縮伸する。
- 再解析・atempo済みwaveform生成はv1では不要。
- amplitude自体はraw sampleのまま横軸だけ伸縮。

音の聞こえ方を厳密確認するのはPlayer / av probe。

### 16.9 save / approval UI

- speed変更はcutplan変更としてdirty。
- 保存後、approval hash mismatchで未承認表示。
- GUI saveが既存approval recordを直接削除する必要はない。hash mismatchで失効する。
- 再承認は既存preview review境界を通す。

---

## 17. apply / MCP / AI

### 17.1 apply

既存segment IDへset:

```json
{
  "ops": [
    {
      "op": "set",
      "target": "@seg_a1b2c3",
      "path": "speed",
      "value": 2
    }
  ]
}
```

標準へ戻す:

```json
{
  "ops": [
    {
      "op": "remove-field",
      "target": "@seg_a1b2c3",
      "path": "speed"
    }
  ]
}
```

現行op名に `remove-field` が無い場合は、既存のfield削除表現を使う。本設計のために
`null` をspeed削除の意味へ追加しない。

### 17.2 segment分割

既存applyがsegment splitを高水準操作として持たない場合、v1ではwhole-file replaceまたは
GUI splitを使う。speed専用の複合opを同時実装しない。

### 17.3 task-level intent

高水準 `set_speed` intentを追加するならrenderer完成後の別slice。

```ts
{
  kind: "set_speed";
  targetId: string;
  speed: number;
}
```

任意raw rangeを自動splitするintentはv1非対象。

### 17.4 AI prompt

AIへ次を明示する。

- speedはkeep segmentだけ。
- 0.25〜4。
- 途中だけ変えるならsegmentをsplit。
- speed変更は承認失効。
- apply dry-run後にvalidate。
- framesはraw timeで指定。
- 音声あり区間を2倍超にする場合は聞き取りwarningを考慮。

---

## 18. shorts

v1ではshortsへspeedを継承しない。

理由:

- `shorts.json` のrangesは本編cutplanと独立。
- 本編の同じraw範囲がshortでは別編集意図を持つ。
- main cutplan speedを暗黙継承するとshort durationとapproval hashが変わる。
- shorts approval payloadにはspeedがない。

挙動:

- `render --short` は全rangeをspeed 1で処理。
- main cutplanにspeedがあっても無視。
- validate warningは出さない。仕様どおりの独立性。
- Editor short modeにspeed UIを出さない。

将来対応時は `ShortRange = Interval & {id?, speed?}` とshort approval hashを別設計する。

---

## 19. ファイル別変更一覧

### Slice 1: 型、Schema、validate、正規化

- `src/types.ts`
- `schemas/cutplan.schema.json`
- `schemas/examples/cutplan.max.json`
- `src/stages/validate.ts`
- `src/lib/timeline.ts`
  - `PlaybackSegment`
  - `playbackSegmentsOf`
- `test/schema.test.ts`
- `test/validate.test.ts`
- `test/types.test.ts`
- `test/timeline.test.ts`

### Slice 2: timeline kernel

- `src/lib/timeline.ts`
  - `TimelineEntry`置換
  - build / forward / inverse / interval / snap / duration
- `src/lib/avParse.ts`
- timelineを直接読む全ファイル
- `test/timeline.test.ts`

### Slice 3: ffmpeg audio/video

- `src/lib/loudness.ts`
- `src/stages/preview.ts`
- `src/stages/render.ts`
- `src/lib/avFilters.ts`
- `test/loudness.test.ts`
- `test/ffmpeg.test.ts`
- `test/videoEncode.test.ts`

### Slice 4: RenderProps / Editor playback kernel

- `remotion/props.ts`
- `src/lib/renderProps.ts`
- `remotion/Main.tsx`
- frame span helper
- `test/renderProps.test.ts`
- `test/renderSnapshot.test.ts`

### Slice 5: approval / cache

- `src/lib/approval.ts`
- `src/lib/cutCache.ts`
- preview stale比較箇所
- AV stale key
- `test/approval.test.ts`
- `test/cutCache.test.ts`
- `test/renderKey.test.ts`
- `test/chunkPlan.test.ts`

### Slice 6: describe / frames / assert / review / av

- `src/stages/describe.ts`
- `src/stages/frames.ts`
- `src/stages/assert.ts`
- `src/stages/review.ts`
- `src/lib/reviewObservation.ts`
- `src/stages/av.ts`
- 対応tests

### Slice 7: Editor

- `editor/client/model.ts`
- `editor/client/App.tsx`
- `editor/client/Inspector.tsx`
- `editor/client/Timeline.tsx`
- `editor/client/playhead.ts`
- `editor/server.ts`
- Editor tests

### Slice 8: apply / docs

- `src/lib/applyEdits.ts`
- 必要なら `schemas/apply-patch.schema.json`
- `docs/usage.md`
- `AGENTS_CONTRACT.md`
- contract / apply tests

---

## 20. 実装手順

弱いモデルは必ずS1から順に実装する。S2のtimeline migrationとS3のffmpeg変更を同じPRに
入れない。

### S1: 入力境界

1. constantsと`PlanSegment.speed`を追加。
2. Schemaとmax example。
3. validate error / warning。
4. `PlaybackSegment`と`playbackSegmentsOf`。
5. speed同一だけmergeするtest。
6. speed無しfixtureが従来keepsと同じになるtest。
7. typecheckと対象test。

完了条件: speed JSONを安全に読める。まだrender結果は変えない。

### S2: timeline

1. 新 `TimelineEntry` interfaceへ置換。
2. `buildTimelineModel`を実装。
3. speed 1のgoldenを新shapeで固定。
4. speed 2 / 0.5のforward mapping。
5. inverse mapping。
6. interval mapping。
7. insert split。
8. snap / duration。
9. `offset`参照を`rg '\\.offset'`で0件にする。
10. timeline利用側を機械的にhelperへ移行。

完了条件: raw/output変換がspeed-aware。まだmediaは1倍なのでUIへ公開しない。

### S3: ffmpeg

1. `atempoFilters`のunit test。
2. `keepAudioParts`をPlaybackSegment化。
3. speed 1のfilter文字列不変。
4. mic only速度変更。
5. mic+systemはmix後atempo。
6. loudness測定へ同じsegments。
7. preview video setpts。
8. cutFullRes video setpts。
9. synthetic A/V integration test。

完了条件: previewとcut.mp4の映像・音声・durationが正しい。

### S4: props / Player

1. `BaseSegment`型。
2. final cut.mp4経路のvideoStartをretimed timeline化。
3. Editor proxy経路のplaybackRate。
4. CroppedVideoへplaybackRate / preservePitch。
5. screen/camera/blurで同じsegmentを共有。
6. continuous判定。
7. insert split。
8. props tests。

完了条件: Editor Playerとpreviewの尺・境界・音声が一致。

### S5: approval / cache

1. legacy-compatible approval payload。
2. speed変更で失効するtest。
3. speed省略で旧hash不変test。
4. cut cacheへspeed非1だけ追加。
5. preview stale。
6. AV stale。
7. chunk full fallback。

完了条件: 古いmediaやapprovalを誤利用しない。

### S6: projection / observation

1. describe inputをPlaybackSegment化。
2. keeps projectionへspeed/output duration。
3. frames raw->output。
4. assert output duration。
5. review raw anchor比較。
6. AV filter / sample mapping。
7. full tests。

完了条件: CLI・AIの観測が実renderと一致。

### S7: Editor UI

1. clip幅をoutput duration化。
2. playhead inverse mapping。
3. Inspector presets / input。
4. update / undo / redo。
5. splitでspeed copy。
6. save/reload。
7. approval stale表示。
8. Safari/Chromeで境界再生確認。

完了条件: GUIだけで定速変更を完結できる。

### S8: agent surface / docs

1. apply set/remove。
2. dry-run。
3. usage。
4. AGENTS_CONTRACT。
5. drift tests。

完了条件: `describe -> apply --dry-run -> apply -> validate -> preview/frames -> approve -> render`
を完走できる。

---

## 21. 必須テスト

### 21.1 playback正規化

- speed省略 -> 1。
- explicit 1 -> 1。
- 同speed隣接はmerge。
- 異speed隣接は保持。
- cut segment除外。
- input mutateなし。

### 21.2 timeline

- 1倍のみ。
- 2倍のみ。
- 0.5倍のみ。
- `1 -> 2 -> 0.5`。
- forward exact start / middle / end-near。
- inverse round trip。
- cut内はnull。
- speed境界 exact time。
- insert before / inside / after。
- 末尾insertを含むduration。
- remapIntervalがspeed境界をまたぐ。
- remapIntervalPiecesがentryを保持。
- 1000segmentで丸め誤差が累積しない。

### 21.3 ffmpeg filter

- speed 1のvideo filter従来一致。
- 2倍 `setpts=(PTS-STARTPTS)/2`。
- 0.5倍。
- atempo 0.25 / 0.5 / 1 / 1.5 / 2 / 3 / 4。
- denoise順序。
- system volume -> amix -> atempo順序。
- loudness passにもatempoがある。

### 21.4 integration media

synthetic 4秒video + tone/audio markerを作る。

- speed 2 -> 約2秒。
- speed 0.5 -> 約8秒。
- 2segment mixed speedの期待duration。
- fps維持。
- video/audio duration差20ms以下。
- output先頭/中間/末尾frame内容。
- 音声pitchが維持されることを周波数解析で許容範囲内確認。
- speed境界でaudio gapが無い。

### 21.5 props

- speed無しpropsの既存golden不変。
- final経路にplaybackRate無し。
- Editor経路speed非1だけplaybackRate。
- videoStart raw/outputの取り違えなし。
- insert前後。
- caption/words/BGM/overlay span。
- material startFromはoutput表示秒で進む。

### 21.6 approval / cache

- speed無し旧approval hash不変。
- explicit speed 1も旧hash。
- 1 -> 2で失効。
- 2 -> 1でlegacy payload。
- reasonだけ変更は失効しない。
- cut cache speed変更で不一致。
- proxy cacheは不変。
- audio key / global key不一致でfull fallback。

### 21.7 describe / frames / review

- source keptSecは不変、outDurationだけ変わる。
- keep entryのraw/output duration。
- raw frame requestのoutput変換。
- before/after reviewが同じraw内容を見る。
- assert output duration。
- AV probe stale。

### 21.8 Editor

- preset選択。
- custom値commit。
- 範囲外error。
- resetでfield削除。
- clip幅ripple。
- playhead raw表示。
- splitでspeed copy。
- undo/redo。
- save/reload。
- speed変更でapproval stale。
- short modeにUI無し。

---

## 22. 手動確認

最低10秒の音声付きfixtureで次を作る。

1. `[0,2)` 1倍。
2. `[2,6)` 2倍。
3. `[6,8)` 0.5倍。
4. `[8,10)` 1倍。
5. 各区間にcaption。
6. speed境界をまたぐcaption。
7. karaoke words。
8. material overlay。
9. blur / annotation。
10. speed 2区間内にinsert。

期待base duration:

```text
2/1 + 4/2 + 2/0.5 + 2/1 = 10秒
```

insert 1.5秒ならfinal 11.5秒。

確認:

```sh
node src/cli.ts validate <dir>
node src/cli.ts describe <dir> --json
node src/cli.ts preview <dir>
node src/cli.ts frames <dir> --t 1,3,7,9
node src/cli.ts av <dir>
```

人間確認:

- 2倍区間の声の音程が不自然に上がらない。
- 0.5倍区間の音程が下がらない。
- 境界に無音・黒frame・同一frame飛びがない。
- captionと発話が同期する。
- insert後もraw anchorがずれない。
- Editorとpreviewで同じタイミング。

final renderはapproval後だけ実行する。設計実装testのためにapproval fileを直接編集しない。

---

## 23. ドキュメント更新

`docs/usage.md`:

- `cutplan.segments[].speed`
- 0.25〜4、既定1
- 音程維持
- segment途中はsplit
- output duration式
- insert / BGM / material / shortsとの関係
- approval失効
- apply例
- preview / frames確認手順

`AGENTS_CONTRACT.md`:

- cutplan説明を「keep/cutとkeep区間の再生速度」に更新。
- 全時刻がrawという規約は維持。
- approval hashがkeep集合に加えて非1 speedを含むことを明記。
- editable/generated/approvalの分類は変更しない。

---

## 24. 受け入れ条件

以下をすべて満たしたときP2「速度変更」v1完了とする。

- keep segmentへ0.25〜4の定速を指定できる。
- 映像、マイク、システム音声が同倍率で同期する。
- 音声の音程が維持される。
- raw/output timelineが区分線形で正逆変換できる。
- caption、word、overlay、blur、annotation、zoom、wipe、BGM、duckが新timelineへ追従する。
- insertは1倍で、前後のbase speedを維持する。
- preview、Editor、frames、review、AV、final renderが同じtimingを使う。
- speed変更でapproval、cut cache、render cache、AV probeが適切に失効する。
- speed無しの既存approval hash、filter graph、props、render結果が回帰しない。
- shortsは明示的に1倍のまま。
- GUIで設定、reset、split継承、undo/redo、save/reloadできる。
- apply dry-run / apply / validateがspeedを扱える。
- `npm test` と `npm run typecheck` が成功する。

---

## 25. 将来拡張

v1完了後も次を別PR・別設計で進める。

1. shorts rangeの定速。
2. insert / material clipの独立速度。
3. 音声ミュート付き高速B-rollモード。
4. freeze frame。
5. reverse。
6. motion interpolation。
7. speed ramp。

speed rampでは現在の `PlaybackSegment.speed` をそのままkeyframe化しない。必要なのは
`outputDuration = integral(1 / speed(sourceTime))` とその逆関数である。定速entryを細分化して
近似するか、解析可能なcurveを採用するかを先に決め、音声filter graphとEditor seekを含む
独立設計を作る。
