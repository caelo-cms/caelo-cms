# Font parser fixtures

`NotoSans-Regular.base64.txt` contains a base64-encoded Noto Sans WOFF fixture
copied from Pictbook's bundled font fixtures. The font is distributed under
SIL Open Font License 1.1; the accompanying license is in `OFL.txt`.

`InterVariable-mini.woff2.base64.txt` is a base64-encoded WOFF2 cut from the
variable `Inter[opsz,wght].ttf` in github.com/google/fonts (`ofl/inter`), keeping
the characters `Aao1 ąДдΩωạ→` and both variation axes (opsz 14-32, wght
100-900). It exercises web-delivery slicing across the latin, latin-ext,
cyrillic, greek, vietnamese and `other` slices while staying ~11 KB. Inter is
distributed under SIL Open Font License 1.1; the license is in `Inter-OFL.txt`.

Tests decode the real fonts to verify metadata parsing, embedding permissions,
character coverage and WOFF2 delivery derivation without downloading fonts or
calling an AI provider.
