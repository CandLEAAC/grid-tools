# Tests

Needs Node 20+ and Python 3 with Pillow and NumPy. No `npm install` needed: the tests
use the same vendored libraries as the page.

## 1. Shrink a gridset outside the browser

```sh
node tests/shrink-node.mjs "input.gridset" /tmp/output.gridset --log /tmp/details.tsv
```

This runs exactly the same code as the web page (`assets/js/core.js` and
`assets/js/shrink.mjs`), one picture at a time. It prints a summary. `--log` writes one
line per unique picture: name, original size, result, method or reason, new size,
SSIM, mean ΔE, and % of pixels with ΔE > 10.

## 2. Independently verify the result

```sh
python3 tests/verify.py "input.gridset" /tmp/output.gridset
```

Uses Python's `zipfile` and Pillow, so none of the page's own code is involved. It fails if:

- the output ZIP is invalid, or files are missing, added or reordered
- any file that is not a picture changed in any way (grid XML, settings, sounds…)
- any file date changed
- a changed picture does not open, has a different width/height, or lost transparency

It also prints the lowest PSNR among changed pictures as a sanity check.

## 3. Encrypted gridsets

```sh
node tests/shrink-node.mjs "protected.gridsetx" /tmp/x.gridset
# → GridsetError: This gridset is encrypted (protected) …
```

## How the thresholds were chosen

On the four sample gridsets (October 2026), candidates were made with each codec and
the closest calls were checked by eye at 1× and 3× zoom: photos, screenshots with text,
diagrams with thin coloured lines, and transparent icons. Pictures right at the limits
(SSIM ≈ 0.98, mean ΔE ≈ 1.5–1.9) could not be told apart from the originals. Earlier
versions without a colour check let a hue shift through (purple → grey with similar
brightness), which is why ΔE is checked as well as SSIM.

## Checking the web page itself

Serve the folder (`python3 -m http.server 8000`), open it in Chrome or Edge, and
shrink a sample. The browser's developer tools Network tab should show no requests to
any other site.
