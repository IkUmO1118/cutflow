# X1 embedded-font fixture

`NotoSansJP-X1-subset.woff2` is a test-only subset of
[`remotion/fonts/NotoSansJP.woff2`](../../../remotion/fonts/NotoSansJP.woff2).
The source font is distributed under the SIL Open Font License; see
[`remotion/fonts/OFL.txt`](../../../remotion/fonts/OFL.txt).

- Source SHA-256: `172e79e428c0e412ae4b51996f5d469fb41ad5e801f5c6dbfd5c944d462a63e1`
- Subset SHA-256: `f2042791ff65d872d4b085994df10823e47f8c3930f301be77f8c92f31ae0c4c`
- Subset size: 13,200 bytes
- Glyph text: `CutFlow WOFF2 埋め込みフォント 0123456789`

The file was produced with an external, temporary fonttools installation. CutFlow
does not depend on or bundle fonttools:

```sh
PYTHONPATH=/private/tmp/cutflow-x1-fonttools \
/private/tmp/cutflow-x1-fonttools/bin/pyftsubset \
  remotion/fonts/NotoSansJP.woff2 \
  --output-file=test/fixtures/hyperframe-fonts/NotoSansJP-X1-subset.woff2 \
  --flavor=woff2 \
  '--text=CutFlow WOFF2 埋め込みフォント 0123456789' \
  '--layout-features=*' \
  --no-hinting
```

`embedded-woff2.html` embeds those exact bytes as a `data:font/woff2` URL and
is the real-render fixture for the X1 gate. The worked example under
`docs/hyperframes-skills/examples/cutflow--embedded-woff2-font.html` intentionally
contains the same bytes so it remains self-contained.
