# SPDX-License-Identifier: MPL-2.0
#
# Writes the reference token ids tokenize.test.ts compares the JavaScript
# tokenizer against (#1650): the Rust implementation, through its Python
# bindings, on the catalog model's tokenizer.json.
#
#   python3 -m venv /tmp/tok && /tmp/tok/bin/pip install tokenizers==0.23.3
#   /tmp/tok/bin/python reference-tokens.py $CAELO_MODELS_DIR/<id>/<revision>/tokenizer.json \
#     > <id>.tokens.json
import json, sys
from tokenizers import Tokenizer
import tokenizers
texts = [
  "Größentabelle für Wanderschuhe – eine halbe Nummer größer wählen.",
  "Straße, Maß, Fuß: ß bleibt ß.",
  "Preise ab 49 € pro Monat (zzgl. MwSt.)",
  "https://www.example.com/preise/?utm_source=x#pakete",
  "Café Müller öffnet um 8:30 Uhr — Ä Ö Ü ä ö ü",
  "Was kostet das?",
  "  mehrere   Leerzeichen\nund\tTabs  ",
  "Emoji 🙂 and CJK 東京 mixed",
  "E-Mail: info@stadt-lindenau.de, Tel. +49 30 1234-0",
  "Don't stop: it's 20.000 mm Wassersäule!",
  "",
  "x",
  "ÆØÅ æøå Œ œ ﬁ ﬂ ①②",
  "Ⅻ ¼ ½ ² ³ µ",
  "Which pages does Googlebot never visit?",
  "Personalausweis beantragen: biometrisches Passfoto, Gebühr 37 Euro.",
]
t = Tokenizer.from_file(sys.argv[1])
print(json.dumps({"generator": f"tokenizers {tokenizers.__version__} (Rust, Python bindings)", "texts": texts, "ids": [t.encode(x).ids for x in texts]}, ensure_ascii=False, indent=1))
