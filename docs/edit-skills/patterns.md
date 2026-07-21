# edit-skills — 収録タイプ(cut-patterns)

> 母艦: [`../programs/edit-knowledge-assets-program.md`](../programs/edit-knowledge-assets-program.md)。
> 実装設計の正本: [`../plans/2026-07-20-cut-knowledge-p3-p5-design.md`](../plans/2026-07-20-cut-knowledge-p3-p5-design.md) §1/§2。
> id 集合・注入内容の単一の出所は `src/lib/cutPatterns.ts` の
> `CUT_PATTERN_IDS` / `CUT_PATTERN_INJECTION`(このファイルの記述はそこから
> 生成される固定文字列の**説明**であって、注入の実体そのものではない)。

## これは何か

`docs/edit-skills/recipes/*.md`(13分類)は「カット判断で使う語彙」全体を
定義するが、収録の性質によって**どれが実際に効くか**は変わる。ツール紹介・
デモの収録では `demo-wait`(画面が語っている無言)が支配的だが、脱線
(`tangent`)や失敗と修正(`failure-and-fix`)はほとんど出ない——逆の収録も
ありうる。この「どれを重点的に注入するか」の選択を **収録タイプ(pattern)**
として `config.yaml` の `plan.reasonIds.pattern` で宣言する。

**選ぶ主体は LLM ではなく人間。** 収録タイプは撮影者が一番よく知っている
(自分が何を撮ったか)。誤判定しうる分類器を判断経路に挟む理由が無い
(詳細は設計書 §2「なぜ LLM に選ばせないか」)。

## 2エントリで発足

母艦 §4.2 は5型(ツール紹介・デモ / ライブコーディング / 解説・座学 /
トラブルシュート / 進捗報告)を想定するが、**実在確認が取れているのは
`tool-demo` 1本だけ**(`~/Movies/cutflow/2026-07-12`)。残る4型は実データ
ゼロの想定にすぎず、統廃合前提のものをプロンプト分岐に載せる順序ではない
(母艦 §6.1・G4 の原則)。実収録が増えるたびにここへ型を足していく。

| id | 表示名 | 接地 | 注入内容 |
|---|---|---|---|
| [`general`](#general) | 汎用(収録タイプを宣言しない) | — (既定) | 13分類全部。`plan.reasonIds.pattern` 省略時と同じ |
| [`tool-demo`](#tool-demo) | ツール紹介・デモ | 実データ(`~/Movies/cutflow/2026-07-12`。承認・レンダー済み) | 11/13分類 + blueprint(`tool-demo-arc`。P4) |

## `general`

**既定。** `config.yaml` に `plan.reasonIds.pattern` を書かない、または
明示的に `pattern: general` と書いたときの挙動。13分類**全部**を
(id + 一行定義 + 系の見出しで)注入し、冒頭の重み付け行(note)は無い。

この宣言は P2(選択注入が無かった時点)の注入内容と**バイト等価**——
`renderReasonIdsBlock(true, "general")` は `renderReasonIdsBlock(true)` と
完全に同じ文字列を返す。`pattern` という機構自体は P3 の追加だが、既定挙動を
変えない(母艦の「新型追加はローカルな変更」という設計目標の裏返し)。

## `tool-demo`

ツール紹介・デモの収録(画面が主役で、無言の価値が高い)。実データ
(`~/Movies/cutflow/2026-07-12`)から重み付けした **11/13分類** を注入する:

| 扱い | 分類 | 理由 |
|---|---|---|
| **必ず入れる(対比ペア)** | `demo-wait` / `dead-air` | この型で最も外す境目(`rules.md` の実失敗)。同じ「無言」という表層で処置が逆になる対比を分割しない |
| 入れる | `restatement` / `duplicate-tail` / `gap-trim` / `stumble` | 実データで実際に使われた4分類 |
| 入れる | `hook` / `greeting` / `tail-clip` / `reference-orphan` | `rules.md` に接地のある残す側・境界 |
| 入れる | `slate` | 実データ2件 |
| **落とす** | `tangent` | 実データ0件・この型では削り代が小さい |
| **落とす** | `failure-and-fix` | 実データ0件。デモ型では支配的でない |

冒頭に1行の重み付け(note)が付く:

> この収録は画面が主役です。無言は既定でカットせず、画面が変化しているかで
> 判断してください。

加えて blueprint `tool-demo-arc`(P4。[`blueprints.md`](blueprints.md)参照)が
注入ブロックの末尾に連結される。

**注入の形は `general` から変えない**(見出し・行フォーマット・`keeps` の
説明文は同一)。違うのは行数と note 1行だけ(設計書 §2.2)。

## config での宣言

```yaml
plan:
  reasonIds:
    enabled: true       # 既存(注入自体の有効化)
    pattern: tool-demo  # 新規。既定 general
```

未知の `pattern`(ここに載っていない id)は警告のうえ `general` へ劣化する
(前提エラーでは止めない。`style-profile` 不在時と同じ流儀)。
