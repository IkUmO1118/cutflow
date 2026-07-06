# approved・中間生成物の書込スコープをコード強制 — 設計

*2026-07-07 / 診断レビュー `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Now #4*

診断の核心的指摘(38行目付近):

> **承認ゲートが、紳士協定** — `validate` は `approved` を boolean 検査するだけ、
> `render` がそれをゲートする。つまり **AI が `approved:true` と書けば人間承認を
> 丸ごとすり抜けて最終レンダーまで進める**。中核の安全設計がコードで
> 強制されていない。

本ドキュメントは、この「紳士協定」をどこまで・どうやってコードで強制するかを
決める。あわせて中間生成物(キャッシュ・生成物)の手編集についても書込
スコープの守り方を決める。

---

## 0. 結論の要約(最初に読む)

- **信頼モデル**: 承認を「cutplan の描画決定内容(keep 集合)のハッシュに束縛した
  承認レコード」に格上げし、専用ファイル `approvals.json` に**別置き**する。
  render のゲートは boolean `approved` を単独では信用せず、「現内容のハッシュと
  一致する承認レコードが存在する」ことを要求する。承認後に内容を編集すると
  ハッシュ不一致で**自動失効**する。
- **強制できること(cutflow のコードが決定論で保証)**:
  1. 生の `approved:true` だけでは render は通らない(footgun を潰す)。
  2. 承認後に cut を編集したら承認が自動失効し、古い内容のまま render できない。
  3. 承認は「編集ワークフローが一切触らない別ファイル+専用コマンド」という
     **命名された別行為**になり、reflex(cutplan を編集するついで)では発生しない。
- **強制できないこと(=ハーネスの権限層に委ねる / 運用規律に委ねる)**:
  - 生 Write ツールと Bash を無制限に持つエージェントは、承認レコードを
    **意図的に偽造**できる(ハッシュも同じコードで計算できる)。これは
    cutflow のコードでは塞げない。塞ぐのは Claude Code の**権限設定**
    (`approvals.json` への Write/Edit と `approve` コマンドの Bash を deny)で、
    cutflow の役割は「その deny ルールが**1ファイル+1コマンドで済むよう
    形を整える**」こと。今は cutplan.json の中の1フィールドなので、
    「cut は編集させるが approved は書かせない」を権限で表現できない。
  - この線引きを偽らない: **偶発事故(うっかり approved:true / 承認後の
    編集で古い render)は確実に塞ぐ。意図的なバイパスは、目立つ・deny 可能に
    するところまでで、無制限権限下での完全阻止は約束しない。**

---

## 1. 信頼モデルの核心(論点1)

### 1.1 何が本当の問題か

「AI の Write ツールは物理的にどのファイルも書ける」。したがって承認レコードが
**平文ファイルである限り、同じ Write ツールで偽造できる**。ハッシュを足しても、
AI はハッシュ計算コードを走らせて正しい値を書けるので、原理的には紳士協定に
戻る。これを直視した上で、**enforce できる部分**を切り出す。

現実に起きる事故は2種類あり、両者を分けて考えるのが鍵:

- **事故A(偶発・高頻度)**: AI が cutplan.json を(cut のために正当に)編集する
  流れの中で、`approved` という**同じファイルの中に居るフィールド**を
  「もう仕上がったから」「『承認してレンダーして』と言われたから」で `true` に
  してしまう。boolean 1個の書き換えで render まで抜ける。
- **事故B(承認の陳腐化・中頻度)**: 人間が承認 → その後 AI or 人間が cutplan を
  編集 → `approved` は `true` のまま残るので、**人間が見ていない内容が render**
  される。今日の boolean ゲートはこれを一切検知しない。
- **意図的偽造(低頻度・敵対的)**: エージェントが承認レコードを狙って捏造する。

事故A・Bは cutflow のコードで**確実に潰せる**。意図的偽造は権限層に委ねる。
最優先は task 指示どおり「うっかり approved:true で render まで進む事故(=A)」の
確実な封鎖、次いで B の封鎖。

### 1.2 候補の比較

| 案 | 事故A(うっかり true) | 事故B(承認後の編集) | 偽造 | 権限 deny の容易さ | 実装量 |
|---|---|---|---|---|---|
| 現状(boolean のみ) | ✗ 通る | ✗ 通る | ✗ | ✗(cut と同居) | — |
| (a) cutplan 内に `approval:{hash}` フィールド | △ record 不整合で弾ける | ◎ 自動失効 | ✗ | ✗(同じファイル) | 小 |
| **(b) 別ファイル `approvals.json` にハッシュ束縛レコード(採用)** | ◎ | ◎ 自動失効 | ✗(コードでは) | **◎(別ファイル1つを deny)** | 中 |
| 署名鍵・外部 KMS 等 | ◎ | ◎ | △ | — | 大(却下: ソロ/ローカル/決定論に反する) |

**(a) と (b) の差が決定的**: (a) は承認レコードを cutplan.json の中に置くので、
「AI に cut は編集させるが承認は書かせない」を権限ルールで表現できない
(同じファイルを許可/拒否のどちらかにしかできない)。(b) は承認を**別ファイル**に
出すので、`approvals.json` への Write だけを deny すれば、cutplan.json への
通常の編集は許したまま承認だけを封じられる。**これが「本当にコードで強制する」に
一番近づける唯一の梃子**——ただし強制の実体は cutflow ではなく**ハーネスの
権限設定**にある、という線引きを明示する。

署名鍵・暗号は却下: ソロ開発者・ローカル完結・決定論・「未使用時は既存挙動
不変」という制約に反する過剰設計。鍵をローカルに置けば結局 AI が読めるので
安全性の実利も薄い。

### 1.3 採用する多層防御(それぞれ何を保証するか)

1. **ゲート層(cutflow が決定論で保証・信頼不要)**
   render は `approvals.json` の承認レコードを読み、その `hash` が **現在の
   cutplan の描画決定内容(= `mergeIntervals(keeps)`)のハッシュ**と一致する
   ときだけ通す。レコード無し/ハッシュ不一致は「未承認」として拒否。
   → 事故A(生の boolean は無力化)と事故B(内容が変われば自動失効)を
   完全に封鎖。**これは信頼を要さない。**
2. **分離層(out-of-band 書込経路)**
   承認レコードは編集ワークフローが一切書かない専用ファイルに置く。書けるのは
   `approve`/`unapprove` コマンドと GUI サーバー(人間がチェックボックス操作)
   のみ。承認は「cutplan をいじるついで」ではなく**命名された別行為**になる。
3. **権限層(唯一の真の偽造障壁・ハーネス側・opt-in)**
   承認が別ファイル+専用コマンドに分離されたことで、人間は Claude Code の
   `settings.json` に「`approvals.json` への Write/Edit を deny」「`approve`
   コマンドの Bash を deny/ask」を**1ファイル1コマンド粒度**で書ける。
   ここで初めて「AI が物理的に書けない」が成立する。cutflow の仕事は、この
   ルールが**自明かつ外科的に書ける形**にしておくこと(+ 推奨ルールの提供)。

### 1.4 線引き(偽らない宣言)

- **cutflow コードが強制(信頼不要)**: 承認は内容束縛で自動失効する。生の
  boolean は render を通さない。陳腐化した承認では render しない。
- **ハーネス権限が強制(opt-in・cutflow 外)**: エージェントが承認レコードを
  **物理的に書けない**。cutflow はこれを安価・外科的にする形を提供する。
- **運用規律に委ねる(無制限権限下では阻止しない)**: 人間が AI に無制限 Write と
  Bash を与えたなら、意図的偽造(レコード捏造 / `approve --yes` の強行)は
  止まらない。ただし **偶発は起きない**(承認は reflex で触るフィールドでは
  なくなり、専用コマンドは非対話では自己拒否する)。これ以上を「コード強制」と
  称するのは security theater なので主張しない。

---

## 2. スキーマ案

### 2.1 承認レコードのハッシュ対象(正規化)

承認は「どの区間を残すか=最終出力を決めるもの」に束縛する。したがってハッシュ
対象は **render が実際に使う keep 集合**(`mergeIntervals` 後)にする。

- **cutplan**: `mergeIntervals(segments.filter(action==="keep"))` を
  `[[start,end], ...]` に正規化し、各値を `Math.round(x*1000)/1000`(ms 丸めで
  浮動小数のジッタを吸収)してから `JSON.stringify` → `sha256`。
  - `reason` は含めない(注釈であり出力に影響しない。reason だけの編集で承認が
    失効しないのが望ましい)。
  - `cut` セグメントは含めない(出力に出ない)。
  - 同じ keep 集合を境界維持のまま分割(GUI の分割編集)しても `mergeIntervals`
    後は同一 → 承認は維持される(出力が同じなら承認も有効、が正しい)。
- **short**: `{ profile: short.profile ?? null, keeps: mergeIntervals(ranges)
  正規化 }` を `JSON.stringify` → `sha256`。`profile` はレイアウト=出力に効くので
  含める。`name` はレコードのキーであってハッシュ対象ではない
  (rename は別ショート扱いで新規レコードになる)。`captionTracks` は本編の
  telop 同様、承認スコープ外(§2.4 参照)。

**ハッシュ対象を cut/short の keep 集合だけに限る根拠**: 今日の承認ゲートの
スコープと一致させる(人間は preview で「カットの出来」を承認している)。
overlays/telop/bgm まで束縛すると、テロップの微修正のたびに承認が飛んで
運用が重くなる。ここは**意図的に cut 決定のみ**に束縛し、telop/演出の後編集は
承認を無効化しない(=今日と同じ挙動)。この非目標を §2.4 に明記。

### 2.2 `approvals.json` の形

収録フォルダ直下に置く新ファイル。

```jsonc
{
  "version": 1,
  "cutplan": {
    "hash": "sha256:2f1e…",       // §2.1 の正規化ハッシュ
    "approvedAt": "2026-07-07T12:34:56+09:00", // ローカル時刻・情報用
    "by": "cli" | "gui"           // 情報用(監査の助け。信頼値ではない)
  },
  "shorts": {
    "highlight-1": { "hash": "sha256:…", "approvedAt": "…", "by": "gui" }
  }
}
```

- 承認が無い項目はキーごと存在しない(`cutplan` 欠落=本編未承認、`shorts` の
  当該 name 欠落=そのショート未承認)。
- `by` / `approvedAt` は監査用の情報で、ゲート判定には使わない(信頼できる値では
  ないため。判定は hash 一致のみ)。
- 保存場所を**別ファイル**にするのが本質(§1.2)。中間生成物一覧・
  `EDITABLE_FILES` のどちらにも属さない**第3のカテゴリ「承認レコード」**として
  扱い、backup 退避の対象にはしない(承認は退避・復元の対象ではなく、
  内容が変われば作り直すもの)。

### 2.3 型(`src/types.ts` 追加)

```ts
/** 承認レコード(approvals.json)。承認は cutplan/short の keep 集合の
 * ハッシュに束縛され、内容が変われば hash 不一致で自動失効する。
 * render の唯一のゲート。boolean approved は人間の意図表示に降格(§2.4)。 */
export interface Approvals {
  version: 1;
  cutplan?: ApprovalRecord;
  shorts?: Record<string, ApprovalRecord>;
}
export interface ApprovalRecord {
  /** "sha256:…"。src/lib/approval.ts が現内容から算出した値と一致で承認有効 */
  hash: string;
  approvedAt: string;
  by?: "cli" | "gui";
}
```

### 2.4 `CutPlan.approved` / `Short.approved` の再定義

- 型からは**消さない**(後方互換・GUI チェックボックスのモデル・人間が読む
  意図表示として残す)。
- 意味を変える: 「**人間の承認意図の表示**であって、render のゲートではない」。
  ゲートは approvals.json のレコード。コメントを更新する。
- 想定される過渡状態: `approved:true` だが記録が無い/陳腐化 → render は拒否、
  validate は警告(§7)。boolean は諮問的、レコードが正。
- **非目標(明記)**: overlays/transcript/bgm の編集は承認を失効させない
  (今日と同じ)。承認スコープは cut 決定のみ。

---

## 3. 変更点マップ(ファイル別)

| ファイル | 変更 |
|---|---|
| `src/lib/approval.ts`(新規) | ハッシュ算出とレコード I/O の純ロジック。`cutplanApprovalHash(cutplan)` / `shortApprovalHash(short)` / `readApprovals(dir)` / `writeCutplanApproval(dir, cutplan, by)` / `clearCutplanApproval(dir)` / `writeShortApproval` / `clearShortApproval` / `isCutplanApproved(dir, cutplan): {ok, reason?}` / `isShortApproved(dir, short)`。ハッシュ計算は `node:crypto` + `mergeIntervals`(lib/timeline)。副作用のある I/O と純ハッシュ関数を分けてテスト可能に |
| `src/lib/files.ts`(新規) | ファイル分類の単一の真実。`EDITABLE_FILES`(backup.ts から移設)/ `GENERATED_FILES`(中間生成物一覧)/ `APPROVAL_FILE = "approvals.json"` / `fileRole(name)`。§6 で権限 deny リストの生成元にもなる |
| `src/lib/backup.ts` | `EDITABLE_FILES` を files.ts から re-export(互換維持)。承認レコードは退避対象にしない(現状どおり) |
| `src/types.ts` | `Approvals` / `ApprovalRecord` 追加。`CutPlan.approved` / `Short.approved` のコメントを「意図表示・ゲートではない」に更新 |
| `src/stages/render.ts` | ゲートを `isCutplanApproved` / `isShortApproved` に置換(§4)。エラーメッセージに `cutflow approve` を案内 |
| `src/cli.ts` | `approve` / `unapprove` コマンド追加(§5)。TTY ゲート付き |
| `src/stages/validate.ts` | fs 版 `validate(dir)` ラッパにだけ「approved:true なのにレコード欠落/陳腐化」警告を追加(§7)。`validateDocs` の純粋性は保つ |
| `editor/server.ts` | `saveProject` で cutplan/short の approved トグルに応じてレコードを mint/clear(§8)。`WATCHED_FILES` と `selfWroteAt` に `approvals.json` を扱わせない(監視対象外=hot-reload をトリガしない) |
| `config.yaml` | **新規必須設定なし**(§9)。config によるゲート無効化トグルは**意図的に入れない**(1キー編集でゲート全体を殺せると安全性の物語が崩れるため) |
| `CLAUDE.md` / `docs/usage.md` | 承認モデルの説明・`approve`/`unapprove`・中間生成物の権限 deny ガイド・推奨 settings スニペット(§6, §10) |

---

## 4. render ゲートの変更(論点の中心)

現状 `src/stages/render.ts:78`:

```ts
if (!cutplan.approved) { throw new Error("… approved が false …"); }
```

変更後(概念):

```ts
const gate = isCutplanApproved(dir, cutplan); // approvals.json を読み hash 照合
if (!gate.ok) {
  throw new Error(
    `render できません: ${gate.reason}\n` +
    "preview で確認のうえ `node src/cli.ts approve <dir>` で承認してください" +
    "(GUI ならチェックボックス)。",
  );
}
```

`isCutplanApproved` が返す `reason` の分岐(人間・AI に何をすべきか伝える):

- レコードなし: 「承認レコードがありません(未承認)」
- hash 不一致: 「承認後に cut が変更されています(承認が失効)。再承認が必要です」

ショートも同様に `renderShort`(:296)は `isShortApproved` で throw、
`renderShorts`(:274)は skip ログを「承認レコードなし/陳腐化」に対応。

**移行(論点3): strict-by-default を採用する。**

- `approvals.json` が無い/レコードが無い項目は**未承認**として扱う(boolean への
  fallback はしない)。
- 根拠: 「レコード無し→boolean にフォールバック」は、**新規プロジェクトでも
  footgun が閉じない**(AI が approved:true を書きレコードを作らなければ、
  fallback で render が通ってしまう)。事故Aを全プロジェクトで確実に塞ぐには
  strict しかない。
- 既存収録への影響: 過去に `approved:true` で承認済みだが `approvals.json` を
  持たないフォルダは、次の render で拒否される。復旧は **`cutflow approve <dir>`
  を1回**走らせるだけ(データ破壊なし・冪等)。render のエラーメッセージが
  この手順をそのまま案内する。完成済み(既に final.mp4 がある)フォルダは
  再レンダー不要なので実害はほぼ無い。
- **render 時の自動 mint はしない**(「approved:true を見たらレコードを作る」は
  boolean footgun を復活させるので禁止)。承認は必ず `approve`/GUI 経由。
- 対案として `approval.legacyBooleanGate`(config)での旧挙動維持も検討したが、
  **採用しない**: 1つの YAML キーでゲート全体を無効化できると、AI が config を
  書き換えてバイパスする経路を新設してしまい、安全性の物語が崩れる。移行は
  「approve を1回」で足りるため、恒久バイパスは不要。

**壊してはいけない既存挙動**: 承認済み(レコードあり・hash 一致)プロジェクトの
render 出力・キャッシュ(cut.mp4 / render.key.json / チャンク差分)は完全に不変。
ゲートは入口の判定だけを差し替える。

---

## 5. UX: 承認経路(論点4)

### 5.1 CLI

```
node src/cli.ts approve <dir>            # 本編を承認
node src/cli.ts approve <dir> --short <name>  # ショートを承認
node src/cli.ts unapprove <dir> [--short <name>]  # 承認取り消し
```

`approve` の挙動:

1. まず `validate(dir)` を走らせ、エラーがあれば承認しない(壊れた内容の承認を
   防ぐ)。
2. `process.stdin.isTTY` を確認。**非対話(TTY でない)かつ `--yes` なしなら拒否**:
   「approve は人間の対話操作です。preview で確認のうえ端末から実行してください
   (非対話環境では --yes が必要)」。
   → 子エージェント/`Bash` から reflex で叩いても既定で自己拒否する。task 指示の
     「AI が『承認して』と頼まれても非対話では反転しない」を自然に満たす。
3. TTY なら `preview.mp4` の確認を促す y/N プロンプト。yes で、現 cutplan(または
   short)から §2.1 のハッシュを算出し、`approvals.json` にレコードを書き、
   合わせて `cutplan.approved`(または `short.approved`)を `true` にする
   (boolean は表示同期のため揃える)。
4. `unapprove` は安全側(能力を減らすだけ)なので TTY ゲート不要。レコードを
   消し、boolean を `false` にする。

`--yes` は「意図的バイパス」の可視な入口。無制限権限下では止められないが、
transcript に明示的に残り、権限で `approve` 自体を ask/deny にもできる。

### 5.2 GUI

チェックボックスの UX は**現状のまま**(App.tsx は変更しない)。人間がチェックし
保存すると、サーバー(人間が起動した `npm run editor` プロセス=out-of-band の
権威)がレコードを mint する(§8)。AI はブラウザのチェックを押さない。
`curl` で `/api/save` を叩く経路は「意図的偽造」と同じクラスで、権限層の話に
帰着する(GUI サーバーへのアクセスを絞る)。

---

## 6. 中間生成物の書込スコープ強制(論点2)

### 6.1 現実的な評価

中間生成物は2種に分かれ、危険度が違う:

- **内容キー付きキャッシュ**(`cut.keeps.json` / `render.key.json` /
  `proxy.key.json` / `render.chunks/chunks.key.json` / `cut.<name>.keeps.json`
  など): 手編集されてもキー不一致で**再生成に落ちるだけ**=自己修復。破壊的
  被害は無い。これは既存設計が既に堅牢。
- **真実として読まれる生成物**(`manifest.json`): 手編集されると誤った前提で
  動く。ただし `ingest` で再生成でき、`validate` が durationSec 等を検査する。
- **プロンプト生応答等**(`plan.raw.txt` 等): 読み捨て。被害なし。

つまり「validate が中間生成物の手編集を内容整合で検出」(案 i)は、キャッシュに
対しては**過剰**(自己修復するので不要)で、opaque なキャッシュの「手編集」を
一般に検出するのはコスト高。よって **深追いしない**。

### 6.2 採る方針(軽量・プロジェクトの粒度に合う)

1. **ファイル分類をコードの単一の真実に**(`src/lib/files.ts`)。`EDITABLE_FILES`
   /`GENERATED_FILES`/`APPROVAL_FILE` を1箇所で定義し、backup.ts・docs・
   権限 deny リストがここから派生する。今は `EDITABLE_FILES` が backup.ts に
   だけあり、生成物一覧は CLAUDE.md の散文にしか無い。
2. **書込ホワイトリストは GUI に既にある**(`saveProject` は「渡された
   ドキュメントだけ書く」)。CLI/AI 経路には**単一の save チョークポイントが
   無い**(AI は Write ツールで直接書く)ので、cutflow のコードでは傍受できない。
   ここも**権限層に委ねる**のが正直: `GENERATED_FILES` から生成した
   **推奨 deny ルール**(生成物・キャッシュへの Write/Edit を deny)を
   ドキュメントで提供し(§10)、`src/lib/files.ts` を唯一の出所にする。
3. **キャッシュの自己修復に依拠**(既存): 生成物への誤書込の最悪ケースは
   再生成であることを明文化し、これ以上の保険は積まない。

この方針で、task が求める「CLI/AI 経路に GUI 相当の保険」は、**コードで傍受**
ではなく**権限層 + 分類の単一真実**という現実解に落とす。cutflow が
enforce できないものを enforce できると偽装しない。

---

## 7. validate の追加(早期フィードバック)

`validateDocs`(純関数)は変更しない(fs を触らない設計を保つ)。fs 版
`validate(dir)` ラッパにだけ、`approvals.json` を読んで次を**警告**する:

- `cutplan.approved === true` かつ(レコード無し or hash 不一致):
  「承認レコードがありません/承認後に cut が変更されています。この状態では
  render は拒否されます。preview で確認のうえ `cutflow approve` で再承認して
  ください」
- 各ショートについても同様。

警告どまり(exit 0)。編集ループ(JSON 編集 → validate)の中で、render を待たずに
「承認が飛んだ」ことに気づける。これが AI・人間双方の主なフィードバック。

**壊してはいけない既存挙動**: 既存の valid なプロジェクトで**新たな error を
出さない**(warning のみ)。`validateDocs` のテスト(`test/validate.test.ts`)は
純関数のままなので不変。

---

## 8. GUI サーバーのレコード mint(editor/server.ts)

`saveProject`(:644)に追記:

- 既存の `validateDocs` 前置ゲートは維持(壊れた保存の全拒否)。
- `body.cutplan` を書いた後:
  - `body.cutplan.approved === true` なら、書いた cutplan から §2.1 の
    ハッシュを算出し `approvals.json` の `cutplan` レコードを mint(`by:"gui"`)。
  - `false` なら `cutplan` レコードを clear。
- `body.shorts` の各ショートについても、`approved` に応じて当該 name の
  レコードを mint/clear。
- `approvals.json` を書くときも `selfWroteAt.set("approvals.json", …)` を
  呼ぶ。ただし `WATCHED_FILES` には**加えない**(承認レコードの変化で
  クライアントの hot-reload を起こす必要はない。cutplan/overlays/transcript/
  shorts の監視は現状のまま)。

これで GUI の UX は不変のまま、チェック→保存が承認レコードを生む。GUI は
「人間が起動したプロセスが人間のチェックで書く」= §1.3 の分離層の権威側。

**壊してはいけない既存挙動**: 他ドキュメントの保存・bgm/shorts の削除分岐・
validate 前置・`selfWroteAt` による自己イベント除外はそのまま。

---

## 9. config.yaml

- **新規の必須設定は追加しない。**
- ゲート無効化トグル(例 `approval.legacyBooleanGate`)は**意図的に入れない**
  (§4 の移行判断)。1つの YAML キーでゲート全体を殺せると、AI が config を
  書いてバイパスする新経路になり、安全設計の意味が消える。移行は
  `cutflow approve` 1回で足りる。
- ハッシュの丸め桁(ms)等はコードの定数に置く(config 化する意味が薄い・
  決定論を config でブレさせない)。

---

## 10. タスク分解(1タスク=1コミット)

依存順に並べる。**T3(render を strict に)は、承認を書ける両経路(T4 CLI・
T5 GUI)が揃った後に入れる**——先に入れると GUI/CLI からの承認手段が無いまま
既存フローが全部詰まるため。

### T1. 承認ハッシュ + レコード I/O ライブラリ + 単体テスト
- **変更ファイル**: `src/lib/approval.ts`(新規)、`src/types.ts`
  (`Approvals`/`ApprovalRecord` 追加。boolean のコメント更新)、
  `test/approval.test.ts`(新規)。
- **テスト方針**:
  - unit: 同一 keep 集合 → 同一 hash / cut 境界を動かす → hash 変化 /
    `reason` だけ変更 → hash 不変 / 同一境界の分割 → hash 不変
    (`mergeIntervals` 後同一)/ short は profile を変えると hash 変化。
  - `isCutplanApproved`: レコード無し=`{ok:false, reason:"…なし…"}` /
    hash 一致=`ok:true` / 不一致=`ok:false, reason:"…失効…"`。
  - 実データ: 既存収録フォルダの cutplan.json に対しハッシュが決定論で
    安定することを確認(2回算出して同値)。
- **壊してはいけない挙動**: 未配線なので既存挙動ゼロ変化。`npm run typecheck` /
  `npm test` が緑。Node 23 type-stripping 制約(enum/namespace/パラメータ
  プロパティ禁止)を守る。

### T2. ファイル分類の単一真実化(`src/lib/files.ts`)
- **変更ファイル**: `src/lib/files.ts`(新規: `EDITABLE_FILES`/`GENERATED_FILES`/
  `APPROVAL_FILE`/`fileRole`)、`src/lib/backup.ts`(`EDITABLE_FILES` を
  re-export へ)、`src/cli.ts`(import 元の切替のみ)、`test/files.test.ts`。
- **テスト方針**: unit で分類の網羅(CLAUDE.md の生成物一覧と一致)・
  重複なし・editable と generated が交差しないこと。
- **壊してはいけない挙動**: `backupEditableFiles` の対象集合が現状と**完全一致**
  (退避挙動不変)。`guardRerun` の backup リストも不変。

### T3 の前提として T4・T5 を先に置く(下記の順で)。

### T4. `approve` / `unapprove` CLI(TTY ゲート付き)
- **変更ファイル**: `src/cli.ts`(コマンド追加)、必要なら
  `src/lib/approval.ts` の writer を使用。
- **テスト方針**:
  - 実データ/手動: TTY で `approve` → `approvals.json` にレコード生成・
    boolean が true・hash が現内容と一致。`unapprove` で消える・false に戻る。
  - 非対話(パイプ/リダイレクトで `isTTY=false`)では `--yes` 無しは
    exit 1・レコード不変。`--yes` で承認される。
  - `approve` 前に validate エラーがあると承認しない。
- **壊してはいけない挙動**: 既存コマンド(plan/render/editor…)の挙動不変。
  `postAction` の所要時間表示等の共通フックと整合。

### T5. GUI サーバーのレコード mint/clear
- **変更ファイル**: `editor/server.ts`(`saveProject` に mint/clear、
  `selfWroteAt` に approvals.json、`WATCHED_FILES` は据え置き)。
- **テスト方針**:
  - 手動(エディタ再起動が必要: クライアントは起動時に1回バンドル):
    チェック→保存で `approvals.json` 生成、hash が保存内容と一致。
    チェック外し→保存でレコード消滅。ショートのチェックで name 別レコード。
  - headless 検証で hot-reload が approvals.json 変化で無駄に発火しないこと。
- **壊してはいけない挙動**: 他ドキュメント保存・validate 前置・bgm/shorts の
  削除分岐・自己イベント除外・素材アップロードは不変。

### T6. render ゲートを承認レコードへ(strict)
- **変更ファイル**: `src/stages/render.ts`(本編 `:78`・ショート `:274`/`:296`)。
- **テスト方針**:
  - 実データ/手動: (1) レコード無しで render → 拒否&案内文。
    (2) `cutflow approve` 後 render → 従来どおり成功、cut.mp4/final.mp4/
    キャッシュ再利用が不変。(3) 承認後に cutplan の keep を編集 → render 拒否
    (hash 失効)。(4) `render --shorts` が未承認ショートを理由付きで skip。
  - 既存の承認済み(レコードあり)ケースで最終出力が bit 同等(ゲートは入口
    判定のみ)。
- **壊してはいけない挙動**: cut.mp4 / render.key.json / チャンク差分レンダー /
  ショートのキャッシュキーは一切変更しない。既存の承認済みプロジェクトの
  出力・再利用ログが不変。

### T7. validate の承認整合チェック(警告)
- **変更ファイル**: `src/stages/validate.ts`(fs 版 `validate(dir)` ラッパのみ。
  `validateDocs` は不変)。
- **テスト方針**: 手動: approved:true でレコード無し/陳腐化 → 警告が出る・
  exit 0。承認済み一致 → 警告なし。`test/validate.test.ts`(純関数)は不変。
- **壊してはいけない挙動**: 既存 valid プロジェクトで新たな **error** を出さない
  (warning のみ)。`validateDocs` のシグネチャ・純粋性を保つ。

### T8. ドキュメント + 推奨権限ルール(コード変更なし)
- **変更ファイル**: `CLAUDE.md`(承認=内容束縛レコードに更新・
  `approve`/`unapprove` 追加・`approvals.json` を「触らない第3カテゴリ」として
  記載・中間生成物の権限ガイド)、`docs/usage.md`(どのファイルが何を決めるか
  の表に approvals.json、コマンド表に approve/unapprove)。
- **内容の核**: Claude Code の `settings.json` に貼れる**推奨 deny スニペット**を
  `src/lib/files.ts` の `GENERATED_FILES` + `APPROVAL_FILE` から起こして掲載
  (`approvals.json` への Write/Edit を deny、`approve` の Bash を ask、
  生成物・キャッシュへの Write を deny)。ここが §1.3 権限層の実配布物。
  「これを入れて初めて AI は物理的に承認を書けない」ことと、入れない場合の
  残余リスク(偶発は塞がる/意図的偽造は残る)を正直に書く。
- **テスト方針**: 記述と実装(files.ts の一覧、approve の挙動)の一致を目視。
- **壊してはいけない挙動**: ドキュメントのみ。`docs/reviews/` の診断レビューは
  入力データなので**変更しない**。

---

## 11. 後方互換の移行パス(まとめ)

- 既存フォルダに `approvals.json` は無い → strict で「未承認」扱い(§4)。
- 復旧は `cutflow approve <dir>` を1回(データ破壊なし・冪等)。render の
  エラーメッセージがそのまま手順を案内。
- 完成済み(final.mp4 あり)フォルダは再レンダー不要=実害ほぼ無し。
- `plan`/`run`/`plan-shorts` は cutplan/shorts を作り直すが、内容が変われば
  ハッシュ不一致で承認は自動失効するので、**これらのコマンドを承認レコードの
  ためだけに改修する必要はない**(安全側に倒れる)。承認レコードの明示的な
  クリアは任意(将来 tidy として追加可)。
- `CutPlan.approved`/`Short.approved` フィールドは残すので、既存 JSON の
  読み込み・GUI モデル・人間の目視は壊れない。
