import { continueRender, delayRender } from "remotion";
import notoSansJp from "./fonts/NotoSansJP.woff2";

// テロップ既定フォント Noto Sans JP を可変フォント(wght 100〜900)として
// バンドルに焼き込んで登録する。収録フォルダ(publicDir)には置かず、
// バンドラのアセット取り込みで URL 化する(remotion=webpack asset/resource /
// エディタ=esbuild dataurl loader)。これにより frames/preview/thumbnail/
// render と GUI の @remotion/player すべてで中間ウェイトが実際に描き分けられる。
//
// FontFace の第3引数 weight を範囲指定にするのが可変フォントの肝で、これが
// あって初めて 300/500/600/800 等の指定が font-synthesis ではなく実グリフの
// 太さとして反映される。delayRender で読み込み完了までフレーム捕捉を待たせ、
// フォールバック(Hiragino 等)で焼き込まれるのを防ぐ。
// timeoutInMilliseconds/retries: chrome-headless-shell はまれに1タブだけ
// FontFace.load() が永久に解決しないことがある(data URL 焼き込みでも発生=
// フェッチではなくフォントサブシステムのフレーク。docs/perf.md フェーズ9)。
// 正常時は数十ms で終わる処理なので、20秒で見切ってページ再読込でやり直す。
// フォント読込が完了するまでフレームは1枚も撮られないため出力は不変
const handle = delayRender("Loading Noto Sans JP", {
  timeoutInMilliseconds: 20_000,
  retries: 2,
});

const face = new FontFace(
  "Noto Sans JP",
  `url(${notoSansJp}) format("woff2")`,
  { weight: "100 900", display: "block" },
);

face
  .load()
  .then((loaded) => {
    document.fonts.add(loaded);
    continueRender(handle);
  })
  .catch(() => {
    // 読み込みに失敗しても描画は継続(フォールバックのゴシックで出す)。
    // render を止めるより「太さは効かないが絵は出る」方が実害が小さい。
    continueRender(handle);
  });
