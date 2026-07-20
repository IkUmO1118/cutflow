# ブループリント(実証済みの shot 型)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ./PROVENANCE.md.
>
> 実装者へ: これは新規ファイル `docs/hyperframes-skills/blueprints.md` の完成版。
> **中身はスケルトン**(timecode 構造 + signature move + role メニュー)で、
> `data-composition-id` を含む HTML コードブロックは**一切置かない**(recipes と
> 同じく render 形状のテスト負荷を足さない設計)。`test/hyperframeExamples.test.ts` の拡張で
> このファイルもスキャン対象に入れる(該当ブロックが無いので vacuous に通る。
> 具体は `P3-test-extension.md`)。

## これは何か / card-patterns との違い

**ブループリント**は、製品非依存の**時間割りされた shot テンプレート**
(`Scene N (a–b s): …` の `[slot]` 群 + 1つの名前付き **signature move**)。
golden な product-launch クリップ群から逆算した「型」で、**尺いっぱいに reveal を
配る**(t=0 に全部出さない)ことを構造として持つ。upstream の
`hyperframes-animation/blueprints/*.md` を Cutflow 向けに要約したもの。

- `card-patterns.md` = **番号で1つ選んですぐ render できる完成カード**(検証済みの HTML)。
- `blueprints.md`(この文書) = **shot の骨格**。card-patterns に無い beat を作るとき、
  ここから **Reproduce / Adapt / Compose**(card-patterns 冒頭指針)して `recipes/` の
  move で肉付けする。**signature move は落とさない**。

## 無音・作図カードの制約(全 blueprint 共通の読み替え)

upstream の型は「ナレーション(VO)+ 実写/実UI/カーソル/BGM/SFX」を前提にした
product-launch 動画のもの。Cutflow の HyperFrames カードは**無音の作図素材**なので、
次を一律に読み替える(各 blueprint の「無音カードでの当たり判定」はこれを個別に述べる):

- **VO は無い** → reveal は VO ではなく**カードの尺(clip 窓)/beat**に配る。
  「VO がその語を言ったら出す」は「その beat の時刻で出す」。
- **音は無い** → `sfx:` / BGM / duck・音同期(ASR word timing)は対象外。ASR 由来の
  karaoke/keyword-glow は**手打ちの timing 配列**で近似する(recipe の `no-input` 印)。
- **実カーソル・ブラウザ chrome・実 UI は原則出さない**(faceless の負リスト)。
  再現 UI を主役にする型(cursor-ui-demo / device-surface-showcase)は下記のとおり
  **pattern 化しない**(blueprint 止まり)。
- **`<video>` はカードに置けない**(interpreter がメディアを駆動しない)。実写クリップを
  主役にする型(video-text-pivot の video 面)は、カードでは静止面/図で代替するか、
  動画自体は本編 overlays/inserts(`materials/`)側へ回す。
- **カメラ移動は要素空間 or 一度だけ計測**。`getBoundingClientRect`/`measureText` を
  毎フレーム読む zoom/pan は perceptual-risk(AA jitter)。setup で1回計測し
  `__ready` の裏で固定する(recipes の `measure+zoom` hazard)。
- **重い 3D/WebGL(3D-hand gesture・portal bloom・真の Three.js)は rule library の外**。
  raw WebGL shader は `gpu-angle` profile で render 可(`perceptual` tier 必須)だが、
  Three.jsもmanual/core-only経路だけが`usable`。無音の作図カードでは基本使わず、
  真のgeometry/perspective/depthが必要な場合だけ選ぶ。

## pattern 化しない2型(重要)

- **`cursor-ui-demo`** と **`device-surface-showcase`** は、**再現された生 UI/デバイス面 +
  それを駆動するカーソル/ジェスチャ + カメラ chase** が型の本体で、無音の作図カードの
  レジスタ(タイポ・図形・図解)から外れる。**card-patterns には昇格しない**
  (blueprint としては残す)。静的な UI/デバイス**枠**を1枚描く程度なら Compose で
  作れるが、その場合カーソル駆動・screen-cycle・chase は落とす=もう別物。

---

# 15 blueprints

各項: **roles / duration / timecode(要約)/ signature move / role メニュー行 /
無音カードでの当たり判定**。timecode は upstream の Scene 行を圧縮した骨格
(```text フェンス=完全 composition ではない)。

## 1. kinetic-type-beats

- **roles**: Hook · Problem · Product_Intro · Benefits · CTA · Brand_Outro(**6役の主力**)
- **duration**: 3.4–12s
- **timecode**:
  ```text
  Scene 1 (0–~1s): 単色背景に太字が中央へ1回の入場(type-on / flash-cut / per-word / big→small)。
  Scene 2..N: beat が中央で入れ替わる engine。 (A) fixed-line token swap(可変スロットだけ hard-cut)
              または (B) multi-beat statement build(1 beat=1 背景/行、各自の入退場 move)。
  Scene N (最終→end): 最後の beat が着地しホールド(settle のみ、scale-out しない)。
  ```
- **signature move**: 「**motion が語の変化そのもの**」— in-place token cycle(ハードカット)
  または beat 単位の statement build → spring-pop payoff。
- **role メニュー**: Hook=皮肉な一行/エスカレーション · Problem=3–5の痛点が単独着地 ·
  Product_Intro="Introducing…" name-drop · Benefits=8–12の高速 staccato · CTA=締めの一行 ·
  Brand_Outro=単語の verb 連打→定義語。
- **無音カード**: 直球で作れる主力型。beat の cadence は尺で割る。karaoke/keyword-glow は
  手打ち timing。camera push は静止でよい(多くの variant は camera-locked)。

## 2. typewriter-reveal  → **card-patterns #11 に昇格済み**

- **roles**: Hook · Brand_Outro
- **duration**: 3.6–7s
- **timecode**:
  ```text
  Scene 1 (0–~2s): キャレット | が行頭で点滅→ primary line が1文字ずつ type-on。
  Scene 2 (~2–4.5s): 打った行を in-place で改変(backspace→retype / hard-cut / mask-wipe)。
  Scene 3: Hook=行を点へ collapse→ brand を spring-pop / Brand_Outro=持続する mark の下で CTA が type-in。
  ```
- **signature move**: 「**誰かが今打っている**」— キャレット付きの1文字ずつ type-on(と編集)。
- **role メニュー**: Hook=等身大の一行→畳んで brand · Brand_Outro=常駐 mark + 打ち替わる CTA rail。
- **無音カード**: 昇格済み(#11)。`steps()` の width アニメで seek-safe に離散表示。

## 3. spatial-pan-stations

- **roles**: Hook · Problem
- **duration**: 7–10s
- **timecode**:
  ```text
  Scene 1 (0–~1s): 1枚の巨大キャンバスに全 station を先置き。camera が station 1 を中央に。
  Scene 2..N-1: camera が ease-in-out で次の station を中央へ pan、到着で callout を reveal(1停 ~1s)。
  Scene N: 最後の station に着地し callout がホールド、camera 静止。
  ```
- **signature move**: 「**1台の仮想カメラが先置きの station 列を pan で巡る**」
  (Hook=水平タイムライン左送り / Problem=手描き線に沿う斜め pan → 終端は scribble knot)。
- **role メニュー**: Hook=現在に至るマイルストーン歩き · Problem=繋がった痛点の web → もつれ。
- **無音カード**: pan は `viewport-change`(1つの `.world` を transform)。off-edge に流れる
  ラベルは card を `overflow:hidden` で clip(device-surface の overflow 注記と同型)。
  measure+zoom を避け scripted transform で。

## 4. constellation-hub

- **roles**: Hook · Social_Proof(+ CTA orbit-collapse)
- **duration**: 5–8s
- **timecode**:
  ```text
  Scene 1 (0–~1.5s): 暗背景に primary node がリング状に spring-pop(elastic overshoot, stagger)。
  Scene 2 (~0.7–2.5s): secondary node が隙間を埋め、hub→node の connector を draw。camera 静止。
  Scene 3: finisher — (Hook) 中心へ push-in + 外周 DOF blur / (Social_Proof) hub mark を軸に
           badge が周回しつつ slow zoom-out(ecosystem reveal)。
  ```
- **signature move**: 「**node が中心のまわりにリングで湧き、core に解決**」
  (push-in-with-DOF、または hub を保って satellite が orbit)。
- **role メニュー**: Hook=道具/ノードの星座 + push-in「全部つながる」 · Social_Proof=製品 mark を
  hub に partner logo が周回「あなたの stack の中心」。
- **無音カード**: リング配置は `avatar-cloud-network`。push-in/zoom-out は measure once。
  無限 orbit は禁止=有限 tween で表現。

## 5. grid-card-assemble  → **card-patterns #8 に昇格済み**

- **roles**: Key_Feature · Benefits · Social_Proof
- **duration**: 3.0–10.5s
- **timecode**:
  ```text
  Scene 1 (0–~1s): 空の grid/list 領域に item が短い stagger で assemble(1枚ずつ slot へ、~0.04–0.08s gap)。
  Scene 2: 残りが到着し layout 確定、完成 array がホールド(gentle float / slow push-in)。
  Scene 3: settle / camera zoom-OUT で「より大きな全体の中」を reveal(glass-card / logo-wall variant)。
  ```
- **signature move**: 「**N 個が staggered cascade で grid/list に自己組み上げ**」
  (任意で camera zoom-OUT が array を広大な全体の中に見せる)。
- **role メニュー**: Key_Feature=機能タイル grid · Benefits=積み上がる縦リスト · Social_Proof=logo wall→ecosystem。
- **無音カード**: 昇格済み(#8)。密な wall は共有中心バーストにせず短経路 into-slot
  (`center-outward-expansion` の short-path 形)。

## 6. logo-assemble-lockup  → **card-patterns #10 に昇格済み**

- **roles**: Product_Intro · CTA · Brand_Outro
- **duration**: ~4.6–11s
- **timecode**:
  ```text
  Scene 1 (0–~1s): 舞台を用意(ring pulse / 3D mark settle / button 描画 / 既存 formation が四辺へ退場)。
  Scene 2 (~1–Ys): mark が部品から組み上がる(seed→shape / wordmark cascade / 対角 band wipe / stroke draw)。
  Scene 3: 中央 lockup に解決してホールド、または CTA(URL/verb)へ延長。
  ```
- **signature move**: 「**ブランド mark が部品から自分を組み上げ、中央ロックアップに解決**」
  (要素の assemble/orbit・letter cascade・outline draw-on・camera push-through のどれか)。
- **role メニュー**: Product_Intro=無言の premium sting · CTA=logo build→最終 URL · Brand_Outro=UI を払って mark が描かれる。
- **無音カード**: 昇格済み(#10)。camera push-through は heavy 演出=無音版では stroke-draw +
  letter cascade の軽い組み上げに寄せると安定。

## 7. cursor-ui-demo  ⚠️ **pattern 化しない(blueprint 止まり)**

- **roles**: Product_Intro · Key_Feature
- **duration**: 4.0–9.3s
- **timecode**:
  ```text
  Scene 1: 製品 UI 面が中央に establish、custom cursor が第1操作、UI が live 応答。
  Scene 2: camera が次の target へ chase(push-in+pan / whip-pan)、cursor が操作 k、UI が更新(engine)。
  Scene 3: 最終 target で payoff 状態、camera 静止しホールド。
  ```
- **signature move**: 「**可視カーソルが再現 UI を click/hover/drag で駆動し、画面が state を変える
  / camera が各操作を chase**」。
- **role メニュー**: Product_Intro=面の初見 sweep · Key_Feature=1本の workflow を端から端まで実演。
- **無音カード当たり判定**: **不適格**。再現された生 UI + カーソル駆動 + camera chase が本体で、
  無音の作図レジスタから外れる(実 UI/カーソル chrome は faceless 負リスト)。カードでは
  **昇格しない**。UI 枠を1枚描くだけなら Compose で可(その時点でこの型ではない)。

## 8. device-surface-showcase  ⚠️ **pattern 化しない(blueprint 止まり)**

- **roles**: Key_Feature(role-narrow・mechanic-rich)
- **duration**: 5–9.6s
- **timecode**:
  ```text
  Scene 1: device mockup / floating window が establish、first screen 表示、showcase camera 開始。
  Scene 2: 面の上で操作(tap/scroll)→ screen が advance、脇の headline が更新。
  Scene 3+: 2–4 の screen beat を巡り、最終 screen でホールド(または portal bloom で exit)。
  ```
- **signature move**: 「**device/window を hero に保ったまま、その画面が実フローを cycle**」
  (static hold / push-in→zoom-out / 連続3Dプッシュ)。
- **role メニュー**: Key_Feature=機能を「その実 UI の中で」体験させる。
- **無音カード当たり判定**: **不適格**。device 面 + screen-cycle + camera が本体。3d-hand
  gesture + WebGL portal は rule library 外の heavy special。カードでは**昇格しない**。
  静的なデバイス枠1枚は Compose 可(cycle/gesture は落とす)。

## 9. dataviz-countup

- **roles**: Problem · Product_Intro · Hook
- **duration**: ~4–12s
- **timecode**:
  ```text
  Scene 1: 最初のデータ instrument が中央 establish(count-up 数値 + progress ring/bar が同 ease で着地)。
  Scene 2: camera が次の instrument へ traverse(trend line が左→右 draw / tilted grid が scroll)。
  Scene 3: hero metric card を中央に landing、背後に accent glow bloom、settle してホールド。
  ```
- **signature move**: 「**数字と図が hero、camera が instrument を push-THROUGH / scroll して
  hero metric に着地**」。
- **role メニュー**: Problem=悪化する問題を定量化 · Product_Intro="結果を見て"の自信ある開幕 ·
  Hook=1つの劇的統計の cold-open。
- **無音カード**: count-up は `counting-dynamic-scale`、fill 図は `stat-bars-and-fills`、glow は
  `ambient-glow-bloom`(→ card-patterns #6 stat の語彙追記と同源)。camera push-through は
  measure once / scripted。

## 10. titlecard-reveal  → **card-patterns #7 に昇格済み**

- **roles**: Benefits · Social_Proof
- **duration**: 3–5s
- **timecode**:
  ```text
  Scene 1 (0–~0.4s): 静止 camera、開幕 state を確立(空→テキスト、または雑多な collage)。
  Scene 2 (~0.4–1.5s): たった1つの restrained reveal(fade+subtle scale settle / 対角 pill-wipe)。
  Scene 3 (~1.5–end): reveal 済みカードが最後までホールド(生きた要素は多くて1つ)。
  ```
- **signature move**: 「**restrained な reveal を1回だけ + 静止ホールド**」
  (Benefits=2行の slide-up crossfade / Social_Proof=雑多を wipe して clean lockup + proof)。
- **role メニュー**: Benefits=落ち着いた2行の価値タイトル · Social_Proof=busy open を払って lockup + "N+ teams"。
- **無音カード**: 昇格済み(#7)。**動きの少なさが payload**=開発フェーズを捏造しない。

## 11. comparison-split  → **card-patterns #9 に昇格済み**

- **roles**: Key_Feature
- **duration**: 4–6s
- **timecode**:
  ```text
  Scene 1 (0–~0.8s): 中央 title が上から降りて着地(非対立の T 字)。
  Scene 2 (~0.4–1.9s): 等幅2カードが両袖から入場、mirrored rotateY book-open tilt + 0.85→1、傾き保持。
  Scene 3 (~1.9–end): 内縁に pill badge が spring-pop(唯一の overshoot)、settle しホールド。
  ```
- **signature move**: 「**両袖からの mirrored 3D book-open tilt + 内縁 badge**」。
- **role メニュー**: Key_Feature=同重量の2つを同時に天秤(A/B・"X+Y together")。>2 や逐次は不可。
- **無音カード**: 昇格済み(#9)。`split-tilt-cards`。camera は静止(対称が主題)。

## 12. overwhelm-surround

- **roles**: Problem
- **duration**: 6–9s
- **timecode**:
  ```text
  Scene 1 (0–~1.6s): 見知った surface 3枚が staggered scale-in(中央 full, 両脇 ~0.86)、低振幅 float。
  Scene 2 (~1.6–3s): platform icon が density marker として散り込む(「量」の表現)。
  Scene 3 (~3–4.6s): 中央 mockup が morph → 下から viewer の avatar が reveal(製品→人)。
  Scene 4 (~4.6–end): task bubble が全方位から close-in(avatar は不動)、閉塞状態でホールド。
  ```
- **signature move**: 「**中央が viewer の avatar に morph → 要素が全方位から close-in(surrounded, not zoomed)**」。
- **role メニュー**: Problem=「道具に埋もれている / あなた自身が中に」。
- **無音カード**: camera 静止(push-in は閉塞感を殺す)。morph は `card-morph-anchor`
  (width/height ではなく scaleX/scaleY)。bubble 配置は cos/sin を setup 1回。

## 13. ticker-takeover

- **roles**: Hook · Brand_Outro
- **duration**: 5–7s
- **timecode**:
  ```text
  Scene 1 (0–~1.4s): typewriter が lead-in を打つ(typo なし=自信)。camera 静止。
  Scene 2 (~1.4–3s): accent word slot が 2–3 option を縦 spring-roll で cycle(「色々あり得る」)。
  Scene 3 (~3–4.2s): hero が画面外から勢いで crash-in し text 群を物理的に押しのける(fade でなく衝突)。
  Scene 4 (~4.2–end): hero が中央に heavy に着地しホールド。
  ```
- **signature move**: 「**off-screen の hero が crash-in して text を shove(collision, not fade)**」。
- **role メニュー**: Hook=cycling を hero が暴力的に置換 · Brand_Outro=同じ衝突を締めに。
- **無音カード**: cycle は `vertical-spring-ticker`、衝突は `reactive-displacement`(押される text が
  displaced mass)、crash は `motion-blur-streak`。resting jitter は低振幅・有限。

## 14. video-text-pivot

- **roles**: Product_Intro · Key_Feature
- **duration**: 6–8s
- **timecode**:
  ```text
  Scene 1 (0–~1.6s): product video が中央 scale-in、小さく breath。
  Scene 2 (~1.6–3.2s): video が脇へ slide(x+縮小)し、空いた場所に hero stat が 3D-depth で pop(重心移譲)。
  Scene 3 (~3.2–5s): 両者が退場、kinetic text が空いた中央に type-in(accent 語が意味を担う)。
  Scene 4 (~5–end): gradient pill が closing 行に scaleX-snap、glow halo が一拍遅れて締める。
  ```
- **signature move**: 「**video が脇へ slide して重みを hero stat に手渡す → 中央に kinetic text**」。
- **role メニュー**: Product_Intro="機能を見せる→影響を見せる"で video を残す · Key_Feature=clip→metric→impact line。
- **無音カード当たり判定**: 部分適格。**`<video>` はカードに置けない**ので video 面は静止の
  製品図/still で代替するか、動画は本編 overlays 側へ。stat pivot・kinetic text・pill snap は
  作図で再現可(`3d-text-depth-layers` / `scale-swap-transition` / `ambient-glow-bloom`)。

## 15. cta-morph-press

- **roles**: CTA
- **duration**: 4–6s
- **timecode**:
  ```text
  Scene 1 (0–~1.4s): hero mark が中央でホールド(faint rotation breath のみ)。camera 静止。
  Scene 2 (~1.4–2.4s): hero が同じ中心で小さく明るい CTA に condense(shrink-fade ↔ scale-up、同 origin)。
  Scene 3 (~2.4–3.4s): cursor が off-stage から減速して到着、CTA の幾何中心を数px 外して着地(human aim)。
  Scene 4 (~3.4–end): click — cursor と CTA が lockstep で圧縮→release(ripple/glow)、clicked 状態でホールド。
  ```
- **signature move**: 「**同一中心で mark→CTA に morph、その後 cursor が human-aimed click**」。
- **role メニュー**: CTA=identity から action へ目線を運ぶ集中した「ここを押す」締め(spatial set なし)。
- **無音カード当たり判定**: 部分適格。morph(`scale-swap-transition`)は作図で綺麗に出るが、
  **カーソル/クリックは faceless 負リスト寄り**。カードでは morph 中心で締め、cursor press は
  落とすか、UI を主題にする収録に限る(実質 cursor-ui-demo 側の判断)。

---

## role → blueprint メニュー(SOFT)

story/beat が先。下は「その beat なら手に取る」候補(⚠️=無音カードでは pattern 化しない)。
役は storyboard の frame `type` に対応(Hook=hook · Problem=pain_point · Product_Intro=product_intro ·
Key_Feature=feature_showcase · Benefits=benefit_highlight · Social_Proof=social_proof · CTA=cta ·
Brand_Outro=branding)。

| role | 候補 blueprint |
|---|---|
| Hook | kinetic-type-beats · typewriter-reveal · spatial-pan-stations · constellation-hub · ticker-takeover · dataviz-countup |
| Problem | kinetic-type-beats · spatial-pan-stations · dataviz-countup · overwhelm-surround |
| Product_Intro | kinetic-type-beats · logo-assemble-lockup · dataviz-countup · video-text-pivot · ⚠️cursor-ui-demo |
| Key_Feature | grid-card-assemble · comparison-split · video-text-pivot · ⚠️cursor-ui-demo · ⚠️device-surface-showcase |
| Benefits | kinetic-type-beats · grid-card-assemble · titlecard-reveal |
| Social_Proof | constellation-hub · grid-card-assemble · titlecard-reveal |
| CTA | kinetic-type-beats · logo-assemble-lockup · cta-morph-press · constellation-hub(orbit-collapse) |
| Brand_Outro | kinetic-type-beats · typewriter-reveal · logo-assemble-lockup · ticker-takeover |

**card-patterns に昇格済みの5型**: titlecard-reveal(#7)· grid-card-assemble(#8)·
comparison-split(#9)· logo-assemble-lockup(#10)· typewriter-reveal(#11)。
残る型はここから Reproduce/Adapt/Compose して作る。
