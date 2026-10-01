# Font parser fixture

`NotoSans-Regular.base64.txt` contains a base64-encoded Noto Sans WOFF fixture
copied from Pictbook's bundled font fixtures. The font is distributed under
SIL Open Font License 1.1; the accompanying license is in `OFL.txt`.

Tests decode the real font to verify metadata parsing, embedding permissions,
and character coverage without downloading fonts or calling an AI provider.
