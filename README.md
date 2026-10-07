# Gridset Shrinker

A web page that makes Grid 3 gridsets smaller by shrinking the pictures inside them,
so large gridsets stop lagging on devices.

- **Only pictures change.** Grids, words, symbols, sounds and settings are copied
  across exactly as they were.
- **Pictures look the same.** Every shrunk picture is checked against the original,
  and if it would look different the original is kept.
- **Nothing is uploaded.** It all runs in your web browser, on your computer.

Typical result: a 46 MB gridset becomes 12.5 MB.

## Using it

1. Export the gridset from Grid 3 as a `.gridset` file.
2. Open the Gridset Shrinker page and drag the file onto it.
3. Click **Download smaller gridset** when it finishes.
4. Import the smaller gridset into Grid 3 and check it on a device before sharing it.

Encrypted (protected) gridsets, usually `.gridsetx`, can't be shrunk. Use the
original `.gridset` file instead.

It's safe to shrink a gridset more than once, or one built from pages of gridsets
that were already shrunk. Pictures that have been shrunk before are always left
exactly as they are.

## Running it on your own computer

The page needs a small local web server; opening `index.html` directly won't work.

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Making changes

- **How-to section and FAQ:** edit the marked block in `index.html`. Put screenshots
  in `assets/img/`.
- **Colours and fonts:** `assets/css/style.css`.
- **Quality limits:** `QUALITY` at the top of `assets/js/shrink.mjs`.

Changes go in through a pull request to `main`. Once merged, GitHub Pages updates
the live site automatically within a minute or two. There is no build step.

## Testing

Needs Node 20+ and Python 3 with Pillow and NumPy.

```sh
# Shrink a gridset using the same code as the web page
node tests/shrink-node.mjs original.gridset shrunk.gridset

# Independently check that only pictures changed and nothing is broken
python3 tests/verify.py original.gridset shrunk.gridset
```

More detail, and a tool for checking a gridset that has been through Grid 3, is in
[`tests/README.md`](tests/README.md).

Never commit real gridsets: they contain lesson content. `.gitignore` blocks them.

## How it works

Each picture is tried three ways, and the smallest version that passes the
"looks the same" check is kept:

| Method | What it does | Library |
|---|---|---|
| Lossless | Stores the same pixels more efficiently | oxipng |
| Fewer colours | Reduces to a 256-colour palette | libimagequant |
| Photo compression | Saves as JPEG (only pictures with no transparency) | MozJPEG |

The "looks the same" check compares sharpness (SSIM) and colour (ΔE). Pictures with
transparency are compared on both white and black backgrounds, and see-through parts
must stay see-through. If a picture can't be made at least 5% smaller, it isn't
changed.

Every shrunk picture gets a small hidden tag, so it is never processed again. This
stops quality dropping when pages are copied between gridsets and shrunk repeatedly.
Grid 3 keeps the tag when pages are copied (tested).

File names never change. Grid 3 reads pictures by their content, so a `.png` file
can safely contain JPEG data. Grid already does this itself.

| File | Purpose |
|---|---|
| `index.html`, `assets/css/` | The page |
| `assets/js/app.js` | Page logic; runs several pictures at once in the background |
| `assets/js/shrink.mjs` | Picture shrinking and the "looks the same" check |
| `assets/js/core.js` | Reading and writing gridsets; rejects encrypted ones |
| `assets/vendor/` | Third-party libraries, stored locally |
| `tests/` | Test and checking scripts |

## Licence

GNU GPL v3 (see `LICENSE`), because the libimagequant library is GPL-3.0. If the code
ever needs to be kept private and the tool offered outside CandLE, swap libimagequant
for an MIT-licensed library such as `image-q`, or buy a commercial libimagequant
licence.

| Library | Licence |
|---|---|
| [libimagequant](https://github.com/ImageOptim/libimagequant) 4.4.1 (via [libimagequant-wasm](https://github.com/akshetpandey/libimagequant-wasm) 0.3.0) | GPL-3.0 |
| [oxipng](https://github.com/shssoichiro/oxipng), [png](https://github.com/image-rs/image-png), [MozJPEG](https://github.com/mozilla/mozjpeg) (via [jSquash](https://github.com/jamsinclair/jSquash)) | MIT / Apache-2.0 / BSD-style |
| [ssim.js](https://github.com/obartra/ssim) 3.5.0 | MIT |
| [fflate](https://github.com/101arrowz/fflate) 0.8.2 | MIT |
| [Fredoka](https://fonts.google.com/specimen/Fredoka) font | SIL OFL 1.1 |

Each library's licence file sits next to it in `assets/vendor/`. The CandLE logo
belongs to CandLE.
