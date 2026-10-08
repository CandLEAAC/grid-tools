"""Independent check of a shrunk grid set against the original (uses Python + Pillow).

    python3 tests/verify.py original.gridset shrunk.gridset

Checks:
  * the ZIP is valid and lists exactly the same files, in the same order
  * every file that is not a picture is byte-for-byte identical
  * every changed picture opens, has the same width/height, and keeps
    transparency (no pixel's see-through-ness changes by more than ~5%)
  * reports how similar the changed pictures are (PSNR on white)
"""
import io
import sys
import zipfile

from PIL import Image
import numpy as np


def is_picture(data):
    return data[:8] == b'\x89PNG\r\n\x1a\n' or data[:3] == b'\xff\xd8\xff'


def main(a_path, b_path):
    a, b = zipfile.ZipFile(a_path), zipfile.ZipFile(b_path)
    problems = []
    bad = b.testzip()
    if bad:
        problems.append(f'corrupt entry in output: {bad}')
    if a.namelist() != b.namelist():
        problems.append('file list or order differs')
    ia, ib = {i.filename: i for i in a.infolist()}, {i.filename: i for i in b.infolist()}
    changed, worst = 0, []
    for name in a.namelist():
        x, y = a.read(name), b.read(name)
        if ia[name].date_time != ib[name].date_time:
            problems.append(f'date changed: {name}')
        if x == y:
            continue
        if not (name.startswith('Grids/') and is_picture(x)):
            problems.append(f'non-picture file changed: {name}')
            continue
        if not is_picture(y):
            problems.append(f'picture became something else: {name}')
            continue
        changed += 1
        p, q = Image.open(io.BytesIO(x)), Image.open(io.BytesIO(y))
        if p.size != q.size:
            problems.append(f'size changed {p.size} -> {q.size}: {name}')
            continue
        pa = np.asarray(p.convert('RGBA'), dtype=np.float64)
        qa = np.asarray(q.convert('RGBA'), dtype=np.float64)
        al, bl = pa[..., 3], qa[..., 3]
        if np.abs(al - bl).max() > 12:
            problems.append(f'transparency changed: {name}')
        if (al < 255).any() and not (bl < 255).any():
            problems.append(f'see-through picture became solid: {name}')
        pw = pa[..., :3] * (al[..., None] / 255) + 255 * (1 - al[..., None] / 255)
        qw = qa[..., :3] * (bl[..., None] / 255) + 255 * (1 - bl[..., None] / 255)
        mse = np.mean((pw - qw) ** 2)
        psnr = 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
        worst.append((psnr, name))
    worst.sort()
    print(f'{a_path}: {len(a.namelist())} files, {changed} pictures changed, {len(problems)} problems')
    if worst:
        print('  lowest PSNR (dB):', ', '.join(f'{p:.1f} {n.split("/", 1)[1]}' for p, n in worst[:3]))
        print(f'  median PSNR: {worst[len(worst) // 2][0]:.1f} dB')
    for p in problems[:20]:
        print('  PROBLEM:', p)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
