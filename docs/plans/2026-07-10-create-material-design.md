# Editor AI `create-material` 設計

## 背景

現状の Editor AI は、素材を必要とする指示に対して `place-material`
task か `overlays.inserts` の JSON だけを作れる。しかし `materials/opening.mp4`
のような未存在ファイルを参照すると、実ファイルが無いまま editable JSON が
更新され、`validate` で落ちる。

今回の目的は、Editor AI に高水準 task `create-material` を追加し、実際に
recording folder の `materials/` 配下へ素材ファイルを生成してから、その
素材を後続の `place-material` や `overlays.inserts` で参照できる状態にすること。

重要な制約:

- 動画生成 AI / 画像生成 AI / 外部 text-to-video / text-to-image API に依存しない。
- ローカル生成で完結する。
- AI 未設定でも既存 deterministic CLI / editor / render は壊さない。
- provider failure で editable JSON を壊さない。
- 生成物が存在しないまま JSON だけが更新される状態を作らない。

参考素材:

- `/Users/19mo/Movies/cutflow/2026-07-02/materials/opening.mp4`
- `ffprobe` 実測: 1920x1080、動画 2.5 秒、音声 2.56 秒、30fps、H.264 + AAC。
- 構成: 暗い背景、中央タイトル、下線、フェード/線アニメーション。
- メタデータ上は Remotion 4.0.484 で作られている。

## 結論

`create-material` は JSON 編集 task ではなく、**素材生成を含む副作用 task** として扱う。
Editor AI 提案の planning 中に、`materials/` へ一時ファイルとして生成し、ffprobe
で検証してから最終ファイルへ atomic rename する。その後に `place-material` を
コンパイルする。

適用順序は固定する。

1. AI 応答を parse / normalize する。
2. `create-material` tasks を解決して、実ファイルを `materials/` に生成する。
3. 生成に成功した task だけを `materialId -> file` の map に登録する。
4. 後続の `place-material` は `file` 直接指定か `materialRef` 経由で実在ファイルを参照する。
5. `planIntentEdits` / `planApply` / `validateDocs` を既存経路で実行する。
6. どこかで失敗したら editable JSON は一切書かない。必要なら生成済みの未参照素材だけ削除する。

この順序により、`place-material` の既存 `safeExistingPath` ガードを強みにできる。
未生成素材を参照した JSON はコンパイル段階で拒否される。

## Task 仕様

`EditIntent` に `create-material` を追加する。

```ts
type CreateMaterialIntent = {
  type: "create-material";
  id: string;
  kind: "title-card";
  file?: string;
  spec: {
    text: string;
    subtitle?: string;
    durationSec?: number;
    width?: number;
    height?: number;
    fps?: number;
    theme?: "dark" | "light" | "brand";
    accentColor?: string;
    backgroundColor?: string;
    audio?: "silent" | "tone" | "none";
  };
};
```

`id` は同じ AI 応答内の参照用で、`mat_opening` のような任意文字列を許す。
`@id` ではない。生成後の実ファイルパスは `createdMaterials[id].file` として
保持する。

後続 `place-material` は `materialRef` を受け付ける。

```ts
type PlaceMaterialIntent = {
  type: "place-material";
  file?: string;
  materialRef?: string;
  range: { startSec: number; endSec: number };
  placement:
    | { mode: "overlay"; rect?: Region; fit?: "contain" | "cover"; track?: number }
    | { mode: "insert"; durationSec?: number; startFrom?: number; fit?: "contain" | "cover" };
  audio?: { volume: number };
};
```

`materialRef` がある場合は `create-material.id` で解決する。`file` と
`materialRef` が両方ある場合はエラーにする。`insert.durationSec` 省略時は
生成素材の probe 結果の `durationSec` を使う。

AI の出力例:

```json
{
  "title": "オープニングを追加",
  "summary": ["タイトルカードを生成し、冒頭に挿入します"],
  "edit": {
    "mode": "tasks",
    "tasks": [
      {
        "type": "create-material",
        "id": "opening_card",
        "kind": "title-card",
        "file": "opening.mp4",
        "spec": {
          "text": "Cutflow Demo",
          "subtitle": "Local-first video editing",
          "durationSec": 2.56,
          "width": 1920,
          "height": 1080,
          "fps": 30,
          "theme": "dark",
          "audio": "silent"
        }
      },
      {
        "type": "place-material",
        "materialRef": "opening_card",
        "range": { "startSec": 0, "endSec": 0.1 },
        "placement": { "mode": "insert", "fit": "cover" }
      }
    ]
  },
  "review": {
    "frames": [{ "axis": "output", "atSec": 1.2, "reason": "opening card center" }],
    "notes": ["生成素材は materials/opening.mp4 です"]
  }
}
```

## ローカル生成器

初期実装は `kind: "title-card"` のみ対応する。これは「動画生成AI」ではなく、
ローカルのプログラム描画 + エンコードである。

推奨実装:

- `src/lib/materialGenerator.ts` を新設する。
- Remotion に `TitleCard` Composition を追加する。
- `@remotion/renderer` の `renderMedia` で mp4 を生成する。
- `codec: "h264"`、`fps: 30`、既定 `1920x1080`、既定 `durationSec: 2.56`。
- 音声は v1 では `audio: "silent"` を既定とし、必要なら ffmpeg の `anullsrc`
  で AAC の無音トラックを mux する。
- 見た目は deterministic props で決める。AI は画像を生成せず、テキストや色などの
  パラメータだけを渡す。

TitleCard の最低要件:

- 暗いグラデーション背景。
- 中央タイトル。
- 任意のサブタイトル。
- 下線の横方向 reveal。
- 全体の fade in / fade out。
- 文字サイズは画面幅とテキスト長から deterministic に決める。

Remotion を選ぶ理由:

- 既存プロジェクトが Remotion を render / frames / review / thumbnail に使っている。
- H.264 mp4 生成の既存依存がある。
- ffmpeg filter の drawtext よりテキストレイアウト、CSS、アニメーションの保守性が高い。
- 生成 AI を使わず、完全に local-first。

ffmpeg は補助として使う。

- 生成後の `ffprobe` 検証。
- `audio: "silent"` の AAC 無音トラック付与。
- 将来 `kind: "solid-card"` のような超軽量生成を追加する場合の代替 backend。

## ファイル命名と安全性

`create-material.file` は任意だが、保存先は必ず `materials/` 直下に限定する。

規則:

- 入力が `opening.mp4` なら出力は `materials/opening.mp4`。
- 入力が `materials/opening.mp4` でも受け付けるが、内部的には basename を使う。
- パス区切り、先頭ドット、危険文字はアップロード処理と同じ方針で潰す。
- 拡張子は v1 では `.mp4` のみ。
- 同名が存在する場合は `opening-2.mp4`, `opening-3.mp4` のように衝突回避する。
- 一時出力は `materials/.cutflow-create-<pid>-<uuid>.mp4` に書き、検証後に最終名へ rename する。
- 失敗時は一時ファイルを削除する。

`materials/` は `AGENTS_CONTRACT.md` 上も人間の素材置き場であり generated dir ではない。
`create-material` は「ユーザー指示に基づいて素材を作る編集操作」なので、ここに置く。
`materials.probe/` は引き続き知覚キャッシュであり、生成物の置き場にしない。

## トランザクション境界

Editor AI の提案生成時点では、現状すでに `proposeEditorAi` が patch を計画し、
GUI が proposal と diff を表示する。`create-material` はここに副作用を持ち込むため、
失敗時の後始末を明確にする。

### v1 方針

`proposeEditorAi` 中で素材を生成する。成功した素材はすぐ `materials/` に残る。
ただし editable JSON はまだ保存しない。ユーザーが proposal を reject した場合、
未使用素材が残る可能性はあるが、JSON は壊れない。

理由:

- 現在の GUI proposal store は JSON patch / review を中心にしており、accept 時だけ
  副作用を実行するには proposal lifecycle の拡張が大きい。
- 生成済み素材が未使用で残ることは安全側のゴミであり、「JSON が存在しない素材を
  参照する」よりはるかに良い。
- `materials <dir>` は未使用素材を検出できる。

### v2 候補

proposal に `sideEffects.createdMaterials[]` を持たせ、accept 時に生成する二相方式にする。

- preview/review 用には一時素材を使う。
- accept で最終 `materials/` へ commit。
- reject / expire で一時素材を削除。

ただし v1 の要件「生成した素材はその後の `place-material` や `overlays.inserts`
で参照できる」を満たすには、提案時生成で十分。

## 失敗時の扱い

失敗は `Problem[]` として Editor AI の通常エラーに変換する。

生成エラー例:

- Remotion render failure。
- ffmpeg / ffprobe 不在。
- duration / width / height が期待範囲外。
- 出力ファイルが存在しない。
- 0 byte。
- H.264 以外、または mp4 として probe できない。

原則:

- `create-material` が 1 件でも失敗したら、その AI 提案全体を失敗にする。
- 後続 `place-material` は実行しない。
- `planApply` は呼ばないか、呼んでも書かない。
- 既に同じ提案内で生成済みのファイルは、後続失敗時に削除できるなら削除する。
  ただし既存ファイルを上書きしない設計なので、削除対象は `createdByThisAttempt`
  に限定する。
- editable JSON は一切変更しない。

provider failure について:

- AI provider failure は `completeWithJsonSchema` の時点で起こるため、素材生成前。
- 生成器 failure は AI provider と独立して扱う。
- `refineEditorAi` では v1 は `create-material` を禁止する。既存 proposal の JSON
  修正に限定し、追加副作用を避ける。

## validate / describe / render との関係

`validate` は現状でも overlays/inserts/bgm の `file` 存在を検査している。
このガードは維持し、`create-material` 専用の特別扱いは入れない。

`describe --json` は既存通り `exists: true/false` を返す。生成成功後は
`materials/opening.mp4` が通常素材として見える。

`render` は既存通り Remotion の `<OffthreadVideo>` / `<Audio>` で素材を読む。
生成素材に特別な code path は不要。

`materials <dir>` は生成後に任意で実行できる。初期実装では自動実行しない。
理由は、`materials.probe/` は知覚キャッシュであり、生成 task の成功条件では
ないため。

## Editor AI prompt / schema 変更

`prompts/editor-ai-propose.md` を更新する。

- valid task に `create-material` を追加する。
- 「新しい素材を必要とする場合、存在しない `materials/foo.mp4` を直接参照せず、
  先に `create-material` を返す」と明記する。
- 「外部生成 AI は使えない。title-card はローカル描画で生成される」と明記する。
- 「既存素材を置くだけなら `place-material.file`、新規素材を作るなら
  `create-material` + `place-material.materialRef`」と明記する。

`EDITOR_AI_RESPONSE_SCHEMA` は `strict: false` のままで、task enum とフィールドだけ追加する。

## 実装単位

### 1. 型と正規化

対象:

- `src/lib/editIntent.ts`
- `src/stages/editorAi.ts`
- `test/editIntent.test.ts`

変更:

- `EditIntent` union に `create-material` を追加。
- `place-material` に `materialRef?: string` を追加。
- `normalizeEditIntents` で `create-material` を通す。
- `create-material` が `compileEditIntents` に直接来た場合はエラーにする。
  生成解決後の task list だけが `compileEditIntents` に渡るべきであるため。

### 2. 生成器

対象:

- `src/lib/materialGenerator.ts` 新規
- `remotion/Root.tsx`
- `remotion/TitleCard.tsx` 新規

API:

```ts
export interface GeneratedMaterial {
  id: string;
  file: string;
  absPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export async function createMaterial(
  dir: string,
  intent: CreateMaterialIntent,
): Promise<GeneratedMaterial>;
```

`createMaterial` は最終ファイルが存在し、ffprobe 検証済みのときだけ resolve する。

### 3. task 解決オーケストレータ

対象:

- `src/lib/editIntent.ts` または新規 `src/lib/editorAiMaterials.ts`
- `src/stages/editorAi.ts`

API:

```ts
export async function resolveMaterialCreationTasks(
  dir: string,
  intents: EditIntent[],
): Promise<{ intents: EditIntent[]; created: GeneratedMaterial[]; warnings: Problem[] }>;
```

処理:

- task を順に走査する。
- `create-material` は生成して map に積む。出力 task list からは除外する。
- `place-material.materialRef` は map から `file` へ置換する。
- 未解決 ref はエラー。
- `insert.durationSec` が無ければ生成素材の duration を補う。

`planEditorAiPatch` は async に変更し、`planIntentEdits` の前にこの解決を挟む。

### 4. Editor server のジョブ分類

対象:

- `editor/server.ts`

`propose` heavy job の中で生成が走る。既存の `heavyJob` で同時実行は抑制されるため、
新しいジョブ種別は必須ではない。ただし UI 文言を分けたい場合は
`HeavyJobStage = "material" | ...` ではなく、`propose` のまま
「AI提案生成」に含めるのが v1 では簡単。

### 5. docs

対象:

- `docs/usage.md`
- `AGENTS_CONTRACT.md`

追記内容:

- `materials/` は通常の素材置き場で、`create-material` により新規ファイルが
  作られることがある。
- `materials.probe/` は引き続き generated cache。
- AI / agent は存在しない素材パスを JSON に書かず、生成 task かアップロードで
  実ファイルを先に用意する。

`AGENTS_CONTRACT.md` の「Files you must NOT write」には `materials/` を追加しない。
`materials/` は禁止対象ではない。

## テスト計画

単体:

- `create-material` intent の validation。
- `materialRef` が実生成ファイルに置換される。
- 未解決 `materialRef` はエラー。
- `create-material` が `compileEditIntents` に残ったらエラー。
- `insert.durationSec` 省略時に probe duration が補われる。

統合:

- temp recording folder に title-card を生成し、`materials/opening.mp4` が存在する。
- `ffprobe` で H.264 mp4、1920x1080、duration 約 2.56 秒を確認する。
- 生成後に `place-material` insert を含む proposal を `planEditorAiPatch` し、
  `validateDocs` が error 0 になる。
- 生成器を失敗させた場合、`overlays.json` が変更されない。
- 後続 task 失敗時、同 attempt で作った素材が削除される。

手動:

```sh
npm test
npm run typecheck
node src/cli.ts editor /Users/19mo/Movies/cutflow/2026-07-02
node src/cli.ts validate /Users/19mo/Movies/cutflow/2026-07-02
node src/cli.ts materials /Users/19mo/Movies/cutflow/2026-07-02
node src/cli.ts frames /Users/19mo/Movies/cutflow/2026-07-02 --t 0,1.2
```

## 実装レシピ

この節は、実装担当モデルが判断を減らして順番に作業できるようにした作業票。
上から順に進める。途中で壊れた場合は、次へ進まずその段階のテストを直す。

### Step 0: 既存変更の保護

作業前に必ず確認する。

```sh
git status --short
```

既に変更があるファイルは、差分を読んでから編集する。特に次のファイルは既存変更が
入りやすい。

- `prompts/editor-ai-propose.md`
- `src/stages/editorAi.ts`
- `test/editorAi.test.ts`
- `config.yaml`

既存変更を戻さない。`git checkout --` や `git reset --hard` は使わない。

### Step 1: `EditIntent` 型だけを拡張する

対象: `src/lib/editIntent.ts`

追加する型:

```ts
export type CreateMaterialIntent = {
  type: "create-material";
  id: string;
  kind: "title-card";
  file?: string;
  spec: {
    text: string;
    subtitle?: string;
    durationSec?: number;
    width?: number;
    height?: number;
    fps?: number;
    theme?: "dark" | "light" | "brand";
    accentColor?: string;
    backgroundColor?: string;
    audio?: "silent" | "none";
  };
};
```

`EditIntent` union に `CreateMaterialIntent` を足す。

`place-material` は次のように変更する。

```ts
| {
    type: "place-material";
    file?: string;
    materialRef?: string;
    range: { startSec: number; endSec: number };
    placement:
      | { mode: "overlay"; rect?: Region; fit?: "contain" | "cover"; track?: number }
      | { mode: "insert"; durationSec?: number; startFrom?: number; fit?: "contain" | "cover" };
    audio?: { volume: number };
  };
```

この段階では `compileEditIntents` はまだ `materialRef` を解決しない。
`compileEditIntents` に次の防御を入れる。

- `intent.type === "create-material"` なら error。
- エラーメッセージは `create-material は事前解決が必要です`。
- `place-material` は `file` が string かつ実在するときだけ通す。
- `materialRef` が残っている `place-material` は error。

理由: `compileEditIntents` は純粋に editable JSON patch を作る関数として維持する。
素材生成の副作用をここに入れない。

最低限のテスト:

- `compileEditIntents(docs(), [{ type: "create-material", ... }])` は patch `{}` と error 1。
- `place-material` に `materialRef` だけが残っていたら error。

### Step 2: AI 応答 schema / normalize を広げる

対象: `src/stages/editorAi.ts`

`EDITOR_AI_RESPONSE_SCHEMA` の task enum に `create-material` を足す。

task item の properties に追加する。

```ts
id: { type: "string" },
kind: { enum: ["title-card"] },
spec: { type: "object" },
materialRef: { type: "string" },
```

`normalizeEditIntents` の分岐に `create-material` を追加する。
正規化は最小限でよい。

```ts
if (item.type === "create-material") {
  return item as unknown as EditIntent;
}
```

`place-material` の既存正規化は維持し、`materialRef` を落とさない。

この段階では `planEditorAiPatch` はまだ同期関数のままでよい。
Step 4 で async 化する。

### Step 3: Remotion `TitleCard` を追加する

対象:

- `remotion/TitleCard.tsx` 新規
- `remotion/Root.tsx`

`TitleCard.tsx` の props は次で固定する。

```ts
export interface TitleCardProps {
  text: string;
  subtitle?: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  theme: "dark" | "light" | "brand";
  accentColor: string;
  backgroundColor: string;
}
```

コンポーネントは `useCurrentFrame` と `useVideoConfig` を使い、次を描く。

- `AbsoluteFill` の背景。
- 背景は `linear-gradient` と薄い円形 glow 2 個。
- 中央に title。
- subtitle があれば title 下に表示。
- 下線は `transform: scaleX(progress)` で 0 から 1 へ伸ばす。
- 全体 opacity は `interpolate` で fade in/out。

推奨アニメーション:

```ts
const frame = useCurrentFrame();
const { fps, durationInFrames } = useVideoConfig();
const t = frame / fps;
const fadeIn = Math.min(1, t / 0.35);
const fadeOut = Math.min(1, (durationInFrames - frame) / (fps * 0.35));
const opacity = Math.max(0, Math.min(fadeIn, fadeOut));
const lineProgress = Math.max(0, Math.min(1, (t - 0.35) / 0.65));
```

フォントは既存字幕の標準に寄せたい場合、`CAPTION_DEFAULT_FONT_FAMILY` を使ってよい。
ただし import が重くなるなら CSS font-family 文字列でよい。タイトルカードは素材生成用で、
本編 caption layout とは独立している。

`Root.tsx` に Composition を追加する。

```tsx
<Composition
  id="TitleCard"
  component={TitleCard}
  durationInFrames={77}
  fps={30}
  width={1920}
  height={1080}
  defaultProps={{
    text: "Title",
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 2.56,
    theme: "dark",
    accentColor: "#d8b45f",
    backgroundColor: "#101216",
  }}
  calculateMetadata={({ props }: { props: TitleCardProps }) => ({
    durationInFrames: Math.max(1, Math.round(props.durationSec * props.fps)),
    fps: props.fps,
    width: props.width,
    height: props.height,
  })}
/>
```

注意:

- 既存 `Main` Composition を壊さない。
- `defaultProps` は `TitleCard` 専用にする。`defaultProps` from `props.ts` と混ぜない。
- `Root.tsx` の import を追加するだけに留める。

### Step 4: `materialGenerator.ts` を作る

対象: `src/lib/materialGenerator.ts` 新規

このファイルに副作用を集約する。`editIntent.ts` には fs / Remotion / ffmpeg を入れない。

必要 import:

```ts
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { probe, summarizeProbe } from "./ffmpeg.ts";
import { run } from "./exec.ts";
import type { CreateMaterialIntent } from "./editIntent.ts";
```

実際の `@remotion/renderer` の import は既存 `src/stages/thumbnail.ts` や
`src/stages/review.ts` に合わせる。`ensureBrowser` / `openBrowser` が同じ import で
取れない場合は既存ファイルと同じ書き方にする。

定数:

```ts
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION_SEC = 2.56;
const DEFAULT_ACCENT = "#d8b45f";
const DEFAULT_DARK_BG = "#101216";
```

公開型:

```ts
export interface GeneratedMaterial {
  id: string;
  file: string;
  absPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}
```

ファイル名 sanitization:

```ts
function safeMaterialName(raw: string | undefined, fallbackStem: string): string {
  const base = basename(raw ?? `${fallbackStem}.mp4`)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "");
  const ext = extname(base).toLowerCase();
  const stem = ext ? base.slice(0, -ext.length) : base;
  const safeStem = stem.trim() || fallbackStem;
  if (ext !== "" && ext !== ".mp4") throw new Error(`create-material は .mp4 のみ対応です: ${raw}`);
  return `${safeStem}.mp4`;
}
```

衝突回避:

```ts
function uniqueMaterialPath(dir: string, preferredName: string): { rel: string; abs: string } {
  mkdirSync(join(dir, "materials"), { recursive: true });
  const ext = extname(preferredName);
  const stem = preferredName.slice(0, -ext.length);
  let name = preferredName;
  for (let i = 2; existsSync(join(dir, "materials", name)); i++) {
    name = `${stem}-${i}${ext}`;
  }
  return { rel: `materials/${name}`, abs: join(dir, "materials", name) };
}
```

`createMaterial` の疑似コード:

```ts
export async function createMaterial(dir: string, intent: CreateMaterialIntent): Promise<GeneratedMaterial> {
  validateCreateMaterialIntent(intent);
  const width = clampInt(intent.spec.width, 320, 7680, DEFAULT_WIDTH);
  const height = clampInt(intent.spec.height, 180, 4320, DEFAULT_HEIGHT);
  const fps = clampInt(intent.spec.fps, 1, 120, DEFAULT_FPS);
  const durationSec = clampNumber(intent.spec.durationSec, 0.5, 30, DEFAULT_DURATION_SEC);
  const preferred = safeMaterialName(intent.file, intent.id || "material");
  const finalPath = uniqueMaterialPath(dir, preferred);
  const tmpAbs = join(dir, "materials", `.cutflow-create-${process.pid}-${randomUUID()}.mp4`);
  const tmpVideoAbs = join(dir, "materials", `.cutflow-create-${process.pid}-${randomUUID()}.video.mp4`);
  try {
    await renderTitleCardMp4(dir, tmpVideoAbs, { ...props });
    if ((intent.spec.audio ?? "silent") === "silent") {
      await muxSilentAac(tmpVideoAbs, tmpAbs, durationSec);
      rmSync(tmpVideoAbs, { force: true });
    } else {
      renameSync(tmpVideoAbs, tmpAbs);
    }
    const meta = await verifyGeneratedMp4(tmpAbs, { width, height, durationSec });
    renameSync(tmpAbs, finalPath.abs);
    return { id: intent.id, file: finalPath.rel, absPath: finalPath.abs, ...meta };
  } catch (error) {
    rmSync(tmpAbs, { force: true });
    rmSync(tmpVideoAbs, { force: true });
    throw error;
  }
}
```

`renderTitleCardMp4` の疑似コード:

```ts
async function renderTitleCardMp4(dir: string, outFile: string, props: TitleCardProps): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  await ensureBrowser();
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome");
  try {
    const composition = await selectComposition({
      serveUrl,
      id: "TitleCard",
      inputProps: props as unknown as Record<string, unknown>,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    await renderMedia({
      composition,
      serveUrl,
      outputLocation: outFile,
      codec: "h264",
      inputProps: props as unknown as Record<string, unknown>,
      puppeteerInstance: browser,
      overwrite: true,
      logLevel: "warn",
    });
  } finally {
    await browser.close({ silent: true });
  }
}
```

silent AAC mux:

```ts
async function muxSilentAac(videoFile: string, outFile: string, durationSec: number): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-i", videoFile,
    "-f", "lavfi",
    "-t", String(durationSec),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    outFile,
  ]);
}
```

検証:

```ts
async function verifyGeneratedMp4(file: string, expected: { width: number; height: number; durationSec: number }) {
  if (!existsSync(file)) throw new Error(`生成素材がありません: ${file}`);
  const st = statSync(file);
  if (st.size <= 0) throw new Error(`生成素材が空です: ${file}`);
  const p = summarizeProbe(await probe(file));
  if (p.videoCodec !== "h264") throw new Error(`生成素材が H.264 ではありません: ${p.videoCodec ?? "unknown"}`);
  if (p.width !== expected.width || p.height !== expected.height) {
    throw new Error(`生成素材の解像度が不正です: ${p.width}x${p.height}`);
  }
  if (p.durationSec === undefined || Math.abs(p.durationSec - expected.durationSec) > 0.25) {
    throw new Error(`生成素材の尺が不正です: ${p.durationSec ?? "unknown"}秒`);
  }
  return {
    durationSec: p.durationSec,
    width: p.width,
    height: p.height,
    fps: p.fps ?? DEFAULT_FPS,
  };
}
```

`audio: "none"` の場合は AAC が無いので、検証で `hasAudio` は要求しない。
参考素材に合わせたい場合の既定は `silent`。

### Step 5: `resolveMaterialCreationTasks` を作る

対象: `src/lib/editorAiMaterials.ts` 新規

役割:

- `create-material` を実行する。
- 同じ task list 内の `place-material.materialRef` を `file` に解決する。
- 生成副作用の cleanup を一箇所に閉じ込める。

公開型:

```ts
export interface ResolveMaterialCreationResult {
  intents: EditIntent[];
  created: GeneratedMaterial[];
  warnings: Problem[];
}
```

関数 signature:

```ts
export async function resolveMaterialCreationTasks(
  dir: string,
  intents: EditIntent[],
): Promise<ResolveMaterialCreationResult>;
```

疑似コード:

```ts
export async function resolveMaterialCreationTasks(dir: string, intents: EditIntent[]) {
  const created: GeneratedMaterial[] = [];
  const byId = new Map<string, GeneratedMaterial>();
  const resolved: EditIntent[] = [];
  try {
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      if (intent.type === "create-material") {
        validateCreateMaterialTaskShape(intent, i, byId);
        const material = await createMaterial(dir, intent);
        created.push(material);
        byId.set(intent.id, material);
        continue;
      }
      if (intent.type === "place-material" && "materialRef" in intent && intent.materialRef !== undefined) {
        if (intent.file !== undefined) {
          throw intentProblem(i, "file と materialRef は同時に指定できません");
        }
        const material = byId.get(intent.materialRef);
        if (!material) {
          throw intentProblem(i, `materialRef が未解決です: ${intent.materialRef}`);
        }
        const next = clone(intent);
        delete next.materialRef;
        next.file = material.file;
        if (next.placement.mode === "insert" && next.placement.durationSec === undefined) {
          next.placement.durationSec = material.durationSec;
        }
        resolved.push(next);
        continue;
      }
      resolved.push(intent);
    }
    return { intents: resolved, created, warnings: [] };
  } catch (error) {
    cleanupCreatedMaterials(created);
    throw error;
  }
}
```

`intentProblem` は `EditorAiError` に直接依存させない。`Problem` 互換の独自 Error を
作るか、`resolveMaterialCreationTasks` が `{ errors }` を返す形でもよい。
推奨は `Problem[]` を返す形。

推奨 signature:

```ts
export interface ResolveMaterialCreationResult {
  intents: EditIntent[];
  created: GeneratedMaterial[];
  warnings: Problem[];
  errors: Problem[];
}
```

この場合、catch は不要で caller が errors を見る。生成中の例外だけ catch して
`errors` に変換し、cleanup する。

実装上の注意:

- `created` の削除は `created.absPath` だけに限定する。
- `existsSync(created.absPath)` を確認してから `rmSync(..., { force: true })`。
- 既存素材名に衝突した場合は unique name になるため、既存ファイルを消す危険はない。
- `create-material.id` の重複は error。
- `create-material.kind !== "title-card"` は error。
- `spec.text` が空なら error。

### Step 6: `planEditorAiPatch` を async 化する

対象: `src/stages/editorAi.ts`

変更前:

```ts
export function planEditorAiPatch(
  dir: string,
  parsed: ParsedAiPatchResponse,
): AiProposeResponse {
```

変更後:

```ts
export async function planEditorAiPatch(
  dir: string,
  parsed: ParsedAiPatchResponse,
): Promise<AiProposeResponse> {
```

`proposeEditorAi` の `runAttempt` では既に async なので、呼び出しを `await` に変える。

```ts
return await planEditorAiPatch(dir, parsed);
```

`refineEditorAi` も同様に `await` に変える。ただし v1 では refine で
`create-material` を禁止する。

`planEditorAiPatch` 内の処理順:

```ts
const outputBounds = readManifest(dir).video.screenRegion;
let tasks = parsed.tasks;
let materialResolution: ResolveMaterialCreationResult | null = null;
if (tasks) {
  materialResolution = await resolveMaterialCreationTasks(dir, tasks);
  if (materialResolution.errors.length > 0) {
    throw new EditorAiError(400, formatProblems(materialResolution.errors));
  }
  tasks = materialResolution.intents;
}
const intentPlan = tasks ? planIntentEdits(dir, tasks) : null;
```

戻り値には `tasks: parsed.tasks` ではなく、実際に plan した `tasks` を入れる。
ただし UI に `create-material` も見せたい場合は `rawTasks` を別フィールドにする必要がある。
v1 では型変更を増やさず、`tasks` は解決後 task list でよい。

`patch fallback` との関係:

- `create-material` がある場合、patch fallback は使わない。
- 理由: patch fallback は JSON だけを扱うため、素材生成との整合を崩す。
- `intentPlan.errors.length > 0 && hasPatchEdits(parsed.patch)` の分岐に入る前に、
  `parsed.tasks` に `create-material` が含まれていたらその errors をそのまま返す。

具体条件:

```ts
const hasCreateMaterial = parsed.tasks?.some((task) => task.type === "create-material") ?? false;
if (intentPlan && intentPlan.errors.length > 0 && hasPatchEdits(parsed.patch) && !hasCreateMaterial) {
  ...
}
```

### Step 7: retry 判定を調整する

対象: `src/stages/editorAi.ts`

`isAiProposalRetryCandidate` は `create-material` 失敗では patch-only retry しない。
理由: patch-only retry は素材生成を消して JSON だけを作る方向へ逃げる可能性がある。

追加ルール:

- エラーメッセージに `create-material` または `materialRef` が含まれる場合は retry しない。
- `shouldForcePatchOnly` が true の annotation 系は従来通り。

疑似コード:

```ts
function isAiProposalRetryCandidate(message: string): boolean {
  if (/create-material|materialRef/.test(message)) return false;
  return ...
}
```

### Step 8: prompt を更新する

対象: `prompts/editor-ai-propose.md`

既存の valid task list を変更する。

```md
`add-annotation`, `create-material`, and `place-material`.
```

追加するルール:

```md
- If the user asks to create a new intro/outro/title-card material, use
  `create-material` first. Do not reference a non-existent `materials/*.mp4`
  path directly.
- `create-material` is local deterministic rendering, not text-to-video or
  image generation. Use it only for simple title-card style videos.
- After `create-material`, place it with `place-material.materialRef`.
- For existing files already listed in project materials, use `place-material.file`.
- For newly created files, never guess the final filename in JSON; use
  `materialRef` and let the tool resolve the actual `materials/...` path.
```

`review.frames` は opening insert なら output 秒で指定してよい。

```md
- For an inserted opening card, use output review frames around 0.5s and 1.2s.
```

### Step 9: tests を追加する

対象:

- `test/editIntent.test.ts`
- `test/editorAiMaterial.test.ts` 新規、または既存 `test/editorAi.test.ts`

`editIntent` tests:

1. `create-material` が `compileEditIntents` に残ると error。

期待:

```ts
assert.deepEqual(result.patch, {});
assert.equal(result.errors.length, 1);
assert.match(result.errors[0].message, /create-material は事前解決/);
```

2. `place-material.materialRef` が残ると error。

期待:

```ts
assert.match(result.errors[0].message, /materialRef/);
```

`resolveMaterialCreationTasks` unit tests:

実 Remotion を呼ぶと重いので、生成器 dependency injection を入れる。

推奨 signature:

```ts
export async function resolveMaterialCreationTasks(
  dir: string,
  intents: EditIntent[],
  deps: { createMaterial?: typeof createMaterial } = {},
)
```

テストでは fake を渡す。

```ts
const fakeCreate = async () => ({
  id: "opening_card",
  file: "materials/opening.mp4",
  absPath: join(tmp, "materials/opening.mp4"),
  durationSec: 2.56,
  width: 1920,
  height: 1080,
  fps: 30,
});
```

期待:

- resolved intents に `create-material` は残らない。
- `place-material.file === "materials/opening.mp4"`。
- `placement.mode === "insert"` の `durationSec === 2.56`。

生成器 integration test:

- CI / local の Remotion + Chrome 依存で重い。
- 既存 test suite が重くなるなら `node:test` の通常テストには入れず、
  `test/materialGenerator.integration.test.ts` を作って `process.env.CUTFLOW_INTEGRATION`
  がある時だけ実行する。

```ts
if (!process.env.CUTFLOW_INTEGRATION) {
  test("material generator integration", { skip: true }, () => {});
} else {
  test("material generator integration", async () => { ... });
}
```

通常 `npm test` で必須にするのは fake create の unit test まで。

### Step 10: typecheck / test

最小確認:

```sh
npm test
npm run typecheck
```

手動確認:

1. Editor を起動する。

```sh
node src/cli.ts editor /Users/19mo/Movies/cutflow/2026-07-02
```

2. Editor AI に依頼する。

```text
オープニング動画を作成し、その素材を冒頭に挿入して。タイトルは「Cutflow Demo」。
```

3. 期待:

- `materials/opening.mp4` または `materials/opening-2.mp4` が作られる。
- 提案 patch の `overlays.inserts[].file` が実在パスを指す。
- `validate` が通る。

4. 確認:

```sh
node src/cli.ts validate /Users/19mo/Movies/cutflow/2026-07-02
node src/cli.ts materials /Users/19mo/Movies/cutflow/2026-07-02
ffprobe -v error -show_format -show_streams -print_format json \
  /Users/19mo/Movies/cutflow/2026-07-02/materials/opening.mp4
```

## 実装時の禁止事項

- `compileEditIntents` から Remotion / ffmpeg / fs 書き込みを呼ばない。
- `validate` に `create-material` 専用例外を入れない。
- `materials.probe/` に生成素材を置かない。
- 既存 `materials/opening.mp4` を上書きしない。
- `place-material.file` に未存在パスを許可しない。
- 生成失敗後に `planApply` 成功扱いへ進まない。
- `patch-only retry` で `create-material` 失敗を JSON だけの編集に変換しない。
- AI provider 未設定時に deterministic CLI / editor 起動 / render の既存経路を壊さない。

## 受け入れ条件

実装完了の条件:

- `npm test` が通る。
- `npm run typecheck` が通る。
- Editor AI が `create-material` task を parse できる。
- `create-material` が実ファイルを `materials/` 配下へ作る。
- 同じ提案内の `place-material.materialRef` が実在 `materials/*.mp4` に解決される。
- `overlays.inserts` または `overlays.overlays` は未存在ファイルを参照しない。
- 生成器 failure 時に editable JSON は変更されない。
- AI provider failure 時に素材ファイルも editable JSON も変更されない。
- 既存の `place-material.file` で実在素材を置く挙動は維持される。

## 非目標

- text-to-video / text-to-image provider 連携。
- 任意画像生成。
- 複雑なモーショングラフィックス DSL。
- AI 未設定時に自動で素材を生成する CLI コマンドの追加。
- `materials.probe/` を生成素材の保存先にすること。

## 将来拡張

- `kind: "outro-card"`: CTA / チャンネル名 / SNS 表示。
- `kind: "chapter-card"`: 章タイトルを短く表示する区切り素材。
- `kind: "lower-third"`: 透明背景 webm は魅力的だが、codec / alpha 対応が
  render 環境差を増やすため v1 では避ける。
- `create-material` 専用 CLI:
  `node src/cli.ts create-material <dir> --kind title-card --text ...`
  これは AI なしでも deterministic に素材を作れるが、今回の最小実装には含めない。
