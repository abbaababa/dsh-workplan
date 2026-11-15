#!/usr/bin/env python3
"""T9 交付自检：逐项断言，全部可复算。只读，不修改任何文件。"""
import hashlib, io, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(ROOT)
fails = []

def check(name, ok, detail=''):
    print(('PASS  ' if ok else 'FAIL  ') + name + (('  | ' + detail) if detail else ''))
    if not ok:
        fails.append(name)

def sha(p):
    return hashlib.sha256(io.open(p,'rb').read()).hexdigest()

# C1 交付物齐备
reports = ['reports/T4-修复后复核-20261114.md', 'reports/T10-修复说明-20261114.md']
for r in reports:
    check('C1 产物存在 ' + r, os.path.isfile(r) and os.path.getsize(r) > 2000,
          'bytes=%d sha=%s' % (os.path.getsize(r) if os.path.isfile(r) else 0, sha(r)[:8] if os.path.isfile(r) else '-'))

# C2 禁用表述扫描（我的两份交付物）
banned = ['已完成', '已交付', '最终版']
for r in reports:
    text = io.open(r, encoding='utf-8').read()
    hits = {w: text.count(w) for w in banned if text.count(w)}
    check('C2 禁用表述为零 ' + os.path.basename(r), not hits, str(hits) if hits else '0 命中')

# C3 编译产物与源码同步
for name in ['plan', 'runtime']:
    d = sha('dist/%s.js' % name); l = sha('lib/%s.js' % name)
    check('C3 dist==lib %s.js' % name, d == l, d[:8])

# C4 全量回归日志
log = 'evidence/T10-final/full-suite.log'
tail = io.open(log, encoding='utf-8').read().strip().splitlines()[-1] if os.path.isfile(log) else ''
check('C4 全量回归 pass=1146 fail=0', 'pass=1146 fail=0' in tail, tail[:80])

# C5 关键锚点仍在
anchors = [
    ('src/plan.ts', 'PENDING_UPDATE_COUNT_LIMIT = 100'),
    ('src/plan.ts', 'PENDING_UPDATE_SIZE_LIMIT = 200_000'),
    ('src/plan.ts', 'PENDING_UPDATE_FLUSH_MS = 20_000'),
    ('src/plan.ts', 'function tryBufferWorkplanUpdate'),
    ('src/plan.ts', 'export function flushPendingWorkplanUpdates'),
    ('src/plan.ts', 'export function parseUpdateMessages'),
    ('src/runtime.ts', 'for (const update of parseUpdateMessages(event.data))'),
    ('src/runtime.ts', 'const cancel = parseCancelMessage(event.data)'),
]
for (f, needle) in anchors:
    t = io.open(f, encoding='utf-8').read()
    check('C5 锚点 %s :: %s' % (f, needle[:38]), needle in t)

# C6 取消块必须在循环外：cancel 行号 > for 行号，且两者之间没有未闭合的循环
rt = io.open('src/runtime.ts', encoding='utf-8').read().splitlines()
for_line = next(i for i, l in enumerate(rt, 1) if 'for (const update of parseUpdateMessages' in l)
cancel_line = next(i for i, l in enumerate(rt, 1) if 'const cancel = parseCancelMessage' in l)
segment = '\n'.join(rt[for_line - 1:cancel_line - 1])
check('C6 cancel 在 for 之后', cancel_line > for_line, 'for@%d cancel@%d' % (for_line, cancel_line))
check('C6b 循环体内无新的 for 未闭合', segment.count('{') - segment.count('}') == 0,
      'braces net=%d' % (segment.count('{') - segment.count('}')))

# C7 新增回归用例
for t in ['tests/workplan-255-injection-merge.test.ts', 'tests/workplan-255-cancel-replay.test.ts']:
    check('C7 用例存在 ' + t, os.path.isfile(t))

# C8 工作树状态（只读证明：与报告登记值一致）
st = subprocess.run(['git', 'status', '--porcelain'], capture_output=True, text=True).stdout.splitlines()
head = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
check('C8 HEAD 仍为 3af2686', head == '3af2686', head)
print('INFO  git status 行数 = %d（含本次新增报告/证据，故大于 143 属预期）' % len(st))

print('RESULT: %s  (fail=%d)' % ('ALL PASS' if not fails else 'HAS FAIL', len(fails)))
sys.exit(0 if not fails else 1)
