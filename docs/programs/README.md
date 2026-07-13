# programs/ — 生きているロードマップ/継続中プログラム

単発の機能設計書(`docs/plans/`)とは違い、ここに置くのは**継続的に
ブラッシュアップされる生きたドキュメント**。ロードマップ・バックログ・
意思決定ログを自身の中に持ち、施策が進むたびに追記・更新する。

- `edit-precision-program.md`(精度母艦) — カット/素材/BGMの編集精度を
  上げる取り組み
- `aesthetic-judgment-and-style-learning.md`(審美眼プログラム) —
  スタイルを学び、判断品質を測って上げる取り組み。精度母艦から引き継いだ
  現行の母艦
- `adoption-and-onboarding.md`(導入母艦) — クローンから稼働・定着までの
  activation 摩擦を潰す取り組み。上2つが上げた「編集の質」に、そもそも
  ユーザーが到達できるようにする層(質・審美と直交)
- `render-fastpath-program.md`(render 高速パス母艦) — cold render の速度の床
  (headless Chrome の per-frame 描画)を、テロップ静止区間の ffmpeg 直合成で
  破る取り組み。編集の質(上3つ)と直交する「書き出しの速さ」の層

個別の設計書(`docs/plans/`)からは「親ドキュメント: `docs/programs/....md`
(母艦)」の形で参照される。
