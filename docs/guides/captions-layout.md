# テロップとレイアウトの見た目

> 字幕・帯・ベースレイアウト・カット境界演出など「見栄え」を整える。
> 関連: [cut-planning.md](cut-planning.md) / [effects.md](effects.md) / [tools-and-ops.md](tools-and-ops.md) / [../usage.md](../usage.md)

## テロップのデザインは3層(config → トラック標準 → クリップ)

テロップの見た目(`CaptionStyle`: `fontSizePx` / `color` / `outlineColor` /
`outlineWidthPx` / `fontFamily` / `fontWeight` / `background` / `anim` /
`karaoke`)は**項目単位**で下から積み上げて解決される:

| 層 | どこに書く | 効く範囲 |
|---|---|---|
| ① 全体の既定 | `config.yaml` の `render.caption*`(`captionFontSizePx` / `captionColor` / `captionOutlineColor` / `captionFontFamily` / `captionFontWeight` / `captionBackground`) | 全テロップ |
| ② トラック標準 | `overlays.json` の `captionTracks[].style` | そのトラックのテロップ全部 |
| ③ クリップ個別 | `transcript.json` の `segments[].style` | そのテロップ1件 |

**「テロップ」と「章」でデザインを変えたい**、は②で表現する。例えば章
(track 2)だけ帯なし・左寄せにしたいなら:

```json
// overlays.json
{
  "captionTracks": [
    { "track": 2, "name": "章", "anchor": "topLeft", "x": 80, "y": 80,
      "style": { "background": "none", "fontSizePx": 36, "fontWeight": 700 } }
  ]
}
```

GUI エディタでは**タイムラインのトラックラベル(「テロップ」「章」)を
クリック**するとインスペクタが②の編集に切り替わる(クリップを選ぶと③)。

### 帯(`background`)の `"none"` — 「未指定」と「帯なし」は違う

`background` だけは他の項目と違い、**省略(undefined)が「帯なし」を意味しない**。
省略は「指定なし=下の層から継承」なので、下の層(②や①)が帯を持っていると
継承されて帯が出る。ある層で**継承した帯を消す**には、キーを消すのではなく
明示的に `"none"` を書く:

```jsonc
// config.yaml で全テロップに帯を敷きつつ…
render:
  captionBackground: { color: "rgba(35,35,35,0.9)", paddingPx: 52, radiusPx: 20 }
```
```jsonc
// …章トラックだけ帯を消す(background を消すのではなく "none" を書く)
{ "track": 2, "style": { "background": "none" } }
```

これは `outlineColor: "none"`(縁取りを消す)と同じ流儀。どの層でも `"none"` で
その下を打ち消せる(③の `"none"` は②と①を、②の `"none"` は①を打ち消す)。
逆に、②が `"none"` でも③でオブジェクトを書けばそのテロップだけ帯が戻る。

> **よくある間違い**: 「帯を消したのに消えない」。`transcript.json` の
> `style.background` を**削除**しただけだと ①/② の帯が継承されて復活する。
> `"none"` を書くのが正解(GUI のインスペクタは「帯」のチェックを外すと
> 自動でこれを書く)。


## ベースレイアウトのデザイン(config.yaml `render.design`。既定オフ)

既定(`enabled: false` / キーを書かない)では、ベース映像は収録レイアウト本来の
見た目のまま(この機能の導入前と同じ)。`enabled: true` にすると、

  背景画像 → 角丸+影の画面パネル → 右下の角丸正方形カメラワイプ → テロップ

の重ね順で合成する。テロップ・素材・注釈はすべてこのデザインの**上**に出る。

デザインが載るのは**OBS拡張キャンバス収録(`obs-canvas`)だけ**。通常動画
(`plain`)は「素材をそのまま見せる収録」(OBSを通していないスマホのショート
動画・画面録画など)なので、`enabled: true` のままでも背景・パネルは一切
かぶらず、素の映像として出る。これにより「OBS収録=デザイン付き / 素の動画=
素のまま」が、収録ごとの設定なしに自動で切り分かる。ショート(縦プリセット)
にもdesignを継承しない。

```yaml
render:
  design:
    enabled: true
    # 省略時は backgroundColor の単色。3通りの書き方を解決する:
    #   assets/backgrounds/teal.jpg … リポジトリ同梱(誰の環境でも動く)
    #   ~/Movies/obs/bg.jpg         … 自分の素材(絶対パス。~ は展開される)
    #   materials/bg.jpg            … その収録フォルダ内のファイル
    backgroundFile: assets/backgrounds/teal.jpg
    backgroundColor: "#1b1b1f"   # 背景画像の下地・画像が無いときの背景
    screen:                       # 画面(screenRegion)パネル
      marginXPx: 100              # 左右の余白(出力px)
      marginBottomPx: 90          # 下の余白。高さは 16:9 維持の成り行き(上余白 22px)
      radiusPx: 24
      shadow: true
    camera:                       # OBSのカメラ(ワイプ)
      sizePx: 375                 # 一辺(出力px)
      marginPx: 28                # 右・下からの余白
      radiusPx: 96                # sizePx/2 でクランプ(そこが最大の丸み = 円)
      shadow: true                # 画面パネルの shadow とは独立
```

背景が収録フォルダの外(同梱 `assets/` / 絶対パス)にあるときは、合成前に収録
フォルダの `render.design/` へ自動コピーされてから参照される(Remotion が読めるのは
publicDir = 収録フォルダの中だけのため)。収録ごとの手コピーは要らない。中間生成物
なので `clean` で消えるが、次の実行で自動的に復帰する。背景が見つからないときは
警告だけ出して `backgroundColor` の単色へ劣化し、レンダーは止まらない。

**注意点**:

- **render高速パス(`render.fastPath`)はplainにも対応する。** plainはdesignが
  載らないので恒等基底、obs-canvasのdesign有りは背景+画面パネル基底としてFAST
  区間を合成する。必要な静的資産が無い/生成できない、または既存の適格条件を
  満たさない場合は、壊れた高速出力を作らず通常のRemotionレンダーへ保守的に退避する
- OBS拡張キャンバスでは`overlays.json`の`wipeFull`(ワイプ全画面)はデザイン
  有効時も効く。区間に
  入るとカメラが右下の角丸正方形から**出力の全画面**へ広がり(背景画像・画面
  パネルは覆い隠される)、角丸も 0 へ補間されるのでデザイン無しの `wipeFull` と
  同じ絵になる。出入りの遷移時間は同じ `render.wipeTransitionSec`
- plainではカメラ映像が無いため`wipeFull`自体が`validate`エラーになる
- テロップの `pos`・`blurs.rect`・`annotations` の座標系は**変わらない**(従来どおり
  出力px)。デザイン有効時はベース映像がパネルに縮んで置かれるため、`zooms` /
  `blurs` / `frames --ocr` の box は内部でパネル座標へ写して辻褄を合わせている
  (§`src/lib/design.ts`)
- GUI エディタに専用 UI は無い(`cutTransition` と同じく config.yaml のみの設定。
  プレビューは render props を最終レンダーと共有しているので自動で反映される)


## カット境界のディップ・トゥ・ブラック(config.yaml `render.cutTransition`)

既定(`type: none`)ではカット境界(keep区間の継ぎ目)は瞬時に切り替わる。
`type: dip-to-black` にすると、境界の前後で黒フェードが入る(ジャンプカットの
繋ぎ目を和らげる演出)。`sec` は黒への往復の合計秒(前半でフェードアウト、
後半でフェードイン)。カット段(cut.mp4)自体には触れない Remotion 合成層の
オーバーレイなので、動画の総尺・音声・テロップのタイミングは変わらない。

```yaml
render:
  cutTransition:
    type: dip-to-black
    sec: 0.3
```

境界ごとの個別指定はできない(全境界に一律で効く)。`hardwareAcceleration` /
`chunkSec` と同じく config.yaml のみの設定で、GUI エディタの設定画面には
専用の UI はない(エディタのプレビューは render.props.json を最終レンダーと
共有しているため、config.yaml を変えれば自動でプレビューにも反映される)。

ズーム演出(`overlays.json` の `zooms`)の遷移秒数の既定値も同じ扱いで、
config.yaml の `render.zoom.easeSec`(既定 0.4)のみで変更する
(`zooms[].easeSec` で個別指定があればそちらが優先)。ズーム中にカメラワイプを
縮める倍率も同様に config.yaml の `render.zoom.wipeScale`(既定 0.8。
`zooms[]` ごとの上書きは無い)のみで変更する。


## 見た目の調整(Remotion Studio)

ワイプの大きさ・余白・字幕サイズ・テロップ既定の色/縁/フォントは
GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)から変更できる
(実体は config.yaml の `render` セクションなので YAML 手編集でもよい)。
黒帯などデザインそのものを変えたいときは `remotion/Main.tsx` を編集する。

設定画面で保存した変更のうちラウドネス(`targetLufs`)・システム音声・
ノイズ除去(`denoise`)・プレビュー幅は proxy.mp4 に焼き込まれるため、
エディタのプレビューへ反映するにはプロキシの再生成が必要(保存後に
バナーで案内が出る。書き出しには再生成なしで反映される)。


```sh
# レイアウトだけ確認(動画部分はプレースホルダー表示)
npx remotion studio

# 実際の収録データを流し込んで確認(render を1回実行した後に使える)
npx remotion studio --props <収録フォルダ>/render.props.json --public-dir <収録フォルダ>
```

Studio はブラウザで開く動画エディタ風の画面で、Main.tsx を保存すると
即座に反映される。デザインが決まったら通常の `render` を実行する。

