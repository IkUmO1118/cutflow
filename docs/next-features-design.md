# 次期機能候補 設計調査(採用/延期/却下の推薦)

> 状態: **調査のみ**(2026-07-06)。3候補それぞれに採用/延期/却下を推薦する。
> 「作る」前提ではなく、実装コスト・保守コスト・差別化軸への貢献・対象ジャンル
> (画面デモ+解説)での実需で判断する。採用推薦の候補だけタスク分解まで書く。
> 先行フェーズ1〜7(dip-to-black・ノイズ除去・ショート・ズーム・カラー調整・
> サムネイル)は実装済み。docs/decisions.md の 2026-07-06 と docs/shorts-design.md 参照。

## 0. 前提と一番効く事実(3候補すべてに効く)

- **不変条件の実体**は `src/lib/timeline.ts` の `TimelineEntry {start, end, offset}`。
  写像は `output = source + offset` の**区分定数オフセット(傾き1)**。各 keep の
  出力尺 = 元尺(`round2(e.end - e.start)`)で、**「keep 集合の合計 = 出力尺」**が
  ここから来る。`toOutputTime`/`toSourceTime`/`remapInterval` はすべて
  「エントリが重なりなく時系列単調」を前提に二分探索する(timeline.ts:107-171)。
- この不変条件の上に**全部が載っている**: テロップ・BGM・overlays・zoom の写像
  (`renderProps.ts`)、`baseSegments` の `videoStart`/`durationSec`、チャンク差分
  レンダーの `totalFrames = durationSec × fps`(render.ts:463)、エディタ Player の
  飛び飛び再生(`videoIsSource` 経路)、エディタ Timeline の帯幅
  (`(outEnd - outStart) × pps`)。
- **「尺不変」の演出ファミリー**の手本は dip-to-black(Main.tsx:114-122, 366-368)。
  境界秒 `cutBoundarySecs` の前後で黒 `AbsoluteFill` の opacity を 0→1→0 する
  **合成層だけの演出**で、尺・音声・字幕のタイミングに一切触れない。**元素材の
  フレームを必要としない**演出はこの型で尺不変に足せる。
- plan は「区間番号の選択」方式(docs/decisions.md 2026-07-02)。LLM に時刻を
  生成させず、detect の候補区間に番号を振って(`numberSegments` plan.ts:29)
  「どの番号か」だけ返させる。**ハルシネーションは「存在しない番号」として機械
  検出・無視**できる。上書き防御は `guardRerun`(cli.ts:68)+ `backupEditableFiles`。

---

## 1. 候補ごとの推薦

### 候補1: クロスフェード → **却下**

**判断**: カット間の映像・音声オーバーラップ遷移(xfade/acrossfade 相当)は**作らない**。
「境界で両クリップの“見えないフレーム”を重ねる」という要件が、現在の単一ストリーム
`cut.mp4` と両立しない。尺不変では**汚く**なり、尺可変では不変条件を**深く**壊す。

**理由(核心の技術的発見)**:
- `cut.mp4` は keep を隙間なく連結した**1本のストリーム**。A/B 境界(出力秒 `tb`)の
  直前は A の最後の keep フレーム、直後は B の最初の keep フレームで、**その間の
  カットされたフレームは cut.mp4 に存在しない**。
- 真のクロスフェードは窓 `[tb−s/2, tb+s/2]` の各瞬間で「出て行く A(カット点より
  **後**のフレーム)」と「入って来る B(keep 点より**前**のフレーム)」の加重合成を
  要する。どちらも cut.mp4 に無い。
  - **尺不変で無理に作ると汚い**: cut.mp4 を2レイヤー(1本は通常再生、もう1本を
    +s/2 シーク)で重ねれば「A の末尾 × B の頭」を合成はできる。しかし B の頭は
    その後の通常再生でも出る=**時間的に二重表示**(エコー/スタッター)。dip-to-black
    が綺麗なのは黒が第2ストリームも重複フレームも要らないから。クロスフェードは
    原理的にそれを要求する。
  - **尺可変にすると不変条件を深く壊す**: 本物の重なりは窓ぶん出力尺を縮める
    (−s)。しかも重なり中は**1つの出力時刻に2つの元時刻**が対応する=
    `remapInterval`/`toOutputTime` の「出力↔元は単射・単調」前提が崩れる。テロップ・
    BGM・`baseSegments` が「そのフレームはどの元秒か」を一意に決められなくなる。
    これは候補2(速度=傾きが変わるだけで単射は保たれる)より**厳しい**破壊。
- **対象ジャンルの実需が薄い**: 画面デモ+解説で章/場面転換は既に dip-to-black が
  担う。クロスフェードは技術系デモでは古く見えがちで、使用頻度が低い。差別化軸
  (JSON駆動+ローカルAI編集)への貢献もほぼ無い(見た目の一演出にすぎない)。

**トレードオフ / 代替の逃げ道**: どうしても「境界にひと味」が欲しくなったら、
dip-to-black と**完全に同じ尺不変ファミリー**で `dissolve-to-white`(白フラッシュ)や
`quick-blur-dip`(短いブラーで落として戻す)を足すのは near-zero コスト
(`cutTransition.type` を増やし Main.tsx の合成層に分岐1つ)。ただしこれは
**クロスフェードではない別機能**であり、必要になってから単独で判断すればよい。
本候補「クロスフェード」としては却下。

---

### 候補2: 速度変更(区間の倍速・スロー)→ **延期**

**判断**: 任意区間に倍率をかける**汎用の速度変更は延期**。理由は写像が区分定数
(傾き1)から**区分アフィン(任意傾き)**になり、回帰リスクが `timeline.ts` の外へ
広く波及するため。ただし価値の8割を占める「長い退屈区間の早送り(ビルド/インストール/
ダウンロードの倍速)」は、**アフィン写像を導入せず既存の insert(挿入編集)レールで
実現できる**ことを発見したので、そちらを将来の小機能として温存する。

**理由**:
- **(a) アフィン一般化の実コストと回帰リスク = 大**。`TimelineEntry` に `rate` を足し
  `output = outStart + (source − start)·rate` にする改造自体は timeline.ts に閉じるが、
  **傾き1が焼き付いている下流が広い**:
  - `renderProps.ts` の `baseSegments.durationSec = round2(e.end − e.start)` と
    `durationSec = keeps.reduce(...)` が「出力尺 = 元尺」前提(renderProps.ts:195-230)。
    速度が入ると**cut.mp4 自体を区間ごとに時間伸縮**(映像 `setpts=PTS/rate`・音声
    `atempo` でピッチ維持)する**新しい ffmpeg 処理**が cutFullRes に必要になり、
    loudnorm 実測ツーパスとも干渉する。「別 keeps を渡すだけ」では済まない。
  - チャンク差分レンダーの `totalFrames`(render.ts:463)や describe の 元秒⇔出力秒
    対応表がセグメント内で**非線形**になる。
  - テスト資産(`test/renderProps` `test/chunkPlan` timeline 写像テスト)が傾き1を
    多数固定しており、その多くを書き直す = 回帰面が広い。
- **(b) 限定版(無音の自動早送り)は本ジャンルでは価値が出ない**。現状 detect+plan は
  無音区間を**カットして消す**。消えた無音を早送りする価値は無い。速度が本当に効くのは
  「**残したい長い退屈区間**(npm install・ビルド・レンダー待ち)を倍速で見せる」= 元
  素材を残しつつ出力尺を縮める timelapse で、これは無音カットとは別物。
- **(c) だが timelapse は insert レールで写像ゼロで作れる**(本調査の要点)。
  `InsertSpan {at, durationSec}`(timeline.ts:14)は**アンカーに任意尺のクリップを
  差し込む**機構で、傾き写像を経由しない(挿入は explicit な `durationSec` を持つ)。
  よって「退屈区間を倍速に」= ①cutplan でその区間をカット + ②その元区間を ffmpeg で
  timelapse した素材(`materials/ff-1.mp4`)を生成 + ③insert として差し込む、で
  **不変条件を1バイトも触らず**実現できる。挿入の帯幅は既存 UI がそのまま扱う
  (候補2(c)の「帯と尺のずれ」問題も insert なら発生しない)。

**トレードオフ**: insert 版 timelapse は「元素材の前処理(倍速エンコード)」という
中間ステップが要り、区間内の音声は基本ミュート(atempo で残す拡張は後日)。しかし
汎用アフィン化の回帰リスクを全く負わずに主要ユースケースを取れる。**汎用の任意区間
速度は延期**(採用推薦ではないのでタスク分解は割愛)。速度がいつか要れば、
`timeline.ts` を一般化する前に**まず insert-timelapse を検討する**、を次の判断の起点にする。

---

### 候補3: ショートの LLM ハイライト自動選定(仮 `plan-shorts`)→ **採用**

**判断**: transcript + 既存の候補区間から「ショート向きの見せ場」を LLM に**番号選択**
させ、`shorts.json` の下書き(各ショートの `name` / `ranges` / 既定 `profile: vertical` /
`approved: false`)を生成する新コマンド `plan-shorts` を**作る**。3候補で唯一、
**新しい不変条件を一切増やさず**(ショートは既存の keep 集合機構に相乗り済み)、
**差別化軸(LLM は生成せず選択・JSON駆動)に直接貢献**し、**対象ジャンルの実需が高い**
(長尺1本からショートを量産は開発系 YouTube の定番運用)。

**理由**:
- **(a) plan の既存実装が7割再利用できる**:
  - `numberSegments(segments, transcript)`(plan.ts:29)= 候補区間に番号+重なる
    文字起こしを付ける。**そのまま流用**。
  - 番号選択プロンプト方式・`parseResponse`(JSON 抽出)・`renderPrompt`(テンプレ置換)・
    `complete`(LLM 呼び出し)= **流用**。plan が「切る番号」を返させるのに対し、
    plan-shorts は「**各ショートに入れる番号の集合**」を返させる(選択方向が逆なだけ)。
  - 番号の母集合は detect の `keepSegments`(または本編 cutplan の keeps)。ショートは
    本編でカットした素材も使える(D2)ので、**detect の候補区間全体**を番号母集合に
    するのが素直(本編で切った所も候補に入る)。
- **(b) 上書き防御と「approved は人間の仕事」が既存機構でそのまま守れる**:
  - `guardRerun`(cli.ts:68)を `["shorts.json"]` に対して使う=既存 shorts.json が
    あれば `--force` 必須、`--force` 時は `backupEditableFiles` で `backups/` へ退避。
    plan/run と同じ作法。plan-shorts は**LLM 生成物なので明示コマンド**にし、
    「再実行禁止」の plan/run には混ぜない。
  - 生成する各ショートは**必ず `approved: false`**。AI は true にしない。
    `render --short` の承認ゲート(render.ts:295)が未承認を弾くので原則が自動で効く。
- **(c) ショート特有の制約は「番号選択+コード側検証」で表現できる**:
  - **「60秒以内」**: 番号母集合は各区間の `[start,end]` を持つので、LLM が返した
    番号集合の尺合計を**コード側で検証**し、超過は末尾番号を落とすか警告する
    (plan と同じ「LLM の誤りは機械で検出」哲学。LLM には目安として prompt で伝えるが
    信用しない)。
  - **「フックが頭に来る」の限界を正しく設計に織り込む**: `render` は
    `mergeIntervals(short.ranges)`(render.ts:302)で ranges を**時系列にマージ**する
    =ショートは**元収録の時間順でしか並ばない**(中盤の一言を頭に引っ張る並べ替えは
    不可)。よって plan-shorts が提案できるのは「**時間順のハイライト**」に限る。
    「フック先頭」は「開幕が掴みになる**連続区間**を選ぶ / 最初の区間を掴みにする」で
    表現する。真の並べ替えショートは v1 の shorts モデルの範囲外=**下書き**として出し、
    並べ替え・最終判断は人間(承認は人間の仕事の原則と整合)。

**トレードオフ**: LLM がショートの粒度(何本・各何区間)を外すことはある。だが出力は
`approved: false` の**下書き**で、人間が preview/エディタで削る前提。validate は既存の
shorts.json 検査(docs/shorts-design.md §2.4)がそのまま効くので、生成直後に
`validate` で機械チェックできる。コスト対効果が3候補で最良。

---

## 2. 採用候補 `plan-shorts` の設計

### 2.1 変更しない土台(相乗り先)

- `numberSegments` / `renderPrompt` / `parseResponse` / `complete`(plan.ts)。
- `shorts.json` スキーマ・validate・`loadShorts`(既に実装済み)。
- `guardRerun` / `backupEditableFiles`(cli.ts)。
- 承認ゲート `render --short`(render.ts:295)。**approved は必ず false で出す。**

### 2.2 LLM 応答スキーマ(`prompts/plan-shorts.md`・新規)

番号母集合(detect `keepSegments` を `numberSegments` した `#id [start-end] 発言`)を
渡し、次の JSON **のみ**を返させる:

```jsonc
{
  "shorts": [
    {
      "name": "hook-mistake",     // 出力ファイル名。英小文字/数字/-/_
      "ids": [12, 13, 14],        // このショートに入れる区間番号(時系列。先頭が掴み)
      "reason": "本番で詰まって直す一連。開幕の詰まりが掴みになる"
    }
  ]
}
```

- 時刻(秒)は**一切生成させない**(plan と同じ)。`ids` → `ranges` はコードが
  番号表から引く。
- prompt に「各ショート ≤ 60 秒目安・2〜4 本・フックが先頭に来る連続 or 近接区間を
  選ぶ・時間順にしか並ばない」を制約として書くが、**尺と番号存在はコードで検証**する。

### 2.3 新コード(`src/stages/planShorts.ts`・新規)

```
planShorts(dir, cfg):
  transcript = read transcript.json
  auto = read cuts.auto.json            // detect 必須(plan と同じ前段依存)
  numbered = numberSegments(auto.keepSegments, transcript)   // 流用
  raw = complete(renderPrompt(dir, "plan-shorts.md", numbered, auto.originalDurationSec))
  write plan-shorts.raw.txt              // plan.raw.txt と同じく生応答を残す
  parsed = parseShortsResponse(raw)      // {shorts:[{name, ids, reason}]}
  for each short:
    存在しない id は警告して落とす(numbered に無い番号)
    ranges = ids を numbered 表で [start,end] に変換 → mergeIntervals
    尺合計 > maxSec(config)なら末尾 range を落とし警告(過剰は削る)
    name 正規化・重複回避
    → { name, profile:"vertical", approved:false, ranges }
  write shorts.json（approved は必ず false）
```

`config.yaml` に `planShorts.maxDurationSec`(既定 60)を1つ足す(ハードコードしない
方針)。母集合を detect の `keepSegments` にするか本編 `cutplan` の keeps にするかは
実装時に1本決める(推奨: detect 候補=本編カット分も拾える)。

### 2.4 CLI(`src/cli.ts`)

```
plan-shorts <dir> [--force]
  guardRerun(dir, ["shorts.json"], force, "plan-shorts")   // 既存 shorts.json を退避
  await planShorts(dir, cfg)
  「shorts.json を生成しました(全て approved:false。preview/エディタで確認・承認を)」
```

### 2.5 壊してはいけない既存挙動

- **`shorts.json` を上書きする唯一の防御を通す**: `guardRerun` を必ず経由し、既存
  shorts.json(人手で書いた ranges・captionTracks・profile・approved)を `--force`
  無しで消さない。`--force` 時も `backups/` へ退避してから書く。
- **`approved` を true にしない**(全ショート false 固定)。承認ゲート render.ts:295 の
  趣旨を破らない。
- **時刻を LLM に生成させない**(番号選択のみ)。ハルシネーション耐性の設計を守る。
- **plan / run と混ぜない**(それらは「再実行禁止」。plan-shorts は独立コマンド)。
- `numberSegments` など流用関数の**シグネチャを変えない**(plan 側の挙動不変)。

### 2.6 タスク分解(1タスク = 1コミット)

**T1. `prompts/plan-shorts.md`(新規)+ 応答パーサ**
- テンプレ(§2.2)。`parseShortsResponse` を planShorts.ts に置き、`parseResponse` の
  JSON 抽出(plan.ts:257)と同じ堅牢さ(コードフェンス/前後文を許容)。
- テスト: `test/planShorts.test.ts` — 正例、id 欠落無視、`shorts` 欠落時に空配列。
- 壊さない: plan.ts の `parseResponse`(共有するなら export、しないなら複製)。

**T2. `planShorts()` 本体(LLM 呼び出し無しの純ロジックを分離)**
- `numbered + parsed → Short[]` の変換を純関数 `shortsFromSelection(numbered, parsed,
  maxSec)` に切る(id→ranges 変換・mergeIntervals・尺超過の末尾切り・name 正規化/
  重複回避)。planShorts() は read/complete/write の殻。
- テスト: `shortsFromSelection` の unit — 尺超過で末尾 range が落ちる / 存在しない id が
  無視される / ranges が時系列マージされる / name 重複が回避される / approved 常に false。
- 壊さない: 既存 shorts.json 消費側(生成物のスキーマは docs/shorts-design.md §2.2 準拠)。

**T3. `config.yaml` に `planShorts.maxDurationSec`(既定60)+ config 型/検証**
- `src/lib/config.ts` に読み込み。テスト: `test/config.test.ts` に既定値。
- 壊さない: 既存 config(追加キーのみ)。

**T4. CLI 結線 `plan-shorts <dir> [--force]`**
- `guardRerun(["shorts.json"])` → `planShorts` → 生成本数と「approved:false」の案内。
- テスト: 手動(実収録で shorts.json 生成 → `validate` 緑 → 未承認で `render --short` が
  拒否 → 既存 shorts.json ありで `--force` 無しが停止・`--force` で backups/ 退避)。
- 壊さない: 既存コマンド、`guardRerun` の他コマンド利用。

**T5. docs / CLAUDE.md 同期**
- CLAUDE.md コマンド表に `plan-shorts`(下書き生成・approved は人間・--force で退避)、
  `plan-shorts.raw.txt` を中間生成物(編集しない)一覧へ。docs/usage.md にも1行。
- 壊さない: 既存記述。

---

## 3. 優先順位と次の1手

| 順位 | 候補 | 推薦 | 決め手 |
|---|---|---|---|
| 1 | 候補3 `plan-shorts` | **採用** | 新不変条件ゼロ・差別化軸に直撃・実需高・plan 7割再利用 |
| 2 | 候補2 速度変更 | **延期** | 汎用アフィン化は回帰面が広い。価値の8割は insert-timelapse で写像ゼロで取れる(要時に再検討) |
| 3 | 候補1 クロスフェード | **却下** | 単一 cut.mp4 では尺不変=汚い/尺可変=不変条件を深く破壊。ジャンル実需も薄い |

**次の1手**: 候補3 `plan-shorts` の **T1(prompts/plan-shorts.md + パーサ)**から着手する。
番号母集合を detect `keepSegments` に確定し、`shortsFromSelection` を純関数で TDD 固定
してから CLI に結線する。plan の番号選択方式・上書き退避・承認ゲートという**既に検証
済みのレール**にそのまま載るため、着手リスクが最も低く、差別化軸(JSON駆動+ローカル
AI編集)への寄与が最も大きい。

候補2は「速度が欲しい」という要望が実際に出た時点で、`timeline.ts` を一般化する前に
**insert-timelapse(前処理した倍速素材を挿入)**を第一候補として設計し直す。候補1は、
境界演出の要望が出れば**クロスフェードではなく** dip-to-black 同型の尺不変トランジション
(白フラッシュ/ブラーディップ)を単独機能として検討する。
</content>
</invoke>
