# S1: 音声のシーケンス時間 — BGM が挿入で切れない / 挿入クリップに BGM を当てられる

親ドキュメント: `docs/programs/sequence-time-program.md`(シーケンス時間母艦)
状態: **IMPLEMENTED** / 2026-08-02
前提: **S0 が landing していること**(特に T1 の `outputDurationSec` と
`insertSpansOf()`)。S0 と同一 PR にしてもよい。

解決する要望: 母艦 §2 の **(2) 挿入で BGM が消える** と
**(3) 挿入クリップに BGM を当てられない**。

---

## 0. なぜ BGM が最初か

`timebase` という新しい語彙を document 層へ降ろす最初の適用先として BGM が最も安全:

- **source 結合を持たない**。BGM は収録の内容と何の対応関係も持たない純粋な加算音声。
  テロップのように「この発話に貼り付いている」制約が無い
- **ミキサーは既に出力秒で動く**。`src/lib/bgmEnvelope.ts:8-17` の `bgmTrackTiming` は
  `track.start` を**出力秒として**フレームへ変換しており、`src/lib/bgmMix.ts:60-62` は
  `props.durationSec`(挿入込みの全長)ぶんのベッドを確保する。
  `src/lib/insertMix.ts:207-210` は BGM を全長のベッドへ単純加算する。
  **つまり `props.bgm` に区間さえあれば挿入下でも鳴る。壊れているのは
  `buildBgm` の source→output 写像だけ**
- **下流が既に出力秒のみを見ている**。`src/lib/bgmFit.ts:293-303` は
  `sound.bgm.spans`(出力秒)だけを使い、`tracks[].start/end` を読まないことを
  doc コメントで明示している。よって `bgm-fit` は `timebase` に対して透過
- **承認 hash に無関係**。`src/lib/approval.ts:57-68` のペイロードは keep 集合のみ

---

## A1: source timebase のトラックを1本の連続 span へコンパイルする

### 現状(バグ)

`src/lib/renderProps.ts:702-724`:
```ts
  if (bgm && Array.isArray(bgm.tracks)) {
    return bgm.tracks.flatMap((t) => {
      if (!fileExists(t.file)) { warn(...); return []; }
      const parts = remapInterval(t.start, t.end, timeline);
      return parts.map((iv, j) => withDuck({
        file: t.file,
        volumeDb: t.volumeDb ?? renderCfg.bgm.volumeDb,
        start: iv.start, end: iv.end,
        ...(t.startFrom ? { startFrom: round2(t.startFrom) } : {}),
        ...(j === 0 && t.fadeInSec ? { fadeInSec: Math.min(t.fadeInSec, round2(iv.end - iv.start)) } : {}),
        ...(j === parts.length - 1 && t.fadeOutSec ? { fadeOutSec: Math.min(t.fadeOutSec, round2(iv.end - iv.start)) } : {}),
      }));
    });
  }
```

`remapInterval`(`src/lib/timeline.ts:197-220`)は隣接断片を
`Math.abs(last.end - iv.start) < 0.005` のときだけ連結する。**挿入をまたぐと
出力側の隙間は挿入尺そのもの(秒オーダー)**なので絶対に連結されず、穴が開く。

再現(数値):
```
keeps   [0,30] / insert { at: 8, durationSec: 4 } / bgm track { start: 5, end: 16 }
entries : src 0–8  → out 0–8     src 8–30 → out 12–34
insert  :               out 8–12
remapInterval(5,16) → [{5,8}, {12,20}]     ← 出力 8–12 に BGM 区間が無い = 無音
```

### 非対称の証拠(診断に使える)
`renderProps.ts:729-739` の fallback(収録直下 `bgm.mp3`)は
`start: 0, end: durationSec` と**出力秒で直接**指定しているため挿入をまたいでも切れない。
「`bgm.mp3` 直置きなら鳴るのに `bgm.json` にすると挿入部で切れる」が本症状の指紋。

### 修正: 挿入があるときだけ凸包を取る

```ts
/** 写像した断片を1本の連続 span へ畳む(凸包)。挿入で割れた BGM を繋ぐ。
 *
 * **挿入が無いときは呼ばない**(`hasInserts` ガード)。remapInterval が
 * cut 境界では既に連結するため挿入なしなら結果は同じはずだが、
 * outputStart の二重丸め(round2)で 0.005 を跨ぐ理論上の縁があるので、
 * 「挿入が無ければバイト等価」を**構成的に**保証するためにガードする
 * (母艦 §8-1)。 */
function hullOf(parts: Interval[]): Interval[] {
  if (parts.length <= 1) return parts;
  return [{ start: parts[0].start, end: parts[parts.length - 1].end }];
}
```

`buildBgm` の source 分岐:
```ts
      const parts = remapInterval(t.start, t.end, timeline);
      const spans = hasInserts ? hullOf(parts) : parts;
      return spans.map((iv, j) => withDuck({ ... }));
```

`hasInserts` は `buildBgm` の引数に足す(`buildRenderProps` から
`activeInserts.length > 0` を渡す)。

### 効果
- `spans.length === 1` になるので `j === 0 && j === spans.length - 1` が同時に成立し、
  **フェードイン/アウトが同じ1本の span の両端に載る**。
  現行の「端の断片だけに載せる」特殊処理(`renderProps.ts:684` の doc コメント)は
  自然に不要になる。doc コメントを書き換えること
- カットは今までどおり詰まる(凸包は**射影後**に取るので、カットされた区間は
  そもそも出力に現れず、両端だけが繋がる)

### 既存テストの書き換え

`test/renderProps.test.ts:1524-1545` の
`"buildRenderProps: 挿入で割れた BGM はフェードを端の断片だけに載せる"` は
**この仕様を pin 留めしている**。以下へ置き換える:

```ts
test("buildRenderProps: 挿入をまたぐ BGM は1本の連続区間になる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: { inserts: [{ at: 8, file: "materials/ins.mp4", durationSec: 4 }] },
    renderCfg, width: 1920, height: 1080, videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 5, end: 16, file: "bgm.mp3", fadeInSec: 1, fadeOutSec: 2 }] },
    bgmFallbackFile: null, overlayExists: () => true, warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.equal(props.bgm[0].start, 5);
  assert.equal(props.bgm[0].end, 20);   // 8→12 の挿入 4秒ぶん後ろへ伸びる
  assert.equal(props.bgm[0].fadeInSec, 1);
  assert.equal(props.bgm[0].fadeOutSec, 2);
});

test("buildRenderProps: 挿入が0件なら BGM の区間は従来どおり(バイト等価)", () => {
  // 同じ keeps/bgm で inserts 無し → props.bgm が S1 導入前と同一であること
});

test("buildRenderProps: 挿入があってもカットは詰まる(凸包は射影後)", () => {
  // keeps [0,10],[20,30] / insert at 5 dur 2 / bgm src [2,25]
  // → 1本、start=2、end は出力尺内に収まること
});
```

---

## A2: `timebase: "output"` — 挿入クリップに BGM を当てる

### なぜ A1 だけでは足りないか

A1 は「BGM の source 区間が挿入をまたぐ」場合を直すが、
**先頭 intro / 末尾 ending には原像が無い**。
`inserts: [{ at: 0, durationSec: 8 }]` の出力 0–8 秒は、どんな
`tracks[].start/end` を書いても `remapInterval` の像に入らない
(`timeline.ts:102` の `place()` が entries を生まないため)。
`toSourceTime`(`timeline.ts:252-261`)も entries しか探さないので逆も不可。

**したがって (3) はバグ修正では直らない。語彙を足すしかない。**

### スキーマ(5点セット)

#### 1. `src/types.ts` — `Bgm.tracks[]` に追加

`id?: string;` の直後、`start` の直前へ:

```ts
    /** この区間の時刻(start/end)が属する時間軸。省略時 "source"。
     *  - "source" … 元収録の秒(従来どおり)。cut に追随して縮み、
     *    挿入をまたぐときは繋がった1本の区間になる
     *  - "output" … 出力(カット後・挿入込み)の秒。**元収録に対応時刻が
     *    無い区間**(冒頭 intro クリップ・末尾 ending クリップ・挿入の中)へ
     *    BGM を当てるときに使う。cut を編集しても位置は動かない
     *    (NLE で sync lock を外した音声トラックと同じ挙動)
     *  出力秒は `describe <dir>`(「出力」列)や `describe <dir> --json` の
     *  `keeps[].outStart/outEnd`・`inserts[].out` で確認できる */
    timebase?: "source" | "output";
```

#### 2. `src/stages/validate.ts` — bgm.json 検査(`validate.ts:995` 付近)

```ts
    // timebase("source" 省略時 / "output")
    if (t.timebase !== undefined && t.timebase !== "source" && t.timebase !== "output") {
      err(f, w, `timebase は "source" か "output" です: ${JSON.stringify(t.timebase)}`);
    } else if (t.timebase === "output") {
      // 出力秒なので manifest.durationSec ではなく出力尺で検査する(S0-T1 が供給)
      checkSpanAgainst(f, w, t, outputDurationSec, err, warn);
    } else {
      checkSpan(f, w, t, dur, err, warn);          // ← 従来どおり
    }
```

`checkSpanAgainst` は `checkSpan`(`validate.ts:1198-1218`)の
`dur` を引数化しただけの薄いラッパでよい。実装は `checkSpan` の
シグネチャに既に `dur` があるので**そのまま使える**:
`checkSpan(f, w, t, outputDurationSec, err, warn)`。新関数は不要。

超過メッセージだけ軸を明示したいので、`checkSpan` に任意引数を足す:
```ts
function checkSpan(file, where, s, dur, err, warn, durLabel = "収録の長さ"): void {
  ...
  const msg = `end(${fmtT(s.end)})が${durLabel}(${fmtT(dur)})を超えています`;
```
呼び出し側: `checkSpan(f, w, t, outputDurationSec, err, warn, "出力の長さ")`。
**他の全呼び出し元は既定引数で従来と同一メッセージ**(バイト等価)。

`outputDurationSec` が `null`(cutplan にエラーがある等)のときは
`checkSpan` の既存ガード(`dur !== null`)で範囲検査がスキップされる。

#### 3. `docs/usage.md` — `bgm.json` の表に1行

| フィールド | 説明 |
|---|---|
| `timebase` | `"source"`(省略時)= 元収録の秒 / `"output"` = 出力(カット後・挿入込み)の秒。冒頭 intro・末尾 ending・挿入クリップの中へ BGM を当てるときは `"output"` を使う |

あわせて「BGM が挿入で切れる」旧挙動の説明があれば削除する。

#### 4. `schemas/bgm.schema.json` — `tracks.items.properties` に追加

```json
          "timebase": { "enum": ["source", "output"] },
```
(`id` の直後に置く。`test/schema.test.ts` が enum を `types.ts` へピン留めするため
値の綴りを完全に一致させること)

#### 5. `schemas/examples/bgm.max.json` — 2本目のトラックへ追加

```json
    { "timebase": "output", "start": 0, "end": 8, "file": "materials/intro-bgm.mp3" },
    { "start": 60, "end": 120, "file": "materials/outro.mp3" }
```
(max fixture は「全キーが1度は出る」ことが要件。1本目は `timebase` 省略のまま
残し、`"output"` の例を足す)

**`AGENTS_CONTRACT.md` は無変更**(ファイル分類もコマンド一覧も変わらない)。

### 実装: `src/lib/renderProps.ts` の `buildBgm`

```ts
  if (bgm && Array.isArray(bgm.tracks)) {
    return bgm.tracks.flatMap((t) => {
      if (!fileExists(t.file)) {
        warn(`BGM 素材が見つかりません: ${t.file}(この区間は無音になります)`);
        return [];
      }

      // timebase:"output" は写像しない。出力秒として直接使い、出力尺でクランプする
      // (元収録に原像が無い区間=挿入クリップ・冒頭/末尾へ BGM を当てるための経路)
      let spans: Interval[];
      if (t.timebase === "output") {
        const s = Math.max(0, t.start);
        const e = Math.min(durationSec, t.end);
        if (e <= s) {
          warn(
            `BGM 区間が出力タイムラインの外です: ${t.file} ` +
              `(timebase:"output" の ${fmtT(t.start)}–${fmtT(t.end)}、出力尺 ${fmtT(durationSec)})`,
          );
          return [];
        }
        spans = [{ start: round2(s), end: round2(e) }];
      } else {
        const parts = remapInterval(t.start, t.end, timeline);
        spans = hasInserts ? hullOf(parts) : parts;
      }

      return spans.map((iv, j) => withDuck({
        file: t.file,
        volumeDb: t.volumeDb ?? renderCfg.bgm.volumeDb,
        start: iv.start,
        end: iv.end,
        ...(t.startFrom ? { startFrom: round2(t.startFrom) } : {}),
        ...(j === 0 && t.fadeInSec
          ? { fadeInSec: Math.min(t.fadeInSec, round2(iv.end - iv.start)) } : {}),
        ...(j === spans.length - 1 && t.fadeOutSec
          ? { fadeOutSec: Math.min(t.fadeOutSec, round2(iv.end - iv.start)) } : {}),
      }));
    });
  }
```

**ダッキングは変更不要**。`withDuck` が付ける `duck.spans` は
`buildDuck`(`renderProps.ts:660-679`)が既に**出力秒**へ写像済みで、
`bgmVolumeAtFrame`(`bgmEnvelope.ts:19-34`)は出力秒でルックアップする。
よって `timebase:"output"` のトラックにも正しくダッキングがかかる。

**ループも変更不要**。`bgmMix.ts:79` の `% loopSampleCount` は span 長だけを見る。

### `describe` への露出

`src/stages/describe.ts:1246` は
```ts
    bgm = { source: "bgm.json", tracks: inp.bgm.tracks };
```
と**トラックをそのまま**射影へ渡しており、型も
`BgmProjection.tracks?: Bgm["tracks"]`(`describe.ts:656-660`)と
`Bgm` を参照している。したがって `timebase` は `describe --json` に
**自動的に現れる(追加実装ゼロ)**。確認済み。

散文側(`describe.ts:206-211`)は BGM を「区間数とファイル名」でしか出していないので、
`timebase:"output"` のトラックがあるときだけ1語足す:
```ts
`bgm.json(${bgm.tracks.length}区間${outCount > 0 ? `・うち${outCount}件は出力秒指定` : ""}: ...)`
```
`outCount === 0` のときは**従来とバイト等価**。

---

## A3: `plan-bgm` / `bgmSlots` を挿入認識にする

### 現状
`src/lib/bgmSlots.ts:144-145`:
```ts
  const playback = playbackSegmentsOf(cutplan);
  const timeline = playback.length > 0 ? buildTimeline(playback) : [];
```
**inserts を渡していない**。`src/stages/planBgm.ts:174` は
`manifest.durationSec`(元収録尺)をアンカーの終端にしている。
その結果 LLM に見せる「可視Ns」(`prompts/plan-bgm.md:12-13`、`planBgm.ts:91`)が
挿入のあるプロジェクトで実際より短く出る。

### この段でやること(最小)
1. `bgmSlots.anchorsToSlots` に inserts を渡し、`buildTimeline(playback, insertSpans)` にする。
   `insertSpansOf()`(S0-T2 で `src/lib/timeline.ts` に追加)を使う
2. `planBgm.ts` が `overlays.json` を読んで inserts を渡す

### この段でやらないこと(明示的な非目標)
- **`plan-bgm` が `timebase:"output"` のトラックを自動生成すること**。
  intro/ending への BGM 配置は当面**人間 / `apply --patch` の仕事**。
  LLM は番号選択方式(母艦 §4-1)なので、出力秒スロットを候補として
  提示する設計が別途要る。needs があれば S4 で扱う
- `plan-bgm` のプロンプト(`prompts/plan-bgm.md`)は**1バイトも変えない**

---

## 検証

```sh
npx tsc --noEmit
npm test                 # renderProps / validate / schema / bgmEnvelope / bgmMix
npm run gate:pixel       # 音声のみの変更なので画素は不変であることの確認
```

### 実収録での確認

**(2) の確認**
```sh
# 挿入をまたぐ BGM トラックを1本用意して
node src/cli.ts validate <dir>
node src/cli.ts describe <dir> --json | jq '.bgm.tracks'
node src/cli.ts render <dir>
node src/cli.ts av <dir> --sound-only
# → 挿入区間の RMS が落ちていないこと(修正前は落ちる)
```

**(3) の確認**
```jsonc
// bgm.json
{ "tracks": [
  { "timebase": "output", "start": 0, "end": 8, "file": "materials/intro-bgm.mp3", "fadeOutSec": 1 },
  { "start": 0, "end": 600, "file": "materials/main-bgm.mp3" }
]}
```
`overlays.json` に `inserts: [{ at: 0, file: "materials/intro.mp4", durationSec: 8 }]` を置き、
render 後に出力 0–8 秒で intro-bgm が鳴ること。

### バイト等価の回帰(母艦 §8-1)
`timebase` を1つも書かず挿入も無い既存収録で:
- `props.bgm` が S1 導入前と同一(`render.props.json` の diff が空)
- `describe`(散文・`--json` 両方)の出力が同一
- `validate` の警告一覧が同一

---

## この段が S2 以降へ渡すもの

| 渡すもの | 使う段 |
|---|---|
| `timebase?: "source" \| "output"` という document 層の語彙と、その検証パターン | S2, S3, S4 |
| `checkSpan` の `durLabel` 引数(出力尺に対する検査) | S2-B3 |
| 「挿入区間に音が鳴る」状態 | S2(スチルは無音なので BGM が唯一の音源になる) |
