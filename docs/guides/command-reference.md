# コマンド早見表

> 各コマンドを「いつ使うか」で引く一覧。個々の詳細は各ガイドを参照。
> 関連: [../usage.md](../usage.md) / [cut-planning.md](cut-planning.md) / [materials.md](materials.md) / [effects.md](effects.md) / [audio-bgm.md](audio-bgm.md) / [export.md](export.md) / [safe-editing.md](safe-editing.md) / [tools-and-ops.md](tools-and-ops.md)

## 個別コマンドの使い分け

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | 自動下書きを一括生成したい上級/バッチ用。2回目以降は `--force` が必要(実行前に backups/ へ退避) |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる。transcribe の再実行はテロップの手編集ごと上書きする(既存の transcript.json は backups/ へ退避される)。`whisper.wordTimestamps`(既定 true)が有効だと transcribe が各テロップに `words[]`(語単位タイミング。テロップの `style.karaoke` が消費する)を付ける。既存収録は再 transcribe が要る(明示的に `false` を書けば付けない従来挙動に戻せる)。`whisper.captionSplit`(省略時オフ=whisper のチャンク幅そのまま)を書くと、transcribe が長い 1 発話を「約 `maxChars` 文字」の読みやすい 1 テロップへ割り直す(日本語の文節末=助詞・句末表現+無音ギャップ+文字数上限で折る決定論処理。LLM も再文字起こしも使わない。`words[]` があれば分割後の時刻は語境界そのもの・カラオケ補助も各断片へ引き継ぐ)。`maxChars` 以下のテロップは一切改変しない |
| `editor <dir> --layout <plain\|obs-canvas\|auto>` / `ingest <dir> --layout …` / `run <dir> --layout …` | 収録レイアウトを明示するとき。既定は `plain`=通常動画(1画面・カメラ無し。出力解像度=収録の実寸)。OBS 拡張キャンバスでワイプを使う場合は `--layout obs-canvas`。`auto` はキャンバス寸法が `screenRegion + cameraRegion` と完全一致、または十分な超横長なら obs-canvas、それ以外は plain |
| `ingest <dir> --mic-track <n>` / `--system-track <n>`、`run <dir> --mic-track <n>` / `--system-track <n>` | OBS の音声トラック割当が `config.yaml` の `ingest.micTrack`/`systemTrack`(既定 1/2)と違うとき、一時的に上書きする(1始まりの番号)。`ingest` はまず設定値を尊重するが、範囲外なら音声トラックが1本ならそれを mic とみなし、複数本あってトラックのメタデータ(タイトル)から mic が一意に決まれば推定し、それでも判別できなければ**見つかった全トラックの一覧(コーデック/チャンネル数/タイトル)を提示して停止**する(黙って別トラックを mic として抽出することはない)。提示された番号を `--mic-track` に指定するか、`config.yaml` の `ingest.micTrack` を恒久的に直す |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(上記。2回目以降は `--force` が必要) |
| `plan <dir> --cuts-only` | カット判断だけをやり直したいとき(章立て・タイトル案・概要欄は変えたくない)。cutplan.json / plan.raw.txt だけを書く(chapters / meta / transcript の章テロップ / overlays の章トラックには触らない) |
| `remeta <dir>` | **カットは手編集済みだが、章立て・タイトル案・概要欄だけ作り直したい**とき。現在の cutplan の keep 区間(=完成動画)を見て chapters / meta と「章」トラックのテロップだけを再生成する。cutplan は触らないのでカットの手編集は保たれる(実行前に transcript / chapters / meta を backups/ へ退避) |
| `plan-shorts <dir>` | **長尺1本からショートの下書きを作りたい**とき。detect の候補区間を LLM に番号で選ばせ、`shorts.json`(各ショート `profile`(camera 有り→`vertical`、plain→`vertical-screen`)/ `approved: false` / 時間順の `ranges`。尺は `config.yaml` の `planShorts.maxDurationSec`(既定60秒)以下)を生成する。時刻は LLM に生成させず番号選択のみ。承認は人間(preview / エディタのショートモードで確認して `approve <dir> --short <name>`)。既存 `shorts.json` があるときは `--force` 必須で、実行前に shorts.json ごと backups/ へ退避する |
| `plan-materials <dir>` | **手持ちの素材(B-roll)をどこに置くか下書きしたい**とき。要 `materials <dir> --all` の事前実行。cutplan の keep span(アンカー)× 実在素材に番号を振り、LLM に (アンカー番号, 素材番号) のペアだけを選ばせて `overlays.json` の `overlays[]` を下書きする。時刻・ファイルパスは LLM に生成させず番号選択のみ。cut / 承認には一切触れない。承認不要(overlays は承認スコープ外)だが下書きなので preview / エディタで見て要らなければ削る。既存 `overlays.json` があるときは `--force` 必須で、実行前に backups/ へ退避する。詳細は下記「素材配置候補の自動生成(plan-materials)」参照 |
| `plan-effects <dir>` | **画面の一部を拡大/隠す/囲みたい下書きが欲しい**とき。要 `frames <dir> --ocr` と `av <dir>` のいずれか(両方推奨)の事前実行。画面OCR・動き検出・発話から演出アンカーに番号を振り、LLM に (アンカー番号, 種別) のペアだけを選ばせて `overlays.json` の `zooms`/`blurs`/`annotations` を下書きする。座標・時刻・色は LLM に生成させず番号+種別選択のみ(座標は知覚が決めた実在矩形から)。cut / 承認には一切触れない。承認不要だが下書きなので preview / frames で見て要らなければ削る。既存の zooms/blurs/annotations があるときは `--force` 必須で、実行前に backups/ へ退避する。`--observe` を付けると前回の `effect-check.json` の警告を参考情報としてプロンプトへ渡す(E7・opt-in・省略時はバイト等価)。詳細は下記「演出候補の自動生成(plan-effects)」「検品を閉じる(E6/E7)」参照 |
| `plan-bgm <dir>` | **手持ちの曲をどこに敷くか下書きしたい**とき。区間境界(切替アンカー)は章境界(`chapters.json`)+ 大カット境界から決定論で列挙し、曲は `materials/` の音声ファイル ∪ 収録直下 `bgm.*` の実在集合から番号選択する。LLM に渡すのはスロット一覧と曲一覧の2リストだけで、応答は (slotId, file: 曲番号 or null) のペアのみ。時刻・ファイルパス・音量は LLM に生成させない。cut / 承認には一切触れない。承認不要(bgm は承認スコープ外)だが下書きなので preview / エディタで聴いて要らなければ削る。既存 `bgm.json` があるときは `--force` 必須で、実行前に backups/ へ退避する。詳細は下記「BGM 配置候補の自動生成(plan-bgm)」参照 |
| `learn <dir>` | **直前の LLM 生成を人間がどう仕上げたかから、次回用のチャンネルルール追記案を作りたい**とき。`plan.raw.txt`(AI の最初の案)と `describe(dir)` + `meta.json`(人間の仕上げ)を LLM に見せ、`rules.suggested.md` に追記案の下書きを書く。**channel の `rules.md` には一切書き込まない**(採用は人間が内容を確認して手で `rules.md` に転記)。`plan.raw.txt` が無ければ先に `plan` か `run` を実行するよう促してエラー終了。詳細は下記「チャンネル rules と learn」参照 |
| `validate <dir>` | JSON を手編集した後は毎回。整合性エラー(exit 1)と警告を出す。概要欄チャプター(chapters.json)と画面表示の章タイトル(「章」トラックのテロップ)が食い違うと警告するので、片方だけ直した取りこぼしに気づける。GUI の保存も同じ検査を通す(壊れた JSON は保存できない)。`frames/index.json` が現在の JSON より古ければ「frames を撮り直せ」も警告する(下記) |
| `preview <dir>` | cutplan.json を編集するたび。承認前でも動く |
| `approve <dir>` / `approve <dir> --short <name>` | preview(または縦動画)を確認して承認したいとき。`approvals.json` に keep 集合のハッシュを記録し、`cutplan.approved`(または該当ショートの `approved`)を true に同期する。対話操作(preview 確認の y/N を挟む)で、非対話環境からは `--yes` が無いと拒否される。詳細は下記「承認(approve/unapprove)」参照 |
| `unapprove <dir>` / `unapprove <dir> --short <name>` | 承認を取り消したいとき。`approvals.json` のレコードを消し、boolean を false に戻す(安全側の操作なので確認プロンプトは無い) |
| `render <dir>` | `approve` 済み(= `approvals.json` に現内容のハッシュと一致するレコードがある状態)のときだけ実行できる。cutplan.json の `approved: true` を書くだけでは通らない(下記「承認(approve/unapprove)」参照)。transcript.json 修正後の再実行も速い(再文字起こし不要) |
| `render <dir> --short <name>` / `--shorts` | `shorts.json` のショートを書き出すとき(下記「ショート動画」参照)。承認はショート単位(本編の承認とは別のレコード) |
| `clean <dir>` | **収録フォルダのディスクを空けたい**とき。中間生成物/キャッシュを安全削除(分類は `src/lib/files.ts` の `GENERATED_FILES`/`fileRole` 由来。編集ファイル・`approvals.json`・`materials/`・元収録・成果物(`final.mp4`/`thumbnail.png`)には触れない)。`--dry-run`(消さず一覧)/ `--cache-only`(proxy/cut/render.chunks/frames/shorts/*.probe 等の重いキャッシュだけ消し、`manifest.json`/`whisper-out.*` 等は残す)/ `--json` |
| `describe <dir>` | AI/人間が JSON 群を全部読まずに編集状態(keep/カットの並び・各区間の発言・カット理由・演出・章・ショート)を把握したいとき。人間可読の散文で出す(発言は36字で切り捨て、タイトル案は先頭3件のみ)。元秒⇔出力秒を併記する。末尾に frames の現況(何の絵が `frames/` に入っているか)か、古ければ撮り直し勧告を添える(下記) |
| `describe <dir> --json` | **散文では切り捨てられる情報まで含めて機械的に処理したい**とき。発言・タイトルを一切切り捨てない機械可読な完全射影を stdout に純 JSON で出す(`schemaVersion` / `source` / `summary` / `keeps` / `cuts`(消える発言も全文) / `captions`(全文・`pos`/`style`/`words`・元秒⇔出力秒) / `overlays`(素材・挿入・ワイプ・ズーム・ぼかし・色調整の全フィールド) / `chapters` / `meta`(タイトル全件・概要欄全文) / `bgm` / `shorts`)。パイプ/`JSON.parse` 可能(所要時間の診断行は stderr に出る)。`--json` を付けない限り `describe` の散文出力は完全に不変。**id-stamp 済みのプロジェクトでは各要素に `id` が載る(散文には出ない。@-mention の発見手段はここ)**(下記「安定 id / @-mention」参照) |
| `id-stamp <dir>` | **既存プロジェクトの各要素に `@id` を一括採番したい**とき(冪等。既存 id は保持し、無い要素にだけ振る)。詳細は下記「安定 id / @-mention」参照 |
| `apply <dir> --patch <file>` | **`@id` 指定の編集を検査付きで当てたい**とき(生 JSON を丸ごと書き換えず、配列添字も書かない)。全部 valid なら全書き込み、1つでもエラーなら1バイトも書かない。`--dry-run` で書かずに変更要約だけ見られる。詳細は下記「検査付きアトミック適用(apply)」参照 |
| `frames <dir> --t ... \| --captions \| --every N` | AI がその時刻の絵を確認したいとき(テロップ位置・ワイプ被り・素材の見え方)。`frames/*.png` に出力(実行のたびに古い PNG は全消し) |
| `frames <dir> ... --ocr` | 画面内のコード・ターミナル・エラー文をテキストとして読みたいとき。元収録のフル解像度の画面領域を Apple Vision で OCR し `frames/out<秒>s.ocr.json`(`text` / `lines[].{text,confidence,box}`)に書く。macOS 専用・オフライン。非対応環境では警告のうえ PNG 出力のみ続行し、`--ocr` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames <dir> ... --full-res` | 画面キャプチャ内の文字を絵として鮮明に見たいとき。ベース映像をプロキシ(幅は config.yaml の preview.width)ではなく元収録のフル解像度にした**合成込み**(テロップ/ワイプ/素材/ズーム/ぼかし込み)still を出す。`--ocr` はテキスト抽出、こちらは見た目そのものの鮮明化(レイアウト込みで確認したいとき)。`--ocr` と併用可。`--full-res` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames-serve <dir>` | **JSON 微調整ループ(編集 → `frames --t …` → 確認 → 編集 → …)を何度も回すとき**。bundle(webpack)+headless Chrome を暖めたまま待ち受ける opt-in の常駐デーモン(下記「frames-serve(常駐フレームサーバ)」参照)。起動していなければ `frames` は現状どおりの単発実行(挙動・出力は不変) |
| `materials <dir>` | **素材(B-roll)の中身を知りたい**とき(尺・解像度・fps・音声有無・`overlays.json`/`bgm.json` との参照クロスリンク・未使用/dangling 検出)。既定は ffprobe だけ。`--frames`/`--ocr`/`--transcribe`/`--all` で見た目・画面文字・音声発話まで opt-in で取得(下記「素材(B-roll)の中身を知る(materials)」参照) |
| `material-fit <dir>` | **既存の素材参照(overlay/insert)の尺不整合や dangling/unused を直したい**とき。要 `materials <dir>` の事前実行と overlays の `@id`。修正案は収録フォルダへ直接書かず `apply` パッチ下書き(`material-fit.suggested.json`)として出す(下記「素材参照の不整合検出と修正パッチ(material-fit)」参照) |
| `av <dir>` | **keep 後タイムラインの動きと音を知りたい**とき。`av.probe/motion.json` / `sound.json` / `motion.strip.png` に、motion(scene score・freeze・フィルムストリップ)と sound(LUFS 包絡・無音・mic/system 被り・BGM/duck 設定)を出す。`--range` / `--every` / `--short` / `--full-res` / `--motion-only` / `--sound-only` を持つ |
| `bgm-fit <dir>` | **既存の `bgm.json` の音量/duck/フェードが実測と合っているか直したい**とき。要 `av <dir>` の事前実行と bgm トラックの `@id`。修正案は収録フォルダへ直接書かず `apply` パッチ下書き(`bgm-fit.suggested.json`)として出す。章が複数あるのに BGM が単調/fallback のままなら `plan-bgm` へ誘導する(下記「BGM の音量/被り/単調の検出と調整提案(bgm-fit)」参照) |
| `style-profile --from <path>` | **任意の動画/収録からテンポ・字幕密度/位置・ラウドネス・構成の統計(スタイルプロファイル)を抽出したい**とき。`<dir>` ではなく `--from`(複数可)で入力を集める。収録プロジェクトなら観測統計+補正デルタ(own-project)、素の動画/フォルダなら観測統計のみ(bare-video)。決定論のみ・編集ファイルは書かず、channel 直下の `style.probe/<name>.json` に書く(下記「スタイルプロファイル抽出(style-profile)」参照) |
| `mcp <dir>` | **任意の MCP 対応エージェントにこの収録フォルダを機械的に開かせたい**とき。stdio 上で `describe`/`validate`/`frames`/`materials`/`assert`/`apply`/`id-stamp` 相当の tool を露出する常駐サーバ(上記「MCP サーバ(mcp)」参照)。承認/render/plan 等は露出しない |

`frames` は撮影のたびに、その絵を決める編集 JSON(本編経路は cutplan/
transcript/overlays、`--short` 経路は shorts/transcript/overlays)の内容
フィンガープリントを `frames/index.json` に記録する(stale-PNG 対策。
frames は毎回全消し+撮り直すので安全だが、frames を**呼ばずに**古い PNG を
Read すると編集前の絵を見てしまう罠がある)。これを踏まえ、`validate`(必ず
編集後に叩く)と `describe`(最初に見る)が現在の JSON と突き合わせ、
食い違えば「frames を撮り直せ」と警告する。`frames/index.json` が無い
(未撮影・機能導入前)フォルダでは警告しない。**`config.yaml` の変更
(caption サイズ等)はこの検出の対象外**(JSON 手編集の撮り直し漏れが対象
のため。config を変えたときは自分で撮り直す)。


