// woff2 等のフォントアセットを import できるようにする ambient 宣言。
// remotion(webpack: asset/resource)とエディタ(esbuild: dataurl loader)の
// どちらでも既定エクスポートは「読み込み可能な URL 文字列」になる。
declare module "*.woff2" {
  const src: string;
  export default src;
}
declare module "*.woff" {
  const src: string;
  export default src;
}
