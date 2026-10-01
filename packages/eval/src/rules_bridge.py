# Runs the Python half of CrochetPARADE's rule-based translator on one
# pattern, as crochetparade.org does in Pyodide.
#
# stdin:  {"text": "<english>", "prevCount": <int or null>}
# stdout: the base review model JSON (rows with candidates, previewCpText)
#
# With prevCount, the first instruction row is re-read with that as the
# previous row's and round's stitch count, the way the site passes row
# contexts after the user edits an earlier row. Step-level items use it to
# give the translator the count of the gold prefix.

import json
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[3] / "vendor" / "crochetparade" / "python"
sys.path.insert(0, str(VENDOR))

from crochetparade_translator.browser.review_model import (  # noqa: E402
    build_browser_review_model,
    build_browser_review_model_with_contexts,
)

request = json.load(sys.stdin)
text = request["text"]
prev = request.get("prevCount")

model = build_browser_review_model(text)
if prev is not None:
    first = next((r for r in model["rows"] if r.get("kind") == "instruction"), None)
    if first is not None:
        context = {"id": first["id"], "prevRowCount": prev, "prevRoundCount": prev}
        model = build_browser_review_model_with_contexts(text, [context])

json.dump(model, sys.stdout)
