import { Config } from "@remotion/cli/config";

// テロップ既定フォント(remotion/fonts/NotoSansJP.woff2)をバンドルへ data URL
// で焼き込む(asset/inline)。Remotion 既定の asset/resource だと woff2 は
// bundle サーバから HTTP 配信されるが、render 中は OffthreadVideo のフレーム
// 抽出(/proxy)・BGM・素材のフェッチが同一ホストへの Chrome の同時接続枠
// (HTTP/1.1 で6本)を占有し続けるため、立ち上がりが遅れたレンダータブの
// フォント取得が接続待ちのまま永久に進まず、delayRender タイムアウトで
// render 全体が落ちることがある(実測は docs/perf.md フェーズ9。
// 「Loading Noto Sans JP ... not cleared」で 5 タブ中 1 タブだけ死ぬ症状)。
// inline ならフォントのフェッチ自体が発生しない。描画は不変(同じフォント
// バイトを FontFace に渡すだけ)。エディタ(esbuild)は元から dataurl loader
// なので、これで2バンドラの扱いが揃う。
// このファイルは remotion CLI(render / チャンク再レンダー等)だけが読む。
// programmatic な bundle()(frames の静止画経路)は読まないが、そちらは
// 1ページだけの読み込みで接続枠の競合が起きないため asset/resource のままで害はない。
Config.overrideWebpackConfig((config) => {
  return {
    ...config,
    module: {
      ...config.module,
      rules: (config.module?.rules ?? []).map((rule) => {
        if (
          rule &&
          typeof rule === "object" &&
          "test" in rule &&
          rule.test instanceof RegExp &&
          rule.test.test(".woff2")
        ) {
          return { ...rule, type: "asset/inline" };
        }
        return rule;
      }),
    },
  };
});
