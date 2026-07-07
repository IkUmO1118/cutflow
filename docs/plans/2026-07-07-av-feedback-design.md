# エージェントが消費できる実 A/V フィードバック(動き+音)設計

- 対象: NLE 診断レビュー **Theme D「高速フィードバックループ」/ Next**「フィードバックが動きなし・音なし・proxy 静止画」(severity major / effort L)
- 診断: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`(**読むだけ・触らない**)
- 前提規約: `CLAUDE.md`(全編集は平文 JSON / 時刻は元収録の秒 / **既定オフ・未使用時バイト等価が鉄則** / ローカルファースト・決定論・依存を増やさない / 生成物は `src/lib/files.ts` に正しく分類)
- 手本にする既存設計: `docs/plans/2026-07-07-material-introspection-design.md`(`materials.probe/` 差分キャッシュ・純関数/オーケストレータ分離)、`docs/plans/2026-07-06-readable-eyes-ocr-design.md`(知覚コマンドの opt-in / 優雅な劣化)、`docs/plans/2026-07-07-audio-perception-design.md`(トラック帰属の正直な宣言)

---

## 0. 問題の一行要約

`frames` は **proxy 静止画1枚**しか出せない=**動きなし・音なし**。テキスト LLM
エージェント(操作者・および `plan` のカット判断 LLM)は動画を再生も試聴もできず、
**テンポ・繋ぎ・間・ダッキングの効き・音量バランス・クリップ**を自己検証できない。
フィードバックループが人間(preview / エディタ)で終端している。

核心は「動画を見聞きさせる」ことではなく、**観測を機械可読な要約に落とす**こと:

- **動き(motion)**: 指定区間を時系列サンプリングした複数フレーム(フィルムストリップ)
  + フレーム間の**動き量**(シーン変化スコア)+ **静止(フリーズ)区間**を秒付きで。
  「この区間で何がいつ動く/止まるか」。
- **音(sound)**: 最終ミックス相当の**ラウドネス包絡・無音/間・クリッピング**、
  **トラック別プレゼンス(mic / system の被り)**、**BGM とダッキングの効き**を秒付きで。
  「どこが大きい/小さい/無音/被っているか」。

いずれも **ffmpeg だけ**で決定論的に抽出する(新規依存ゼロ・macOS 非依存・
同じ入力→同じ出力)。

---

## 1. スコープ規律(最初に線を引く)

**やる(F2 =「観測手段の提供」まで)**:

1. 新コマンド **`av <dir>`**(audio+video)。区間を指定して **motion.json / sound.json /
   フィルムストリップ PNG** を `av.probe/` に書く知覚コマンド。既定オフの opt-in
   コマンドで、未実行なら既存挙動は1バイトも変わらない。
2. **motion**: 基映像(proxy 既定 / `--full-res` で raw)を ffmpeg でタイル状に
   サンプリングしたフィルムストリップ + シーン変化スコア列 + フリーズ区間。
3. **sound**: `keepAudioParts`(既存)で組んだ **mic+system ミックスの音声ベッド**を
   `ebur128` / `astats` / `silencedetect` で計測(統合 LUFS・短時間ラウドネス包絡・
   無音区間・トゥルーピーク/クリップ)+ **mic 単独 / system 単独**を別計測して
   **被り(どちらが大きいか)**を出す + **BGM とダッキング**を props から**解析的に**併記。
4. `av.probe/` を `files.ts` に **生成ディレクトリ(差分更新型。`materials.probe/` と
   同じ位置づけ)**として登録。
5. **MCP tool `cutflow_av`** を露出(読取系。露出候補どおり)。

**やらない(本 Feature の外)**:

- **F1(GUI)**: エディタへの波形・モーション表示・差分レビュー UI。触らない。
- **F3(内部 LLM のエージェントループ本体)**: `plan` を観測→再調整ループにする配線。
  本 Feature は **F3 が読む観測データの形**まで用意する(§7)が、ループそのものは作らない。
- **`plan.perception` への av 接続**(カット判断 LLM の入力へ motion/sound を注入):
  eyes-ears/audio-perception doc の管轄。本 Feature は**操作エージェント向けの知覚
  コマンド**として独立させる(§論点5 の理由)。
- **音響話者分離・非言語音分類**(笑い/SFX の event tagging): 決定論・dep-free で
  安定に取れない。audio-perception doc で既に Later。
- **真の post-BGM ミックスの実測**(BGM+ダッキング込みの LUFS): ダッキングは
  Remotion 側(`remotion/Main.tsx` の `BgmTrack` + `duckFactorAt`)にあり、ffmpeg で
  再現すると二重実装で乖離リスク。v1 は **BGM/ダッキングを props から解析的に併記**する
  (§論点3-D8。真の実測は §9 の将来トリガー)。
- **動画への新しい描画・編集ファイルの追加**: `av.probe/` は読むだけの生成物。
  `EDITABLE_FILES` は1バイトも動かさない。

---

## 2. 決定サマリ(decisions.md 形式)

| # | 論点 | 決定 | 理由(要約) |
|---|---|---|---|
| D1 | コマンドの表面 | **新コマンド `av <dir>`**(motion+sound を1コマンドに束ね、既定は両方。`--motion-only`/`--sound-only` で片方) | motion と sound はどちらも「**区間上の時系列包絡**」で、区間選択・出力先・キャッシュ・優雅な劣化を共有する。1コマンドにすると知覚表面が小さく、F3/MCP から1回の呼びで A/V 両方を得られる。`frames --motion` 拡張は却下(frames は**瞬間**の合成 still で毎回 `frames/` を全消しする別セマンティクス)。`describe` 拡張も却下(describe は**計測しない**瞬間射影) |
| D2 | 区間指定の文法 | **`frames` の文法を踏襲**: `--range <a-b>`(出力秒の範囲。既定は全域)/ `--every <sec>`(サンプル間隔)/ `--short <name>`(ショートの縦レイアウト・ranges)/ `--full-res`(raw 基映像)。時刻はすべて**出力(カット後)秒**を第一軸にする(元秒は各サンプルに併記) | 学習コストゼロ(`frames`/`assert` と同型)。「動き/音」は**視聴者が体験する出力タイムライン**上の現象なので出力秒が自然。sound の音声ベッドは keeps の concat=出力秒に一致し、motion の基映像サンプルは source 秒→出力秒に `timeline.ts` で写像する(frames と同じ) |
| D3 | 出力先とキャッシュ | **新ディレクトリ `av.probe/`**(`materials.probe/` と同じ**差分更新型**。実行のたびの全消しはしない)。`sound.json` / `motion.json` / `motion.strip.png` を安定ファイル名で上書き。各 JSON 先頭に `key`(陳腐化判定)を埋める | `frames/`(全消し)に相乗りさせない=`frames` の stale-PNG 罠と切り離す。`materials.probe/` の前例に揃えれば `files.ts` 分類・テストの型が既にある。`key` に前回選択・入力フィンガープリントを持たせ、同一選択の再実行は ffmpeg をスキップして即返せる(F3 の反復ループで効く) |
| D4 | motion の映像表現 | **フィルムストリップ(タイル montage)1枚 PNG + `motion.json`(タイル索引→時刻)**。合成(テロップ/ズーム/ワイプ)は**乗せない**=基映像そのもの(proxy/raw)を ffmpeg `fps`+`tile` で並べる | 「動き」の主眼は**画面/カメラの物理的な動き**で、これは基映像に出る。合成演出の時刻は既に `describe --json`(overlays の zoom/wipe/insert 秒)で機械可読に取れるので二重に描かない。合成込みの静止確認が要るなら既存 `frames --every` がある(役割分離)。**Remotion を一切通さない**=速い・決定論・`frames.ts` を改造しない |
| D5 | motion の動き量メトリクス | ffmpeg **`scdet`**(シーン変化スコアを全フレーム stderr 出力)を parse して**サンプル区間ごとの動き量**、**`freezedetect`** で**静止(フリーズ)区間**を秒付きで出す。基映像は proxy 既定(`--full-res` で raw) | `silencedetect` と同じ「stderr をログ parse」の既存パターン(`ffmpeg.ts` の `detectSilence` に前例)。scdet=シーンカット/大きな動き、freezedetect=**ビルド待ち等の無変化区間**の検出に直結(dev screencast の間延び診断)。決定論・追加依存なし・全 OS |
| D6 | sound のミックス計測 | **`keepAudioParts`(既存 `lib/loudness.ts`)で mic+system を keeps concat した音声ベッド**を、音声のみデコードで `ebur128`(統合 I / LRA / トゥルーピーク / 短時間 S 包絡)+ `silencedetect`(無音区間)+ `astats`(ピーク/クリップ)に通す。フル render はしない | ダッキング前の mic+system ミックス=`cut.mp4` の音声と**同一構成**(`cutFullRes` と同じ `keepAudioParts`)。音声のみなので数秒。`measuredLoudnormFilter` が既に同じ concat を実測している前例があり、フィルタ組み立てを共有できる。ラウドネス正規化(loudnorm)は**かけない生の値**を測る=「正規化前にどこが大きい/小さい」を見せるため(正規化後の絶対値は targetLufs で決まり情報が無い) |
| D7 | sound のトラック別プレゼンス | **mic 単独 / system 単独**の concat を別々に短時間 RMS 包絡(`astats` の per-window / `ebur128` の S)で測り、同一時間窓で**どちらが大きいか(被り)**を `sound.json` に出す | 「system 音がマイク発話を食っている」を秒付きで可視化=診断の「トラック別プレゼンス・被り」に直答。mic/system のストリーム番号は `manifest.audio`(既存)から取れる。system が無い収録では mic 単独のみ(優雅に縮退) |
| D8 | BGM/ダッキングの扱い | v1 は**解析的に併記**(実測しない)。`buildRenderProps` が作る `props` の **BGM span + duck span**(既存 `renderProps.ts` の `buildDuck`)を読み、`sound.json` に「区間 X で BGM が config の volumeDb、発話区間 Y でダッキング duckDb」を秒付きで出す | 真のダッキングは Remotion(`Main.tsx`/`duckFactorAt`)にあり ffmpeg 再現は乖離リスク(§1「やらない」)。だが**設計値としての BGM 配置・ダッキング窓**は props から決定論的に取れ、「BGM がどこで鳴りどこで下がる設定か」は答えられる。実測 post-BGM は §9 の将来トリガー |
| D9 | 決定論と環境依存 | ffmpeg のみ=**全 OS・追加依存なし・決定論**。Apple Vision(OCR)は**使わない**。音声ストリーム欠落・proxy 不在は優雅に対処(§6) | motion/sound は OCR と違い macOS 依存が要らない=`frames --ocr` より広く動く。`av` を使わない限り ffmpeg は一切追加起動されない=バイト等価 |
| D10 | MCP 露出 | `cutflow_av` を **read 系 tool として露出**(`makeTools` に1件追加)。承認/render 系は従来どおり非露出 | `frames`/`materials`/`assert` と同じ知覚 tool。F3(や外部エージェント)が A/V を消費する主経路 |

---

## 3. データ形状(出力 JSON のスキーマ案)

`av.probe/` に3ファイル(motion 無効時は motion.json/PNG を書かない、逆も同様)。
時刻は**出力秒**を主、`sourceSec` を併記。すべて `schemaVersion` と陳腐化 `key` を持つ。

### 3.1 `av.probe/sound.json`

```ts
interface SoundReport {
  schemaVersion: number;            // 1
  capturedAt: string;               // ISO
  key: SoundKey;                    // 陳腐化判定(§4)
  range: { startSec: number; endSec: number }; // 出力秒(--range 省略時は全域)
  short: string | null;             // --short 名(本編は null)

  // ミックス(mic+system・ダッキング前・正規化前)の全体値
  mix: {
    integratedLufs: number;         // ebur128 統合 I
    loudnessRangeLu: number;        // ebur128 LRA
    truePeakDbtp: number;           // ebur128 トゥルーピーク
    clipping: {                     // astats 由来
      peakDbfs: number;
      clippedSamples: number;       // 0dBFS 到達サンプル数(>0 で要注意)
    };
    // 短時間ラウドネス包絡(ebur128 S。windowSec 間隔)
    envelope: { outSec: number; sourceSec: number; shortTermLufs: number }[];
  };

  // 無音/間(ミックスに対する silencedetect。出力秒)
  silences: { outSec: number; endOutSec: number; lenSec: number }[];

  // トラック別プレゼンス(§D7)。system が無い収録では system:null
  tracks: {
    windowSec: number;
    samples: {
      outSec: number;
      sourceSec: number;
      micRmsDb: number;
      systemRmsDb: number | null;
      louder: "mic" | "system" | "tie" | null; // 被りの向き
    }[];
  };

  // BGM/ダッキング(§D8。props から解析的に。bgm 未使用なら空配列)
  bgm: {
    spans: { startOutSec: number; endOutSec: number; volumeDb: number; file: string }[];
    duckSpans: { startOutSec: number; endOutSec: number; duckDb: number }[];
  };
}

interface SoundKey {
  // 音声に効く入力だけ(映像設定は含めない)
  source: { file: string; mtimeMs: number; size: number };
  keepsHash: string;                // mergeIntervals(keeps) の安定ハッシュ
  audio: { systemMix: boolean; systemVolumeDb: number; denoiseMic: boolean; noiseFloorDb: number; targetLufs: number };
  range: { startSec: number; endSec: number };
  short: string | null;
  windowSec: number;
}
```

### 3.2 `av.probe/motion.json`

```ts
interface MotionReport {
  schemaVersion: number;            // 1
  capturedAt: string;
  key: MotionKey;
  range: { startSec: number; endSec: number };
  short: string | null;
  base: "proxy" | "source";         // --full-res で "source"

  strip: {
    file: string;                   // "av.probe/motion.strip.png"(相対)
    cols: number; rows: number;
    tiles: { index: number; outSec: number; sourceSec: number }[]; // タイル索引→時刻
  };

  // 動き量(scdet のシーンスコアをサンプル区間で集約。0..1)
  motion: { outSec: number; sourceSec: number; sceneScore: number }[];

  // 静止(フリーズ)区間(freezedetect。出力秒。dev の間延び/ビルド待ち診断)
  frozen: { outSec: number; endOutSec: number; lenSec: number }[];
}

interface MotionKey {
  base: { file: string; mtimeMs: number; size: number }; // proxy か source
  keepsHash: string;
  range: { startSec: number; endSec: number };
  short: string | null;
  everySec: number; cols: number;
  freeze: { noiseDb: number; durationSec: number };
  scdetThreshold: number;
}
```

`motion.strip.png` は ffmpeg `fps=1/every,scale=W:-1,tile=colsxrows` で作る単一グリッド
PNG(基映像のサムネイル。合成なし=D4)。

### 3.3 `files.ts` への登録

`src/lib/files.ts` の `GENERATED_DIRS` に **`"av.probe"`** を追加するだけ:

```ts
const GENERATED_DIRS: readonly string[] = [
  "frames", "render.chunks", "shorts", "materials.probe", "av.probe",
];
```

これで `fileRole("av.probe/sound.json")` 等が `"generated"` になり、backup 退避対象外・
「手編集しない」分類に正しく載る。`EDITABLE_FILES` / `GENERATED_FILES`(直下固定名)/
`APPROVAL_FILE` はいずれも不変。`test/files.test.ts` に av.probe のケースを1行追加。

---

## 4. キャッシュ(差分更新型)

`materials.probe/` に倣う。`av.probe/{sound,motion}.json` を書く前に既存を読み、
`key` が現在の入力と一致すれば ffmpeg 群をスキップして前回結果をそのまま返す
(F3 の「同じ区間を何度も観る」反復で効く)。`key` の構成は §3(motion は映像入力・
sound は音声入力だけを含める=交差汚染しない)。`av.probe/` をディレクトリごと削除
すれば常にフル再計算に戻る(`materials.probe/`・`render.chunks/` と同じ契約)。

---

## 5. モジュール構成(純関数 / オーケストレータ分離)

`materials.ts`(純 `lib` + 不純 `stages`)と同じ流儀:

- **`src/lib/avParse.ts`(純関数・テスト対象・fs/ffmpeg 非依存)**
  - `parseEbur128(stderr): { integratedLufs; loudnessRangeLu; truePeakDbtp; envelope: {t; shortTermLufs}[] }`
  - `parseAstats(stderr): { peakDbfs; clippedSamples; rmsDb }`(mix/track 兼用)
  - `parseScdet(stderr): { t; sceneScore }[]`
  - `parseFreezedetect(stderr): { start; end }[]`(`silencedetect` parse と同型)
  - `parseSilences` は既存 `detectSilence`(`ffmpeg.ts`)を音声ベッドに使い回す
  - `keepsHash(keeps): string`(承認 hash と同じ sha256 の薄いラッパ or 既存流用)
  - `mapSamplesToOutput(samples, timeline)`: source 秒→出力秒(`timeline.ts` の
    `toOutputTime`/`toSourceTime` を使う純合成)
- **`src/lib/avFilters.ts`(純関数)**: ffmpeg 引数/フィルタ文字列の組み立て
  - 音声ベッドは `keepAudioParts`(既存 `lib/loudness.ts`)+ `ebur128`/`astats`/
    `silencedetect` を足す filter_complex 文字列(mix/mic単独/system単独の3系統)
  - motion の montage/scdet/freezedetect の `-vf` 文字列(`screenStill.ts` の
    `cropFilterArg`/`seekArg` と同じ「引数を組む純関数」流儀)
- **`src/stages/av.ts`(オーケストレータ・不純)**: 区間解決(keeps / short.ranges /
  range / every)→ proxy 陳腐化チェック(`isProxyStale`/`buildProxy` 流用)→ ffmpeg
  実行(`lib/exec.ts` の `run`)→ 純 parser へ渡す → `key` 判定 → `av.probe/` 書き出し
  → stdout 1行要約。BGM/duck は `buildRenderProps`(既存)を呼んで `props` から抽出。

---

## 6. 決定論と環境依存(優雅な劣化)

- **ffmpeg のみ**=Apple Vision 不要=全 OS で同じ結果(D9)。`av` 未使用なら ffmpeg は
  一切起動しない=バイト等価。
- **音声ストリーム無し**(映像のみ収録): sound は `mix`/`tracks` を空にし警告1行で
  motion だけ返す(例外を投げない)。
- **system ストリーム無し**: `tracks[].systemRmsDb=null`・`louder` を mic 基準に縮退、
  `bgm` は bgm.json / 直下 bgm.* が無ければ空。
- **proxy 不在/陳腐化**: `frames` と同じく `buildProxy`/`isProxyStale` で自動生成
  (`--full-res` 時は raw を使うので proxy 不要)。
- **keeps 0件 / range が出力尺外**: 明確なエラー(`frames` の同種メッセージに倣う)。
- **ffmpeg の scdet/freezedetect が古い版で無い環境**: 当該メトリクスだけ空配列+警告、
  フィルムストリップ PNG は出す(部分的劣化。全体は失敗させない)。

---

## 7. エージェント統合(F3 が読む形)

- **主経路は `av.probe/{sound,motion}.json`** の純 JSON(`describe --json` と同じく
  機械可読・完全射影)。F3 の観測ステップはこれを `JSON.parse` して「テンポが速すぎる/
  無音が長い/system がmicを食う/フリーズが○秒」を判断できる。
- **MCP `cutflow_av`**(D10)で外部エージェントも同じ観測を取得。`toToolResult` の
  human 行 + JSON payload 二層(既存 tools と同じ)。
- **assert との連携は将来拡張として明記(本 Feature ではやらない)**: `maxIntegratedLufs` /
  `noClipping` / `maxSilenceGapSec` / `noFrozenLongerThan` のような宣言的アサーション
  type を `assertions.json` に足すと F3 が「音がクリップしていない」を pass/fail で
  検証できる。ただしこれは assert(別 Feature)のスコープ。本 doc は**観測データの
  提供**まで(§1)。

---

## 8. タスク分解(1タスク=1コミット)

各タスクは (a) 触るファイル(シンボル名) (b) テスト方針 (c) 壊してはいけない既存挙動。
先行マージで行番号がずれるため**シンボル名でのみ**参照する。

### T1: 純パーサ `src/lib/avParse.ts`
- (a) 新規 `src/lib/avParse.ts`: `parseEbur128` / `parseAstats` / `parseScdet` /
  `parseFreezedetect` / `keepsHash` / `mapSamplesToOutput`。`ffmpeg.ts` の
  `detectSilence` の stderr parse を手本にする(**`ffmpeg.ts` は改変しない**)。
- (b) `test/avParse.test.ts`: 実 ffmpeg の stderr 出力を**固定文字列 fixture**として
  貼り、各 parser がその文字列から期待構造を返すことを `node --test` で固定。
  `mapSamplesToOutput` は既存 `timeline.ts` のテスト済み関数の合成として境界ケース
  (カット跨ぎ・range 端)を検証。
- (c) 純追加・他ファイル未 import=既存挙動に影響なし(バイト等価は自明)。

### T2: ffmpeg フィルタ組み立て `src/lib/avFilters.ts`
- (a) 新規 `src/lib/avFilters.ts`: 音声ベッド filter_complex(`keepAudioParts` を import
  して mix/mic/system の3系統に `ebur128`/`astats`/`silencedetect` を接続)+ motion の
  `-vf`(montage/scdet/freezedetect)を返す純関数群。
- (b) `test/avFilters.test.ts`: 生成される引数配列/フィルタ文字列をスナップショット
  固定(keeps 1件/複数件、system 有無、--full-res の分岐)。
- (c) `lib/loudness.ts`(`keepAudioParts`)は**読むだけ**=`cut.mp4`/`preview`/`proxy`
  の音声経路に影響なし。純追加。

### T3: オーケストレータ `src/stages/av.ts`
- (a) 新規 `src/stages/av.ts`: `av(dir, opts, cfg): AvResult`。区間解決(`mergeIntervals`
  / `loadShort` / range / every は frames.ts の `buildTargets` の考え方を流用)、
  `isProxyStale`/`buildProxy` 流用、`run("ffmpeg", …)` 実行、T1/T2 を束ねて
  `av.probe/{sound,motion}.json` + `motion.strip.png` を書く。BGM/duck は
  `buildRenderProps` を呼んで `props.bgm`/`props.duck` から抽出。`key` 差分再利用。
  `formatAvSummary(report): string[]`(stdout 1行要約。`formatMaterialsSummary` と同型)。
- (b) `test/av.test.ts`: 実 ffmpeg を要するので**実データ統合テスト**(§10)+ 純
  部分(区間解決・key 等値・summary 整形)は関数を切り出してユニット。key 差分
  再利用の分岐(unchanged→スキップ)を fingerprint モックで固定。
- (c) 新規ファイル。`frames.ts`/`render.ts`/`materials.ts` は import しない=不変。

### T4: `config.yaml` に `av` ブロック
- (a) `config.yaml` に `av:`(`everySec` 既定 5 / `cols` 既定 5 / `windowSec` 既定 1 /
  `scdetThreshold` / `freeze: {noiseDb, durationSec}` / `stripWidthPx`)。`src/lib/config.ts`
  の型に `av?` を**オプショナル**で追加し、`av.ts` が既定値でフォールバック。
- (b) `test/config.test.ts` に `av` 既定解決のケース追加。
- (c) **`av:` を省略した config は完全に従来どおり**(オプショナル・全既定で埋める)。
  既存 config を読む他コマンドに一切影響しない=バイト等価。

### T5: `files.ts` に `av.probe` 登録
- (a) `src/lib/files.ts` の `GENERATED_DIRS` に `"av.probe"` 追加(§3.3)。
- (b) `test/files.test.ts`: `fileRole("av.probe/sound.json") === "generated"` を追加。
- (c) `EDITABLE_FILES`/`GENERATED_FILES`/`APPROVAL_FILE`/`fileRole` の他分岐は不変。

### T6: CLI 配線 `av <dir>`
- (a) `src/cli.ts`: `program.command("av <dir>")` を追加(`--range` / `--every` /
  `--short` / `--full-res` / `--motion-only` / `--sound-only`)。`materials`/`frames`
  コマンドの action を手本に `av()` を呼び `formatAvSummary` を出力。
- (b) `test/` の CLI レベルは既存 `cliRunIdStamp.test.ts` 等の型で最小限(引数排他の
  検証)。主検証は §10 の実データ。
- (c) 既存コマンド定義は不変。新 `command` 追加のみ=他コマンドのパースに影響なし。

### T7: MCP tool `cutflow_av`
- (a) `src/mcp/tools.ts`: `makeTools` の配列に `cutflow_av` を1件追加(`inputSchema` は
  range/every/short/fullRes/motionOnly/soundOnly、handler は `av()` を呼び
  `toToolResult`)。引数検証は `parseFramesArgs` と同じ流儀。
- (b) `test/mcpTools.test.ts`: tool 一覧に `cutflow_av` が出ること・handler が
  ToolResult 二層を返すことを固定。
- (c) 既存7 tool の定義・順序は不変(配列末尾に追加)。approve/render 系が非露出の
  ままであること(既存テスト)を壊さない。

### T8: ドキュメント + ピン留めテスト整合
- (a) `CLAUDE.md`(知覚セクション + 中間生成物一覧に `av.probe/` + コマンド一覧に `av`)、
  `docs/usage.md`(`av` の節・表)、`AGENTS_CONTRACT.md`(§コマンド一覧・`GENERATED_DIRS` 相当の
  記述)。
- (b) `test/agentsMd.test.ts`(コマンド名 `av` / 生成ディレクトリ `av.probe` の網羅を
  ピン留めしているため追随必須)を通す。`schemas/*` は EDITABLE スキーマを変えない
  ので**追加不要**(av.probe は生成物で `validate`/`apply`/`@id`/承認の対象外)。
- (c) 既存ドキュメントのバイト固定 golden(`describe.golden.txt` 等)には触れない。

> 依存順: T1→T2→T3(コア)。T4/T5 は T3 と並行可。T6/T7 は T3 後。T8 は最後。
> **各コミットで `npm run typecheck` + `npm test` が緑**であること。

---

## 9. 将来トリガー(本 Feature で線を引いた先)

- **真の post-BGM ミックス実測**(BGM+ダッキング込み LUFS): `preview.mp4` が存在すれば
  その音声を直接 `ebur128` にかける経路を opt-in で足す(render 済み前提)。または
  `duckFactorAt` を volume-envelope 化して ffmpeg で再現(乖離検証込み)。
- **assert への A/V アサーション type**(§7): `noClipping` / `maxSilenceGapSec` /
  `noFrozenLongerThan`。F3 の自己検証を pass/fail 化。
- **`plan.perception` への motion/sound 注入**: カット判断 LLM に「この区間は動きが無い/
  無音が長い」を渡す(audio-perception / eyes-ears doc と統合)。
- **非言語音・話者分離**: 重 ML。思想を保つなら Later のまま。

---

## 10. 実データ検証(タスクに織り込む)

実収録 `~/Movies/cutflow/2026-07-02-whisper-bench` と `~/Movies/cutflow/2026-07-07`
(proxy.mp4・audio/・*.json・materials/ あり)で手動検証する:

1. `node src/cli.ts av <dir>` → `av.probe/{sound,motion}.json` + `motion.strip.png` が
   でき、`sound.json` の統合 LUFS が既知の収録音量とオーダー一致、`silences` が
   `cuts.auto.json`(既存)の無音とおおむね対応することを確認。
2. `motion.strip.png` を Read で目視し、フィルムストリップが基映像の時系列になっている
   こと・`motion.json` のタイル索引→時刻が絵と一致することを確認。
3. `--short <name>` / `--range` / `--full-res` / `--motion-only` / `--sound-only` の
   分岐を1回ずつ。
4. **決定論**: 同じ引数で2回実行し JSON(capturedAt 除く)が一致すること + 2回目が
   `key` 一致で ffmpeg スキップになることを確認。
5. **バイト等価**: `av` を一度も実行していない収録で `validate`/`describe`/`frames` の
   出力・`git status`(av.probe 以外)が変わらないこと。
6. **検証用に作った `av.probe/` は実収録に残さず削除する**(`materials.probe/` 等と
   同じ中間生成物だが、検証痕跡を残さない)。system 音声が無い収録では `tracks` が
   mic のみに縮退すること・映像のみ素材での優雅な劣化も1件確認。

---

## 11. 先に読むべきコード(実装者向け)

- 知覚コマンドの前例(オーケストレータ/純関数分離・差分キャッシュ):
  `src/stages/materials.ts` / `src/lib/materials.ts`
- 区間サンプリング・proxy 陳腐化・short 解決・timeline 写像:
  `src/stages/frames.ts`(`buildTargets` / `isProxyStale` / `loadShort`)、
  `src/lib/timeline.ts`(`buildTimeline` / `toOutputTime` / `toSourceTime` / `mergeIntervals`)
- ffmpeg ラッパー・stderr parse の前例: `src/lib/ffmpeg.ts`(`detectSilence` / `probe` /
  `run` 経由)、`src/lib/exec.ts`
- 音声ベッド(mic+system concat・loudnorm 実測): `src/lib/loudness.ts`
  (`keepAudioParts` / `audioSourceOf` / `measuredLoudnormFilter`)、`src/stages/render.ts`
  (`cutFullRes`)、`src/stages/proxy.ts`
- BGM/ダッキング span の出所: `src/lib/renderProps.ts`(`buildDuck`)、`src/lib/duck.ts`、
  `remotion/Main.tsx`(`BgmTrack` — 読むだけ)
- 基映像クロップ/still 引数の純関数流儀: `src/lib/screenStill.ts`
- ファイル分類: `src/lib/files.ts`。CLI 配線: `src/cli.ts`(`materials`/`frames` の action)。
  MCP: `src/mcp/tools.ts`(`makeTools`)。設定: `config.yaml` / `src/lib/config.ts`
- 診断の該当箇所: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`(Theme D / 「5条件」#5)

---

## 12. スコープ外(明示的にやらないこと)

- **F1(GUI)**: エディタへの波形/モーション表示・A/V の差分レビュー UI。
- **F3(エージェントループ本体)**: `plan` を観測→再調整ループにする配線・予測アクション。
  本 Feature は F3 が読む観測データ(`av.probe/*.json`・`cutflow_av`)の**提供まで**。
- **真の post-BGM/ダッキング実測**・**assert への A/V type 追加**・**`plan.perception`
  への注入**(いずれも §9 の将来トリガー)。
- **音響話者分離・非言語音イベント分類**(重 ML・非決定論=思想違反)。
- **`EDITABLE_FILES` / 描画契約 / `@id` / 承認 hash / `schemas/*` の変更**:
  `av.probe/` は読むだけの生成物で、これらに一切波及しない。
- **既存 `frames`/`render`/`materials`/`describe` の挙動変更**: `av` は独立コマンドで、
  既存コードは import して再利用するのみ(改変しない)。未使用時バイト等価。
