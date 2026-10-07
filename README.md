# Gridset Shrinker

A web page that makes Grid 3 gridsets smaller by shrinking the pictures inside them
(screenshots, photos, backgrounds). Everything else in the gridset is copied across
byte-for-byte.

Everything runs in the browser. Gridsets are never uploaded anywhere: there is no
server, every library and font is stored in this repository, and the page's
Content-Security-Policy stops it from sending data to any other site.

## What it does

1. Opens the gridset (a ZIP file) in the browser.
2. Rejects files that are not gridsets, and **encrypted gridsets** (usually `.gridsetx`,
   where every file inside is scrambled).
3. For every picture inside `Grids/…` it makes several candidate versions:
   - **oxipng**: lossless PNG optimisation (pixels identical)
   - **libimagequant**: the pngquant engine, which reduces a PNG to a 256-colour palette
   - **MozJPEG**: JPEG compression, only for pictures with no transparency
4. Each candidate is compared with the original and only allowed if it
   **looks the same** (see thresholds below). The smallest allowed candidate is used,
   and if nothing saves at least 5% the original picture is kept.
5. Writes the gridset back out. Files keep the same names, order, dates and attributes.
   Anything that is not a changed picture (grid XML, settings, sounds, Widgit and other
   symbol references, vector `.wmf` symbols) is copied without being touched.

### Shrinking the same pictures again

Pages are often copied from old gridsets into new ones, so the same picture may be
shrunk many times. To stop it losing quality on every pass, each picture the tool
changes gets a tiny invisible tag (a PNG `tEXt` chunk or a JPEG comment, keyword
`CandLE-GridsetShrinker`). Tagged pictures are always left exactly as they are.
Tested by shrinking a gridset 10 times: passes 2–10 changed nothing, and the result
after pass 10 was byte-for-byte identical to the result after pass 1.

Pictures the tool decided to keep unchanged are not tagged, because they are still
the originals. They get the same decision every time.

Grid 3 reads a picture by its content, not by its file extension. The sample gridsets
already contain JPEG data in files named `.png`, so a picture can become JPEG data
under its original name without any grid XML changing.

### "Looks the same" thresholds (`assets/js/shrink.mjs`, `QUALITY`)

| Check | Limit |
|---|---|
| SSIM (structure/brightness) | ≥ 0.98 |
| Average colour difference ΔE (after a 2×2 blur, so fine dithering averages out) | ≤ 2.0 |
| Pixels with a clearly visible colour change (ΔE > 10) | ≤ 0.5% |
| Change in transparency of any pixel | ≤ 12 / 255 (~5%) |

Pictures with transparency are judged on both a white and a black background.

### Results on the sample gridsets

| Gridset | Before | After | Smaller by |
|---|---|---|---|
| Maths Autumn Term 26.1 | 46.1 MB | 12.5 MB | 73% |
| Literacy Autumn term 26.1 | 111.7 MB | 36.4 MB | 67% |
| Maths Autumn Term 1 – Week 5 | 25.7 MB | 18.9 MB | 26% |

Week 5 is mostly one small picture stored over 1,000 times (Grid keeps a copy per cell).
Removing duplicates would mean editing the grid XML, which this tool never does.

## Editing the page

- **How-to section:** edit the clearly marked block in `index.html`. Put screenshots in
  `assets/img/` and add them with `<img src="assets/img/name.png" alt="…">`.
- **Colours and fonts:** `assets/css/style.css` (CandLE purple `#7C5584`, orange `#F66123`,
  Fredoka font).

## Publishing on GitHub Pages

1. Push this folder to a GitHub repository (sample gridsets are excluded by `.gitignore`).
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**,
   choose `main` and `/ (root)`.
3. The site appears at `https://<organisation>.github.io/<repository>/`.

No build step is needed.

To try it locally, run a small web server (the page will not work when opened from
`file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Testing

See [`tests/README.md`](tests/README.md). In short:

```sh
node tests/shrink-node.mjs original.gridset shrunk.gridset   # same pipeline as the page
python3 tests/verify.py original.gridset shrunk.gridset      # independent check (Pillow)
```

Always check a shrunk gridset on a real Grid 3 device before sharing it widely.

## Project layout

```
index.html               the page
assets/css/style.css     styles
assets/js/app.js         page logic and the pool of background workers
assets/js/worker.mjs     background worker (one picture at a time)
assets/js/shrink.mjs     picture processing and the "looks the same" check
assets/js/core.js        gridset/ZIP reading and writing, encryption check
assets/vendor/           third-party libraries (see below)
assets/fonts/            Fredoka font
tests/                   Node runner + Python verifier
```

## Licences

This project is released under the **GNU GPL v3** (see `LICENSE`), because it includes
libimagequant, which is GPL-3.0. Hosting it from a public repository satisfies this.
If a non-GPL licence is ever needed, swap libimagequant for an MIT-licensed quantiser
such as `image-q`, or buy a commercial libimagequant licence.

| Library | Version | Licence | Used for |
|---|---|---|---|
| [libimagequant](https://github.com/ImageOptim/libimagequant) via [libimagequant-wasm](https://github.com/akshetpandey/libimagequant-wasm) | 4.4.1 / 0.3.0 | GPL-3.0 / MIT wrapper | Colour reduction |
| [oxipng](https://github.com/shssoichiro/oxipng) via [jSquash](https://github.com/jamsinclair/jSquash) | @jsquash/oxipng 2.3.0 | MIT / Apache-2.0 | Lossless PNG |
| [png](https://github.com/image-rs/image-png) via jSquash | @jsquash/png 3.1.1 | MIT / Apache-2.0 | PNG decoding |
| [MozJPEG](https://github.com/mozilla/mozjpeg) via jSquash | @jsquash/jpeg 1.6.0 | BSD-style / Apache-2.0 | JPEG |
| [ssim.js](https://github.com/obartra/ssim) | 3.5.0 | MIT | Similarity check |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.2 | MIT | ZIP compression |
| [Fredoka](https://fonts.google.com/specimen/Fredoka) | — | SIL OFL 1.1 | Font |

Each library's licence file is kept next to it in `assets/vendor/`.
The CandLE logo belongs to CandLE.
