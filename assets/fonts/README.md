# Bundled Fonts

`NotoSansJP.woff2` is the bundled Noto Sans JP variable font (`wght` 100-900)
under the SIL Open Font License. See `OFL.txt` for the license text.

CutFlow keeps this font in the repository because `CAPTION_DEFAULT_FONT_FAMILY`
starts with `"Noto Sans JP"`. The variable font can render intermediate
caption weights with real glyph data; system fonts such as Hiragino may round
numeric weights.

The export engine currently copies this font into its temporary browser page in
`src/lib/engineSession.ts` (`buildExportHtml`) and registers it with
`@font-face`. Keep this asset available for render parity and for future font
loading changes.
