import io

def ctx(path, needle, before=3, after=10):
    lines = io.open(path, encoding='utf-8').read().splitlines()
    hits = [i for i, l in enumerate(lines) if needle in l]
    print('##### %s :: %r -> %d hits' % (path, needle, len(hits)))
    for i in hits:
        print('--- at %d ---' % (i + 1))
        for j in range(max(0, i - before), min(len(lines), i + after + 1)):
            print('%5d %s' % (j + 1, lines[j]))

ctx('src/runtime.ts', 'salvagePartialPlan(', 2, 4)
ctx('src/runtime.ts', 'validatePlan(raw)', 3, 3)
ctx('src/replan.ts', 'replanFieldError(raw', 2, 2)
ctx('src/replan.ts', 'function replanFieldError', 2, 4)
ctx('src/replan.ts', 'effortError', 2, 6)
ctx('src/client.ts', "['low', 'medium', 'high', 'xhigh', 'max'].includes", 8, 3)
