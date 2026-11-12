#!/usr/bin/env python3
"""Generate apply-r3-patch.py with patched contents embedded as raw triple-quoted
strings (per spec 3/3; historical lesson: never embed source in JS template
strings). Asserts embed-safety and round-trip hash identity before writing."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = '[R3-fix] incremental per-session commit'


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


rels = ['src/index.ts', 'lib/index.js']
base = {r: (ROOT / 'baseline' / r).read_bytes() for r in rels}
pat = {r: (ROOT / 'patched' / r).read_bytes() for r in rels}
for r in rels:
    text = pat[r].decode('utf-8')
    assert '"""' not in text, f'{r}: triple-quote collision, cannot embed raw'
    assert '\\' not in text[-2:], f'{r}: trailing backslash unsafe for raw string'
    assert MARKER in text, f'{r}: marker missing'
    assert text.endswith('\n'), f'{r}: must end with newline'

header = '''#!/usr/bin/env python3
"""R3 session-search fix: idempotent patch applier (self-contained).

Applies the R3 minimal fix (incremental per-session commit in _reconcile /
_observeStable) to a checkout of @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.2.

Usage:
    python3 apply-r3-patch.py --target <package-directory>

Safety flow:
  1. sha256 of target src/index.ts and lib/index.js must equal the pristine
     baseline hashes; otherwise exit non-zero and print the hash differences.
  2. If both files already equal the patched hashes AND carry the [R3-fix]
     marker, exit 0 (idempotent skip, nothing written).
  3. Before writing, back up both target files as <name>.bak-r3 (an existing
     backup is preserved, never overwritten).
  4. Write the patched contents atomically (tmp + os.replace; embedded below,
     hash-verified at runtime).
  5. Post-check: marker present in both files, sha256 equals patched hashes,
     and `node --check lib/index.js` passes; any failure rolls both files back
     from .bak-r3 automatically.

No network, no installs, no restarts. Restart of the host is a manual user step.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = "[R3-fix] incremental per-session commit"
BASELINE_SHA256 = {
    "src/index.ts": "__BASE_SRC__",
    "lib/index.js": "__BASE_LIB__",
}
PATCHED_SHA256 = {
    "src/index.ts": "__PAT_SRC__",
    "lib/index.js": "__PAT_LIB__",
}
'''

parts = [header]
for r in rels:
    key = 'SRC_CONTENT' if r.endswith('.ts') else 'LIB_CONTENT'
    parts.append(f'{key} = r"""')
    parts.append(pat[r].decode('utf-8'))
    parts.append('"""\n\n')
parts.append('''PATCHED_CONTENT = {"src/index.ts": SRC_CONTENT, "lib/index.js": LIB_CONTENT}


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="Apply the R3 session-search fix (idempotent).")
    ap.add_argument("--target", required=True, help="target package directory containing src/index.ts and lib/index.js")
    args = ap.parse_args()
    target = Path(args.target).resolve()
    paths = {rel: target / rel for rel in BASELINE_SHA256}
    for rel, p in paths.items():
        if not p.is_file():
            print(f"ERROR: missing target file {p}", file=sys.stderr)
            return 2
    current = {rel: sha256_bytes(p.read_bytes()) for rel, p in paths.items()}

    if all(current[rel] == PATCHED_SHA256[rel] for rel in paths) and all(
        MARKER in p.read_text(encoding="utf-8") for p in paths.values()
    ):
        print("IDEMPOTENT SKIP: target already carries the R3 fix (patched hashes + marker present). Nothing written.")
        return 0

    if not all(current[rel] == BASELINE_SHA256[rel] for rel in paths):
        print("HASH MISMATCH: target files are neither pristine baseline nor already-patched. Refusing to apply.", file=sys.stderr)
        for rel in paths:
            print(f"  {rel}:", file=sys.stderr)
            print(f"    expected baseline: {BASELINE_SHA256[rel]}", file=sys.stderr)
            print(f"    expected patched : {PATCHED_SHA256[rel]}", file=sys.stderr)
            print(f"    actual           : {current[rel]}", file=sys.stderr)
        return 3

    for rel, content in PATCHED_CONTENT.items():
        if sha256_bytes(content.encode("utf-8")) != PATCHED_SHA256[rel]:
            print(f"INTERNAL ERROR: embedded content hash mismatch for {rel}", file=sys.stderr)
            return 4

    for rel, p in paths.items():
        bak = p.with_name(p.name + ".bak-r3")
        if bak.exists():
            print(f"backup preserved (already exists): {bak}")
        else:
            shutil.copy2(p, bak)
            print(f"backup: {bak}")
    for rel, p in paths.items():
        tmp = p.with_name(p.name + ".tmp-r3")
        tmp.write_bytes(PATCHED_CONTENT[rel].encode("utf-8"))
        os.replace(tmp, p)
        print(f"patched (atomic): {p}")

    def rollback(reason: str, code: int) -> int:
        for rel2, p2 in paths.items():
            bak2 = p2.with_name(p2.name + ".bak-r3")
            if bak2.exists():
                shutil.copy2(bak2, p2)
        print(f"POST-CHECK FAILED: {reason} — rolled back from .bak-r3", file=sys.stderr)
        return code

    for rel, p in paths.items():
        data = p.read_bytes()
        if MARKER not in data.decode("utf-8"):
            return rollback(f"marker missing in {p}", 5)
        if sha256_bytes(data) != PATCHED_SHA256[rel]:
            return rollback(f"hash mismatch in {p}", 5)
    check = subprocess.run(["node", "--check", str(paths["lib/index.js"])])
    if check.returncode != 0:
        return rollback("node --check lib/index.js", 6)
    print("R3 PATCH APPLIED OK: marker present, hashes verified, node --check passed.")
    print("NEXT STEP (manual): the user must restart the host for the fix to take effect.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
''')

out = ''.join(parts)
out = out.replace('__BASE_SRC__', sha(base['src/index.ts']))
out = out.replace('__BASE_LIB__', sha(base['lib/index.js']))
out = out.replace('__PAT_SRC__', sha(pat['src/index.ts']))
out = out.replace('__PAT_LIB__', sha(pat['lib/index.js']))
dest = ROOT / 'apply-r3-patch.py'
dest.write_text(out, encoding='utf-8')
print(f'generated {dest} bytes={len(out.encode("utf-8"))}')
print('baseline src', sha(base['src/index.ts']))
print('baseline lib', sha(base['lib/index.js']))
print('patched  src', sha(pat['src/index.ts']))
print('patched  lib', sha(pat['lib/index.js']))
