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
const handle = delayRender("Loading Noto Sans JP");

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
