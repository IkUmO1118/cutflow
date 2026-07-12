# templates/ — 撮影前に埋めるテンプレート(このリポジトリに置く理由)

ここに置く2つは、どちらも**このツールのコード/運用と直接つながる**ため
`~/dev/content/`(コンテンツ置き場)ではなくリポジトリ側に置いている。

- `episode-brief.md` — 埋めて収録フォルダへ `brief.md` としてコピーすると、
  `plan`/`plan-materials`/`plan-effects`/`plan-bgm` の入力になる(`rules.md`
  より優先)。**コードが直接読むファイルの雛形**
- `shooting-checklist.md` — `docs/recording-guide.md`(拡張キャンバス収録・
  `screenRegion` 設定など、このツール固有の収録前提)に紐づく技術チェック
  リスト

一方、**実際に読み上げる台本(セリフ+画面指定+タイムスタンプ)はコード/
パイプラインを一切参照しない純粋なコンテンツ**なので `~/dev/content/scripts/`
に置く(`content/README.md` の判断基準「主役は文章・画像・動画などの
コンテンツ」に合致)。episode-brief で内容を固めてから台本を書く、という
順序を想定している。詳細は `~/dev/content/scripts/README.md` を参照。
