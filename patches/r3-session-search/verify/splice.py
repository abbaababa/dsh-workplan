#!/usr/bin/env python3
"""R3 dual-track splice: apply spec 1/2 edits to patched copies (bottom-up, asserted).

Operates ONLY inside the workspace patch directory. Baseline files are read-only
inputs; patched files start as byte-identical baseline copies. Every replacement
asserts its boundary lines first, so a drifted tree fails loudly instead of
silently corrupting the patch.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # r3-session-search/
BLOCKS = ROOT / 'verify' / 'blocks'


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load_lines(p: Path):
    return p.read_text(encoding='utf-8').splitlines(keepends=True)


def block_lines(name: str):
    text = (BLOCKS / name).read_text(encoding='utf-8')
    assert text.endswith('\n'), f'{name} must end with newline'
    return text.splitlines(keepends=True)


def expect(lines, lineno, expected, label):
    actual = lines[lineno - 1].rstrip('\n')
    if actual != expected:
        raise SystemExit(f'BOUNDARY MISMATCH {label} line {lineno}: {actual!r} != {expected!r}')


def splice(path: Path, edits):
    """edits: list of (start, end, replacement_lines_or_None, boundary_checks).
    Applied bottom-up; start/end are 1-based inclusive."""
    lines = load_lines(path)
    for start, end, repl, checks in sorted(edits, key=lambda e: -e[0]):
        for lineno, expected in checks:
            expect(lines, lineno, expected, str(path))
        lines[start - 1:end] = repl if repl is not None else []
    path.write_text(''.join(lines), encoding='utf-8')
    return lines


def main():
    src = ROOT / 'patched' / 'src' / 'index.ts'
    lib = ROOT / 'patched' / 'lib' / 'index.js'
    base_src = ROOT / 'baseline' / 'src' / 'index.ts'
    base_lib = ROOT / 'baseline' / 'lib' / 'index.js'
    assert sha256(src) == sha256(base_src), 'patched src must start from baseline'
    assert sha256(lib) == sha256(base_lib), 'patched lib must start from baseline'

    splice(src, [
        (911, 926, None, [
            (911, 'function samePersistenceSnapshots('),
            (925, '}'),
            (926, ''),
            (927, 'function sameSessionIds('),
        ]),
        (495, 562, block_lines('src-observe.txt'), [
            (495, '  private async _observeStable('),
            (562, '  }'),
        ]),
        (407, 493, block_lines('src-reconcile.txt'), [
            (407, '  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {'),
            (493, '  }'),
        ]),
        (143, 143, None, [(143, '  loaded?: ObservedSession')]),
    ])
    splice(lib, [
        (1025, 1032, None, [
            (1025, 'function samePersistenceSnapshots(before, after) {'),
            (1032, '}'),
            (1033, 'function sameSessionIds(before, after) {'),
        ]),
        (707, 756, block_lines('lib-observe.txt'), [
            (707, '\tasync _observeStable(indexed, signal) {'),
            (756, '\t}'),
        ]),
        (646, 706, block_lines('lib-reconcile.txt'), [
            (646, '\tasync _reconcile(signal) {'),
            (706, '\t}'),
        ]),
    ])

    for p in (src, lib):
        text = p.read_text(encoding='utf-8')
        for forbidden in ('persistentChanges', 'samePersistenceSnapshots', '.loaded', 'entry.loaded'):
            assert forbidden not in text, f'{p}: forbidden residue {forbidden}'
        assert text.count('[R3-fix] incremental per-session commit') >= 1, f'{p}: missing marker'
        assert 'commitPersisted' in text, f'{p}: missing closure'
        print(f'OK {p.relative_to(ROOT)} lines={len(text.splitlines())} sha256={sha256(p)}')
    print('SPLICE DONE')


if __name__ == '__main__':
    sys.exit(main())
