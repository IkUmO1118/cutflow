# assets/

`config.yaml` から参照できる同梱素材。収録フォルダ(`~/Movies/cutflow/<収録>/`)
とは別で、**リポジトリに同梱してどの環境でも動く**ものだけを置く。

## backgrounds/

ベースレイアウトのデザイン(`render.design`)の背景画像。`config.yaml` に
リポジトリ直下からの相対パスで書く:

```yaml
render:
  design:
    enabled: true
    backgroundFile: assets/backgrounds/dusk.jpg
```

合成時に収録フォルダの `render.design/` へ自動コピーされる(Remotion が読めるのは
publicDir = 収録フォルダの中だけのため。§`src/lib/designAsset.ts`)。自分の素材を
使うなら、ここに足すか、`~/Movies/obs/xxx.jpg` のような絶対パスを書けばよい。

背景は出力解像度(1920x1080)に合わせて縮小・圧縮しておく。元が数MBの写真でも、
グラデーション主体なら数十KBまで落ちる:

```sh
ffmpeg -i 元画像.jpg \
  -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" \
  -q:v 4 assets/backgrounds/名前.jpg
```

同梱の背景は全て 1920x1080 / JPEG に揃えてある(32〜40KB)。

| ファイル | 色味 |
|---|---|
| `dusk.jpg` | ピンク〜ブルーの夕景グラデーション |
| `amber.jpg` | アンバー |
| `green.jpg` | グリーン |
| `lavender.jpg` | ラベンダー |
| `teal.jpg` | ティール |

### 出典

| ファイル | 出典 | ライセンス |
|---|---|---|
| `dusk.jpg` | [Aperture Vintage](https://unsplash.com/photos/NrAvSjyW3D4) (Unsplash) | [Unsplash License](https://unsplash.com/license)(商用利用可・帰属表示は任意) |
| `amber.jpg` / `green.jpg` / `lavender.jpg` / `teal.jpg` | (要記入) | (要記入) |

> 公開リポジトリなら、素材の出所とライセンスをここに残しておくこと。
