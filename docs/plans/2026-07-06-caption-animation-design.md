# テロップの登場アニメ / カラオケアニメ 設計ドキュメント

対象: 診断レビュー `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Now ロードマップ
項目6「★ テロップの登場/カラオケアニメ」(表現力 / effort M)。
レビュー本文の指摘: 「素材にある `fadeIn/Out` すらテロップに無い非対称(埋めるのは安い)」
「アニメ字幕テンプレ(競合が持つ)」。

このフェーズで入れる2機能:

1. **登場/退場アニメ**(entrance / exit): テロップが出る/消える瞬間の動き
   (フェード・スライド・ポップ)。素材(overlays)の `fadeInSec`/`fadeOutSec` に
   対応する非対称をテロップ側にも埋める。
2. **カラオケアニメ**: 発話に同期して語を1つずつ色替えする。前フェーズで実装・
   マージ済みの語単位タイムスタンプ(`TranscriptSegment.words[]`)を初めて消費する
   最初の下流。

## 最優先の不変条件(すべての判断がこれに従属する)

- **アニメ未指定のテロップは現状と1ピクセルも変わらない。** `anim` / `karaoke` を
  指定していない全テロップは、DOM 構造・描画結果が今と完全一致すること。
  → 実装は「未指定なら余計な div も span 分割も一切増やさない」ことで担保する。
- 語単位タイムスタンプ(`words[]`)が無いテロップは普通にある(config
  `whisper.wordTimestamps` 既定 off・手追加テロップ)。カラオケ指定があっても
  words が無ければ**通常表示にフォールバック**(壊れない)。
- Node 23 type stripping 制約: enum / namespace / パラメータプロパティ不可。
  interface と純関数のみ。

---

## 設計判断

### 判断1: 登場アニメのスキーマ → **`CaptionStyle` に `anim?` を足す**

| 選択肢 | 評価 |
|---|---|
| **(a) `CaptionStyle.anim?`** | ★推奨。`captionStyleOf`(セグメント → トラック標準 → 既定の項目単位マージ)にそのまま乗る。`props.Caption.style` は既に `CaptionStyle` を丸ごと運んでいて、Main.tsx も `caption.style?.X` で読む。→ **renderProps / props / Main の配管を一切増やさず** anim が末端まで届く。検査も既存 `checkStyle` の1箇所に足すだけ。 |
| (b) `TranscriptSegment.anim?`(独立フィールド) | 却下。トラック標準(overlays.captionTracks)での一括指定ができず、props.Caption に新フィールドを足す配管が要る。「章トラックだけポップで出す」等ができない。 |
| (c) `overlays.captionTracks` のみ | 却下。個別テロップ単位の上書きができない。(a) はトラック標準も個別も両取り。 |

`CaptionStyle` の各トップレベルキーは「セグメント → トラック → 既定」で**キー単位に
上書き**される(`captionStyleOf` の `{ ...trackStyle, ...segStyle }`)。`anim` は
`background` と同じく**まるごと1キー**として上書きされる(部分マージはしない=
矛盾が起きにくい)。これは既存の `background` の扱いと一致していて学習コストが無い。

**1件の形:**

```ts
/** テロップの登場/退場アニメ。CaptionStyle.anim。省略時はアニメ無し(現状)。
 * in/out はキー単位で独立(片方だけ指定可)。durationSec は in/out 共通。
 * かかるのはテロップの器(位置・レイアウトは不変)で、opacity と transform
 * だけを時間で動かす。素材の fadeInSec/fadeOutSec に対応するテロップ版。 */
export interface CaptionAnim {
  /** 登場(表示開始 start から durationSec 秒)。省略時 in なし(瞬時に出る) */
  in?: CaptionAnimKind;
  /** 退場(表示終了 end の手前 durationSec 秒)。省略時 out なし(瞬時に消える) */
  out?: CaptionAnimKind;
  /** in/out それぞれの遷移秒。省略時 DEFAULT_CAPTION_ANIM_SEC(0.3)。
   * 表示区間が in+out より短いときは短い方へ自動で縮める(fadeFactor と同じ) */
  durationSec?: number;
}

/** アニメ種別の最小セット。"none" は明示的にアニメ無し(トラック標準を打ち消す用) */
export type CaptionAnimKind =
  | "fade"        // 不透明度 0→1
  | "slide-up"    // 下からせり上がりながらフェード
  | "slide-down"  // 上から降りながらフェード
  | "slide-left"  // 右から寄りながらフェード
  | "slide-right" // 左から寄りながらフェード
  | "pop"         // 小さめから拡大しながらフェード
  | "none";
```

**素材 `fadeInSec`/`fadeOutSec` との命名整合:** 素材は「方向ごとの秒数」だが、
テロップは「種別 + 共通秒」にする。理由: テロップのアニメはフェード以外
(スライド・ポップ)を持つので、秒数だけでは表現しきれない。`in: "fade"` +
`durationSec: 0.3` が素材の `fadeInSec: 0.3` と等価になる、という対応で説明する
(usage.md に明記)。方向ごとに秒を変えたい要望は effort M 外。

**やらないこと(M の線引き):** イージング関数の選択(常に smoothstep 固定)、
キーフレーム(任意プロパティ・任意時刻)、per-word の登場ずらし、回転・ぼかし系
エフェクト、方向ごとの秒数指定。

### 判断2: カラオケのスキーマ → **`CaptionStyle` に `karaoke?` を足す(anim と同じ場所)**

anim と同じ理由(配管ゼロ・トラック標準/個別両取り・検査1箇所)で `CaptionStyle`
に置く。`anim` の中のモードにはしない(登場アニメとカラオケは**直交**する演出で、
両方同時に効く。1つの enum に押し込むと相互排他に見えて誤解を生む)。

```ts
/** テロップのカラオケ表示。CaptionStyle.karaoke。省略時はカラオケ無し(現状)。
 * segment.words[](語単位タイムスタンプ)を消費し、発話済みの語を activeColor に、
 * 未発話の語を inactiveColor(既定=テロップの本文色)にして左から順に色を進める。
 * words[] が無いテロップに指定した場合は無視され通常表示になる(validate が警告)。 */
export interface CaptionKaraoke {
  /** 発話済み(t >= 語の start)の語の色。省略時 KARAOKE_DEFAULT_ACTIVE(#ffe14d) */
  activeColor?: string;
  /** 未発話の語の色。省略時はテロップの本文色(style.color→既定の白)。
   * 「未発話は薄く」したいときは inactiveOpacity と併用 */
  inactiveColor?: string;
  /** 未発話の語の不透明度(0〜1)。省略時 1。0.4 等で「これから読む所を薄く」 */
  inactiveOpacity?: number;
  /** 語をまたぐ塗りの進み方。"word"(既定): 語単位で瞬間に色が切り替わる /
   * "fill": いま発話中の語だけ左から右へ塗り進む(karaoke 字幕の定番)。 */
  mode?: "word" | "fill";
}
```

**見た目パラメータの推奨:** `mode: "word"`(瞬間切替)を既定・中核とする。
`"fill"`(発話中の語の塗り進み)は linear-gradient の text-fill で実装でき、
カラオケらしさが出るので含めるが、実装難度が上がるので**任意の上積み**
(判断4 参照。まず "word" を通してから "fill" を足す)。

**words 不在時の挙動 → 無視 + 通常表示 + validate 警告。** レンダーは
`caption.words?.length` を見て、無ければ従来の1塊描画に落ちる(判断4)。壊さない。

**confidence(低確信語)→ 今は使わない。** 色分けや除外に使わない
(words[] は既に特殊トークン・空 text 除外済み)。将来「低確信語だけ薄く」等の
拡張余地として `words[].confidence` は残るが、このフェーズはスコープ外。

### 判断3(★最重要): 語タイミングのカット後秒への写像

**問題の構造:**
- `words[]` は**元収録の秒**。カラオケ描画は**カット後の秒**の `t` で判定する。
- 1テロップ(segment)は挿入/カットで**複数の Caption 断片に割れる**
  (`remapInterval(s.start, s.end, timeline)` が複数区間を返す)。
- したがって「どの語がどの断片に載るか」「断片をまたぐ語・カット内に落ちた語」を
  厳密に定義しないとカラオケが破綻する。

**設計: `props.Caption` に `words?: { text, start, end }[]`(カット後の秒)を足す。**
renderProps の captions 構築時に、各語を独立に `remapInterval` で写像してから
各断片へ配る。断片へのクリップまで renderProps 側で済ませ、Main.tsx は
「カット後秒の words をそのまま t と比較するだけ」にする(判断4)。

`remotion/props.ts` の `Caption` に追加:

```ts
export interface Caption {
  start: number;
  end: number;
  text: string;
  track: number;
  pos?: { x: number; y: number };
  anchor?: "topLeft";
  style?: CaptionStyle;
  /** 語単位タイミング(カラオケ描画用。カット後=出力の秒)。この断片の
   * [start,end) にクリップ済み。省略時(元 segment に words[] が無い/
   * この断片に映る語が無い)はカラオケ非対応=従来どおりの1塊描画。
   * text は必ずしも語の連結と一致しない(手編集で text だけ直した場合)ので、
   * 描画側で text と語を突き合わせる(判断4 の alignKaraoke)。 */
  words?: { text: string; start: number; end: number }[];
}
```

**renderProps.ts の captions 構築(95〜113行目)の置き換え:**

```ts
const captions: Caption[] = transcript.segments
  .flatMap((s) => {
    const pos = captionPosOf(s, overlays);
    const style = captionStyleOf(s, overlays);
    const anchor = captionAnchorOf(s, overlays);
    const frags = remapInterval(s.start, s.end, timeline);

    // 語を独立に写像する。1語も挿入/カット境界で複数断片に割れうるので
    // flatMap。カット内に完全に入る語は remapInterval が [] を返し自然に消える
    // (= その語は出力に映らないので active 判定の対象外。正しい)。
    // words[] が無い(既定)ときは wordPieces=[] で、下の words 付与も走らない
    // = 従来と 1 バイトも変わらない。
    const wordPieces = (s.words ?? []).flatMap((w) =>
      remapInterval(w.start, w.end, timeline).map((iv) => ({
        text: w.text,
        start: iv.start,
        end: iv.end,
      })),
    );

    return frags.map((iv) => {
      // この断片 [iv.start, iv.end) に重なる語だけを載せ、断片へクリップする。
      // 挿入が語の途中に割り込んだ場合、その語は2つの断片に別々に載り、
      // それぞれの局所時刻でハイライトが進む(断片間で状態は連続しないが、
      // 挿入中はテロップ自体が別の絵なので破綻しない)。
      const words = wordPieces
        .filter((wp) => wp.end > iv.start && wp.start < iv.end)
        .map((wp) => ({
          text: wp.text,
          start: Math.max(wp.start, iv.start),
          end: Math.min(wp.end, iv.end),
        }));
      return {
        start: iv.start,
        end: iv.end,
        text: s.text.trim(),
        track: captionTrack(s),
        ...(pos ? { pos } : {}),
        ...(pos && anchor === "topLeft" ? { anchor } : {}),
        ...(style ? { style } : {}),
        ...(words.length > 0 ? { words } : {}),
      };
    });
  })
  .filter((c) => c.text.length > 0);
```

**厳密な定義(レビュー・テストの基準):**
- **カット内に完全に入る語** → `remapInterval` が `[]` → `wordPieces` に現れない → どの
  断片にも載らない。正しい(出力に映らないので色替え対象外)。
- **断片をまたぐ語(挿入が語の途中に割り込む)** → `remapInterval` が2区間を返す →
  2つの `wordPiece` になり、`filter` でそれぞれの断片に振り分けられる。各断片で
  クリップされ、局所的にハイライトが進む。
- **断片ごとの割当** → 「断片と時間的に重なる語ピースだけを、断片へクリップして
  載せる」。重なり判定は `wp.end > iv.start && wp.start < iv.end`(端点接触は含めない
  =区間の半開き `[start,end)` と整合)。
- `round2`(0.01秒量子化)により端点が僅かにずれても、クリップ後 `start < end` が
  保たれる(`filter` の strict 不等号で潰れた0幅は除外される)。

これで Main.tsx は `caption.words`(カット後秒・クリップ済み)を `t` と直接比較でき、
時刻写像の知識を一切持たなくてよい(既存 zooms/blurs と同じ「props で解決済み」方針)。

### 判断4: 描画実装(Main.tsx)

#### (A) 登場/退場アニメ = 器の opacity/transform を t から計算

テロップは Sequence に載っていない(`captionAt(track)` で t 時点の1件を引いて
直接描く)ので、**Sequence の相対フレームは使えない**。`t` と `caption.start/end`
から進行度を出す(ズーム `zoomTransformAt` と同じ発想)。純関数 `animStateAt`
(判断5・`src/lib/captionAnim.ts`)へ切り出す:

```ts
// src/lib/captionAnim.ts(抜粋)
export interface AnimState {
  opacity: number; translateX: number; translateY: number; scale: number;
}
const IDENTITY: AnimState = { opacity: 1, translateX: 0, translateY: 0, scale: 1 };

/** t(カット後秒)における登場/退場アニメの状態。anim 未指定なら恒等
 * (opacity=1・transform 無し)を返す=呼び出し側で「未指定なら器を包まない」
 * 分岐と合わせて 1px 不変を担保する。fontSizePx はスライド量の基準。 */
export function animStateAt(
  anim: CaptionAnim | undefined,
  start: number, end: number, t: number, fontSizePx: number,
): AnimState {
  if (!anim) return IDENTITY;
  const dur = anim.durationSec ?? DEFAULT_CAPTION_ANIM_SEC;
  // in+out が尺を超える短い区間では各遷移を尺の半分へ縮める(fadeFactor と同一規則)
  const half = Math.min(dur, (end - start) / 2);
  const pIn = anim.in && half > 0 ? clamp01((t - start) / half) : 1;
  const pOut = anim.out && half > 0 ? clamp01((end - t) / half) : 1;
  const eIn = smooth(pIn);   // smoothstep
  const eOut = smooth(pOut);
  // 登場は eIn を、退場は eOut を使う。両方とも動くのは短区間で重なるときだけで、
  // その場合は「より進んでいない方」を採る(min)= 出入りが喧嘩しない
  const p = Math.min(eIn, eOut);
  const off = fontSizePx * 0.7; // スライド量(フォントサイズ比。M では固定)
  const dir = (kind?: CaptionAnimKind) => {
    switch (kind) {
      case "slide-up":    return { x: 0,    y: off  };
      case "slide-down":  return { x: 0,    y: -off };
      case "slide-left":  return { x: off,  y: 0    };
      case "slide-right": return { x: -off, y: 0    };
      default:            return { x: 0,    y: 0    };
    }
  };
  // 登場側の未完了分(1-eIn)だけ入りのオフセットを、退場側は出のオフセットを足す
  const din = dir(anim.in); const dout = dir(anim.out);
  const translateX = din.x * (1 - eIn) + dout.x * (1 - eOut);
  const translateY = din.y * (1 - eIn) + dout.y * (1 - eOut);
  const popIn = anim.in === "pop"; const popOut = anim.out === "pop";
  const scale = (popIn || popOut) ? 0.6 + 0.4 * p : 1;
  const fades = anim.in === "fade" || anim.out === "fade" ||
                anim.in === "slide-up" || /* slide/pop も薄く出す */ true;
  const opacity = fades ? p : 1; // 全種別で opacity も動かす(スライド/ポップも淡く入る)
  return { opacity, translateX, translateY, scale };
}
```

Main.tsx の layerNode のテロップ分岐(275〜329行目)で、`styled()` の出力を
アニメ器で包む。**anim 未指定なら包まず素通し**(余計な div を出さない=不変):

```ts
const anim = caption.style?.anim;
const fontSizePx = caption.style?.fontSizePx ?? props.caption.fontSizePx;
const a = animStateAt(anim, caption.start, caption.end, t, fontSizePx);
const withAnim = (node: ReactNode): ReactNode =>
  anim
    ? (
      <div style={{
        opacity: a.opacity,
        transform: `translate(${a.translateX}px, ${a.translateY}px) scale(${a.scale})`,
        transformOrigin: "center",
      }}>{node}</div>
    )
    : node; // ← 未指定: 追加 div なし = DOM 完全一致
```

`withAnim(styled())` を、位置指定あり(298〜310)・下部中央(315〜327)の**両方の
return の中身に適用**する。器は位置決めの外側 div の**内側**に入るので、
`translate(-50%,-50%)` の中央寄せ transform と喧嘩しない(内側の別 div の
ローカル transform になる)。

#### (B) カラオケ = fill 層だけを語 span に割り、stroke 層は1塊のまま

`OutlinedText`(638〜706行目)は縁取り層(`WebkitTextStroke` の span)+本文層
(color の span)の2層。**縁取り層は語ごとに色を変えない**(縁は一定)ので**触らず
1塊のまま**。本文層だけを、`text` と完全に一致する連結になる span 列に割る。
連結が `text` と1文字も違わないので、`whiteSpace: "pre-line"`(手動改行)・`maxWidth`
折り返し・`lineHeight` は**一切崩れない**(同じ文字が同じ順に流れ、色だけ違う)。

text と words の突き合わせは純関数 `alignKaraoke`(判断5)。whisper の語トークンは
基本 `text` の部分文字列として順に現れる(日本語はサブワードで空白無し)。手編集で
text だけ直され語が見つからない場合はその語を飛ばし、覆えない文字は「gap ピース」に
なる(gap は直前の語の active 状態を引き継ぐ=句読点が語と一緒に色づく):

```ts
// src/lib/captionAnim.ts(抜粋)
export interface KaraokePiece {
  text: string;
  /** この文字列に対応する語の時刻(カット後秒)。text 内の gap(句読点・
   * 手編集で語に対応しない文字)は null。null は直前の語の active を引き継ぐ */
  start: number | null;
  end: number | null;
}

/** caption.text を語 span 列へ分解する。連結は必ず text と一致する
 * (gap も含めて全文字を覆う)ので、描画側で色だけ差し替えれば layout 不変。 */
export function alignKaraoke(
  text: string,
  words: { text: string; start: number; end: number }[],
): KaraokePiece[] {
  const pieces: KaraokePiece[] = [];
  let cursor = 0;
  for (const w of words) {
    if (w.text === "") continue;
    const idx = text.indexOf(w.text, cursor);
    if (idx < 0) continue; // 手編集で語が見つからない → 飛ばす(stale words)
    if (idx > cursor) pieces.push({ text: text.slice(cursor, idx), start: null, end: null });
    pieces.push({ text: w.text, start: w.start, end: w.end });
    cursor = idx + w.text.length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), start: null, end: null });
  return pieces;
}

/** ピース i が t 時点で active(発話済み=色替え済み)か。語は t>=start で active に
 * なり以降 active のまま(左→右に進む)。gap は直前の語の active を引き継ぐ。 */
export function karaokeActiveAt(pieces: KaraokePiece[], t: number): boolean[] {
  const out: boolean[] = [];
  let prev = false;
  for (const p of pieces) {
    const active = p.start === null ? prev : t >= p.start;
    out.push(active);
    prev = active;
  }
  return out;
}
```

`OutlinedText` にオプション props `words?` / `karaokeStyle?` / `t?` を足し、
**words が無ければ現状の `{text}` 1塊を描く**(不変)。ある場合だけ本文層を割る:

```tsx
// OutlinedText 内。hasStroke の縁取り層は現状のまま {text} を1塊で描く(不変)。
// 本文層だけ差し替える:
const km = useMemo(
  () => (words && words.length > 0 ? alignKaraoke(text, words) : null),
  [text, words],
);
const body = km
  ? (
    <span style={{ position: "relative" }}>
      {(() => {
        const act = karaokeActiveAt(km, t ?? 0);
        return km.map((p, i) => (
          <span key={i} style={{
            color: act[i] ? (karaokeStyle?.activeColor ?? KARAOKE_DEFAULT_ACTIVE) : color,
            ...(act[i] ? {} : karaokeStyle?.inactiveColor ? { color: karaokeStyle.inactiveColor } : {}),
            ...(!act[i] && karaokeStyle?.inactiveOpacity !== undefined
              ? { opacity: karaokeStyle.inactiveOpacity } : {}),
          }}>{p.text}</span>
        ));
      })()}
    </span>
  )
  : <span style={{ position: "relative", color }}>{text}</span>; // ← 現状と同一
```

呼び出し側 `styled()` は
`words={caption.words} karaokeStyle={caption.style?.karaoke} t={t}` を渡す
(いずれも未指定なら OutlinedText は現状経路)。

**"fill" モード(任意の上積み):** `mode === "fill"` のとき、いま発話中の語
(`p.start <= t < p.end`)1つだけ `background: linear-gradient(90deg, active X%, inactive)`
+ `WebkitBackgroundClip: "text"` + `color: transparent` で左→右の塗り進みにする
(`X = clamp01((t - p.start)/(p.end - p.start)) * 100`)。それ以外の語は "word" と同じ
active/inactive の単色。まず "word" を通し、frames で確認してから足す。

#### (A)+(B) の両立
登場アニメは**器(外側 div)の opacity/transform**、カラオケは**本文層 span の色**で、
別レイヤーなので干渉しない。登場中(器がフェード/スライド)にカラオケ(語の色替え)も
同時に進む。両者を別々の純関数・別々の DOM 位置に置くことで二重適用を避ける。

### 判断5: 既定値と config

既存の遷移秒の既定はすべて **types.ts の定数**で持つ方針
(`DEFAULT_WIPE_TRANSITION_SEC` / `DEFAULT_ZOOM_EASE_SEC` / `DEFAULT_CUT_TRANSITION_SEC`)。
これに揃え、config.yaml は**足さない**(effort M・ユーザーが全体既定を変えたい要求が
まだ無い。必要になったら後で `render.captionAnim` を足せる):

```ts
// src/types.ts に追加(CAPTION_DEFAULT_* と同じ場所)
/** CaptionAnim.durationSec 未指定時の既定(秒)。in/out 共通。描画側の最終フォールバック */
export const DEFAULT_CAPTION_ANIM_SEC = 0.3;
/** CaptionKaraoke.activeColor 未指定時の既定(発話済みの語の色) */
export const KARAOKE_DEFAULT_ACTIVE = "#ffe14d";
```

`inactiveColor` の既定は「テロップの本文色」= 動的(`style.color` → 既定の白)なので
定数を置かない(OutlinedText の `color` 引数をそのまま使う)。

「アニメ指定が無ければアニメ無し=現状」が既定。config に既定 anim を持たせない
(全テロップ一律アニメは求められていない・不変条件と衝突する)。

### 判断6: 検証(validate)

`checkStyle`(898〜939行目)に `anim` / `karaoke` の検査を足す(CaptionStyle を検査する
全経路=transcript / captionTracks / thumbnail で共有される)。エラー/警告の別は既存方針
(エラー=描画が壊れる・不正になる / 警告=動くが意図と違う可能性)に従う:

- `anim`(オブジェクト):
  - `in` / `out` が許可リスト(`fade`/`slide-up`/`slide-down`/`slide-left`/`slide-right`/`pop`/`none`)外 → **エラー**
  - `durationSec` が数値でない or < 0 → **エラー**
  - 未知キー → **警告**(colorFilter と同じ寛容さ)
- `karaoke`(オブジェクト):
  - `activeColor` / `inactiveColor` が空でない文字列でない → **エラー**(CSS カラー)
  - `inactiveOpacity` が 0〜1 の数値でない → **エラー**
  - `mode` が `"word"`/`"fill"` 以外 → **エラー**
  - 未知キー → **警告**
- **karaoke 指定だが words 不在 → 警告**(transcript の segment ループ内で。checkStyle は
  words を知らないので、`s.style?.karaoke` があり `s.words` が空/無しのときに警告)。
  文言例: 「karaoke 指定がありますが words[] がありません(通常表示になります。
  config の whisper.wordTimestamps を true にして transcribe し直してください)」。
  トラック標準(captionTracks)側の karaoke は各セグメントの words 有無に依存するため
  この警告の対象外(過検出を避ける。実害は「静かに通常表示」で軽微)。

`anim` を thumbnail.json の texts.style に書いても意味は無い(静止画)が、`checkStyle`
共有なので構文検査は通す。害は無い(サムネ生成は anim を無視)ので専用警告は付けない
(M の線引き)。

### 判断7: frames / describe / エディタ

- **frames**: Main.tsx 経由なので**自動反映**。実装すれば `frames --captions`(各テロップの
  表示中間で1枚)や `frames --t` でアニメ途中・カラオケ途中の絵を目視確認できる。
  frames コード自体は無変更。
- **describe**: 触らない(タイムライン要約に anim/karaoke は出さない。M の線引き)。
- **エディタ(GUI)**: 今フェーズで**アニメ編集 UI は作らない**(JSON 直編集で足りる)。
  round-trip(未知フィールド保持)は前フェーズ(word-timestamps)で確認済みの
  **spread 保存**で守られる: エディタは JSON をファイルから読み、保存時にセグメント
  オブジェクトを spread で書き戻すため、`style.anim` / `style.karaoke` は素通しで残る。
  → **タスクで「エディタが caption の style をキー固定で再構築していないか」を確認**する
  (もし固定キーで組み直しているなら anim/karaoke が GUI 編集時に落ちる。その場合は
  spread に直す小修正を足す)。

---

## 確定スキーマまとめ

**`src/types.ts`** — `CaptionStyle` に2キー追加 + 型・定数:

```ts
export interface CaptionStyle {
  fontSizePx?: number;
  color?: string;
  outlineColor?: string;
  fontFamily?: string;
  fontWeight?: number;
  background?: CaptionBackground;
  /** 登場/退場アニメ(判断1)。省略時アニメ無し=現状 */
  anim?: CaptionAnim;
  /** カラオケ表示(判断2)。words[] を消費。省略時カラオケ無し=現状 */
  karaoke?: CaptionKaraoke;
}
// + CaptionAnim / CaptionAnimKind / CaptionKaraoke(上記)
// + DEFAULT_CAPTION_ANIM_SEC / KARAOKE_DEFAULT_ACTIVE(上記)
```

**`remotion/props.ts`** — `Caption` に `words?`(カット後秒)追加(上記・判断3)。
`props.Caption.style` は既に `CaptionStyle` なので anim/karaoke は自動で運ばれる。

**`src/lib/captionAnim.ts`(新規・純関数)** — `animStateAt` / `alignKaraoke` /
`karaokeActiveAt` + 補助(`clamp01` / `smooth`)。ブラウザにも入るので node 依存禁止。

---

## タスク分解(1タスク=1コミット・依存順)

### T1: スキーマ定義(types.ts + props.ts)
- **変更**: `src/types.ts`(CaptionAnim / CaptionAnimKind / CaptionKaraoke / CaptionStyle
  へ2キー / 定数2つ)、`remotion/props.ts`(Caption.words)。コメントは本ドキュメント準拠。
- **テスト**: `npx tsc --noEmit` が通る。既存 `test/types.test.ts` の captionStyleOf が
  anim/karaoke をマージで運ぶこと(セグメント→トラックの上書き)を1ケース追加。
- **壊してはいけない**: 既存の CaptionStyle 利用箇所は全て optional 追加なので影響なし。
  型のみでランタイム挙動ゼロ。

### T2: 純関数 captionAnim.ts + 単体テスト
- **変更**: `src/lib/captionAnim.ts`(新規)、`test/captionAnim.test.ts`(新規)。
- **テスト方針(unit)**:
  - `animStateAt(undefined,...)` が厳密に IDENTITY(opacity=1・transform 恒等)= 不変の砦。
  - `fade` の in が start/start+dur で 0→1、退場が end-dur/end で 1→0。
  - 短区間(尺 < 2*dur)で in/out が尺の半分に縮む。
  - `slide-*` の translate 符号・`pop` の scale レンジ(0.6→1)。
  - `alignKaraoke`: (1)語が text の部分列として順に一致 → 全ピース連結 === text、
    (2)句読点が gap ピースになる、(3)手編集で語が見つからない → その語を飛ばし連結は
    なお === text、(4)words=[] は使わない(呼び出し側で分岐)。
  - `karaokeActiveAt`: t 進行で false→true が左から埋まる・gap が直前を引き継ぐ・
    先頭 gap は inactive。
- **壊してはいけない**: 純追加。既存コードから未参照。

### T3: renderProps で words を断片へ写像(+テスト)
- **変更**: `src/lib/renderProps.ts`(captions 構築 97〜115 を判断3のコードへ)。
- **テスト方針(unit)**: `test/renderProps.test.ts` に追加:
  - **words 無しの segment → 出力 Caption に `words` キーが付かない**(既存スナップと
    完全一致=1バイト不変)。← 最重要の回帰テスト。
  - words 付き・挿入無し → 各語がカット後秒へ写像され断片に載る。
  - **カット内に完全に入る語** → その語が words に現れない。
  - **挿入が語の途中に割り込む** → 語が2断片に分かれ各々クリップされる(`start<end` 保持)。
  - カット境界をまたぐ隣接 keep(remapInterval が1区間に統合)→ 語も1断片に収まる。
- **壊してはいけない**: words 未指定時の captions が現状と完全一致。`describe` / preview /
  既存 render の props(words 抜き)が不変。

### T4: Main.tsx 描画(登場アニメ + カラオケ)
- **変更**: `remotion/Main.tsx`(layerNode テロップ分岐に `withAnim`、`OutlinedText` に
  words/karaokeStyle/t の任意 props と本文層分岐)。`captionAnim.ts` を import。
- **テスト方針(frames 実データ)**: 下記「実データ検証手順」。unit は張りにくい
  (Remotion コンポーネント)ので、ロジックは T2 の純関数で固め、Main は薄い結線に留める。
- **壊してはいけない(最重要)**:
  - `anim` 未指定 → `withAnim` が追加 div を出さず素通し = DOM 完全一致。
  - `words` 未指定 → OutlinedText が従来の1塊 `{text}` を描く = DOM 完全一致。
  - 縁取り層(stroke span)は常に1塊 `{text}` のまま(カラオケでも触らない)。
  - `frames --captions` で既存プロジェクト(anim/karaoke 無し)の全テロップが従来と
    同一の絵になることを1本確認(回帰の目視)。

### T5: validate 拡張(+テスト)
- **変更**: `src/stages/validate.ts`(`checkStyle` に anim/karaoke 検査、transcript ループに
  karaoke×words 不在の警告)。
- **テスト方針(unit)**: `test/validate.test.ts` に追加: anim 種別不正=エラー / durationSec<0
  =エラー / karaoke 色非文字列=エラー / mode 不正=エラー / karaoke あり words 無し=警告 /
  正常な anim・karaoke は 0 エラー。**anim/karaoke 未指定は警告も増えない**(既存固定)。
- **壊してはいけない**: 既存 transcript/thumbnail/captionTracks の検査結果が anim/karaoke
  不使用時に不変。

### T6: ドキュメント同期(docs のみ)
- **変更**: `src/types.ts` の CaptionStyle コメント表(CLAUDE.md 方針)、`docs/usage.md` の
  テロップ style 表に anim/karaoke の行を追加、`overlays.json`/`transcript.json` の説明に
  カラオケ=words 前提を明記。config.yaml は変更なし(判断5)。CLAUDE.md の
  「どのファイルが何を決めるか」表の transcript.json 行に anim/karaoke を追記。
- **テスト**: なし(文書)。`node src/cli.ts validate` のヘルプ整合だけ確認。

**依存順**: T1 →(T2・T3・T5 は並行可)→ T4(T2 と T3 に依存)→ T6(最後)。

---

## 実データ検証手順

検証データ: `~/Movies/cutflow/2026-07-02-whisper-bench`。既定では words[] が無いので、
**カラオケ検証用に words 付きテロップを一時的に用意**する。既存 transcript.json /
overlays.json を破壊せず原状復帰する。

1. **退避**(原状復帰用):
   ```sh
   cp ~/Movies/cutflow/2026-07-02-whisper-bench/transcript.json /tmp/transcript.bench.bak.json
   ```
2. **words を1テロップに用意**(2通り。どちらでも可):
   - (推奨・速い)先頭12秒クリップを wordTimestamps:true で transcribe し、その JSON の
     ある segment の `words` を、実 transcript.json の**同じ時刻の segment**へコピペする
     (先頭12秒なら元収録秒がそのまま一致する)。クリップ生成は前フェーズの
     word-timestamps 設計の手順(`ffmpeg -t 12 -ar 16000 -ac 1` + whisper-cli `-ojf`)。
   - (代替)config の `whisper.wordTimestamps: true` にして transcribe をフルに流し直し、
     全 segment に words を付ける(遅いが手作業ゼロ)。検証後 config を戻す。
3. **アニメ/カラオケを付ける**: 用意した segment に
   `"style": { "karaoke": { "mode": "fill" }, "anim": { "in": "slide-up", "out": "fade" } }`
   を足す。**words 無しの別テロップにも** `"anim": { "in": "pop" }` だけ足して
   「カラオケ無し・登場アニメだけ」も確認する。
4. **検査**: `node src/cli.ts validate ~/Movies/cutflow/2026-07-02-whisper-bench`
   (エラー0を確認。karaoke×words 不在の警告が意図通り出る/出ないを確認)。
5. **目視**:
   ```sh
   node src/cli.ts frames ~/Movies/cutflow/2026-07-02-whisper-bench --captions
   # 対象テロップの表示中間フレームで、発話済み語が activeColor になっていること、
   # 登場アニメが途中なら器がずれ/薄くなっていることを Read で確認。
   node src/cli.ts frames ~/Movies/cutflow/2026-07-02-whisper-bench --t <語の途中の元秒>
   # 特定時刻で塗り進み(fill)の左右分割を確認。
   ```
   `frames/` は実行ごとに古い PNG を全削除する。**JSON を編集したら必ず撮り直す**。
6. **原状復帰**:
   ```sh
   cp /tmp/transcript.bench.bak.json ~/Movies/cutflow/2026-07-02-whisper-bench/transcript.json
   ```
   config を触った場合は戻す。

**回帰(不変)の確認**: anim/karaoke を一切足さない状態で
`frames --captions` を撮り、実装前後で全テロップの絵が一致することを1本見ておく。

---

## 落とし穴(実装時に必ず意識する)

1. **t 基準アニメ ≠ Sequence 相対フレーム**: テロップは Sequence に載っていない。
   `useCurrentFrame` の相対フレームではなく、グローバル `t`(= frame/fps)と
   `caption.start/end`(カット後秒)から進行度を出す。ズーム(`zoomTransformAt`)と同じ。
   Sequence の from を基準にすると全テロップが 0 秒から始まってしまう。
2. **語写像のオフバイワン**: 断片への割当は半開き `[start,end)` と整合させる
   (`wp.end > iv.start && wp.start < iv.end`、クリップは max/min)。`round2` 量子化で
   0幅に潰れた語は strict 不等号で除外。カット内に完全に入る語は `remapInterval` の
   空返しで自然に消える(手で除外を書かない)。
3. **縁取り span 分割時のレイアウト崩れ**: **縁取り層は絶対に割らない**(1塊 `{text}` の
   まま)。本文層だけを、連結が `text` と1文字も違わない span 列に割る。これで
   `pre-line`(手動改行)・`maxWidth` 折り返し・`lineHeight` が保たれる。gap ピースで
   句読点・非語文字まで全文字を覆うのが要(覆い漏れると文字が消える/ずれる)。
4. **カラオケと登場アニメの二重適用**: 器(外側 div の opacity/transform)と本文層(span
   の色)は別レイヤー。同じ transform/opacity を両方に掛けない。両立するのが正しい挙動。
5. **後方互換(1px 不変)の砦**: `anim` 未指定 → 追加 div を出さない(`withAnim` の三項)。
   `words` 未指定 → OutlinedText の従来経路(1塊 `{text}`)。renderProps は `words.length>0`
   のときだけ `words` キーを付ける。この3点が崩れると既存全テロップに影響が出る。
   T3/T4/T5 それぞれに「未指定で不変」テストを必ず置く。
6. **text と words の不一致(手編集 stale)**: `text` が正・`words` は補助(types.ts 既述)。
   `alignKaraoke` は `indexOf` で語を順に探し、見つからない語は飛ばす。text が語と大きく
   食い違っても**壊れず**通常色に近い表示へ劣化する(クラッシュしない)。
7. **エディタの style round-trip**: GUI が caption の style を固定キーで組み直していると
   anim/karaoke が編集時に落ちる。T7 相当の確認(判断7)で spread 保存を確認する。
