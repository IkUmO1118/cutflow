# Phase 5: Clip Sync / Polish

*2026-07-10 / 実装担当: gpt-5.4 想定*

目的:

- before / after clip の同期再生を追加する。
- still fallback、responsive layout、長文崩れ、最終検証を固める。

前提:

- Phase 1 完了。
- Phase 2 完了。
- Phase 3 完了。
- Phase 4 完了。

---

## 1. 触るファイル

更新:

- `editor/client/AiVisualReview.tsx`
- `editor/client/index.html`
- 必要なら `test/editorAi.test.ts`

触らない:

- `editor/server.ts`
- `src/stages/review.ts`
- `src/lib/docDiff.ts`

---

## 2. Clip compare 表示

`ReviewBundle.clips` がある場合に表示する。

条件:

- `reviewBundle.clips?.beforeFile`
- `reviewBundle.clips?.afterFile`

mode:

- `after`: after clip があれば after video。無ければ after still。
- `before`: before clip があれば before video。無ければ before still。
- `side-by-side`: before / after clip が両方あれば同期 video。無ければ still pair。
- `overlay`: still overlay のまま。video overlay は実装しない。

---

## 3. 同期再生

最小実装でよい。

refs:

```ts
const beforeVideoRef = useRef<HTMLVideoElement | null>(null);
const afterVideoRef = useRef<HTMLVideoElement | null>(null);
```

主 clock:

- before video

同期イベント:

- `onPlay`: after.play()
- `onPause`: after.pause()
- `onSeeked`: after.currentTime = before.currentTime
- `onTimeUpdate`: drift が 0.12 秒を超えたら after.currentTime = before.currentTime

注意:

- `after.play()` は promise rejection を握りつぶしてよい。
- after video が無い場合は何もしない。
- loop / playbackRate 同期は不要。

---

## 4. Fallback

clip が無い場合:

- Phase 3 の still compare をそのまま表示する。

片方だけ clip がある場合:

- single mode は clip を使ってよい。
- side-by-side は still pair に fallback する。

---

## 5. Layout polish

確認すること:

- modal が viewport 外へはみ出さない。
- mobile で 3 ペインが縦に並ぶ。
- button text が折り返しても崩れない。
- JSON diff details 内の long JSON が横スクロールになる。
- warning text が preview を押し潰さない。
- event title が長い場合は折り返す。
- timeline marker hover で layout shift しない。

CSS 方針:

- 既存 colors を使う。
- border radius は 8px 以下。
- card in card にしない。
- text container は `min-width: 0` を忘れない。
- image / video は `object-fit: contain`。

---

## 6. Accessibility

最低限:

- modal に `role="dialog"` と `aria-label`。
- preview mode buttons に selected state が分かる class / aria。
- event list buttons は button 要素にする。
- icon-only button は使わない。使う場合は aria-label 必須。
- Escape handling は既存 App 側の modal handling に合わせる。

---

## 7. Manual visual check

1. AI proposal review を開く。
2. deterministic review が生成される。
3. still after が表示される。
4. `side-by-side` にする。
5. review bundle に clips がある場合、before / after video が表示される。
6. before を再生すると after も再生される。
7. seek すると after が追従する。
8. mobile 幅で modal が破綻しない。
9. long JSON details が layout を壊さない。

---

## 8. 検証

```sh
npm run typecheck
node --test test/reviewEvents.test.ts test/docDiff.test.ts test/editorAi.test.ts test/editorServer.test.ts test/review.test.ts
```

最終:

```sh
npm test
```

---

## 9. 完了条件

- clips がある場合に side-by-side 同期再生できる。
- clips が無い場合に still compare が壊れない。
- overlay mode は still overlay として動く。
- layout が desktop / narrow width で破綻しない。
- 全 phase の受け入れ条件が満たされる。
