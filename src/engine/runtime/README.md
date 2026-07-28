# src/engine/runtime/ — ブラウザ専用エンジン実装（M3a）

`src/engine/` 直下（`descriptor.ts`/`describeFrame.ts`/`hash.ts`/`refPainter.ts`）は
Node からもブラウザからも import される純関数群（node import 禁止・副作用禁止）。

ここ `runtime/` はその逆で、`mediabunny`/`opencut-wasm`/DOM API/Worker/AudioContext を
直接使うブラウザ専用コード置き場（Node からは import しない）。

import 方向は一方向:

```
runtime/*  →  ../descriptor.ts, ../hash.ts, ../refPainter.ts など（可）
../*       →  runtime/*                                          （禁止）
```

`src/engine/` 側の純関数が `runtime/` を import してはいけない（純関数群を
ブラウザ専用コードに汚染させない。docs/plans/2026-07-28-engine-m3a-engine-core-design.md
Phase 1）。

構成予定（Phase 2〜5 で追加。母艦 `docs/programs/render-engine-replacement-program.md`）:

- `frameSource.ts` / `sourcePool.ts` / `frameBlit.ts`（Phase 2: フレーム供給）
- `compositorWorker.ts` / `textureCache.ts`（Phase 3: コンポジタ Worker）
- `audioScheduler.ts` / `clock.ts`（Phase 4: 音+クロック）
