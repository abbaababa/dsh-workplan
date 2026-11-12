#!/usr/bin/env python3
"""R3 minimal fix: regenerate patched/ from baseline/ via exact, asserted replacements.

Single source of truth for the dual-track (src/index.ts + lib/index.js) patch.
Every replacement must match exactly once; any drift aborts with a non-zero exit.
Spec clauses implemented (leader design spec, T3 expert-patch task):
  1a-g  _reconcile: pre-observation nextMainGeneration, commitPersisted closure,
        third arg to _observeStable, persistentChanges/loaded removal, hasWrites,
        tail transaction scope, unchanged post-transaction counters.
  2a-f  _observeStable: immediate per-session commit, failure isolation,
        zero-success fuse, coldReadRevisions, narrowed stability, kept retries.
  3     semantics preserved (SQL/cursors/generation monotonic/schema untouched).
  4     dual track + [R3-fix] markers (2 per file).
Lib strings use '§' as a visible stand-in for one leading TAB, expanded below.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKER = "[R3-fix] incremental per-session commit"


def apply(text: str, pairs: list[tuple[str, str]], label: str) -> str:
    for i, (old, new) in enumerate(pairs, 1):
        n = text.count(old)
        if n != 1:
            print(f"FATAL {label} replacement #{i}: expected 1 match, found {n}", file=sys.stderr)
            sys.exit(1)
        text = text.replace(old, new)
        print(f"OK {label} replacement #{i}")
    return text


# ---------------------------------------------------------------- src track
SRC_PAIRS: list[tuple[str, str]] = []

# 1d: remove ObservedPersistedSession.loaded field
SRC_PAIRS.append((
    """interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
}
""",
    """interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
}
""",
))

# 1a+1b+1c+1d: generation before observation, commitPersisted closure, third arg,
# persistentChanges computation removed.
SRC_PAIRS.append((
    """    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const observation = await this._observeStable(persistedById, signal)
    assertNotAborted(signal)
    const persistentChanges = observation.persistenceBinding.service === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => entry.loaded !== undefined)
    const persistentDeletes = observation.persistenceBinding.service === undefined
""",
    """    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    // [R3-fix] incremental per-session commit: fix the target generation before
    // observing so every cold-read session can be committed atomically on its own.
    const nextMainGeneration = this._mainGeneration() + 1
    let persistedWriteCount = 0
    const commitPersisted = (entry: ObservedPersistedSession, observed: ObservedSession): void => {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        this._replacePersistedSession(observed, entry.revision, nextMainGeneration)
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
      persistedWriteCount += 1
      persistedById.set(entry.header.id, { id: entry.header.id, revision: entry.revision, generation: nextMainGeneration })
    }
    const observation = await this._observeStable(persistedById, signal, commitPersisted)
    assertNotAborted(signal)
    const persistentDeletes = observation.persistenceBinding.service === undefined
""",
))

# 1e + generation block: hasWrites uses persistedWriteCount; nextMainGeneration is
# already fixed before observation (1a), so the conditional bump is removed.
SRC_PAIRS.append((
    """    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
""",
    """    const hasWrites = persistedWriteCount > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextLocalGeneration = this._localGeneration
    const liveReplacements = liveChanges.map((entry) => {
""",
))

# 1f: tail transaction keeps deletes / conditional generation UPDATE / live work only.
SRC_PAIRS.append((
    """        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) {
          /* v8 ignore next -- observation loads every entry whose revision differs */
          if (entry.loaded === undefined) throw new Error(`missing loaded revision for session "${entry.header.id}"`)
          this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration)
        }
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
""",
    """        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        if (persistedWriteCount > 0 || persistentDeletes.length > 0) {
""",
))

# 1c: _observeStable gains the commitPersisted parameter.
SRC_PAIRS.append((
    """  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
  ): Promise<Observation> {
""",
    """  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
    commitPersisted: (entry: ObservedPersistedSession, observed: ObservedSession) => void,
  ): Promise<Observation> {
""",
))

# 2a+2b+2c+2d+2e: immediate commit, isolation, fuse, coldReadRevisions, narrowed stability.
SRC_PAIRS.append((
    """          persisted = materializePersistenceSnapshots(before)
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
            // Skip work already shadowed by a live owner. The cold read is
            // non-mutating (interrupted turns are balanced in memory only), so
            // an owner attaching after this check cannot cause side effects;
            // the live-membership retry below makes the returned observation
            // live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            assertNotAborted(signal)
            const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
            assertNotAborted(signal)
            assertSessionHeadersCompatible(entry.header, loaded.header)
            entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after)) continue
          if (this._persistenceBinding !== persistenceBinding) continue
""",
    """          persisted = materializePersistenceSnapshots(before)
          // [R3-fix] incremental per-session commit: isolate per-session failures,
          // commit each observed session immediately, and narrow the stability
          // comparison to the sessions this attempt actually cold-read.
          const coldReadRevisions = new Map<SessionId, SessionPersistenceRevision>()
          const coldReadFailures: { id: SessionId, error: unknown }[] = []
          let coldReadAttempts = 0
          let coldReadSuccesses = 0
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
            // Skip work already shadowed by a live owner. The cold read is
            // non-mutating (interrupted turns are balanced in memory only), so
            // an owner attaching after this check cannot cause side effects;
            // the live-membership retry below makes the returned observation
            // live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            assertNotAborted(signal)
            coldReadRevisions.set(entry.header.id, entry.revision)
            coldReadAttempts += 1
            try {
              const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
              assertNotAborted(signal)
              assertSessionHeadersCompatible(entry.header, loaded.header)
              const observed = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
              commitPersisted(entry, observed)
              coldReadSuccesses += 1
            } catch (error: unknown) {
              if (isAbort(error) || signal?.aborted) throw error
              if (this._persistenceBinding !== persistenceBinding) throw error
              coldReadFailures.push({ id: entry.header.id, error })
              this.ctx.logger?.warn?.(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`)
            }
          }
          if (coldReadAttempts > 0 && coldReadSuccesses === 0) {
            const firstFailure = coldReadFailures[0]
            throw new SessionQueryError(
              `session-search persistence observation failed: ${errorMessage(firstFailure?.error)}`,
              'SESSION_QUERY_PERSISTENCE_FAILED',
              { cause: firstFailure?.error },
            )
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          let coldReadStable = true
          for (const [id, revision] of coldReadRevisions) {
            const first = persisted.get(id)
            const second = after.get(id)
            if (
              first === undefined
              || second === undefined
              || revision !== second.revision
              || !sameHeader(first.header, second.header)
            ) {
              coldReadStable = false
              break
            }
          }
          if (!coldReadStable) continue
          if (this._persistenceBinding !== persistenceBinding) continue
""",
))

# 2e: delete the whole-map samePersistenceSnapshots helper (only call site removed above).
SRC_PAIRS.append((
    """function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || first.revision !== second.revision
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionIds(
""",
    """function sameSessionIds(
""",
))

# ---------------------------------------------------------------- lib track
# '§' stands for one leading TAB (bundle indentation); expanded before matching.
LIB_PAIRS_RAW: list[tuple[str, str]] = []

# 1a+1b+1c+1d (lib has no type declarations, so no interface edit is needed).
LIB_PAIRS_RAW.append((
    """§§const persistedById = new Map(persistedRows.map((row) => [row.id, row]));
§§const liveById = new Map(liveRows.map((row) => [row.id, row]));
§§const observation = await this._observeStable(persistedById, signal);
§§assertNotAborted(signal);
§§const persistentChanges = observation.persistenceBinding.service === void 0 ? [] : [...observation.persisted.values()].filter((entry) => entry.loaded !== void 0);
§§const persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => !observation.persisted.has(row.id));
""",
    """§§const persistedById = new Map(persistedRows.map((row) => [row.id, row]));
§§const liveById = new Map(liveRows.map((row) => [row.id, row]));
§§// [R3-fix] incremental per-session commit: fix the target generation before
§§// observing so every cold-read session can be committed atomically on its own.
§§const nextMainGeneration = this._mainGeneration() + 1;
§§let persistedWriteCount = 0;
§§const commitPersisted = (entry, observed) => {
§§§let began = false;
§§§try {
§§§§db.exec("BEGIN IMMEDIATE");
§§§§began = true;
§§§§this._replacePersistedSession(observed, entry.revision, nextMainGeneration);
§§§§db.exec("COMMIT");
§§§} catch (error) {
§§§§/* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
§§§§if (began)
§§§§§/* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
§§§§§try {
§§§§§§db.exec("ROLLBACK");
§§§§§} catch {}
§§§§throw new SessionQueryError(`session-search reconciliation failed: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
§§§}
§§§persistedWriteCount += 1;
§§§persistedById.set(entry.header.id, { id: entry.header.id, revision: entry.revision, generation: nextMainGeneration });
§§};
§§const observation = await this._observeStable(persistedById, signal, commitPersisted);
§§assertNotAborted(signal);
§§const persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => !observation.persisted.has(row.id));
""",
))

# 1e + generation block.
LIB_PAIRS_RAW.append((
    """§§const hasWrites = persistentChanges.length > 0 || persistentDeletes.length > 0 || liveChanges.length > 0 || liveDeletes.length > 0;
§§let nextMainGeneration = this._mainGeneration();
§§let nextLocalGeneration = this._localGeneration;
§§if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1;
§§const liveReplacements = liveChanges.map((entry) => {
""",
    """§§const hasWrites = persistedWriteCount > 0 || persistentDeletes.length > 0 || liveChanges.length > 0 || liveDeletes.length > 0;
§§let nextLocalGeneration = this._localGeneration;
§§const liveReplacements = liveChanges.map((entry) => {
""",
))

# 1f: tail transaction scope.
LIB_PAIRS_RAW.append((
    """§§§§for (const row of persistentDeletes) this._deleteSession("persisted", row.id);
§§§§for (const entry of persistentChanges) {
§§§§§/* v8 ignore next -- observation loads every entry whose revision differs */
§§§§§if (entry.loaded === void 0) throw new Error(`missing loaded revision for session "${entry.header.id}"`);
§§§§§this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration);
§§§§}
§§§§if (persistentChanges.length > 0 || persistentDeletes.length > 0) db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(nextMainGeneration);
""",
    """§§§§for (const row of persistentDeletes) this._deleteSession("persisted", row.id);
§§§§if (persistedWriteCount > 0 || persistentDeletes.length > 0) db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(nextMainGeneration);
""",
))

# 1c: signature.
LIB_PAIRS_RAW.append((
    """§async _observeStable(indexed, signal) {
""",
    """§async _observeStable(indexed, signal, commitPersisted) {
""",
))

# 2a+2b+2c+2d+2e.
LIB_PAIRS_RAW.append((
    """§§§§persisted = materializePersistenceSnapshots(before);
§§§§for (const entry of persisted.values()) {
§§§§§if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue;
§§§§§if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== void 0) continue;
§§§§§assertNotAborted(signal);
§§§§§const loaded = await readColdSessionLog(persistence, entry.header.id, signal);
§§§§§assertNotAborted(signal);
§§§§§assertSessionHeadersCompatible(entry.header, loaded.header);
§§§§§entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events);
§§§§}
§§§§assertNotAborted(signal);
§§§§const afterSnapshots = await persistence.list(listOptions);
§§§§assertNotAborted(signal);
§§§§const after = materializePersistenceSnapshots(afterSnapshots);
§§§§if (!samePersistenceSnapshots(persisted, after)) continue;
§§§§if (this._persistenceBinding !== persistenceBinding) continue;
""",
    """§§§§persisted = materializePersistenceSnapshots(before);
§§§§// [R3-fix] incremental per-session commit: isolate per-session failures,
§§§§// commit each observed session immediately, and narrow the stability
§§§§// comparison to the sessions this attempt actually cold-read.
§§§§const coldReadRevisions = /* @__PURE__ */ new Map();
§§§§const coldReadFailures = [];
§§§§let coldReadAttempts = 0;
§§§§let coldReadSuccesses = 0;
§§§§for (const entry of persisted.values()) {
§§§§§if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue;
§§§§§if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== void 0) continue;
§§§§§assertNotAborted(signal);
§§§§§coldReadRevisions.set(entry.header.id, entry.revision);
§§§§§coldReadAttempts += 1;
§§§§§try {
§§§§§§const loaded = await readColdSessionLog(persistence, entry.header.id, signal);
§§§§§§assertNotAborted(signal);
§§§§§§assertSessionHeadersCompatible(entry.header, loaded.header);
§§§§§§const observed = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events);
§§§§§§commitPersisted(entry, observed);
§§§§§§coldReadSuccesses += 1;
§§§§§} catch (error) {
§§§§§§if (isAbort(error) || signal?.aborted) throw error;
§§§§§§if (this._persistenceBinding !== persistenceBinding) throw error;
§§§§§§coldReadFailures.push({ id: entry.header.id, error });
§§§§§§this.ctx.logger?.warn?.(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`);
§§§§§}
§§§§}
§§§§if (coldReadAttempts > 0 && coldReadSuccesses === 0) {
§§§§§const firstFailure = coldReadFailures[0];
§§§§§throw new SessionQueryError(`session-search persistence observation failed: ${errorMessage(firstFailure?.error)}`, "SESSION_QUERY_PERSISTENCE_FAILED", { cause: firstFailure?.error });
§§§§}
§§§§assertNotAborted(signal);
§§§§const afterSnapshots = await persistence.list(listOptions);
§§§§assertNotAborted(signal);
§§§§const after = materializePersistenceSnapshots(afterSnapshots);
§§§§let coldReadStable = true;
§§§§for (const [id, revision] of coldReadRevisions) {
§§§§§const first = persisted.get(id);
§§§§§const second = after.get(id);
§§§§§if (first === void 0 || second === void 0 || revision !== second.revision || !sameHeader(first.header, second.header)) {
§§§§§§coldReadStable = false;
§§§§§§break;
§§§§§}
§§§§}
§§§§if (!coldReadStable) continue;
§§§§if (this._persistenceBinding !== persistenceBinding) continue;
""",
))

# 2e: delete helper.
LIB_PAIRS_RAW.append((
    """function samePersistenceSnapshots(before, after) {
§if (before.size !== after.size) return false;
§for (const [id, first] of before) {
§§const second = after.get(id);
§§if (second === void 0 || first.revision !== second.revision || !sameHeader(first.header, second.header)) return false;
§}
§return true;
}
function sameSessionIds(before, after) {
""",
    """function sameSessionIds(before, after) {
""",
))


def expand(pair: tuple[str, str]) -> tuple[str, str]:
    return pair[0].replace("§", "\t"), pair[1].replace("§", "\t")


def main() -> None:
    src = (ROOT / "baseline/src/index.ts").read_text(encoding="utf-8")
    lib = (ROOT / "baseline/lib/index.js").read_text(encoding="utf-8")
    src = apply(src, SRC_PAIRS, "src")
    lib = apply(lib, [expand(p) for p in LIB_PAIRS_RAW], "lib")

    # Clause 4 markers + clause 1d/2e removal self-checks.
    for label, text in (("src", src), ("lib", lib)):
        assert text.count(MARKER) == 2, f"{label}: expected 2 markers"
        for forbidden in ("entry.loaded", "persistentChanges", "samePersistenceSnapshots"):
            assert forbidden not in text, f"{label}: leftover {forbidden}"
    assert "loaded?: ObservedSession" not in src
    # Clause 3 guards: untouched anchors must survive verbatim.
    for anchor in (
        "NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)",
        "SESSION_QUERY_STALE_CURSOR",
        "_replacePersistedSession(",
        "_replaceLiveSession(",
    ):
        assert anchor in src and anchor in lib, f"missing preserved anchor {anchor}"

    (ROOT / "patched/src/index.ts").write_text(src, encoding="utf-8")
    (ROOT / "patched/lib/index.js").write_text(lib, encoding="utf-8")
    print("PATCHED FILES WRITTEN: patched/src/index.ts, patched/lib/index.js")


if __name__ == "__main__":
    main()
