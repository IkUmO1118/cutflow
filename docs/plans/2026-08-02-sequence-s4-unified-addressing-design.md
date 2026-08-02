# S4: 番地契約の統一 — 「どの秒か」を全表面で明示する

親ドキュメント: `docs/programs/sequence-time-program.md`(シーケンス時間母艦)
状態: **IMPLEMENTED** / 2026-08-02

---

## 0. 着手ゲート

以下がすべて満たされるまで着手しない。**満たされないうちに着手すると、
まだ形の決まっていない番地を契約として固定してしまう。**

1. S0 / S1 / S2 / S3 がすべて landing している
2. 実収録で **1本以上のスライドショー(S3)** が `ingest` から `render` まで完走している
3. 実収録で **1本以上の intro/ending 付き動画(S1+S2)** が完走し、
   挿入区間で BGM が鳴っていることを実機で確認している
4. その運用で「軸が分からなくて間違えた」実例が **1件以上**記録されている
   (推測で設計しない。実害が出てから形を決める)

ゲート未達のまま気づいた不整合は、本 plan の §3 へ追記だけしておく。

---

## 1. 何が残っているのか

S0〜S3 を終えた時点でも、**「この数値はどちらの秒か」を機械が判別できない**表面が残る。

### 1.1 `describe --json` の射影に軸ラベルが無い

`src/stages/describe.ts:585-591` の `MappedInterval` は
```ts
export interface MappedInterval {
  id?: string;
  start: number;   // source
  end: number;     // source
  out: Interval[]; // output
}
```
という**位置による暗黙の規約**。S1 で `timebase:"output"` の BGM トラックが
出現すると、その要素は `start === out[0].start` になり、
**消費側(`assert.ts` / `review.ts` / MCP 経由の外部エージェント)が
「たまたま一致した source 秒」と区別できない**。

### 1.2 request 層と document 層で語彙が二重になる

- request 層: `axis: "source" | "output"`
  (`review.ts:16-35` / `frames.ts:66` / `framesServe.ts:83-86` /
  `editorAi.ts:613,626` / `mcp/tools.ts:349`)
- document 層: `timebase: "source" | "output"`(S1 で新設)

値は同じだがフィールド名が違う。意図的な使い分け(母艦 §4)だが、
**どちらの語を使うべきかを判断する規則がドキュメント化されていない**。

### 1.3 エディタが output timebase 要素を編集できない

`editor/client/Inspector.tsx:227` は「時刻の生値編集はすべて元収録の秒」と
宣言しており、`App.tsx` の `curTimeline` を通した変換が約40箇所ある。
`timebase:"output"` の BGM トラックを Inspector で編集すると
**source 秒として扱われて壊れる**。S1 時点では「エディタでは触らない」運用で
回避する前提だが、恒久的にはここを直す必要がある。

### 1.4 承認 hash と挿入の関係が未決のまま

母艦 §6 の最重要未決。`src/lib/approval.ts:57-68` のペイロードは
keep 集合のみで、**挿入に完全に盲目**。S2 でスチルが出力尺を自由に伸ばせる
ようになった後、「承認した動画」と「出来上がる動画」の乖離をどう扱うか。

---

## 2. 決めること(この plan が着手時に確定する)

| # | 決定事項 | 選択肢 | 現時点の傾き |
|---|---|---|---|
| D1 | `describe --json` の軸ラベル | (a) 要素に `timebase` を載せる / (b) `out` を常に配列にして `start/end` は必ず source と決め、output 要素は `start === null` にする / (c) 射影のトップレベルに `schemaVersion` を上げて規約を変える | **実装済み: (a)**。省略は `"source"` 互換、output 要素は明記 |
| D2 | `axis` と `timebase` の使い分け規則 | 統一する / 使い分けを明文化する | **実装済み: 明文化**。request は問い合わせ軸、document は値の所属軸 |
| D3 | エディタの output timebase 対応 | (a) Inspector に軸トグルを出す / (b) output 要素は読み取り専用にして警告 / (c) `curTimeline` を要素ごとに切り替える | **実装済み: (b)**。output BGM は全編集経路で読み取り専用＋警告 |
| D4 | 承認 hash × 挿入 | (a) 現状維持+ドキュメント明記 / (b) 出力尺を hash に含める(`version:3`) / (c) render 時に出力尺の変化を警告 | **実装済み: (a)**。hash は cut 判断だけ。最終出力確認は別境界 |
| D5 | `av` / `validate` / `frames` の軸一致の恒久保証 | テストで固定する / lint 的な検査を足す | **実装済み: テスト固定** |

---

## 3. ゲート未達中に溜める観測ログ

S0〜S3 の運用で見つけた「軸に起因する事故・混乱」をここに追記していく。
**推測ではなく実例だけを書く。** 形式:

```
- YYYY-MM-DD  <どのコマンド/画面で> <何を期待して> <何が起きたか> <どちらの軸の取り違えか>
```

- 2026-08-02  `stills frames --out` で出力秒のフレームを期待したが、暗黙に
  `proxy.mp4` を source media として選び 404 になった。request の output 軸に
  source media 前提が漏れた。
- 2026-08-02  stills で inserts をスライドに使ったため、出力尺がナレーションより
  長くなり出力の 59%(170秒中100秒)が背景だけになった。ripple 挿入と
  「上を覆う overlay」の取り違え。

---

## 4. 非目標

- **`cutplan` のクリップ列化**(母艦 §7)。S4 でも行わない
- **plan-* への出力秒の持ち込み**(母艦 §4-1)
- **マルチトラック編集 UI**
- **`shorts.json` の挿入対応**
