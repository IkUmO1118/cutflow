# PR Review: #7 — Feature/nle roadmap next perception 2026 07 07

**Reviewed**: 2026-07-07
**Author**: IkUmO1118 (ikumo)
**Branch**: feature/nle-roadmap-next-perception-2026-07-07 → main
**Decision**: APPROVE with comments

## Summary
NLE 診断の「AI の知覚・行動ギャップ」4機能(音声知覚 / 素材知覚 / 視覚アサーション /
MCP サーバ)を追加。+6712/-33、41ファイル。承認境界・未使用時バイト等価・純/不純分離・
ゼロ依存の方針はすべて設計どおり守られており、致命的・高リスクの問題は無い。指摘は
usability 系の MEDIUM/LOW が2件のみで、マージを妨げない。

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM
- **`assert` の `outDuration` に `==` を使うと浮動小数の厳密一致で事実上通らない**
  (`src/stages/assert.ts` `compareOp` の `case "=="`: `actual === value`)。
  `outDuration` の actual は算出された出力尺(float)なので、`{op:"==", value:120}` は
  実測 119.9997 等で fail し、作者を混乱させうる。`keepCount`(整数)は問題なし。
  対策案: `outDuration` の `==` にだけ許容誤差(例 ±0.05s)を入れる、または
  usage.md/スキーマ説明で「尺の等値比較は `<=`/`>=` を使う」と明示する。

### LOW
- **JSON-RPC の `id` 型を検証していない**(`src/mcp/jsonrpc.ts` L51/L57:
  `json.id as string | number | null`)。`{"id": {...}}` のような不正 id を
  request として受理しエコーバックする。仕様(id は string|number|null)からの
  軽微な逸脱で、セキュリティ影響・実害は無い。堅牢性のため型チェックを足す余地。
- (参考・非指摘)`materialSlug` はパス区切りを `__` に畳むため理論上の衝突が
  ありうる(`materials/a/b.png` 参照 と 実ファイル `materials/a__b.png`)が、
  現実にはほぼ発生しない。`materials.probe/index.json` の `capturedAt` タイムスタンプで
  index.json は毎回変わるが、キャッシュ再利用は素材ごとの mtime+size 指紋で
  判定するため無害。

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Lint | N/A(type-stripping・lint script なし) |
| Tests (`npm test`) | Pass — 762 pass / 0 fail |
| Build | N/A(ビルド工程なし) |

## Security / Boundary checks (この repo 固有)
- MCP tool レジストリ(`src/mcp/tools.ts`)は read + 承認スコープ外の安全編集の
  7 tool のみ。approve/unapprove/render/plan/remeta/run 等は配列に存在せず、
  `tools/call` で名前引きしても -32602 に落ちる(コードで物理的に強制)。
- `cutflow_apply` は `approved` を変更せず `approvals.json` に触れない(内部 applyEdits に委譲)。
- 全新機能は既定 config で OFF(`whisper.systemAudio:false` / `plan.perception.systemSpeech:false` /
  `describe.pauses` はコメントアウト)。既存 golden/テストが無改変で緑=バイト等価の機械的証明。

## Files Reviewed(主なもの)
- Added: src/mcp/{types,jsonrpc,protocol,tools,server}.ts, src/stages/{assert,materials}.ts,
  src/lib/materials.ts, schemas/assertions.schema.json, test/{assert,materials,ffmpeg,mcp*}.test.ts,
  docs/plans/2026-07-07-*-design.md(4本)
- Modified: src/types.ts, src/cli.ts, src/lib/{config,ffmpeg,files,perception,screenStill}.ts,
  src/stages/{describe,ingest,transcribe,plan}.ts, config.yaml, AGENTS_CONTRACT.md, CLAUDE.md, docs/usage.md,
  test/{config,files,perception,schema,screenStill}.test.ts
