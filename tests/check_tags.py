"""Report which pictures in a grid set carry the "already shrunk" tag.

    python3 tests/check_tags.py exported.gridset [reference.gridset]

Use this on grid sets that have been through Grid 3 (imported, edited, pages
copied, exported) to see whether Grid kept the shrunk pictures as they were.

With a reference (the grid set the tool produced), it also reports whether
each tagged picture is still byte-for-byte the same as the tool wrote it,
matching pictures by content rather than by file name (Grid may rename
files when pages are copied).
"""
import hashlib
import sys
import zipfile
from collections import Counter, defaultdict

TAG = b'CandLE-GridsetShrinker'


def kind(d):
    if d[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if d[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    return None


def tagged(d):
    k = kind(d)
    if k == 'png':
        p = 8
        while p + 12 <= len(d):
            n = int.from_bytes(d[p:p + 4], 'big')
            t = d[p + 4:p + 8]
            if t in (b'IDAT', b'IEND'):
                return False
            if t == b'tEXt' and d[p + 8:p + 8 + len(TAG)] == TAG:
                return True
            p += 12 + n
    elif k == 'jpeg':
        p = 2
        while p + 4 <= len(d) and d[p] == 0xFF:
            m = d[p + 1]
            if m in (0xDA, 0xD9):
                return False
            n = int.from_bytes(d[p + 2:p + 4], 'big')
            if m == 0xFE and d[p + 4:p + 4 + len(TAG)] == TAG:
                return True
            p += 2 + n
    return False


def pictures(path):
    z = zipfile.ZipFile(path)
    for name in z.namelist():
        if name.startswith('Grids/') and not name.endswith('.xml'):
            d = z.read(name)
            if kind(d):
                yield name, d


def main(path, ref=None):
    ref_hashes = {hashlib.sha1(d).hexdigest() for _, d in pictures(ref)} if ref else set()
    per_grid = defaultdict(Counter)
    total = Counter()
    for name, d in pictures(path):
        grid = name.split('/')[1]
        t = tagged(d)
        key = 'tagged' if t else 'untagged'
        per_grid[grid][key] += 1
        total[key] += 1
        if ref and t:
            same = hashlib.sha1(d).hexdigest() in ref_hashes
            total['tagged, identical to tool output' if same else 'tagged, but bytes changed'] += 1
    print(f'{path}')
    print('  pictures:', dict(total))
    print('  per grid (tagged / untagged):')
    for grid in sorted(per_grid):
        c = per_grid[grid]
        print(f'    {c["tagged"]:4d} / {c["untagged"]:<4d} {grid}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
