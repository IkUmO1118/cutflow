# エディタにテロップ登場/退場アニメ・カラオケ表示の編集 UI を足す設計

対象: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Now ロードマップで
レンダー側は実装済みの「テロップ登場/カラオケアニメ」(`CaptionStyle.anim` /
`CaptionStyle.karaoke`)を、GUI エディタ(`editor/client/`)で人間が編集できる
ようにする。現状 editor に anim/karaoke/words を扱う UI は無く、人間は
`transcript.json` の `style` を手編集するしかない。

**スコープ: エディタ UI だけ。** スキーマ(`src/types.ts`)・レンダー
(`src/lib/captionAnim.ts` / `remotion/Main.tsx`)・validate・型定義は一切
変更しない。すべて `CaptionStyle.anim` / `CaptionStyle.karaoke` の
「読み書きするフォーム」を Inspector に足すだけ。

---

## 前提として確定した事実(調査済み)

- Inspector の単体テロップ編集は `Inspector.tsx` 内 `selection.kind === "caption"`
  ブロック。`base: CaptionStyle`(トラック標準→config 既定を畳んだ値)を組み、
  `patchStyle(p: Partial<CaptionStyle>, key?)` で `s.style` を項目単位更新する。
  `patchStyle` は `{ ...s.style, ...p }` を作り **トップレベルの `undefined`
  キーだけ**を消し、空になれば `style` ごと消す。undo まとめは `updateCaption`
  の `coalesceKey` に相乗り。
- 既存 style 項目(サイズ・色・縁取り・フォント・太さ・座布団)はすべてこの
  `patchStyle` 経由。`background`(ネスト obj:{color,paddingPx,radiusPx})は
  「ネストの一部を変えるときは `{ background: { ...bg, color } }` と既存を
  spread して丸ごと差す」流儀が既にある。**`anim` / `karaoke` も同型のネスト
  obj なので、この background の作法をそのまま踏襲する。**
- 複数選択の一括編集は別コンポーネント `BatchCaptionPanel`。`common(get)` で
  「全件共通値 / 混在(mixed)」を出し、`updateCaptionsStyle(indices, patch|null)`
  で一括適用(`patch===null` で個別 style 全解除)。
- ショートモードのテロップ編集は別コンポーネント `ShortCaptionPanel`。per-segment
  の style を持たず、常にトラック単位(`shorts.json` の `captionTracks`)へ書く
  (`setShortCaptionTrackDefault`)。**本編 `transcript.json` の `style` は触らない。**
- **プレビュー(`@remotion/player`)は最終レンダーと同じ `remotion/Main.tsx` を
  `component` に渡している**(`App.tsx`)。`Main.tsx` は `captionAnim.ts` を使って
  anim/karaoke を既に描く。つまり **anim/karaoke のライブプレビューは
  Player 側で既に動く**(追加コード不要)。`CaptionOverlay.tsx` はドラッグ用の
  透明ヒットボックス層(静的テキスト)で、アニメには関与しない。
- validate は既に:①`style.anim` の型・種別(`CAPTION_ANIM_KINDS`)・
  `durationSec>=0` を検査、②`style.karaoke` の色/`inactiveOpacity`(0〜1)/`mode`
  を検査、③**per-segment の `style.karaoke` 指定なのに `words[]` が空/無いとき
  警告**(exit 0、通常表示にフォールバック)。UI 側はこの警告と重複する
  ブロッキングをしない。
- `words[]` の有無はセグメント自身(`s.words`)から判定できる:
  `Array.isArray(s.words) && s.words.length > 0`。
- 部品(`widgets.tsx`): `Segmented<T>`(セグメント型トグル)、`PctSlider`
  (0〜N%)、`NumInput`(`allowEmpty`/`placeholder`/`onCommit`)、`splitColor`/
  `joinColor`(#rrggbb⇔alpha 分解)。anim/karaoke の UI はこれらだけで組める。
- `CAPTION_ANIM_KINDS` は `validate.ts` のローカル定数(未 export)。`types.ts`
  にあるのは union 型 `CaptionAnimKind` のみ。エディタは自前のラベル付き選択肢
  配列(日本語ラベル)を持つ(runtime 配列が types に無いため。値の正しさは
  型と validate が担保する)。

---

## 決定(decisions 形式)

### 論点1: anim の UI 形

**選択肢**
- (A) 「登場」「退場」を `CaptionAnimKind` の `<select>`(`none` を含む全種別)、
  `durationSec` を `NumInput`(`allowEmpty`, placeholder=`0.3`)。
- (B) 種別を `Segmented` トグル、duration をスライダー。
- (C) 「アニメを付ける」オン/オフのマスタートグル+詳細。

**トレードオフ**
- 種別は 7 値(fade / slide-up/down/left/right / pop / none)あり `Segmented`
  では横に収まらない → `<select>` が妥当(既存フォント/太さも `<select>`)。
- duration は in/out **共通の 1 値**(スキーマ上 `durationSec` は 1 個)。個別に
  分けられないので 1 つの `NumInput` にする。既存の素材フェードや zoom.easeSec
  と同じ「空欄=config/既定」流儀に揃える(placeholder に `DEFAULT_CAPTION_ANIM_SEC`)。
- マスタートグル(C)は「in/out 片方だけ指定」を表現しづらい(スキーマは in/out
  独立)。2 つの select が素直で、両方「なし」なら anim キー自体が消える形にする。

**結論**
- **登場(`anim.in`)/退場(`anim.out`)を各 `<select>` にする。** 選択肢は
  `なし(標準)` = 値 `""`(=キー削除でトラック標準/既定を継承)、`アニメ無し(none)`
  = 値 `"none"`(=トラック標準を明示的に打ち消す)、以下 `fade`/`slide-*`/`pop`。
  この「`""`(継承)と `none`(明示打ち消し)を別扱い」は既存の縁取り
  (`outlineColor: undefined` vs `"none"`)と同じ二分でユーザーに一貫する。
- **`durationSec` は `NumInput`(`allowEmpty`, placeholder=`String(DEFAULT_CAPTION_ANIM_SEC)`)。**
  in も out も「なし(継承)」のときだけ duration 欄を出さない(意味がないため)。
- **patchStyle 整合(重要):** anim はネスト obj。変更は毎回「現在の `s.style?.anim`
  を spread → 該当キーを差す → `in`/`out`/`durationSec` が **すべて undefined なら
  `anim: undefined`(キーごと削除)**」を計算してから `patchStyle({ anim })` を
  呼ぶ小ヘルパー `patchAnim(p: Partial<CaptionAnim>)` を単体パネル内に置く。
  - `in`/`out` の `<select>` で `""` を選んだら該当サブキーを `undefined` に。
  - **ネストの undefined 掃除は自前で行う**(`patchStyle` はトップレベルしか
    掃除しない)。`patchAnim` 内で `{ in, out, durationSec }` から undefined
    サブキーを delete し、空 obj になったら `anim: undefined` を渡す。これで
    「anim を 1 つも指定しない `transcript.json` は既存とバイト等価」を満たす。
- **既定(アニメ無し)との区別:** in=out=`""`(継承)かつ duration 未指定 →
  `anim` キー自体が無い = 現状。`in="none"` は「トラック標準にアニメがあっても
  このテロップは動かさない」意図で JSON に残る(これは意図した差分)。

### 論点2: karaoke の UI 形

**選択肢**
- (A) 「カラオケ表示」オン/オフのマスターチェックボックス+個別項目
  (activeColor / inactiveColor 色入力、inactiveOpacity スライダー、mode トグル)。
- (B) マスター無しで各項目を常時表示(空=無効)。

**トレードオフ**
- karaoke は「有効/無効」がまず主役の機能(色は副次)。座布団(`background`)が
  「オン/オフのチェックボックス→オンのとき詳細」の形を既に持ち、ユーザーに
  馴染む。(B) は「全項目空でも karaoke キーが有る=有効」と紛らわしい。
- `mode` は `word`(既定)/`fill` の 2 値 → `Segmented` が最適。
- `activeColor` 省略時は `KARAOKE_DEFAULT_ACTIVE`(#ffe14d)、`inactiveColor`
  省略時はテロップ本文色。色入力の初期表示はこの既定を出す(座布団色の作法と同じ)。

**結論**
- **「カラオケ表示」チェックボックスをマスターにする**(座布団と同じ流儀)。
  - オン → `patchStyle({ karaoke: {} })`(空 obj = 全既定でカラオケ有効)。
  - オフ → `patchStyle({ karaoke: undefined })`(キーごと削除 = 現状に戻る)。
- **オンのときだけ**詳細を出す:
  - `activeColor`: `<input type="color">`、初期値 `karaoke.activeColor ?? KARAOKE_DEFAULT_ACTIVE`。
  - `inactiveColor`: `<input type="color">`、初期値 `karaoke.inactiveColor ?? effStyle.color(本文色)`。
    「未指定に戻す」小ボタンで `inactiveColor: undefined`(=本文色に戻す)。
  - `inactiveOpacity`: `PctSlider`(0〜100 → 0〜1)、placeholder/既定 100%。
    100% のときは `inactiveOpacity: undefined`(JSON を汚さない)。
  - `mode`: `Segmented`(`word`=語単位で切替 / `fill`=塗り進み)。`word` 既定の
    ときは `mode: undefined`(既定値を書かない、既存の「既定は書かない」流儀)。
- **patchKaraoke(p: Partial<CaptionKaraoke>) ヘルパー**を単体パネルに置き、
  anim と同じく「現 karaoke を spread → 差す → undefined サブキー掃除 →
  空 obj は残す(空=有効の意味なので **karaoke だけは空 obj を保持**)」。
  無効化はマスターのオフ操作(`karaoke: undefined`)だけが行う。

### 論点3: words 依存の表出

**選択肢**
- (A) karaoke オン時、このテロップに `words[]` が無ければ注意文(dim hint)を出す。
- (B) 何も出さない(validate に任せる)。

**トレードオフ**
- validate 警告は保存後/CLI で出るが、GUI で karaoke をオンにした瞬間に
  「効かない理由」がその場で分かる方が親切。ブロックはしない(スキーマ上は
  有効で、後で words が付けば効く。フォールバックも安全)。
- 判定は `s.words?.length` で即座に可能。重複コストは実質ゼロ。

**結論**
- **(A) を採る。** karaoke がオン(`s.style?.karaoke` あり)で
  `!(s.words && s.words.length > 0)` のとき、karaoke 節末尾に dim hint:
  「このテロップには語タイミング(words)が無いため、カラオケは表示されず
  通常表示になります(config の `whisper.wordTimestamps` を有効にして
  再文字起こしすると付きます)」。これは validate 警告と同義だがブロックしない
  =重複はするが場所(その場)と即時性が違うので許容。
- **保存出力には一切影響しない**(注意文は表示だけ)。

### 論点4: 複数選択・一括適用

**選択肢**
- (A) `BatchCaptionPanel` に anim(in/out/duration)と karaoke(オン/オフ)も乗せる。
- (B) 一括は既存項目のまま。anim/karaoke は単体編集のみ。

**トレードオフ**
- anim は「複数テロップに同じ登場/退場を一気に付ける」需要が明確に高い
  (章タイトル群に slide-up を一括、など)。`updateCaptionsStyle` は既に
  `Partial<CaptionStyle>` を各セグメントの style へマージするので、`{ anim }` /
  `{ karaoke }` をそのまま流せる(App 側の実装変更不要)。
- ただし `updateCaptionsStyle` の App 実装も**トップレベルの undefined しか
  掃除しない**。一括で anim/karaoke を渡すときも呼び出し側(BatchCaptionPanel)で
  ネストを組み立て切ってから渡す必要がある(単体と同じ制約)。
- karaoke の「混在(mixed)」表現は色まで含めると複雑。一括ではオン/オフの
  マスターだけに絞る(細かい色は単体で)。anim も in/out select + duration に
  絞り、`common()` で mixed を出す。

**結論**
- **(A) を採るが最小限に。** `BatchCaptionPanel` に:
  - anim: in/out の `<select>`(`common(s => s.style?.anim?.in / .out)` で mixed
    表示、mixed は先頭に `混在` disabled オプション)、duration `NumInput`
    (`common(s => s.style?.anim?.durationSec)`)。変更時は「選択中全件の anim を
    その値で**そろえる**」(既存の一括サイズ/色と同じ挙動)。
  - karaoke: オン/オフ チェックボックス 1 個(`checked = segs.every(s.style?.karaoke)`、
    座布団の一括と同じ形)。オンで `{ karaoke: {} }`、オフで `{ karaoke: undefined }`。
- BatchCaptionPanel 内にも単体と同じ `undefined 掃除つきネスト構築`を行う小関数を
  置く(App の `updateCaptionsStyle` は変えない)。
- **既存の一括挙動(サイズ/色/太さ/座布団/トラック/削除)は 1 バイトも変えない。**

### 論点5: プレイヤープレビュー

**選択肢**
- (A) `CaptionOverlay` / `CaptionSample` で anim/karaoke を実時間プレビュー
  (`captionAnim.ts` の純関数を再利用)。
- (B) 既存の `@remotion/player`(= `remotion/Main.tsx`)のライブ描画に任せ、
  Inspector 側は静的サンプルのまま。

**トレードオフ**
- **プレビューは既に `component={Main}` で最終レンダーと同じ合成を描く。**
  anim/karaoke は `Main.tsx` が `captionAnim.ts` を使って既に動かしている。
  つまり **(B) は追加コードゼロで、レンダーと完全一致のプレビューが既にある。**
- (A) を足すと `CaptionOverlay`(ドラッグ層)や `CaptionSample`(静的目安)に
  時間駆動ロジックが増え、`captionAnim.ts` の二重実装リスク・当たり判定のズレ
  (anim で位置がズレるとドラッグ枠と本体が乖離)を生む。コスト対効果が悪い。
- `CaptionSample` はサイズ縮小した「様式の目安」で、そもそも実寸/実時間は
  プレビュー任せの設計。ここにアニメを足す価値は薄い。

**結論**
- **(B) を採る。** ライブの時間プレビューは既存 Player に委ねる(追加コード
  なし)。`CaptionOverlay` のドラッグ枠は**静的位置のまま**(anim の transform を
  当てない=ドラッグ操作性を保つ)。
- `CaptionSample`(静的サンプル)には **karaoke の色だけ**任意で反映してよいが
  必須ではない。最小実装では触らない(サンプルは様式目安のまま)。karaoke の
  色確認は実プレビューで足りる。→ **T1〜T3 では CaptionSample / CaptionOverlay を
  変更しない**ことを完了基準にする(不変保証が単純になる)。

---

## 変更するファイルと関数/コンポーネント(シンボル指定)

| ファイル | シンボル | 変更 |
|---|---|---|
| `editor/client/Inspector.tsx` | `Inspector`(`selection.kind === "caption"` 単体ブロック内)| 「スタイル」`Section` の下に新 `Section`「アニメーション」「カラオケ」を追加。ローカルヘルパー `patchAnim` / `patchKaraoke` を `patchStyle` の直後に定義 |
| `editor/client/Inspector.tsx` | `BatchCaptionPanel` | 「スタイル(一括)」`Section` に anim(in/out/duration)と karaoke オン/オフを追加。`common()` を anim サブフィールドに使う |
| `editor/client/Inspector.tsx` | 新規モジュール定数 `CAPTION_ANIM_OPTIONS` | `{ value: CaptionAnimKind | ""; label: string }[]`(日本語ラベル。`""`=「なし(標準)」、`"none"`=「アニメ無し」)。`FONT_PRESETS` と並べて置く |
| `editor/client/Inspector.tsx` | import 追加 | `../../src/types.ts` から `DEFAULT_CAPTION_ANIM_SEC`, `KARAOKE_DEFAULT_ACTIVE`, 型 `CaptionAnim`, `CaptionKaraoke`, `CaptionAnimKind` |
| (任意 T4) `editor/client/Inspector.tsx` | `fmtStyle` | トラック標準スタイルのヒントに anim/karaoke の有無を 1 語追記(`アニメ`/`カラオケ`)。※任意・見た目だけ |

**変更しない(重要):** `App.tsx`(`updateCaption` / `updateCaptionsStyle` /
`updateCaptionsTrack` はそのまま使う)、`CaptionOverlay.tsx`、`CaptionSample`、
`widgets.tsx`、`src/types.ts`、`src/lib/captionAnim.ts`、`src/stages/validate.ts`、
`remotion/*`、`ShortCaptionPanel`(論点対象外。ショートは per-segment style を
持たず、anim/karaoke はトラック単位設定に含まれ得るが今回スコープ外。次段で
別途)。

---

## タスク分解(1 タスク = 1 コミット)

### T1: 単体テロップに「アニメーション」節を追加

**①変更内容**
- `Inspector.tsx` 単体 caption ブロックに `patchAnim(p: Partial<CaptionAnim>)` を
  `patchStyle` の直後に定義:
  現 `s.style?.anim` を spread → `p` を差す → `in`/`out`/`durationSec` の
  undefined サブキーを delete → **空 obj なら `patchStyle({ anim: undefined })`、
  それ以外は `patchStyle({ anim })`**。
- 「スタイル」`Section` の後に `<Section title="アニメーション">`:
  - 登場 `<select>`(`value = s.style?.anim?.in ?? ""`、`CAPTION_ANIM_OPTIONS`)。
    onChange: `patchAnim({ in: v === "" ? undefined : v as CaptionAnimKind })`。
  - 退場 `<select>`(同上、`anim?.out`)。
  - **in も out も `""`(継承)のときは** duration 欄を非表示。
  - それ以外のとき duration `NumInput`(`value=anim?.durationSec`, `allowEmpty`,
    `placeholder=String(DEFAULT_CAPTION_ANIM_SEC)`)。onCommit:
    `patchAnim({ durationSec: v !== undefined && v >= 0 ? round2(v) : undefined })`。
  - dim hint 1 行(「登場=表示の頭、退場=表示の終わり際。空欄=トラック標準/
    アニメ無し。『アニメ無し(none)』はトラック標準を打ち消します」)。
- `CAPTION_ANIM_OPTIONS` 定数と型 import を追加。

**②テスト方針**
- `npm run typecheck`(型)/ `npm test`(既存単体テストが緑=回帰なし)。
- `node src/cli.ts editor <収録dir>` を起動(MEMORY: **サーバ再起動でクライアント
  再バンドル**。検証前に必ず再起動)。テロップを選び、登場=slide-up を選択→保存→
  `transcript.json` に `style.anim.in: "slide-up"` が入ることを Read で確認。
  Player を該当テロップの表示頭にシークし、せり上がりが出る(Main.tsx 既存描画)
  ことを目視。in/out を「なし」に戻すと `anim` キーが消えることを確認。
- **バイト等価チェック(完了基準):** anim/karaoke を 1 度も触っていない
  テロップ・別収録の `transcript.json` を、UI で開いて保存だけしても diff が
  出ない(`git diff` / 事前コピーとの `diff`)。

**③壊してはいけない既存挙動**
- 既存「スタイル」節(サイズ・色・縁取り・フォント・太さ・座布団)の編集・
  `patchStyle` の undo `key` まとめ・「標準に戻す/トラック標準にする」ボタン。
- `updateCaption` / 保存 / ホットリロードの経路(App 側は無変更)。
- `CaptionSample` / `CaptionOverlay`(不変)。

### T2: 単体テロップに「カラオケ」節を追加

**①変更内容**
- `patchKaraoke(p: Partial<CaptionKaraoke>)` を定義(現 `s.style?.karaoke` を
  spread → 差す → undefined サブキー掃除 → **空 obj は保持**して `patchStyle({ karaoke })`。
  無効化はしない)。
- `<Section title="カラオケ">`:
  - マスター `<input type="checkbox">`(`checked = !!s.style?.karaoke`)。
    on → `patchStyle({ karaoke: {} })` / off → `patchStyle({ karaoke: undefined })`。
  - オンのときのみ: activeColor(color, 既定 `KARAOKE_DEFAULT_ACTIVE`)、
    inactiveColor(color, 既定=本文色 `effStyle.color`、「本文色に戻す」小ボタンで
    `undefined`)、inactiveOpacity(`PctSlider`, 100%→`undefined`)、
    mode(`Segmented` word/fill、word→`undefined`)。各 onChange は
    `patchKaraoke({...}, key?)`(色は coalesceKey で undo まとめ)。
  - **論点3 の words 無し注意 hint**(オン かつ `!(s.words?.length)` のとき)。

**②テスト方針**
- typecheck / npm test。
- editor 再起動 → words を持つ収録でカラオケをオン→保存→ `style.karaoke`(空 obj)
  が入る。activeColor 変更→ `karaoke.activeColor` が入る。オフ→ `karaoke` キー消滅。
  **words を持たないテロップでオンにすると注意 hint が出て**、Player で通常表示
  (色替えなし)のまま=フォールバックを目視。
- バイト等価チェック(T1 と同じ、karaoke 未使用ファイル)。

**③壊してはいけない既存挙動**
- T1 と同じ + T1 で足した「アニメーション」節。
- 座布団(background)チェックボックスの挙動(同じ obj トグル流儀を真似るだけで
  既存 background コードは変えない)。

### T3: 複数選択の一括に anim / karaoke を追加

**①変更内容**
- `BatchCaptionPanel` の「スタイル(一括)」`Section` に:
  - anim in/out `<select>`(`common(s => s.style?.anim?.in)` / `.out`、mixed は
    disabled `混在` 先頭 option)。変更時は選択中全件へ:ネストを組み立て
    (各件の現 anim を無視して**そろえる**方針=既存一括と同じ)
    `updateCaptionsStyle(indices, { anim: builtOrUndefined })`。
  - duration `NumInput`(`common(s => s.style?.anim?.durationSec)`)。
  - karaoke オン/オフ チェックボックス(`checked = segs.every(s => !!s.style?.karaoke)`)。
    on→`{ karaoke: {} }` / off→`{ karaoke: undefined }`。
- `BatchCaptionPanel` 内に undefined 掃除つきの `buildAnim` 小関数を置く
  (App の `updateCaptionsStyle` は変更しない)。

**②テスト方針**
- typecheck / npm test。
- editor 再起動 → ⌘クリックで 2 件以上選択 → 一括で登場=fade → 両件の
  `style.anim.in: "fade"` を確認。混在状態で `混在` が出ることを確認
  (1 件だけ先に設定 → 複数選択)。karaoke 一括オン/オフ。
- **一括の既存項目(サイズ/色/太さ/座布団/トラック/削除)が無変更**であることを
  操作して確認。バイト等価チェック。

**③壊してはいけない既存挙動**
- `BatchCaptionPanel` の `common()`・既存一括項目・`updateCaptionsStyle(null)`
  (全解除)・削除。App 側 `updateCaptionsStyle` / `updateCaptionsTrack` は無変更。

### T4(任意): トラック標準スタイルのヒントに anim/karaoke を表示

**①変更内容:** `fmtStyle` に `st.anim ? "アニメ" : null` / `st.karaoke ?
"カラオケ" : null` を足す(表示のみ)。
**②テスト方針:** typecheck。トラック標準に anim を設定したときヒント文言に出る。
**③壊してはいけない:** `fmtStyle` の既存出力(anim/karaoke 未指定なら文字列不変)。

---

## 完了基準(全 T 共通の受け入れ条件)

1. **バイト等価:** `anim`/`karaoke` を 1 件も指定していない `transcript.json` は、
   本 UI で開いて操作しても(該当コントロールに触れない限り)保存出力が
   従来とバイト等価。= anim/karaoke を触らなければ既存の JSON に新キーが
   混入しない(`patchAnim`/`patchKaraoke`/一括の空 obj 掃除が undefined を
   キーごと消すことで担保)。既存収録での `git diff`(保存のみ)が空。
2. **JSON を汚さない:** in/out を「なし」に戻す・karaoke をオフにする・
   duration/opacity/mode を既定へ戻すと、対応キー(さらに空になれば `anim` /
   `style` ごと)が **削除される**(undefined として残らない)。
3. **validate 整合:** 保存前に走る `/api/save` の validate を通る(スキーマは
   既存で対応済み)。words 無し karaoke は警告(exit 0)のまま=保存はできる。
4. **既存不変:** 既存 style 編集・`patchStyle`/`updateCaptionsStyle` の undo
   coalesce key・複数選択一括・ショートモード・保存/ホットリロードは無変更。
   `CaptionSample`/`CaptionOverlay`/`widgets.tsx`/`App.tsx`/`src/*` は無変更。
5. **プレビュー一致:** anim/karaoke のライブ描画は既存 Player(`Main.tsx`)が
   担い、Inspector 側に時間駆動プレビューは追加しない(実装コスト 0・
   レンダー完全一致)。

---

## 想定リスクと対策

- **ネスト undefined の掃除漏れ:** `patchStyle` / App の `updateCaptionsStyle` は
  トップレベルしか掃除しない。→ 各パネルの `patchAnim`/`patchKaraoke`/`buildAnim`
  内でサブキー undefined を delete し、空判定してから渡す(background の
  既存作法と同型)。完了基準 1/2 のバイト等価テストで検出できる。
- **`none` と `""`(継承)の取り違え:** UI で別 option に分ける。縁取りの
  `undefined` vs `"none"` と同じ二分なのでユーザーには一貫。hint で補足。
- **karaoke 空 obj の扱い:** karaoke は「空 obj=有効(全既定)」が仕様。anim の
  「空 obj=無意味なので消す」と非対称なので、`patchKaraoke` は空でも消さず、
  無効化はマスター off の `karaoke: undefined` だけが行う、と明記して実装する。
- **words 未同期での誤解:** T2 の注意 hint で「効かない理由」をその場提示。
  ブロックはしない(後で words が付けば効く/フォールバック安全)。
- **編集後の frames 陳腐化:** これはエディタではなく `frames` の話。本設計の
  範囲外(GUI 保存はホットリロードで Player に反映される)。
</content>
</invoke>
