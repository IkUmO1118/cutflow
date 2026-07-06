# 語/トークン単位タイムスタンプ 設計ドキュメント

対象: 診断レビュー `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Now ロードマップ
項目2「★ 語/トークン単位タイムスタンプ」(effort S)。

このフェーズのゴールは **word timing を生成・検証・保存(round-trip 保持)するところまで**。
frames / render / describe は今は word を無視してよい(唯一の当面の下流はフェーズ3の
「テロップのカラオケアニメ」で、そこで初めて words[] を消費する)。

最優先の不変条件: **既存の transcript.json(word 情報なし)がそのまま動くこと**、
かつ **機能オフ時は既存挙動が1バイトも変わらないこと**。

---

## 実機で確認した事実(設計の根拠)

whisper-cli(= whisper.cpp、`/opt/homebrew/bin/whisper-cli`)を検証データの
`~/Movies/cutflow/2026-07-02-whisper-bench/audio/mic.wav` の先頭12秒クリップ
(`ffmpeg -t 12 -ar 16000 -ac 1`)、モデル `ggml-large-v3-turbo-q5_0.bin`、`-l ja` で実測。

- **`-ojf`(output-json-full)は `-oj` と segment レベルで完全一致**する。
  同一クリップで `-oj` と `-ojf` の各セグメントの `text` / `offsets.{from,to}` を比較して
  完全一致を確認済み。`-ojf` は各セグメントに `tokens[]` 配列を **付加するだけ**で、
  既存の segment 区切り・text・offsets を一切変えない。→ **decision 1 で `-ojf` を選ぶ根拠**。
- `-ojf` の token 1件の実形(default セグメンテーション時、1文= 1セグメント内):

  ```json
  {
    "text": "から",
    "timestamps": { "from": "00:00:00,880", "to": "00:00:02,630" },
    "offsets":    { "from": 880, "to": 2630 },   // ミリ秒
    "id": 12345,
    "p": 0.976,          // 確信度 0..1
    "t_dtw": -1          // -dtw MODEL 指定時のみ有効。既定は -1(未使用)
  }
  ```

- **特殊トークン**が tokens[] に混ざる。実測で観測したもの:
  - `[_BEG_]` … セグメント先頭。`offsets {from:0,to:0}`(ゼロ幅)、`p` は低め。
  - `[_TT_441]` のような `[_TT_NNN]` … セグメント末尾のタイムスタンプトークン。ゼロ幅。
  - いずれも `[_..._]` で囲まれた角括弧トークン。**除外対象**。
- 日本語トークンはサブワード(`テ` / `スト`、`取` / `ります`)で、**前後空白は付かない**
  (英語では先頭に半角空白が付くことがある。実装では両対応で `.trim()` する)。
- `-ml N`(max segment length)を付けると **セグメンテーション自体が変わる**
  (`-ml 1` で 1トークン= 1セグメントになり、既存の文単位区切りが壊れる)。
  → **decision 1 で (b) を却下する根拠**。`-ml` は付けない。
- `-dtw MODEL` を付けると `t_dtw` に DTW ベースの高精度トークン時刻が入るが、
  追加モデル指定と実行コストが必要。今フェーズでは不要(`offsets` で十分)。

---

## 設計判断

### 1. word timestamp の取得方法 → **(a) `-ojf` の per-token `offsets` を読む**

| 選択肢 | 評価 |
|---|---|
| **(a) `-ojf` full JSON の tokens[]** | ★推奨。既存の `-oj` 実行に `-ojf` を足すだけ(`-oj` は `-ojf` の下位互換で、`-ojf` 単体でも segment レベル JSON は同じ)。**segment の text/offsets が現状と完全一致**することを実測で確認済み。token timing は既存構造の中に付加される。パースは既存の `whisperJson.transcription[].tokens[]` を1階層潜るだけ。 |
| (b) `-ml 1` + `-oj` | 却下。`-ml` はセグメンテーションを破壊する。1トークン= 1セグメントになり、既存の「文レベル区切り」= `TranscriptSegment` の粒度が消える。最優先条件(既存 segment 不変)に真っ向から反する。 |
| (c) `-owts` の .wts スクリプト parse | 却下。`.wts` は ffmpeg/カラオケ描画用のシェルスクリプトで、機械可読な構造化データではない。パースが脆く、confidence も取れない。 |

**結論**: transcribe の whisper 実行に `-ojf` を追加(`-oj` はそのまま or 置換)。
既存の segment 変換ロジックはそのまま使い、各 segment に対して同じ `tokens[]` から
words[] を組み立てて付加する。segment の `start/end/text` を算出する既存コードには
一切手を入れない。

> 実装メモ: `-oj` と `-ojf` を両方渡しても害はないが、`-ojf` だけで `-oj` 相当の
> JSON(`transcription[].offsets/text`)も出るので、**`-oj` を `-ojf` に置き換える**のが
> 素直(出力ファイル名は同じ `whisper-out.json`)。`-osrt` はそのまま残す。

### 2. スキーマ → `TranscriptSegment.words?: WordTiming[]`(省略可)

```ts
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  track?: number;
  pos?: CaptionPos;
  style?: CaptionStyle;
  /** 語/トークン単位のタイミング(whisper -ojf の per-token offsets 由来)。
   * 省略可(後方互換)。**カラオケアニメ等の描画専用の補助データで、テロップの
   * 文言・表示区間そのものは常に text / start / end が正**。人間が text を
   * 手編集すると words[] は古くなりうる(§5 参照)。特殊トークン([_BEG_] /
   * [_TT_NNN] 等)と空 text は除外済み。時刻は他と同じく「元収録(raw)の秒」。
   * words[] は時系列順で、各 word の [start,end) は親 segment の [start,end] に収まる */
  words?: WordTiming[];
}

/** transcript の1語/1トークンのタイミング。whisper のサブワード単位
 * (日本語は分かち書きが無いためトークン=サブワード)。時刻は元収録の秒 */
export interface WordTiming {
  /** トークン文字列(前後空白を trim 済み。特殊トークンは含めない) */
  text: string;
  /** 開始・終了(元収録の秒)。start < end。親 segment の範囲内 */
  start: number;
  end: number;
  /** whisper の確信度(0..1、-ojf の token.p)。省略可 */
  confidence?: number;
}
```

**単位**: 秒(segment と揃える)。whisper の ms は transcribe が `/1000` して秒に変換
(既存の segment 変換と同じ規約)。ドキュメント全体で「時刻は元収録の秒」で一貫させる。

**confidence**: 持つ(`confidence?`、省略可)。カラオケ演出で「確信度の低い語を
強調しない/色を変える」等に使える安価な付加価値。持たない設計に後から足すより、
最初から round-trip させておく方が安い。値は `token.p` をそのまま(0..1)。

**特殊トークン・空 text の除外方針**(transcribe 側で適用):
- 角括弧特殊トークンを除外: `/^\[.*\]$/` にマッチする token(`[_BEG_]`, `[_TT_NNN]`,
  `[_SOT_]` 等)は words[] に入れない。
- `text.trim()` した結果が空文字の token は除外(ゼロ幅の区切りトークン対策)。
- `from >= to`(ゼロ幅)の token も除外(念のため。特殊トークンは全てゼロ幅だが、
  括弧フィルタと二重で守る)。
- 残った token の `text` は `.trim()` して格納(英語先頭空白対策。日本語では no-op)。

### 3. 有効化スイッチ → **config `whisper.wordTimestamps: boolean`、既定 `false`**

| 選択肢 | 評価 |
|---|---|
| **config でオン/オフ、既定 false** | ★推奨。既定オフなら **既存挙動が完全に不変**(words[] を一切書かない= 現状の transcript.json と 1バイト差)。唯一の下流(カラオケ)がまだ無い今フェーズで、全ユーザーに JSON 肥大を強制しない。フェーズ3で既定を true に切り替える判断を後日できる。 |
| 常時オン | 却下。今 words[] を使う機能が無いのに transcript.json が数倍に膨れる。AI が読む基層としてもノイズ。後方互換の「オフ時完全同一」保証も作れない。 |

`config.yaml` の `whisper` セクションに `wordTimestamps: false` を追加。型は
`src/lib/config.ts` の `whisper: { bin; model; language }` に `wordTimestamps: boolean` を足す。
**既定 false**(config に書かれていなければ false)。

- `false`: 現状どおり。`-oj`(または segment だけ読む)、words[] を書かない。
  出力 transcript.json は現状とバイト一致。
- `true`: `-ojf` で実行し、各 segment に words[] を付加。

> 実装メモ: config のデフォルト補完がどこで行われているか(`src/lib/config.ts`)を確認し、
> 未指定時に `false` になるようにする。既存の config.yaml に書き足す必要はない
> (未指定= false = 現状動作)。

### 4. 後方互換と検証 → validate は words の有無どちらも受理。words 検査は**エラー**級のみ厳格

`validate.ts` の transcript.json 検査ブロック(187〜214行目)に、segment ごとの
words[] 検査を **追加**する(words が undefined なら何もしない= 現状と同一)。

words[] がある場合の検査(`s.words !== undefined` のときだけ):
- `s.words` が配列でなければ **エラー**(`words は配列です`)。
- 各 word について:
  - `text` が string でなければ **エラー**。空文字は **警告**(表示に使わない語)。
  - `start`/`end` が数値かつ `start < end` でなければ **エラー**(`checkSpan` を流用可。
    ただし `checkSpan` は `s.start`/`s.end` を見るので word 用に小さな専用チェックを書くか、
    word オブジェクトを渡す。`dur` 超えは親 segment 検査に任せて word では省略してよい)。
  - `start`/`end` が親 segment の `[start, end]` 範囲内か。**わずかな逸脱(EPS=0.005s)は許容**、
    それを超える逸脱は **警告**(whisper の丸め・末尾ずれがありうるため。描画専用データなので
    エラーにして render を止める価値は低い)。
  - `confidence` があるとき、数値かつ 0..1 の範囲外なら **警告**(描画に致命的でない)。
- words[] の時系列順は **警告**(厳密には whisper 由来で必ず昇順だが、手編集で崩れうる。
  カラオケ描画がおかしくなるだけなので警告どまり)。

方針の一貫性: **words[] は描画専用の補助データ**なので、「壊れると render がクラッシュ/
明らかに不正になる」ものだけエラー(text 型・配列型・start<end)、「意図と違うかも」は
警告(範囲逸脱・順序・confidence 範囲)。既存の validate 方針(エラー= 壊れる、警告= 動くが変)に沿う。

`counts.captions` 等の集計には影響させない(words はテロップ件数を変えない)。

### 5. round-trip 保持と乖離の扱い

**round-trip の担保**:
- 下流の消費者(plan.ts の numberSegments、renderProps.ts の captions 構築、
  captionIndex.ts、describe.ts、GUI エディタ)は **words[] を読まないし書き換えない**。
  これらは `TranscriptSegment` を「必要なフィールドだけ」参照する構造なので、
  words[] は素通しされる(オブジェクトを丸ごと再構築して words を落とす箇所が無いか、
  実装者は下流を確認すること)。
- **要注意ポイント(実装者への申し送り)**: GUI エディタが transcript を保存するとき、
  segment オブジェクトを再構築して既知フィールドだけコピーしていると words[] が消える。
  `editor/server.ts` の保存経路と client のシリアライズを確認し、**未知フィールドを
  保持する(spread で丸ごと保存する)**ことを確認する。もし既知フィールドだけを
  拾っているなら words を明示的に通す。今フェーズは editor が words を編集する必要は
  無い(素通しでよい)。
- renderProps.ts の captions 構築(95〜113行)は segment から新しい Caption を作るが、
  これは **transcript.json とは別物**(render.props.json 側)なので words を通さなくてよい。
  transcript.json 自体を書き換える経路(transcribe / editor 保存)だけが round-trip 対象。

**text 手編集による乖離**:
- 人間がテロップ文言(`text`)を手編集すると words[] は古くなる(語が増減・変化しても
  words[] は元のまま)。**今フェーズは放置(警告も出さない)**。理由:
  - words[] はまだどこにも描画されず、乖離が実害を生まない。
  - text と words[] の対応を機械的に検証するのは難しい(日本語サブワードと編集後テキストの
    アラインメントは非自明)。安価な検査が書けない。
- **フェーズ3(カラオケ実装)で再検討**する旨をこのドキュメントに記録。カラオケ描画時に
  「words[] を text から再アライン or 乖離検知」を設計する。今は words[] を「whisper が
  最後に生成した時点のスナップショット」と割り切る。この方針を `types.ts` の
  WordTiming コメントにも一言残す(上のスキーマ案に反映済み)。

### 6. describe.ts への表示 → **出さない**

describe は「タイムラインの要約」で、AI/人間が内容を素早く把握するための出力。
語単位 timing はカラオケ実装まで消費者が無く、出すと per-segment のテキストが
トークン列で埋まってノイズになる。**describe.ts は変更しない**(最小変更・現状の
segment 単位表示のまま)。フェーズ3で必要になれば足す。

---

## タスク分解(1タスク= 1コミット、依存順)

### タスク 1: スキーマ追加(型 + コメント)
- **変更**: `src/types.ts`。`WordTiming` interface を新規追加、`TranscriptSegment` に
  `words?: WordTiming[]` を追加。両方に上の設計案どおりのコメント。
- **テスト**: `npx tsc --noEmit`(型が通ること)。既存 `test/*.test.ts` が全て緑のまま
  (`npm test`)。この段では挙動は変わらない(省略可フィールドを足すだけ)。
- **壊してはいけない**: 既存の `TranscriptSegment` 利用箇所すべて(words は optional なので
  型エラーは出ないはず)。enum/namespace/パラメータプロパティは使わない(interface のみなので該当なし)。
- **依存**: なし(最初)。

### タスク 2: config に `whisper.wordTimestamps`(既定 false)
- **変更**: `src/lib/config.ts`(`whisper` 型に `wordTimestamps: boolean` 追加 + 既定補完で
  未指定時 false)。`config.yaml` の whisper セクションにコメント付きで
  `wordTimestamps: false`(既定を明示・任意)。`docs/usage.md` に config 項目があれば追記。
- **テスト**: `test/config.test.ts` に「未指定時 wordTimestamps=false」ケースを追加。
  `npm test`。
- **壊してはいけない**: 既存 config.yaml をそのまま読めること(未指定でも動く)。
  config を読む他コード。
- **依存**: なし(タスク1と独立だが、後続が両方に依存)。

### タスク 3: transcribe が words[] を生成(スイッチ on 時のみ)
- **変更**: `src/stages/transcribe.ts`。
  - `WhisperJson` 型に `tokens?` を追加(`transcription[].tokens[]` の
    `{ text, offsets:{from,to}, p }`)。
  - `cfg.whisper.wordTimestamps` が true のとき whisper 引数を `-oj` →`-ojf` に変更
    (false のときは現状のまま)。`-osrt` はそのまま。
  - segment 変換(既存の `.map(...).filter(...)`)は **一切変えない**。true のときだけ、
    各 segment に対応する `tokens[]` から words[] を作って付加する:
    - `[_..._]` 角括弧トークン除外、`text.trim()` が空を除外、`from>=to` 除外。
    - `{ text: tok.text.trim(), start: from/1000, end: to/1000, confidence: tok.p }`。
    - words[] が空配列になった segment は `words` を **付けない**(空配列を書かない=
      JSON を無駄に膨らませない)。
  - **words[] の付加は「segment を組み立てた後」に別ステップで行う**(既存の
    text/start/end 算出には手を触れない)。理想は変換ロジックを純関数
    (`buildWords(tokens): WordTiming[]`)に切り出し、テスト可能にする。
- **テスト**:
  - **unit**: `buildWords`(切り出せば)を新規 `test/transcribe.test.ts`(または既存があれば
    そこ)で、実測した token JSON のミニ fixture(`[_BEG_]` / 通常トークン / `[_TT_NNN]` 混在)を
    入れて、特殊トークン除外・ms→秒変換・trim・confidence 転記を固定する。
  - **実データ検証**: 下記「実データ検証手順」参照。
- **壊してはいけない**: `wordTimestamps: false`(既定)時に transcript.json が **現状とバイト一致**。
  segment の text/start/end/track/pos/style は true でも false でも不変。空 text segment の
  除外(既存 filter)は維持。
- **依存**: タスク1・2。

### タスク 4: validate が words[] を検査
- **変更**: `src/stages/validate.ts` の transcript.json ブロック(193〜210行あたり)に、
  segment ごとの words 検査を追加(`s.words !== undefined` のときだけ)。§4 の方針どおり:
  配列型・text 型はエラー、start<end はエラー、範囲逸脱・順序・confidence 範囲は警告。
  word 用の小さなヘルパ(`checkWords`)を末尾の共通チェック群に追加するのが素直。
- **テスト**: `test/validate.test.ts` に:
  - words 無し segment が現状どおり通る(回帰: 既存ケースはそのまま緑)。
  - 正常な words[] が問題ゼロ。
  - words が配列でない/word.text が非 string/word.start>=end → エラー。
  - word が親 segment 範囲を EPS 超で逸脱 → 警告。confidence 範囲外 → 警告。
- **壊してはいけない**: words 無しの既存 transcript 検査結果(エラー/警告の集合)が不変。
  `counts.captions` 集計。エディタの `/api/save` 共有経路(validateDocs)。
- **依存**: タスク1(型)。タスク3とは独立に実装・テスト可能(fixture を手書きすればよい)。

### タスク 5: round-trip の確認(エディタ保存経路)
- **変更**: 原則 **コード変更なし**(確認タスク)。`editor/server.ts` の transcript 保存経路と
  client のシリアライズを読み、segment の未知フィールド(words)が保存で落ちないことを確認。
  もし既知フィールドだけ拾って再構築している箇所があれば、words を素通しするよう最小修正。
- **テスト**: 手動 or 軽い統合 — words 付き transcript.json を用意 → エディタで開いて保存 →
  words[] が残っていることを確認(§検証手順に具体化)。エディタはバンドル再起動が必要
  (MEMORY: editor-bundle-restart)。
- **壊してはいけない**: エディタの既存保存挙動。ホットリロード。
- **依存**: タスク1・3(words 付き transcript を作れること)。

### タスク 6: ドキュメント整合
- **変更**: `CLAUDE.md` の「どのファイルが何を決めるか」表の transcript.json 行、
  `docs/usage.md` の transcript.json 説明、`src/types.ts` コメント(タスク1で済み)を揃える。
  words[] が「カラオケ用の描画補助・省略可・text が正」であることを一言。config の
  `whisper.wordTimestamps` を usage の config 節に。
- **テスト**: なし(ドキュメント)。ただし CLAUDE.md の「スキーマを変えたら types.ts /
  validate.ts / docs/usage.md の表も揃える」ルールを満たすためのタスク。
- **依存**: タスク1〜4。

---

## 実データ検証手順(既存データを破壊しない)

検証データ: `~/Movies/cutflow/2026-07-02-whisper-bench`。既存の `transcript.json` /
収録ファイル / `whisper-out.json` を **上書きしない**。以下は全てスクラッチor別名で行う。

### 準備(短いクリップを別ディレクトリに)
whisper 全編再実行は数分。短クリップで速く回す。**収録フォルダには書かない**。

```sh
WB=~/Movies/cutflow/2026-07-02-whisper-bench
TMP=$(mktemp -d)                       # スクラッチ
ffmpeg -y -i "$WB/audio/mic.wav" -t 12 -ar 16000 -ac 1 "$TMP/clip.wav"
MODEL=~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
```

### 検証A: `-ojf` が segment を変えないこと(既に実測済み・実装後の回帰確認)
```sh
whisper-cli -m "$MODEL" -l ja -f "$TMP/clip.wav" -oj  -of "$TMP/plain"
whisper-cli -m "$MODEL" -l ja -f "$TMP/clip.wav" -ojf -of "$TMP/full"
# plain.json と full.json の transcription[].text / offsets が一致することを確認
# (tokens[] が full.json にだけ増えている)
```

### 検証B: transcribe の実挙動(スイッチ off/on)
`transcribe.ts` を直接叩けないなら、`buildWords` 純関数の unit テストを主とし、
統合は既存 `whisper-out.json` の **再パース**で速く確認する:
- **off(既定)**: `wordTimestamps` 未指定/false で transcribe を回すと、生成される
  transcript.json が words を持たないこと。可能なら既存 `transcript.json`(backup 済み)と
  segment 部分がバイト一致すること。
- **on**: 短クリップ由来の `whisper-out.json`(`-ojf`)を入力に、生成 transcript の各 segment に
  妥当な words[] が付くこと(件数・時刻が token とおおむね一致、特殊トークンが除外されている)。

> 収録フォルダの `whisper-out.json` は `-oj`(tokens 無し)なので、on 検証には
> スクラッチの `full.json`(`-ojf`)を使う。収録フォルダの `whisper-out.json` を
> `-ojf` で上書きしないこと(必要なら別名 `$TMP/full.json` で)。

### 検証C: validate
words 付き transcript.json(スクラッチにコピーした収録フォルダ、または最小手書き fixture)に
対し `node src/cli.ts validate <tmpdir>` を実行し、words 正常→問題なし、意図的に壊した
word(start>=end 等)→エラー、範囲逸脱→警告 を確認。**本物の収録フォルダでは実行しない**
(validate は読み取り専用だが、念のため検証はコピーで)。

### 検証D: round-trip(エディタ)
words 付き transcript.json を持つスクラッチ収録フォルダでエディタを起動(バンドル再起動を
忘れない)、テロップを1つ選んで位置だけ動かして保存 → 保存後の transcript.json に words[] が
残っていることを確認。

### 原状復帰
- スクラッチ `$TMP` を `rm -rf`。
- 収録フォルダには書き込んでいないので復帰不要。もし誤って `whisper-out.json` 等を
  上書きしたら、収録フォルダの `*.bak`(`transcript.json.bak` 等が存在)や
  `backups/` から復元。**検証中は収録フォルダ直下に一切書かない**のが原則。

---

## 想定される落とし穴

1. **`-oj` を消して `-ojf` だけにするとき**: `-ojf` は `-oj` の上位互換で segment JSON も
   出す(実測確認済み)。ただし出力ファイル名は同じ `whisper-out.json` になることを確認
   (`-of` ベース名は変えない)。既存の `whisper-out.srt`(`-osrt`)も維持。
2. **token text のトリム**: 英語は token 先頭に半角空白が付く(` から` ではなく英語で顕著)。
   必ず `.trim()`。日本語では no-op だが両対応で。trim 後空文字は除外。
3. **特殊トークンの網羅**: `[_BEG_]` / `[_TT_NNN]` を実測で確認したが、`-ps`(print-special)を
   付けなければ通常はこの2種程度。角括弧 `/^\[.*\]$/` フィルタで将来の特殊トークン
   (`[_SOT_]`, `[_EOT_]` 等)もまとめて除外できる。`-ps` は付けないこと(付けると特殊トークンが
   text 本体にも混ざる)。
4. **ミリ秒/秒**: whisper の offsets は **ミリ秒**。segment と同じく `/1000` で秒に。
   混在させると words が 1000倍ずれる。
5. **空セグメント除外との整合**: 既存 transcribe は `text.length > 0` で空 segment を除外している。
   words[] の付加は **除外後の segment に対して**行う(除外された segment には words を作らない)。
   逆に、words[] が空になった(全 token が特殊/空)segment でも、text が非空なら segment 自体は
   残す(words を付けないだけ)。
6. **token と segment の対応**: `-ojf` では tokens[] は **各 segment の中に**入っている
   (`transcription[i].tokens[]`)。グローバルな token 配列を segment に割り振り直す必要は無い。
   segment ループ内でその segment の tokens[] だけ見ればよい。
7. **JSON 肥大**: on にすると transcript.json が数倍になる。既定 off でこれを回避。
   words[] は「JSON.stringify(…, null, 2)」で素直に出る(既存の書き出しをそのまま使う)。
8. **`confidence` の欠測**: token に `p` が無いケースは実測では見ていないが、防御的に
   `typeof tok.p === "number"` のときだけ confidence を付ける(無ければ省略)。
9. **round-trip の盲点**: transcript を「既知フィールドだけ再構築」して保存するコードが
   editor / どこかにあると words が消える。タスク5で必ず確認。renderProps は別ファイル
   (render.props.json)を作るので対象外。
10. **type stripping 制約**: enum / namespace / パラメータプロパティは使わない。今回は
    interface と純関数だけなので該当しにくいが、`buildWords` 等はクラスにせず素の関数で。
