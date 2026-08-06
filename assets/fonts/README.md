# Bundled Fonts

`NotoSansJP.woff2` (Noto Sans JP, `wght` 100-900) and `NotoSerifJP.woff2`
(Noto Serif JP, `wght` 200-900) are bundled variable fonts under the SIL Open
Font License. See `OFL.txt` for the license text. Both were converted to WOFF2,
without subsetting, from the upstream variable TTFs in `google/fonts`
(`ofl/notosansjp/NotoSansJP[wght].ttf`, `ofl/notoserifjp/NotoSerifJP[wght].ttf`).

FrameWright keeps these fonts in the repository because `CAPTION_DEFAULT_FONT_FAMILY`
starts with `"Noto Sans JP"` and `CAPTION_MINCHO_FONT_FAMILY` starts with
`"Noto Serif JP"`. The variable fonts can render intermediate caption weights
with real glyph data; system fonts such as Hiragino may round numeric weights.
Hiragino Mincho ProN is the worst case: it ships only W3 (400) and W6 (600), so
every `fontWeight` from 600 to 900 collapses onto the same face.

Both fonts are registered in two places, and both must stay in sync:

- `src/lib/engineSession.ts` (`BUNDLED_FONTS` / `buildExportHtml`) copies them
  into the temporary browser page used by `render` / `frames` / `thumbnail` and
  registers them with `@font-face`.
- `editor/server.ts` serves them at `/fonts/<file>` for the GUI editor, whose
  `@font-face` rules live in `editor/client/styles.css`. Without this the editor
  preview falls back to system fonts and disagrees with the rendered output.

Keep these assets available for render parity and for future font loading changes.
