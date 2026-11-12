# PATCH-NOTES — R3 session-search minimal fix (T3 · expert-patch)

Plan `wp-480eda74-6759-4794-a64a-d46ae5c4eaf1` · subtask `T3` ·
author expert-patch (agent-17/agent-1, session `6f9ebf4f-c266-455d-b9cb-8f0c68845d53`) ·
2026-11-12 Asia/Shanghai. All work workspace-only; checkout and `~/.dsh` never written;
no restart/install/npm-reinstall performed. Final content implements specs 1–5
(including leader's追加 5/5 startup background pre-warm).

Final hashes (freeze, incl. review-fix round §7): src `ee4d11b8ae26326d1397491295c3d9303cd9ffaf4a0ced1c292ba2278eee7bd6` ·
lib `574ef3ccd75025aaa3546890395aceb9fc4f9565ad364ffbabcaa9e7b74b4114`.

## 1. Implementation map (spec → code, line numbers re-grepped in the FINAL patched tree)

Canonical source `patched/src/index.ts` (1218 lines); runtime bundle
`patched/lib/index.js` (1232 lines) edited semantically equivalent in bundle style
(tabs, double quotes, `void 0`, `/* @__PURE__ */`).

| Spec item | src anchor | lib anchor |
|---|---|---|
| 1a generation before observation (`_mainGeneration() + 1`) | src:434 | lib:668 |
| 1b `commitPersisted` closure (BEGIN IMMEDIATE → `_replacePersistedSession` → COMMIT; rollback + INDEX_FAILED wrap; `persistedWriteCount += 1`; in-place `persistedById.set`) | src:436–463 | lib:670–693 |
| 1c `_observeStable` third parameter + call site | src:464, 532 | lib:694, 735 |
| 1d delete `persistentChanges`, `entry.loaded` assignment, `ObservedPersistedSession.loaded` field, trailing-transaction loop + v8 guard | diff hunks @@ -140 / -415 / -454 (src), @@ -650 / -679 (lib) | same |
| 1e `hasWrites = persistedWriteCount > 0 || …` | src:475 | lib:699 |
| 1f trailing transaction: deletes / conditional `UPDATE search_state` / live deletes / live replacements only | src:491–501 | lib:710–718 |
| 1g post-transaction counters, `liveReplacements`/`nextLocalGeneration`, deletes/liveChanges/pointerChanged computations | unchanged (diff context) | unchanged |
| 2a cold-read order: assert → readColdSessionLog → assert → headers compatible → observeSession → immediate commitPersisted | src:564–572 | lib:761–767 |
| 2b per-session try/catch; abort & binding-change rethrow first; failure record; best-effort NAMED logger warn wrapped in try/catch | src:573–582 (warn at 578) | lib:768–775 (warn at 773) |
| 2c zero-success fuse (`coldReadAttempts > 0 && coldReadSuccesses === 0` → first failure, PERSISTENCE_FAILED, original cause) | src:584–591 | lib:777–780 |
| 2d `coldReadRevisions` records only real cold reads, reset per attempt | src:551, 562 | lib:751, 759 |
| 2e stability narrowed to `coldReadRevisions` (churn flag → next attempt) | src:596–611 | lib:785–796 |
| 2f keep binding check / outer catch / live loop / sameSessionIds / ATTEMPTS=2 / final throw; delete `samePersistenceSnapshots` body | diff hunk @@ -906 (src), @@ -1021 (lib) | same |
| 4 marker `[R3-fix] incremental per-session commit` ≥1 per file | src:432, 548 | lib:666, 748 |
| 5a `_prewarmAbort` field (`private readonly` / bundle field style) | src:239 | lib:511 |
| 5b `Service.init`: non-startup early return; `_ensureReady` then fire-and-forget `void _serialized(_prewarmAbort.signal, … _reconcile …).catch(…)`; abort-silent, other failures named-logger warn in try/catch; marker `[R3-fix] startup background pre-warm` | src:263–280 | lib:534–550 |
| 5c `_close()` aborts pre-warm after `_closed = true`, before `await this._tail` | src:361 | lib:611 |
| 5d `first-search`/`never` zero change; shared `_serialized` queue; pre-warm budget undefined but close-abortable | proven by P3 + A/D suites | same |

## 2. Deliberate retained forms (leader ruling: minimal surgery only)

The on-disk implementation was first written by a parallel instance (§5). The leader
ruled I am the sole writer and must only fix the logger call form, no rewrites.
Three spec-literal vs on-disk differences were reviewed and RETAINED because they are
semantically equivalent and outside the ruled surgery scope:

1. `coldReadFailures` entries store the raw error under `error`
   (`{ id, error }`) instead of the spec's literal `{ id, error: errorMessage(error) }`.
   The fuse derives the message via `errorMessage(firstFailure?.error)` and passes the
   ORIGINAL error as `cause` — exactly spec 2c's required semantics (message summary +
   original cause). Verified by suite C1 and B1.
2. The leading `assertNotAborted(signal)` of the cold-read sequence stays immediately
   before the per-session `try` (spec 2a order preserved). An abort there propagates to
   the unchanged outer catch and is wrapped as `SESSION_QUERY_ABORTED` — contract
   intact, verified by suite A1 (`outcome:"aborted"`).
3. src `_observeStable` keeps `indexed: ReadonlyMap<…>`: the closure mutates the OUTER
   `persistedById` Map (a `Map`), never the parameter, so strict tsc passes (exit 0).

The spec-2b logger surgery (my only content change on top of the parallel instance's
files, message text preserved verbatim), final form:

```ts
// src (patched/src/index.ts:577–581)
try {
  this.ctx.logger('session-query-sqlite').warn(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`)
} catch {
  // Best-effort logging must never affect reconciliation.
}
```
```js
// lib (patched/lib/index.js:772–774), bundle style
try {
    this.ctx.logger("session-query-sqlite").warn(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`);
} catch {}
```

Spec 5 (pre-warm) was then added by me directly per the leader's 5/5 message, exactly
as templated (early return, fire-and-forget `void …catch`, named-logger warn in
try/catch, close-time abort). Disclosed trade-off (spec 5d): pre-warm shares the
`_serialized` queue, so a search arriving mid-pre-warm queues behind the in-flight
reconcile round; correctness is prioritized and each round now commits incrementally.

## 3. Verification outputs (raw; full logs in verify/)

### 3.1 node --check (acceptance ②, final content)

```
$ node --check patched/lib/index.js
node --check exit=0
```

### 3.2 Happy-path smoke (harness copy, R3_LIB_PATH → final patched lib)

```
persisted_sessions rows: [{"id":"session-1111…","revision":"rev-1","generation":1},{"id":"session-2222…","revision":"rev-1","generation":1}] search_state: {"global_generation":1}
warm call hits: 1 coldReadsDelta: 0
SMOKE PASS
```
Identical to baseline smoke (`verify/smoke-baseline.log` vs `verify/smoke-patched-final.log`).

### 3.3 Behavior suite — patched, expect=fixed (12/12 PASS, final)

```
PASS A1-abort-keeps-progress: {"r1":{"outcome":"aborted","elapsedMs":264,…},"committedAfterAbort":7}
PASS A2-resume-converges: {"r2":{"outcome":"aborted",…},"committedAfter2":14,"r3":{"outcome":"ok","elapsedMs":844,"hits":1},"committedFinal":40}
PASS A3-no-reread-of-committed: {"readsCall2":8,"remainingAfterAbort":33,"readsCall3":26,"remainingAfterCall2":26,"warmColdDelta":0}
PASS A4-generation-monotonic: {"genAfterAbort":0,"genFinal":1}
PASS B1-poison-isolated: {"r":{"outcome":"ok","elapsedMs":2,"hits":1},"committed":5,"poisonPresent":false}
PASS B2-warn-logged-named: {"warnings":[{"name":"session-query-sqlite","args":["session-search cold read failed for session \"session-00000003-…\": poison pill archive for session-00000003-…"]}],"namedSessionQuerySqlite":true,…}
PASS C1-zero-success-fuse: {"r":{"outcome":"SESSION_QUERY_PERSISTENCE_FAILED",…},"committed":0}
PASS D1-live-churn-converges: {"r":{"outcome":"ok","elapsedMs":2,"hits":1},"committed":5}
PASS P1-prewarm-builds-without-search: {"committed":12,"coldReads":12}
PASS P2-close-aborts-prewarm: {"closeMs":54,"committed":3}
PASS P3-first-search-no-prewarm: {"committed":0,"coldReads":0}
PASS P4-prewarm-failure-nonfatal: {"prewarmWarn":true,"searchAfter":"SESSION_QUERY_PERSISTENCE_FAILED"}
{"label":"patched",…,"total":12,"passed":12,"failed":[]}
```

P1: `openAt:'startup'`, zero search calls → all 12 sessions indexed by pre-warm.
P2: 40×100ms slow corpus, close after 350ms → close returned in 54ms with 3 committed
sessions kept (abort does not lose durable progress, does not wait for the build).
P3: `openAt:'first-search'` → no DB file even created, zero cold reads (spec 5d).
P4: all-poison corpus at startup → pre-warm failure only logged
(`[R3-fix] startup pre-warm failed: …`), service stays usable, no unhandled rejection.

### 3.4 Behavior suite — baseline, expect=baseline (5/5 PASS, proves the defects existed)

```
PASS A1-baseline-zero-progress: {"r1":{"outcome":"aborted",…},"committedAfterAbort":0,"committedAfter2":0}
PASS B1-baseline-poison-kills-round: {"r":{"outcome":"SESSION_QUERY_PERSISTENCE_FAILED",…},"committed":0}
PASS C1-zero-success-fuse: {"r":{"outcome":"SESSION_QUERY_PERSISTENCE_FAILED",…},"committed":0}
PASS D1-baseline-churn-deadlock: {"r":{"outcome":"SESSION_QUERY_PERSISTENCE_FAILED","message":"session-search persistence observation did not stabilize after one retry"},"committed":0}
PASS P1-baseline-no-prewarm: {"committed":0,"coldReads":0}
{"label":"baseline",…,"total":5,"passed":5,"failed":[]}
```

A3 note: each aborted call may waste at most ONE in-flight (read-but-uncommitted)
session that the next call legitimately re-reads; committed rows are never re-read
(`readsCall3 === remaining`, `warmColdDelta === 0`).

### 3.5 tsc strict typecheck (final patched src; baseline control)

```
$ tsc -p verify/typecheck/tsconfig.json          # final patched src + pristine query.ts/schema.ts
tsc patched exit=0
$ tsc -p verify/typecheck-baseline/tsconfig.json # baseline control
tsc baseline exit=0
```
TS 5.9.3, strict, nodenext, rewriteRelativeImportExtensions, noEmit.

### 3.6 Acceptance ① — final diff reapplies byte-identically (both tools)

```
git apply OK
patch -p1 OK
cmp src (git apply) exit=0
cmp lib (git apply) exit=0
cmp src (patch -p1) exit=0
cmp lib (patch -p1) exit=0
```

### 3.7 Acceptance ③ — applier demos, final content (verify/applier-demo.log)

```
no-args exit=2            (refuses without --target)
first-apply exit=0        (backup .bak-r3 created; cmp src exit=0; cmp lib exit=0;
                           backup hashes == baseline hashes)
second-apply exit=0       (IDEMPOTENT SKIP … Nothing written.)
tampered exit=3           (one appended byte → HASH MISMATCH, expected/actual printed)
```

### 3.8 Acceptance ④ — sha256 manifest recomputable

`SHA256SUMS.txt` at package root; `shasum -a 256 -c SHA256SUMS.txt` → all OK
(output in `verify/sha256-recheck.log`).

## 4. Acceptance ⑤ — zero out-of-spec semantic changes (spec 3 + 5d checklist)

Full 472-line unified diff (final freeze) audited hunk-by-hunk; every hunk maps to spec 1/2/4/5 (§1) or the review-fix round (§7).

| Preserved item | Evidence |
|---|---|
| live-preferred SQL (`NOT EXISTS temp.live_sessions`) | no diff hunk touches `_queryEvents`/`_querySessions`/`selectedDocumentsSql`; clause intact in patched tree |
| generation monotonic | suite A4 PASS; trailing `UPDATE search_state` condition semantics kept (spec 1f) |
| cursor encode/decode + STALE_CURSOR | `encodeCursor`/`decodeCursor`/`invalidCursor` absent from diff |
| `_replacePersistedSession` / `_replaceLiveSession` | absent from diff (called, never modified) |
| `_queryEvents` / `_querySessions` / `selectedDocumentsSql` | absent from diff |
| schema version, no new tables/columns | `schema.ts` not part of patch; all SQL strings unchanged |
| 30s threshold | host-side; untouched |
| other packages | untouched; only the two target files differ |
| spec 1g retained computations | diff context lines show `liveReplacements`/`nextLocalGeneration`, `persistentDeletes`/`liveChanges`/`liveDeletes`/`pointerChanged`, post-transaction `_globalGeneration`/`_persistenceEpoch`/`_localGeneration`/`_lastPersistenceIdentity` unchanged |
| spec 2f retained observation machinery | outer catch classification, live observation loop, `sameSessionIds` retry, `STABLE_OBSERVATION_ATTEMPTS=2`, final not-stabilized throw all unchanged; `sameHeader`/`sameSessionIds` kept, only `samePersistenceSnapshots` deleted |
| incremental skip (old :514) & live skip (old :520) | unchanged context lines in both tracks |
| spec 5d `openAt:'first-search'` / `'never'` zero change | init early-returns for non-startup (identical observable behavior to baseline); suite P3 + baseline P1 control; `'never'` still refused by unchanged `_assertSearchEnabled` before any SQLite work |
| spec 5d pre-warm never blocks activation / never fatal | `void …catch` fire-and-forget; P1 (activation completes, index builds later), P4 (failure only logged) |
| spec 5c close not dragged by pre-warm | P2 closeMs=54 with a 4s build in flight |

## 5. Double-writer incident log (required disclosure)

| Time (Asia/Shanghai) | Event |
|---|---|
| 22:01 | phase-0 task received; self_effort xhigh registered shortly after |
| 22:07:06 | pristine baseline captured: src `72868e4a…b8d3`, lib `dbecf833…70a0` (baseline/SHA256SUMS.txt) |
| 22:09–22:12 | leader sent spec 1/3, 2/3, 3/3 (original task text truncated at "BEGIN IMMEDIAT…"); baseline/patched layout created, patched = byte-copies of baseline |
| **22:13:54** | **parallel instance (agent-17/agent-7, expert-patch(self:xhigh)) wrote a complete implementation into patched/** — src `ca1dbb63e8abed7d2ec111c32733c74b8141d49fa00390899416adc29f4bfb58`, lib `1c4f297a194d1b647e38c5faf34f2a61fcba613a582cfd106fe54b504d3e1d92` (verify/TWIN-HASHES-PRE.txt) |
| ~22:15 | my `verify/splice.py` failed its PRE-WRITE assertion ("patched src must start from baseline") and wrote NOTHING; double-writer detected; I stopped all writes to patched/, reviewed the on-disk implementation read-only, found one spec-2b deviation (logger form) |
| ~22:18 | reported to leader with evidence; **leader ruling A: I am the sole writer**; agent-7 notified to stop writing / go read-only |
| 22:20:01 | twin pre-surgery hashes archived (TWIN-HASHES-PRE.txt) |
| ~22:20 | minimal surgery: logger call form only, both tracks (§2); intermediate hashes src `b18c2d3b…9190`, lib `5ff314ea…02d4` |
| 22:20–22:26 | verification round 1: one fixture defect found and fixed in MY test stub (missing seq-0 head event — implementation untouched), then 8/8 + 4/4 + tsc + reapply + applier demos green |
| ~22:27 | leader sent追加 spec 5/5 (startup background pre-warm, config-gated) |
| 22:29–22:32 | implemented spec 5 in both tracks (6 targeted edits), added P1–P4 suites; two more fixture fixes in MY stub (per-call read metric; missing-DB-file handling for first-search), implementation untouched by fixture fixes; final verification 12/12 + 5/5 + tsc exit 0 + reapply cmp×4 exit 0 + applier demos 2/0/0/3 |
| 22:32 | final hashes: src `f587a0fb…afd1`, lib `fdb67cd0…ba35`; diff + applier regenerated; docs finalized |
| 22:44 | agent-17 lead ruling: agent-18 (settlement retry lead) becomes sole writer of patches/, R3-fix-patch.md and wp-settlement-T3.json for the review-fix round; expert-patch stands down; agent-17 independently re-verifies the freeze |

My originally drafted splice blocks (`verify/blocks/*`, `verify/splice.py`) were NEVER
applied; they are retained only as evidence of the aborted write path. The final
patched files = parallel instance's spec-1/2 implementation + my logger-form surgery
+ my spec-5 pre-warm additions, nothing else.

## 6. Reproduce

```bash
cd plugins/dsh-workplan/patches/r3-session-search
node --check patched/lib/index.js
node verify/behavior.mjs --lib "$PWD/patched/lib/index.js"  --expect fixed    --label patched
node verify/behavior.mjs --lib "$PWD/baseline/lib/index.js" --expect baseline --label baseline
node verify/harness/smoke.mjs                                   # baseline
R3_LIB_PATH="$PWD/patched/lib/index.js" node verify/harness/smoke.mjs
shasum -a 256 -c SHA256SUMS.txt
```


## 7. Review-fix round (agent-18 integration lead · 22:44–22:52 freeze)

Independent peer review (agent-18/patch-review-expert, report
`reports/_r3_fix_t3_20261112/t3-final-agent18/expert-patch-review.md`, probes in its
`probe/`) found two semantic defects in the 22:32 variant, both probe-proven with
baseline-vs-patched differential runs:

1. **High — fuse misfire on quiet poisoned corpora** (`probe/poison-applied.json`:
   call1 ok / call2 FAIL / call3 FAIL / call4 ok). Spec source: agent-17 ruling A
   (skippedAsIndexed counter), replacing agent-18's initial `indexed.size===0` guard
   (stricter fail-closed on binding-change/full-turnover edges).
2. **Medium — stale session cursor after aborted partial commits**
   (`probe/cursor2-applied.json`: patched call3 ok vs baseline STALE_CURSOR). Spec
   source: agent-17 ruling B1+B2, plus its trailing-transaction catch edge
   recommendation (adopted).
3. **Low — commit failures isolated like read failures** (review §7.1). Spec source:
   agent-17 ruling C (identical to agent-18's initial implementation).
4. **Applier hardening** (review F4): atomic writes, backup preservation, automatic
   post-check rollback (agent-17 agreed).

Implementation: six targeted dual-track edits (A counter+condition, B1 per-commit
UPDATE, B2 observe-catch bump, trailing-catch bump, C rethrow) — no other content
changes. Test-side changes (disclosed, implementation untouched): behavior A4
invariant updated from uniform row generation to `row<=global && global==max(row)`
(per-commit sync legitimately yields mixed per-round generations); A5 outcome string
aligned to the raw error code; P1 pre-warm poll window 4s→30s (load-induced flake
observed under a concurrent full-corpus build); `inspect()` made defensive for the
async pre-warm db-creation race. New regressions: behavior B3/A5 (fixed 14 total),
agent-17's supplement L5×2/L6×6/L7×1 (28 total; pre-fix defect capture archived at
`experiments/final-verify/supplement-defect-capture-patched.log` and baseline
`supplement-defect-capture.log`).

Freeze verification (all on src `ee4d11b8…` / lib `574ef3cc…`): tsc 5.9.3 strict
exit=0 (patched AND baseline logs with exit codes); node --check exit=0; diff
roundtrip patch -p1 → cmp src/lib exit=0; applier demos no-args=2/first=0/skip=0/
tamper=3 with atomic writes + preserved backups; behavior fixed 14/14, baseline 5/5;
main suite baseline exact MATCH exit=0, fixed 13/13 exit=0; supplement fixed 28/28
exit=0 (sha-bound), baseline 21/28 defect capture. Real-corpus final-hash pipeline
(full build → 30s query battery → startup pre-warm) run by agent-18, results in
`reports/_r3_fix_t3_20261112/t3-final-agent18/LEAD-final-*`.

## 8. Credits (dual chain, required disclosure)

- agent-17 chain: E-series experiments, corpus copy + manifest + P1 oracle, poison
  dry-run + repair script, regression suite (13 checks), patch implementation
  (expert-patch twin + minimal surgery + spec-5 pre-warm), fix spec A/B/C rulings,
  L5/L6/L7 supplement regressions, independent re-verification.
- agent-18 chain: independent peer review + deterministic probes (findings 1/2/3),
  review-fix implementation + package regeneration + freeze verification, decisive
  real-corpus timing battery + pre-warm proof, final report + settlement.
- Double-writer incidents (22:13 twin write; 22:23–22:32 convergence window; parallel
  attempt coordination) are disclosed in §5 and in R3-fix-patch.md; sole-writer
  rulings prevented a third incident.
