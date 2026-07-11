# 審美眼プログラム — スタイルを学び、判断品質を測って上げる

> **一言**: 精度母艦(`2026-07-11-edit-precision-program.md`。以下 **精度母艦**)は
> **行動空間の拡大**(cut/meta のみ → 演出/BGM/素材まで)と**幻覚耐性**(番号選択方式)を
> 概ね達成した。残った壁は **判断品質=審美眼**:「valid で動く編集」から「編集として上手い」への
> 飛躍で、**現状これは採点できていない**。本母艦はこの一点に集中する。
>
> **この母艦は旧2ドキュメントの統一版**である。旧 `2026-07-11-aesthetic-judgment-program.md`
> (審美眼=測って上げる)と旧 `2026-07-11-reference-style-analysis-design.md`
> (見本動画→スタイル抽出)は**同じプロジェクトの表と裏**だと判明したため1本に統合した
> (2026-07-11。§11 参照)。**審美眼を測るには「良さの参照点」が要り、その参照点を供給するのが
> スタイル学習**、という中心命題(§1.2)で両者を貫く。旧2ファイルは削除済み。

このドキュメントは**生き物**。ブラッシュアップのたびに §10 ロードマップの状態と §11 作業ログを更新する。
機械可読・エージェント非依存の契約は `AGENTS_CONTRACT.md`、運用ニュアンスは `CLAUDE.md` が正。

---

## 1. 目的と中心命題

### 1.1 なぜ今これか(精度母艦からの引き継ぎ)

精度母艦の到達点(2026-07-11 実測で確認済み。精度母艦 §6・[[precision-measurement-nondeterminism-wall]]):

- **行動空間は広がった** — cut/meta しか触れなかった AI が、番号選択方式で演出(zoom/blur/annotation)・
  BGM・素材配置まで提案できる。「AI 所掌 = cut/meta のみ」は解消。
- **幻覚は構造的に塞いだ** — 座標は知覚(決定論)、時刻はアンカー、補正は実測からの算術。
  LLM は「どれを選ぶか」だけ判断し、精密な値を生成しない。
- **機械的整合は保証される** — validate / effect-check / bgm-fit / material-fit が
  幾何衝突・音量被り・尺乖離を人間 preview の前に捕捉する。

しかし実測できたのは **「動く・validate 通る・番号選択が効く・座標は知覚由来」までで、
「編集として良いか(審美眼)」は未採点**。plan の非決定性で単発 diff は品質を採点できず
([[precision-measurement-nondeterminism-wall]])、生成系(plan-effects/plan-bgm)は「動く」までしか
実測していない。**行動空間は広げた。次は広げた空間の中の判断品質と、それを測る物差し。**

### 1.2 中心命題(この母艦の背骨)

> **審美眼を測る土俵には「良さの参照点」が要る。今の測定は J 次元(主観)の参照点を
> 毎回ゼロから(人間 1〜5 / VLM yes-no に外注)しており、そこが再現性の穴。
> その参照点を供給するのが「スタイル学習」— 見本/自コーパスから編集スタイルを
> 抽象データとして取り出すこと。ゆえに「審美眼を測って上げる」と「スタイルを学ぶ」は
> 同じ 1 つのプロジェクトである。**

この命題の要点(詳細は §3〜§5):

- **J 次元の採点は参照点不在で行き詰まる** — 人間 1〜5 は高コスト、VLM は「このチャンネルにとっての
  良さ」を知らない。どちらも**次の動画に転移しない=再現しない**。
- **スタイルプロファイルがその参照点になる** — 「このくらいのテンポ・字幕密度・構成・音量感を好む」
  という方針データ。これが J 次元に欠けていた「良さの目盛り」を供給する。
- **プロファイル 1 個が測定基盤の穴を同時に 3 つ塞ぐ(§5)** — (1) 多くの J 次元を決定論 D へ変換、
  (2) 再現可能な答え合わせセットを生成、(3) 判断向上の few-shot 基質になる。

### 1.3 審美眼の定義

> **審美眼 = 「valid で動く」を超えて「編集として上手い」を選び取る判断品質。**
> 具体的には §2 の各次元(境界の綺麗さ・重複処理・文脈連続性・ペース・演出の目的適合・
> BGM の音響整合・素材の話題適合)を、**採点可能な代理指標に落として測り、上げる**こと。

### 1.4 スコープ / 非スコープ

**スコープ**(ユーザー確定 2026-07-11):

- **採点対象 = 全軸(cut + 演出 + BGM + 素材)。** 実装したての M/E/B こそ質が未検証なので、
  cut と並べて全軸を審美眼の物差しに載せる(精度母艦 D5「cut に集中」は**行動空間拡大フェーズの
  方針**で、審美眼フェーズはそれを解除して全軸採点に進む)。
- **背骨 = 測定基盤を先に。** ただし「測定基盤の第 1 手」は抽象的なエラー分類ログではなく、
  **スタイルプロファイルの抽出**(§5 の理由により、これが測定の的・答え合わせ・判断基質を
  同時に生む)。
- **供給源 = 任意パス吸収を主入口に(§4・確定 2026-07-12)。** このチャンネルは自信作がまだ無く
  承認済み 1 本の cold-start(§11)。ゆえに「承認済み自コーパスの自動採掘」を門にせず、
  **`style-profile --from <path>` で任意の動画/収録を吸収**する。自コーパス採掘は自信作が
  溜まってから重みが増す 1 モード。重い第三者エミュレーションは park(§10.0)。

**非スコープ**:

- **番号選択方式の放棄** — 幻覚耐性の安全網は保つ(精度母艦 D1 ハイブリッド継続)。
- **新しい編集能力の追加** — 行動空間の拡大は精度母艦の担当。ここは**既存能力の使いこなしの質**。
- **完成動画からの source 判断の復元を偽ること** — 完成品からは「残ったもの」しか観測できない
  (§3・§8 不変条件)。
- **バイト等価の破壊** — 知覚・スタイル注入を足すときは `plan.perception` 同様 opt-in / sticky を守る。

---

## 2. 審美眼とは何か(採点可能な次元への分解)

抽象語「審美眼」を、**観測可能な代理指標**へ割る。各次元を **D(決定論で測れる)** と
**J(主観/VLM/人間でしか測れない)** に二分するのが測定基盤の起点 — **D は自動採点で回帰基準線に、
J は回帰サンプルの人間/VLM 評価に回す**。**ただし J の多くは「良い値が分からないから J」であり、
スタイルプロファイル(§4)が目標値を供給すると D へ動く**(その再分類は §5.1)。

### 2.1 カット

| 次元 | 良い状態 | 測り方 | 種別 |
|---|---|---|---|
| 境界の綺麗さ | 語の途中で切れない・呼吸境界で切る | words で語境界一致を判定(精度母艦 C7/C8) | **D** |
| 重複テイクの処理 | 言い直しの綺麗な方だけ残る | near-duplicate span 検出(C2) | D→**J** |
| 文脈連続性 | 指示語の宙吊り・未完了文の分断が無い | cut 境界前後の transcript/words 検査(C10) | D→**J** |
| ペース | 冗長/言い直し/脱線は切り、見せ場は残す | 目標尺・累積尺・話速(C4/C5)。profile の shot 長 [p10,p90] 学習帯からの距離(SD-T1 `style-check`) | **D(SD-T1)** |
| 残しすぎ | keep 長尺に冗長が残っていない | keep 理由・不確実性の出力(X7) | J |

### 2.2 演出(zoom / blur / annotation)

| 次元 | 良い状態 | 測り方 | 種別 |
|---|---|---|---|
| 種別適合 | 見せる=zoom / 隠す=blur / 指す=annotation が目的に合う | 種別選択器の妥当性(E2) | **J** |
| 座標が目的を満たす | 見せたい/隠したい/指したい対象を実際に覆う | before/after still + VLM 判定(E3) | D→**J** |
| 相互作用 | zoom×固定px演出の追従ズレが無い | effect-check の決定論(実装済) | **D** |
| 密度 | 見せ場以外で多用しない・注釈が長すぎない | effect-check の密度ガード(実装済)。**閾値をプロファイル学習値へ** | **D** |

### 2.3 BGM

| 次元 | 良い状態 | 測り方 | 種別 |
|---|---|---|---|
| 発話被り回避 | BGM が発話を潰さない | av.probe の mic/system RMS 被り(bgm-fit 実装済) | **D** |
| 無音の浮き | 無音区間で BGM が原音量で浮かない | av.probe の silences(bgm-fit 実装済) | **D** |
| ラウドネス | 全体が目標 LUFS に収まる | integratedLufs(bgm-fit 実装済)。目標 LUFS は profile.audio.integratedLufs、`style-check` が ±絶対帯(confidence 広げ)で距離判定(SD-T1) | **D** |
| 切替の意味 | 章/大カット境界で意味的に切り替わる | 切替点の意味化(B3)。**切替 cadence はプロファイルで D 化可** | J→D |

### 2.4 素材(B-roll / インサート)

| 次元 | 良い状態 | 測り方 | 種別 |
|---|---|---|---|
| 尺整合 | 実尺 vs 宣言尺の乖離が無い | material-fit(実装済) | **D** |
| 話題マッチ | 素材が語っている話題に対応する | transcript × materials.probe マッチ(M1/M4) | **J** |
| dangling/未使用 | 参照先が実在・置いた素材が使われる | materials(実装済) | **D** |

### 2.5 横断:「valid だが変」

種別に依らず「動くのに変」を捕まえる横断次元。**ここを assert に昇格する(精度母艦 X3)のが
測定基盤の要**:参照語だけ残る / 語途中切れ / 長い freeze / 長い無音 / 見せ場 brief の消失 /
唐突なジャンプ。**プロファイルの学習帯からの逸脱**も、ここに合流する新しい assert 面(§5.1)。
= SD-T1 `style-check`(cut/caption/audio。warn/info・exit 0)。実装済。

---

## 3. 再現性仮説の解剖 — "抽象編集データ"には 2 種類ある

「見本動画→抽象編集データ→自動編集」に再現性がある、という直感は正しい。ただし
**"抽象編集データ" は全く違う 2 つを指しており、混同すると再現性を過大評価する**。

出発点の事実(旧 reference-style §2.1・§9.1):**完成動画だけからは source-time の編集判断を
復元できない**。見えるのは「残ったもの(output)」だけで、切った NG・詰めた間・使わなかった素材・
判断理由は**構造的に失われている**。ここから 2 種類に分かれる:

| | (A) 完成品スタイル方針 | (B) raw+完成ペアの判断例 |
|---|---|---|
| 中身 | 出力で観測できる**好みの分布**(ショット長・caption 密度/位置・loudness・構成) | 「この raw 状況でこれを残した」という**判断関数の実例** |
| 教えられること | *how much / how often / where*(**割合・頻度・配置の統計**) | *which one / is this correct*(**インスタンスの是非**) |
| 再現性 | **高い**(完成品を観るだけ) | 高いが**要アライン**・confidence 限定 |
| 限界 | 「このカットを切れ」は言えない | 他人の見本には raw が無い |

**この境界が本質**:(A) は「テンポ速め・全編 caption・冒頭 4 秒フック」といった**候補選択のバイアス**に
なるが、「**この冗長な 1 文を切れ**」は原理的に言えない。「編集判断の抽象データ」の正直版は
**(A) のスタイル方針**であって判断規則ではない。判断規則 (B) は raw+完成ペアのアラインが要る
(旧 reference-style の P3 = 最難関・最後)。

> **能力境界の一行**: スタイル抽出は *rate/placement 統計*(どのくらい/どの頻度で/どこに)を
> 教えるが、*instance semantics*(この一個が正しいか)は教えない。この線が §5.1 の J→D 変換の
> 及ぶ範囲を決める。

---

## 4. スタイル学習の供給源 — 任意パス吸収が主入口、自コーパス採掘は育つ経路

### 4.0 実データの現実(確定 2026-07-12)

このチャンネルは **承認済み 1 本・自信作なし・第三者見本も未選定**(§11)。ゆえに「§4.1 の自コーパス
採掘=本丸」は**今はまだ空**で、そのまま門にすると何も学べない。ユーザーの希望(Q1)= **「動画パスを
指定してスタイルとして吸収させるコマンドが欲しい」** に沿い、**主入口を `style-profile --from <path>`
(任意の動画/収録を吸収)に一本化**する。**入力の種類で"取れるもの"が変わる(§3 の (A)/(B) 境界)**:

| 入力 | 取れるもの | 種別 |
|---|---|---|
| 素の動画/plain フォルダ(第三者・書き出し済み) | **結果の観測傾向のみ**(ショット長・字幕密度・LUFS)。何を切ったかは完成品に残っていない | (A) |
| cutflow 収録プロジェクト(例 `2026-07-02`) | **本物の編集判断**=cutplan(どこを keep/cut)+ AI 提案→人間補正の**デルタ**(`plan.raw.txt` がある収録) | (B) |

→ ユーザーの言う「複数動画の編集判断を取得→抽象化」は、**cutflow 収録を入力にする限り正しい**。素の動画では
"判断"ではなく"結果の傾向"になる。§4.1 の自コーパス採掘は、この主入口の **「収録プロジェクト入力」モード**で
あり、承認済みが溜まるほど強くなる**育つ経路**(将来の主軸)。今の主軸ではない。

**複数動画の扱い(確定 2026-07-12)**:`style-profile --from A --from B … --name <名前>` で**複数を 1 プロファイルに
集約**できる(単数と同じ経路。多いほど sampleSize↑=confidence↑)。ただし **1 プロファイル = 1 つの一貫した
スタイル**。作風が違う動画(パンチ/静か)は**混ぜず名前で分ける**(合成でマッシュ化させない)。どの動画を
1 グループにするかは `--name` 単位でユーザーが流動的に決める。v1 は承認済み唯一の `2026-07-02`(words 無し=
境界は segment 粒度まで)で単一先行、コマンド/schema は最初から複数対応。

### 4.1 育つ経路 = 自コーパス(承認済み/編集済み収録)

最も効く発見:**cutflow は編集のたびに raw+完成ペアを生成している**。元収録 + 人間が承認した
cutplan/overlays/bgm。そして **source 軸は最初から捨てていない**(`describe` が source⇔output を写像)。
つまり (B) の判断例データセットが、**自分の taste について、アライン不要で、毎回タダで**溜まっている。

- **`approvals.json` = 「人間が良いと言った」クリーンな教師信号**(keep 集合の sha256 に束縛。
  承認済み ⟺ ラベル済み正例)。
- **`learn.ts` は既にこの原型を単一プロジェクト・free-text でやっている** — `plan.raw.txt`
  (直前 AI 生成)と `describe`(人間の仕上げ)と `meta` を LLM に見せ `rules.suggested.md` を書く。
  **「AI 案 vs 人間の最終形」= 補正信号そのもの**を読んでいる。育つ経路はこれを
  **1 プロジェクト×free-text → N 収録×構造化 style-profile** へ一般化すること
  (SD-T0 の「収録プロジェクト入力」モード。§4.0)。
- **チャンネル = 親ディレクトリという足場も既にある**(`readRules` は `dirname(dir)/rules.md` を読む。
  `learn.ts` も同じ規約)。承認済み兄弟フォルダを列挙する自然なスコープ・
  `style-profile.json` を置く自然な家が、親ディレクトリとして既に定義済み。

**再現性の正しい姿**:「他人の完成動画を分析(損失あり・要アライン)」ではなく **「自分の溜まっていく
承認済み編集を採掘(無損失・構造的にアライン済み)」**。旧 reference-style の P3 は自コーパスでは
タダで最初に来る。

### 4.2 第三者見本(reference-analyze・**未実装**・重い track は park)

他人の完成動画からは (A) のスタイル方針しか取れない(§3)。旧 reference-style 設計の
`reference-analyze`(**コード確認済み:設計のみで未実装**。`src/stages/referenceAnalyze.ts` は無い)。

**Q1/Q4 の整合(確定 2026-07-12)**:ユーザーは Q4 で「第三者見本は park」を選びつつ Q1 で
「パス指定で吸収したい」= 同じ "動画→profile" 機構。整合させ:

- **軽量な「任意パス→決定論 profile」入力は §4.0 の主入口(SD-T0)に畳み込む** — 他人を真似る柱では
  なく、あなたの入力手段(あなた自身の素の動画・憧れの参照動画のどちらでも同じパス入力)。
- **重い第三者エミュレーション track は park** — VLM styleNotes(reference P1)・raw+finished
  アライン(reference P3)。具体的に真似たい見本が定まるまで着手しない(§10.1 の ~~SD-T3~~)。
- 出力は同一 schema(§7)へ `provenance: "reference"` として merge(自コーパスが優先)。

### 4.3 既存で使える部品(新エンジンより orchestrator を組む)

スタイル抽出は新しい認識エンジンを作るより、**既存の観測を束ねる**のが最小で強い(旧 reference-style §1):

- `ingest --layout plain` … 通常動画を全フレーム recording として取り込む(第三者見本用)。
- `transcribe` … 発話・テロップ候補の時間軸。
- `detect` … 無音・間・テンポの手掛かり(`cuts.auto.json`)。
- `frames --every … --ocr --full-res` … 代表フレームと画面内テキスト。
- `av` … scene score・freeze・loudness・true peak・silence・motion strip。
- `describe --json` … **自コーパスの完全射影**(keep/cut/captions/overlays/chapters/meta/bgm/shorts を
  source⇔output 対応付きで)。自コーパス採掘の主入力。
- `src/lib/perception.ts` … 音特徴・OCR・システム音声を LLM 入力へ整形する既存パターン。
- `src/lib/vlmObservation.ts` … limited VLM observation の型・安全制約・画像上限。

### 4.4 抽出できる信号と使い方(旧 reference-style §9.2 を継承)

| 領域 | 抽出する値 | 実装 | 自動編集での使い方 |
|---|---|---|---|
| カット密度 | scene changes/min、平均ショット長、scene score 分布、freeze 数 | 既存 `av` の scdet/freezedetect | ペース目標・無音後の切り詰め強度の方針 |
| テンポ | 無音数/長、発話密度、画面変化密度 | `detect` silence、`av` motion、transcript duration | 候補区間の選択重み付け |
| 音量 | integrated LUFS、true peak、音量エンベロープ、盛り上がり区間 | `av` の ebur128/astats/silencedetect | BGM/SE 有無推定、盛り上げ区間、ショート候補補助 |
| テロップ | OCR coverage、平均表示秒、表示位置、box 分布、行数、文字量 | `frames --ocr --full-res` / `runOcr` | caption 密度/位置/強調方針の初期案 |
| 見た目 | 太字、高コントラスト、座布団、キーワード強調、画面占有感 | P1 の VLM 代表フレーム要約(座標・フォント名は信用しすぎない) | `styleNotes` として prompt に圧縮注入(JSON は書かせない) |
| 構成 | hook/intro/main/CTA/ending、密度の高い区間 | transcript + OCR + motion/sound を LLM に渡す | 冒頭の残し方、章立て、終盤 CTA の扱い |
| 素材対応 | finished 区間が raw のどこ由来か | **自コーパスは source 軸保持で不要**。第三者ペアのみ audio fingerprint/transcript/visual hash | 判断例 (B) の生成(第三者は confidence 付き) |

---

## 5. プロファイルが測定基盤の穴を"同時に 3 つ"塞ぐ

スタイルプロファイル(自コーパス主・第三者従)を 1 個作ると、審美眼の背骨に対して 3 つの効果が
同時に出る。**これが「2 つの母艦は同じプロジェクト」の実体**。

### 5.1 J→D 変換 — 参照値が入ると主観次元が決定論チェックになる

§2 で J とされた多くは「良い値が分からないから J」だった。プロファイルが目標値を供給すると D へ落ちる:

| 次元 | プロファイル無し | プロファイル有り | SD-T1 実装状況 |
|---|---|---|---|
| ペース | J(目標尺が主観) | **D**:ショット長分布の KS 距離 | **D**(SD-T1 実装済。KS ではなく [p10,p90] 帯近似。full 分布 KS は profile v2) |
| caption 密度/位置 | J | **D**:coverage 比・位置ヒストグラムの距離 | **D**(SD-T1 実装済。coverage=絶対帯・density/positionHint=カテゴリ一致) |
| BGM loudness/切替頻度 | 一部 D | **D**:目標 LUFS・章あたり切替回数の距離 | loudness は **D**(SD-T1 実装済)/ 切替頻度は profile v2 待ち(未) |
| 演出密度 | D(閾値ハードコード) | **D**:閾値が config 固定でなく**学習値** | v1 は config 固定のまま(学習値化は profile v2 待ち。未) |
| 構成(フック長・CTA) | J | **半 D**:構成テンプレ一致 | profile は値を持つが T1 v1 scope 外(v1.1。未) |

**残る真の J**(プロファイルでも D にならない):重複テイクの「綺麗な方」選択・素材の話題マッチ・
演出の目的適合(この zoom は狙った対象を実際に覆うか)・文脈連続性(宙吊り参照)。理由は §3 の
能力境界 — プロファイルは *rate/placement 統計* を教えるが *instance semantics* は教えない。

→ **プロファイル導入後、§2 の次元表を「D へ動く/J に残る」で再分類する**のが本フェーズの成果物の 1 つ。
逸脱 assert(観測統計が学習帯を外れたら warn)は §2.5 の横断 assert 面に合流する。

### 5.2 再現可能な J 採点 — hold-out 承認済みプロジェクトを"答え合わせ"に使う

毎回の人間 1〜5 は高コストで収束しない。代わりに:

> 承認済みプロジェクトを 1 本伏せて編集を剥がし、AI に再 plan させ、**人間の正解(承認済み keep 集合)
> との軸別 agreement を計算**する。keep 集合 IoU・境界の語一致・演出種別/配置一致・BGM 区間一致。
> 非決定性は **K 回の分布**で吸収([[precision-measurement-nondeterminism-wall]] と合成)。

**答え合わせの鍵が既にファイルにある**(承認済み編集)ので、毎回の人間採点なしに
**「config X は過去の私の編集と 0.72 一致、config Y は 0.81」** と言える。これが従来の「回帰サンプル +
毎回人間 1〜5」に欠けていた**正解キー付き回帰セット**。ただし絶対品質ではない(§6.2)。

> **cold-start による保留(確定 2026-07-12)**:leave-one-out は承認済みが **N=1 では成立しない**
> (訓練 0/テスト 1)。このチャンネルは承認済み 1 本なので、**SD-T2(agreement harness)は
> 承認済み自信作が ≥2〜3 本になるまで保留**。それまでの測定先行の背骨は、agreement ではなく
> **§5.1 の決定論 distance-to-profile assert(SD-T1)**が担う(cold-start でも実行ごとにブレず測れる)。

### 5.3 判断向上の基質 — プロファイル→候補注入(番号選択の原則を死守)

同じプロファイルが判断を上げる燃料にもなる。精度母艦の原則(LLM に値を書かせない・候補集合を
豊かにする)を守る注入経路は 3 つ:

1. **候補スコアリングの事前分布**(「このチャンネルは平均ショット 2.4s → そのペースへ寄せて切る重み」)。
2. **few-shot 判断例**(自コーパスから「似た過去状況ではこれを残した」を提示)。
3. **自己検証 assert の閾値**(§5.1 — プロファイルが assert のパラメータになる)。

> **抽象化(プロファイル)と具体例(few-shot)は別の使い方(確定 2026-07-12)**:経路 1/3 は判断を統計へ
> **抽象化**する=「どのくらい/どこに」を教えるが *instance semantics*(**この冗長な文を切れ**)は落ちる(§3)。
> 経路 2 は判断を**抽象化せず具体例のまま**持つ=instance 判断に近いものを LLM に見せる。**プロファイル
> だけだと「テンポ速め・字幕多め」までが天井**で、"この文を切る"は few-shot が担う。ユーザーの Q3「両方」は
> この **抽象化(統計)+ 具体例(few-shot)の並走**として実装する。

推奨する実行モデル(旧 reference-style §9.3・§9.5 を継承。**profile をそのまま巨大 prompt に貼らず
圧縮 summary を渡す**):

```text
任意の動画パス(素の動画 / 憧れの参照 / 自分の収録プロジェクト)
  -> style-profile --from <path>     # 素の動画=統計のみ / 収録=統計+補正デルタ
  -> style.probe/profile.json（§7・provenance 付き集約）
  -> compact style summary
  -> plan / editor-ai の opt-in prompt context（{{rules}}{{perception}} と同型・未指定時バイト等価）
  -> ApplyPatch / validate / review / human approval（既存の検査境界）
```

→ **プロファイル 1 個が「測定の的(5.1)」「再現可能な答え合わせ(5.2)」「判断向上の基質(5.3)」を
同時に供給する。** だから審美眼の第 1 手は抽象的なエラー分類ログではなく、
**スタイルプロファイルの抽出**(§10 SD-T0。cold-start では承認済みコーパスではなく
`style-profile --from <path>` の任意パス吸収から。§4.0)であるべき。

---

## 6. 測定基盤の運用(非決定性・agreement の扱い・ルーブリック)

### 6.1 非決定性の壁への具体的対処(最優先の前提)

plan は非決定。**単発 diff は品質を採点できない**([[precision-measurement-nondeterminism-wall]])。ゆえに:

- **D 次元は関数直叩き/決定論 assert で測る** — 実行ごとにブレない。回帰基準線はここに置く
  (C1 格子 27→31 が「関数直叩きで測れた」実例)。
- **J 次元は N 回サンプリングして分布で見る** — 1 回の出力ではなく K 回生成の「良い選択の割合」
  「分散」を採点する。中立 cwd から走らせる([[llm-command-verify-neutral-cwd]])。
- **D と J を混ぜて 1 スコアにしない** — 決定論の pass/fail と主観 1〜5 を別々に記録する。

### 6.2 agreement-with-self の失敗モードと扱い方(正直に)

§5.2 の agreement は強力だが、**自分の過去と一致 ≠ 絶対的な良さ**。誤ると過学習する:

- **複数正解問題**:人間の keep 集合と違う ≠ AI が間違い(良い編集は複数ある)。→ agreement は
  **絶対品質ではなく一貫性の代理**。使い方は **(1) 回帰の非常線**(大きな低下=劣化)、
  **(2) 同一 hold-out 上での config 間の相対比較**に限る。絶対点として崇めない。
- **過去の私が雑だった日**:コーパスにノイズ。→ **golden set の curate**(良い編集だけの小集合)+
  新しさ/confidence 重み。
- **cold start**:新チャンネルは自コーパスゼロ。→ 第三者 profile(弱い)+ 既定でしのぎ、
  コーパスが育つに従い自コーパスへ重心移動。
- **brief vs profile**:brief.md=今回の意図、profile=毎回の癖。衝突しうる(今回は静かにいきたいが
  普段はパンチ強め)。→ **brief が profile を上書き**(`CLAUDE.md` の rules vs brief の関係と同型)。
- **完成品の損失は隠さない**:(A)/(B) を provenance で常に可視化。「完成動画から source 判断を
  復元した」と偽らない(§8 不変条件)。

### 6.3 採点ルーブリックの運用

施策 PR の受け入れ基準に使う:

- **D 次元(決定論・自動)**: `assert` / effect-check / bgm-fit / material-fit / validate +
  **プロファイル逸脱 assert(§5.1)** の pass/fail。回帰基準線。**施策で悪化させない**が最低条件。
- **J 次元(主観・N 回)**: 代表収録 × K 回生成で次元ごとに「良い選択の割合」と 1〜5 平均、
  および **hold-out agreement(§5.2)**。中立 cwd。before/after still/clip を添えて採点。
- **カバレッジ併記**: 低スコアが「判断ミス」か「入力欠落」かを毎回明記(精度母艦 X6)。**入力欠落なら
  知覚を届ける(精度母艦 H1/C3/C9)、判断ミスなら検証・ハーネス(C6/H2)** へ振り分ける。
- **検品しやすさ**: AI 提案が正しいかだけでなく、人間が JSON diff を読まずに採否できたかも測る。

---

## 7. 統一 `style-profile.json`(的の形)

`style-profile --from <path>` の各入力型(素の動画 / 収録プロジェクト / 参照)が**同じ schema**で
吐く。これが下流(§5.3 の注入・§5.1 の assert・§5.2 の agreement 目標)の正本。
**編集命令ではなく参照情報**(§8)。

観測 profile(生の抽出値)の骨子:

```json
{
  "schemaVersion": 1,
  "provenance": "own-project | bare-video | reference | merged",
  "axis": "reference-output",
  "sampleSize": { "projects": 8, "shots": 412 },
  "cutDensity": { "sceneChangesPerMin": 18.0, "avgShotSec": 2.4, "confidence": 0.7 },
  "captions": { "coverageRatio": 0.82, "avgDisplaySec": 1.6, "positionHint": "bottom-center",
                "styleNotes": ["bold", "high contrast", "keyword emphasis"] },
  "audio": { "integratedLufs": -14.2, "silenceCount": 12, "bgmLikely": true },
  "structure": [ { "name": "hook", "start": 0, "end": 4 }, { "name": "main", "start": 4, "end": 105 },
                 { "name": "cta", "start": 105, "end": 120 } ]
}
```

これを圧縮した **style policy**(判断に効く項目だけ)を prompt へ渡す:

```json
{
  "axis": "reference-output",
  "cutPolicy": { "targetAvgShotSec": 2.4, "cutAggressiveness": "medium-high", "pauseToleranceSec": 0.35 },
  "captionPolicy": { "coverageRatio": 0.82, "positionHint": "bottom-center", "density": "high",
                     "styleNotes": ["bold", "high contrast", "keyword emphasis"] },
  "structurePolicy": { "hookSec": 4, "ctaLikely": true, "notes": ["冒頭は説明より結果を先に見せる"] }
}
```

**schema 固定の要件**:各集約値に **provenance + confidence + sampleSize** を持たせる
((A)/(B) を混ぜない・cold start の弱さを可視化・golden set 重みを効かせるため)。
`bare-video` 由来は補正デルタを持てない((B) 不在。§4.0)ので、その旨も provenance で表す。
**v1 scope**:上の骨子(`cutDensity` / `captions` / `audio` / `structure`)まで。§2.4 素材配置・§2.2 演出座標の
policy フィールドは **v2**(§10.0 の profile v1 scope)。実装時には
5 点セット(types/validate/usage/`schemas/*.schema.json`/AGENTS_CONTRACT)を揃え、生成物は
`src/lib/files.ts` の `GENERATED_DIRS`(channel 直下 `style.probe/`)へ追加する。

---

## 8. 不変条件

1. **完成動画単体から source-time の編集判断を復元したと偽らない。** 取れるのは (A) スタイル方針まで。
2. **プロファイル生成物は generated。** `cutplan.json` / `transcript.json` / `overlays.json` などの
   手編集ファイルを勝手に上書きしない(`reference.probe/` 等に閉じる)。
3. **決定論を優先する。** VLM/LLM は optional。失敗しても profile 生成の主要部分は通す。
4. **全時刻の軸を明示する。** 見本単体では source ≈ output だが profile に `axis` を入れる。
5. **profile は編集命令ではなく参照情報。** 下流 AI は profile を根拠に提案してよいが、適用は既存の
   `validate` / `apply` 検査境界を通す。番号選択方式(LLM に値を書かせない)を維持する。
6. **既存 workflow を壊さない。** スタイル注入は opt-in / sticky。未指定時は既存挙動とバイト等価。
7. **agreement は一貫性の代理であって絶対品質ではない**(§6.2)。回帰の非常線と相対比較に使う。

---

## 9. 判断品質を上げる施策(測定後・精度母艦へのリンク)

測定基盤(スタイルプロファイル + §6)ができてから打つ。**新規施策は最小限**で、大半は精度母艦の
C/E/B/H 系を審美眼リフレーミングで再優先付けしたもの(施策の正は精度母艦。ここは順序と接続だけ)。

### 9.1 効き順の背骨

1. **知覚を届ける** — 判断 LLM に「見えていない」ものを見せる。J 次元の低精度が「入力欠落」由来だと
   カバレッジ(X6)が示したら、まずここ。
2. **自己検証を主経路化** — 生成→検品→再生成のループを既定にし、D 次元の assert をフィードバックへ戻す。
3. **ハーネス化** — 単発プロンプトから tool+ループ+検証へ。R0 の解像度は apply 経路(H6)だけが越える。
4. **スタイル注入** — §5.3 の 3 経路で profile を候補選択に効かせる(opt-in)。

### 9.2 施策(接続先は精度母艦の ID)

| # | 審美眼での狙い | 接続先施策 | 軸 | 状態 |
|---|---|---|---|---|
| Q1 | 判断 LLM に実画像・複数時点 OCR を届ける | C3 / C9 / C13 | cut | todo |
| Q2 | 語タイムスタンプで境界判断を細かく(R0 の天井上げ) | W0 / C1 / C7 / C8 | cut | todo |
| Q3 | 重複テイク・文脈連続性の専門判定 | C2 / C10 | cut | todo |
| Q4 | 生成後の自己検証を既定化(cut/演出/BGM/素材) | C6 / effect-check / bgm-fit / material-fit を提案ループへ | 全軸 | todo |
| Q5 | 演出の座標が目的を満たすかの VLM 審美判定を実運用(**profile 接地**) | E3 / E7 | 演出 | todo |
| Q6 | 素材の話題マッチを審美観点で | M1 / M4 | 素材 | todo |
| Q7 | BGM 切替の意味づけ | B1 / B3 | BGM | todo |
| Q8 | 知覚を pull 型に・検証を主経路に・apply で R0 突破 | H1 / H2 / H6 | ハーネス | todo |
| Q9 | **スタイル注入**(候補スコア・few-shot・assert 閾値) | §5.3 / 新設 T 系 | 全軸 | todo |

---

## 10. ロードマップ(確定版・2026-07-12)

**実装設計書はまだ書かない(ユーザー指示)。** ここは着手順の背骨と、着手前に確定した判断の一覧。
設計書化はこの確定を土台にした別作業。

### 10.0 確定した既定判断(2026-07-12)

cold-start の実データ(このチャンネルは承認済み 1 本・自信作なし・第三者見本も未選定。§11)と
ユーザーの 4 判断を受けて以下を確定した。

- **入力(Q1 の核心)** — SD-T0 は**任意の動画パスを吸収**する:`style-profile --from <path>`。
  `<path>` は (i) 素の動画/plain フォルダ → **観測統計のみ**、(ii) cutflow 収録 → **統計 + 補正デルタ**。
  承認済み兄弟フォルダの**自動採掘は 1 モード**であって入口の門ではない。channel 直下
  `style.probe/profile.json` へ provenance 付き集約。→ 「本丸=自コーパス」は**育つ経路**へ格下げ、
  当面の主入口はパス吸収(§4.0)。
- **複数動画・名前付き(A の確定)** — `--from` は複数可・`--name <名前>` で **1 プロファイル = 1 作風**。
  多いほど confidence↑、作風が違えば名前で分ける(合成しない。§4.0)。**理想は名前付き複数**だが v1 は
  **テスト台=`2026-07-02`(唯一の承認済み・(B) 判断が取れるリッチ入力・words 無し=境界は segment 粒度)**で
  単一先行、コマンド/schema は最初から複数対応。
- **抽象化+few-shot 並走(B の確定)** — プロファイル(抽象化=rate/placement)は "この文を切れ" を教えられない
  天井があり、instance 判断は few-shot(具体例保持)が担う。Q3「両方」の実体(§5.3)。
- **学習信号(Q3=両方)** — 収録入力では (a) 最終承認/編集状態の観測統計 + (b) AI 提案→人間補正の
  **デルタ**(`plan.raw.txt` がある収録)。素の動画では (a) のみ。**このユーザーは最終形が test-level の
  ため (b) 補正デルタの方が強い taste 信号**になりうる=miner は (b) を一級で扱う。
- **初手の順序(Q2=任せる → cold-start で精度が出る順)** — **SD-T0 →(前提 exit-1 修正)→ SD-T1
  → SD-T4**。**SD-T2(agreement)は承認済み自信作が ≥2〜3 本まで保留**(leave-one-out は N=1 不成立)。
  測定先行の背骨は **T1 の決定論 distance-to-profile assert** が担う(agreement ではなく)。
- **第三者(Q4=park)** — 重い第三者エミュレーション track(VLM styleNotes・raw+finished アライン)は
  park。**軽量な「任意パス→決定論 profile」入力は T0 に畳み込む**(Q1 と整合。§4.2)。
- **その他の既定(確認不要で確定)** —
  - コマンド=新設 `style-profile`(`learn` は現状維持)/ 生成物=channel `style.probe/profile.json`
    (`GENERATED_DIRS` へ追加)/ 注入=opt-in・sticky の `plan.styleProfile`(既定 off・off 時バイト等価。
    `plan.perception` に倣う)。
  - 抽出=数値は決定論集約(`describe --json`+`av`+`frames --ocr`)。LLM/VLM は styleNotes・構成
    ラベルの optional のみ。compact policy は閾値→ラベルの決定論写像=**数値経路に LLM を挟まない**。
  - T1 assert=ペース(ショット長 KS)・caption coverage/位置・BGM loudness/切替 cadence・演出密度。
    全て **warn(exit 0)**、許容帯は**学習分散**。§2.5 の横断 assert 面へ合流。
  - **profile v1 scope** — schema(§7)・T1 assert が持つ軸は **cut / caption / audio(+演出"密度")** に限る。
    §2.4 素材(B-roll)配置・§2.2 演出の**座標** policy は **profile v2**(schema フィールド追加時に §2 の採点面へ合流)。
    v1 は「素材/演出座標を採点次元に挙げつつ profile が値を持たない」状態を**明示的に scope 外**とする。
  - T2(保留中)の設計値=leave-one-out・指標は keep IoU(出力秒格子)+境界語一致+演出種別/配置
    一致+BGM 区間重なり・K=3 回分布・**非常線+config 相対比較に限る**(絶対品質ではない)。
  - 注入順=候補スコア→few-shot、cut 経路(plan/plan-cuts-only)先行→M/E/B 生成系。
  - brief が profile を上書き(§6.2)。

### 10.1 SD ロードマップ

| SD | ねらい | 中身 | 対応 | 状態 |
|---|---|---|---|---|
| **SD-T0** | 任意パス→profile(測定の基質) | `style-profile --from <path>`。素の動画=統計のみ / 収録=統計+補正デルタ。channel `style.probe/<name>.json` へ provenance 付き集約 | reference P0・`learn` 一般化(採掘モード) | **完了(PR #29・2026-07-12)** |
| **SD-T1** | J→D 変換 | profile→距離 assert(warn・学習分散帯)。§2 次元表の再分類。**cold-start でも測れる測定面** | 旧 A3/A5・精度母艦 X3 | **完了(PR #30・2026-07-12)** |
| **SD-T4** | profile→判断注入 | 候補スコア→few-shot、cut 経路先行。opt-in/sticky。効果は T1 assert で測る | 旧 Q1–Q4/Q6/Q7/Q9・reference P2 | **着手中** |
| **SD-T2** | agreement harness | hold-out 承認済みで再現可能な J 採点(leave-one-out・K 回分布) | 旧 A4・精度母艦 §5 回帰 | **保留**(承認済み ≥2〜3 本まで) |
| **SD-T5** | 接地 VLM 審美judge | 残る真 J(目的適合・見た目一致)を profile の参照 still/styleNotes と照合 | 旧 Q5・精度母艦 E3・reference P1 VLM | 後(vision route 前提) |
| ~~SD-T3~~ | 第三者エミュレーション(重い track) | VLM styleNotes(P1)・raw+finished アライン(P3) | reference P1/P3 | **park**(軽量パス入力は T0 に吸収) |

**先に潰す前提**:未再現異常「effect-check 初回 exit 1」([[effect-check-first-run-exit1]])は
「決定論は常に exit 0」不変条件に触れ、T1 の自動採点面の土台。SD-T0 の前提として
captureStills を try/catch で exit 0 保証する(精度母艦でも既知)。

**保留(第三者ペアがある時だけ・後回し)**:reference-align(raw+finished の source/output 推定。
~~SD-T3~~ の P3)。自コーパスでは source 軸保持で不要なので、真似たい第三者の判断例 (B) が本当に
必要になるまで着手しない。

各設計書は精度母艦 §7 と同じ 4 部形式(背景/変更/検証/リスク)で、Opus 設計 → Sonnet 実装 →
コーディネータ実測のリレー([[opus-sonnet-relay-workflow]])で回す。**各ゲートで実測検証**。

---

## 11. 意思決定・作業ログ(追記していく)

- **2026-07-11(旧・審美眼母艦 起票)**: 精度母艦の M/E/B 完遂(PR #18–#28)と実測総括を受け、
  次フェーズを **審美眼=判断品質の向上**と定義。ユーザー確定の 3 判断:**独立母艦 / 全軸(cut+M/E/B)
  採点 / 測定基盤先行**。
- **2026-07-11(旧・審美眼母艦 実測知見・サンプル `2026-07-10_2`)**: M/E/B を端から端まで実走
  ([[stage-orchestrator-bug-classes]]・[[effect-check-first-run-exit1]])。**番号選択の実証**(zoom rect が
  知覚由来=D 次元(幾何)は堅い→伸ばすべきは J 次元)、**決定論ガードの実証**(不完全な選択を
  validate+effect-check が捕捉)、**測定の壁の具体化**(単発では品質採点不能)、**未再現異常 1 件**
  (effect-check 初回 exit 1)、**データ制約**(曲素材/effect-fix パッチ/VLM route が未実測)。
- **2026-07-11(旧・reference-style 設計)**: 見本動画の目的を「完全逆変換」ではなく **"style profile 抽出"**
  と定義。既存 `ingest --layout plain`/`transcribe`/`detect`/`frames --ocr`/`av` を束ねる orchestrator 方針。
  P0=`reference.probe/profile.json` 生成、P1=VLM 要約、P2=AI 編集への注入、P3=素材ペア alignment に分離。
  **完成品単体からは source 判断を復元できない**を不変条件 #1 に。
- **2026-07-11(統一・本ドキュメント作成)**: 上記 2 ドキュメント(審美眼=測って上げる /
  reference-style=見本から学ぶ)が **同じプロジェクトの表と裏**だと判明し 1 本へ統合。中心命題(§1.2)=
  **「審美眼を測るには良さの参照点が要り、それを供給するのがスタイル学習」**。統合で確定した深い知見:
  - **"抽象編集データ" は 2 種類**(§3):(A) 完成品スタイル方針(高再現・好みの統計)と (B) raw+完成ペアの
    判断例(判断規則・要アライン)。混同すると再現性を過大評価する。境界は *rate/placement 統計 vs
    instance semantics*。
  - **本丸は自コーパス**(§4.1):cutflow は承認済み編集で raw+完成ペアを無損失・アライン済みで
    毎回生成している。`approvals.json`=クリーンな教師信号、`learn.ts`=単一プロジェクト free-text の原型、
    チャンネル=親ディレクトリの足場も既存。reference-style の P3(最難関)は自コーパスではタダで最初。
  - **profile が測定の穴を同時に 3 つ塞ぐ**(§5):J→D 変換 / 再現可能な答え合わせ / 判断 few-shot 基質。
    ゆえに測定基盤の第 1 手は「エラー分類ログ」ではなく **SD-T0=承認済みコーパスからの profile 抽出**。
  - **agreement は一貫性の代理**(§6.2):絶対品質ではない。非常線+相対比較で使う。golden set curate・
    cold start は第三者 profile・brief が profile を上書き、を運用則に。
  - **reference-analyze は未実装**(コード確認済み)を明記し、従バイアスとして再位置づけ。
  - 旧 2 ファイル(`2026-07-11-aesthetic-judgment-program.md` /
    `2026-07-11-reference-style-analysis-design.md`)は削除。精度母艦 §6 の参照を本ファイルへ更新。
  - **次の一手 = SD-T0**(§10)。実装設計書はロードマップ確定後の別作業(本ターンでは書かない)。
- **2026-07-12(ロードマップ確定・実データ接地 + ユーザー 4 判断)**: 「ロードマップ確定に必要な判断を
  全て行う」方針で、実チャンネル `/Users/19mo/Movies/cutflow/` を実測(**収録 3 本・承認済み 1 本
  (`2026-07-02`)・自信作なし・channel rules.md/brief.md なし = cold-start**)。前提が 2 つ覆った:
  - **前提修正 1(§4.0)** — 「本丸=承認済み自コーパスの自動採掘」はこのユーザーには**今まだ空**。
    Q1 の希望「動画パスを指定してスタイルとして吸収させたい」を受け、**主入口を
    `style-profile --from <path>`(任意の動画/収録を吸収)に一本化**。自コーパス採掘は自信作が
    溜まってから重みが増す「育つ経路」へ格下げ。
  - **前提修正 2(§4.2)** — Q1(パス吸収したい)と Q4(第三者見本は park)の整合:**軽量な
    「任意パス→決定論 profile」は T0 に畳み込み**(あなたの入力手段)、**重い第三者エミュレーション
    (VLM styleNotes・raw+finished アライン)だけを park**。
  - **ユーザー 4 判断**: Q1=パス吸収を主入口へ / Q2=順序は「精度が出る形で任せる」→ cold-start により
    **T0→T1→T4 を活性・T2(agreement)は承認済み ≥2〜3 本まで保留**(§5.2・§10.0)/ Q3=学習信号は
    **両方(最終形+補正デルタ)**、補正デルタは test-level コーパスではむしろ強信号 / Q4=第三者重 track
    は park。
  - **その他の既定を §10.0 に全確定**(コマンド新設 `style-profile`・生成物 `style.probe/profile.json`・
    opt-in `plan.styleProfile`・抽出は決定論数値+optional VLM・T1 assert は warn/学習分散帯・
    T2 は leave-one-out/相対比較限定・注入は候補スコア→few-shot・brief が profile を上書き)。
  - **ロードマップは §10 で確定**。実装設計書はこの確定を土台にした次の別作業(本ターンでは書かない)。
- **2026-07-12(SD-T0 実装完了・PR #29)**: `style-profile --from <path> [--from ...] [--name]` を実装し main へマージ。
  Opus 設計 → Sonnet 実装 → コーディネータ実測 → 独立コードレビュー(サブエージェント)→ 指摘修正 → 再検証 の
  リレーで完走([[opus-sonnet-relay-workflow]])。確定した実装事実:
  - 生成物は channel 直下 `style.probe/<name>.json`(`GENERATED_DIRS` へ追加)。型は `src/lib/styleProfile.ts` の
    `StyleProfile`(生成物レポート型は module 内に置く既存慣行=`av.ts`/`bgmFit.ts` と同型。`schemas/` には
    置かない=`schema.test.ts` の全単射を壊さない)。config セクションは v1 では**不要**(閾値は module 定数)。
  - 抽出は決定論のみ(`describe --json` + `av.probe` + ffprobe)。schema v1 = cutDensity / captions / audio /
    structure + correctionDelta。各 section に provenance/confidence/sampleSize。cold-start N=1 は confidence
    0.25〜0.33 と低く出て「1本の癖を全体の型と誤認しない」を正直に可視化。
  - **コードレビューで捕捉した HIGH**: caption 位置判定で pos 無し・track 既定無しのテロップを欠測扱いにし、
    レンダラーの実デフォルト(本編は下部中央フォールバック。`remotion/Main.tsx:326-329`)を無視 → positionHint が
    実データで**逆転**(2026-07-02 で 83% が実際は下部なのに top と誤判定)。→ 観測ごとに histogram を持ち、
    pos 無しは bottom 既定へ修正(positionHint=bottom・{top:4,center:0,bottom:26} に是正)。編集ファイルは
    1バイトも書かない(不変条件2)を実測で確認。
  - **次の一手 = SD-T1**(profile→距離 assert。J→D 変換。§5.1 の再分類)。
- **2026-07-12(SD-T1 実装完了・PR #30)**: `style-check <dir> [--profile <name>]` を実装し main へマージ。
  SD-T0 の profile を基準に、収録の現在の編集(候補)の観測統計が profile の学習分散帯からどれだけ逸脱するかを
  **warn/info(常に exit 0)** で報告する決定論の距離 assert。同じ Opus 設計 → Sonnet 実装 → コーディネータ実測 →
  独立コードレビュー → 指摘修正のリレー。確定した実装事実:
  - **二層帯モデル**が cold-start の核。inner=学習帯(ペースは profile の shot 長 [p10,p90]、caption/audio は
    基準トレランス)、outer=各 section の **confidence で広げた帯**(`widen(conf)=1+(1-conf)*2.0`)。
    inner内→なし / inner外∧outer内→borderline(info) / outer外→deviation(warn) / カテゴリ不一致→
    高conf=warn・低conf=info(`CATEGORICAL_TRUST_CONF=0.35`)/ 欠測→skipped(info)。**confidence は帯幅に
    効かせる**(severity floor で潰さない)のが cold-start N=1(conf 0.25〜0.33)の正直な扱い。
  - スコープ = profile v1 が値を持つ **cut / caption / audio** に閉じる。演出密度・BGM 切替 cadence・structure は
    profile v2/v1.1 が該当 policy を格納してから T1 に合流する明示 defer(母艦 §10.0 の T1 scope 記述と reconcile)。
  - 候補は `observeOwnProject`+`mergeObservations`(SD-T0)で profile と同じ形に畳んでから `compareProfiles` で
    突き合わせ=統計・ラベル写像の再実装ゼロ([[stage-orchestrator-bug-classes]] の継ぎ目回避)。編集ファイルは
    1バイトも書かず `<dir>/style-check.json` のみ。
  - **退化帯の落とし穴(2件のコードレビュー HIGH で捕捉・修正)**: (1) relative モードで expected≈0
    (sceneChangesPerMin が profile で 0)だと帯が点になり偽 warn → `RELATIVE_ZERO_EPS` で skipped 化。
    (2) learned-percentile で p10===p90(単一shot/均一尺の cold-start profile)だと margin=0 で confidence が
    効かず点帯化 → **相対フロア** `max(spreadMargin, |expected|·tol·(w-1)·0.5)` で修正(正常ケース p10≠p90 は
    spreadMargin 支配で挙動不変)。cold-start の「退化した分散帯」は SD-T1 の一番の脆さ=帯を必ず幅を持たせて守る。
  - 実測: 自己一致(2026-07-02 vs 自 profile)= warn 0 / 逸脱検出(2026-07-10 の avgShot 114)= pace warn /
    av 欠落= audio skipped / profile 不在= exit 1。
  - **次の一手 = SD-T4**(profile→判断注入。候補スコア→few-shot・cut 経路先行・opt-in/sticky `plan.styleProfile`。
    効果は T1 の style-check で測る)。SD-T2(agreement)は承認済み ≥2〜3 本まで保留のまま。
