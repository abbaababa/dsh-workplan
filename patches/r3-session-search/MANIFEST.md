# R3 session-search fix — patch package MANIFEST

- Package: `@deepseek-ai/dsh-session-query-sqlite` **0.2.2-rc.2**
- Checkout (read-only source of baseline): `/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh-session-query-sqlite`
- Fix markers (runtime grep targets): `[R3-fix] incremental per-session commit` (both files) and `[R3-fix] startup background pre-warm` (both files)
- Plan: `wp-480eda74-6759-4794-a64a-d46ae5c4eaf1` · subtask `T3` · author: expert-patch (agent-17/agent-1, session 6f9ebf4f-c266-455d-b9cb-8f0c68845d53)
- Date: 2026-11-12 (Asia/Shanghai) · final content includes spec 1–5 (incl. 5/5 startup pre-warm) PLUS the review-fix round A/B/C + trailing-transaction token bump + applier atomic-write/rollback hardening (agent-18 integration lead, spec agreed with agent-17; see PATCH-NOTES.md §7)

## 1. Files and sha256

| File | sha256 |
|---|---|
| baseline/src/index.ts | `72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3` |
| baseline/lib/index.js | `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0` |
| patched/src/index.ts (1218 lines) | `ee4d11b8ae26326d1397491295c3d9303cd9ffaf4a0ced1c292ba2278eee7bd6` |
| patched/lib/index.js (1232 lines) | `574ef3ccd75025aaa3546890395aceb9fc4f9565ad364ffbabcaa9e7b74b4114` |
| r3-session-search.patch (472 lines) | `e14923ea87f4c46fc8e8f07055a7998dce51700ab7b5b7bbf9ce0cbd3d5a0af8` |
| apply-r3-patch.py | `db9f4ea2dc09bba43c36f359dd326202f80cd4b421192770c0c3be219a65fa6e` |

`baseline/SHA256SUMS.txt` holds the raw `shasum -a 256` output for the two baseline
files. `SHA256SUMS.txt` (package root) covers every deliverable including the docs
and is recomputable with `shasum -a 256 -c SHA256SUMS.txt` from this directory.
`verify/TWIN-HASHES-PRE.txt` records the pre-surgery hashes of the parallel
instance's implementation (see PATCH-NOTES.md §5 incident log).

## 2. What the fix does (design rationale)

R3 = `session_event_search` 30s timeout dead-loop. Three coupled mechanisms:

1. **Zero-progress dead loop.** Every search first runs `_reconcile`, which cold-reads
   the whole corpus (2118 sessions, offline floor 24.2s) and commits only in ONE
   transaction after the entire round stabilizes. The 30s cooperative budget aborts
   the observation phase, the transaction is never reached, the `:memory:` index stays
   empty, and the next call repeats the same impossible full pass — forever.
   **Fix:** reserve `nextMainGeneration = _mainGeneration() + 1` before observation and
   commit each cold-read session atomically the moment it is observed
   (`commitPersisted` closure: `BEGIN IMMEDIATE` → `_replacePersistedSession` →
   `COMMIT`, rollback + `SESSION_QUERY_INDEX_FAILED` on failure). An aborted round
   keeps every session it finished; the next call skips them via the existing
   revision gate and converges. The in-round `indexed` Map is updated in place so
   attempt 2 also skips committed sessions. Peak memory drops because observed
   documents no longer accumulate in the observation Map.
2. **Whole-round stability churn deadlock.** The old stability check compared the
   ENTIRE before/after snapshot maps; any revision churn anywhere (e.g. actively
   appended live-owned archives) retried the whole round, and two failed attempts
   threw `SESSION_QUERY_PERSISTENCE_FAILED`. **Fix:** narrow the stability re-check
   to `coldReadRevisions` — only sessions this attempt actually cold-read. Live-owned
   churn no longer triggers whole-round retries (live sessions are already skipped
   from cold reads and covered by live observation). Per-session failure isolation
   keeps one corrupt ("poison pill") archive from killing the whole corpus; a
   zero-success fuse still surfaces total persistence failure as
   `SESSION_QUERY_PERSISTENCE_FAILED` with the first original error as cause.
3. **Cold-start budget gap (spec 5).** Even with incremental commits, a full real-backend
   cold build takes ~204s, so the first searches after a restart would still burn their
   30s budget on indexing. **Fix (config-gated):** when `openAt: 'startup'`,
   `Service.init` fires a background pre-warm (`void this._serialized(...)._reconcile(...)`,
   fire-and-forget, never awaited) that builds the index off the tool budget; failures
   are only logged (`[R3-fix] startup pre-warm failed: …`), never fatal. `_close()`
   aborts the pre-warm via `_prewarmAbort` so shutdown is never dragged by a long
   build; already-committed progress is durable. `openAt: 'first-search'` (the current
   bundle default) and `'never'` have ZERO behavior change. Pre-warm shares the
   `_serialized` queue with searches: correctness first; searches queue behind an
   in-flight pre-warm round (disclosed trade-off).

5. **Review-fix round (independent peer review by agent-18/patch-review-expert, probe-proven; spec agreed between agent-17 and agent-18).**
   - **A (high): zero-success fuse misfire.** After isolation, quiet follow-up searches whose only cold reads are known-bad archives hit `attempts>0 && successes==0` and failed permanently. Fix: per-attempt `skippedAsIndexed` counter (revision-gated skips); fuse now requires `coldReadAttempts>0 && coldReadSuccesses===0 && skippedAsIndexed===0` — any reusable indexed session proves the list+index path works; fresh all-poison corpora still fail closed. Regression: behavior B3 + supplement L5.
   - **B (medium): aborted partial commits left the session-cursor token stale.** B1: each `commitPersisted` transaction also `UPDATE search_state SET global_generation=nextMainGeneration` (idempotent in-round; DB stays in sync with committed rows even on abort). B2: `_reconcile` wraps `_observeStable` in try/catch; on any error with `persistedWriteCount>0` it bumps `this._globalGeneration` before rethrowing; the same bump was added to the trailing-transaction catch (agent-17 edge recommendation, adopted). Regression: behavior A5 + supplement L6.
   - **C (low): index-level commit failures were isolated like read failures.** Per-session catch now rethrows `SESSION_QUERY_INDEX_FAILED` (after abort/binding-change rethrows); only read/data failures are isolated. Regression: supplement L7.
   - **Applier hardening (review F4):** atomic tmp+`os.replace` writes, existing `.bak-r3` preserved (never overwritten), automatic rollback from backup on any post-check failure.

Hard semantics preserved (spec 3): live-preferred SQL, generation monotonicity,
cursor encode/decode + STALE_CURSOR, `_replacePersistedSession`/`_replaceLiveSession`/
`_queryEvents`/`_querySessions`/`selectedDocumentsSql`, schema version (no new
tables/columns), the host-side 30s threshold, all other packages. See PATCH-NOTES.md §4.

## 3. Apply (main Agent executes; restart is a MANUAL user step)

Preferred — idempotent applier (verifies hashes, backs up, post-checks):

```bash
python3 apply-r3-patch.py --target /Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh-session-query-sqlite
```

- Refuses to run without `--target` (exit 2).
- Target files must hash-match the pristine baseline; otherwise exit 3 with the
  expected/actual hash differences printed.
- Already patched (patched hashes + marker) → idempotent skip, exit 0.
- Creates `src/index.ts.bak-r3` and `lib/index.js.bak-r3` before writing.
- Post-checks marker presence, patched hashes, and `node --check lib/index.js`.

Equivalent alternatives from the package root:

```bash
git apply /path/to/r3-session-search.patch     # or:
patch -p1 < /path/to/r3-session-search.patch
```

**After applying, the user must manually restart the host.** No restart, install,
or npm reinstall is performed by this package. To enable the startup pre-warm, the
host's engine config must use `openAt: 'startup'` (config decision belongs to the
main Agent/user; with the current default `'first-search'` the fix still applies
mechanisms 1–2 and pre-warm stays inactive).

Rollback: restore the two `.bak-r3` files over `src/index.ts` and `lib/index.js`
(or `git apply -R r3-session-search.patch`), then restart manually.

## 4. Verify after apply

```bash
grep -c "\[R3-fix\] incremental per-session commit" src/index.ts lib/index.js   # ≥1 each
grep -c "\[R3-fix\] startup background pre-warm" src/index.ts lib/index.js      # ≥1 each
node --check lib/index.js                                                        # exit 0
shasum -a 256 src/index.ts lib/index.js                                          # == patched hashes above
```

Offline behavior evidence (workspace-only, no host writes) is in `verify/`:
`behavior.mjs` (14/14 fixed-mode checks incl. B3/A5 review regressions and pre-warm P1–P4 vs 5/5 baseline-mode
checks), `smoke-*.log`, `tsc-*.log`, `applier-demo.log`, `reapply/` byte-identity proof.
