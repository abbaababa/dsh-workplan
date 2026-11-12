#!/usr/bin/env python3
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
    "src/index.ts": "72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3",
    "lib/index.js": "dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0",
}
PATCHED_SHA256 = {
    "src/index.ts": "ee4d11b8ae26326d1397491295c3d9303cd9ffaf4a0ced1c292ba2278eee7bd6",
    "lib/index.js": "574ef3ccd75025aaa3546890395aceb9fc4f9565ad364ffbabcaa9e7b74b4114",
}
SRC_CONTENT = r"""/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  sanitizeFtsText,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

// One transient source change gets a retry; repeated churn fails rather than monopolizing the queue.
const STABLE_OBSERVATION_ATTEMPTS = 2

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedSession>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _prewarmAbort = new AbortController()
  private readonly _optionalPersistenceFiber: Fiber

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt !== 'startup') return
    await this._ensureReady(undefined)
    // [R3-fix] startup background pre-warm: build the index off the tool budget.
    // Fire-and-forget so activation never blocks; failures are only logged.
    void this._serialized(this._prewarmAbort.signal, async () => {
      await this._reconcile(this._prewarmAbort.signal)
    }).catch((error: unknown) => {
      if (isAbort(error)) return
      try {
        this.ctx.logger('session-query-sqlite').warn(`[R3-fix] startup pre-warm failed: ${errorMessage(error)}`)
      } catch {
        // Logging must never throw.
      }
    })
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    this._prewarmAbort.abort()
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
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
        // [R3-fix] keep the persisted generation in sync with committed rows even
        // if the round aborts later (idempotent within the round).
        db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
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
    let observation: Observation
    try {
      observation = await this._observeStable(persistedById, signal, commitPersisted)
    } catch (error: unknown) {
      // [R3-fix] an aborted/failed round keeps its committed rows: advance the
      // session-cursor change token so stale cursors are rejected after partial
      // progress (the persisted generation was already synced per commit).
      if (persistedWriteCount > 0) this._globalGeneration += 1
      throw error
    }
    assertNotAborted(signal)
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : persistedRows.filter(row => !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity
    const hasWrites = persistedWriteCount > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextLocalGeneration = this._localGeneration
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        if (persistedWriteCount > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
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
        // [R3-fix] trailing-transaction failure: committed rows already advanced
        // the persisted generation; keep the session-cursor token in sync too.
        if (persistedWriteCount > 0) this._globalGeneration += 1
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    return observation.persistenceBinding
  }

  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
    commitPersisted: (entry: ObservedPersistedSession, observed: ObservedSession) => void,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      if (persistence !== undefined) {
        try {
          const canReuseIndexed = this._lastPersistenceIdentity === undefined
            || this._lastPersistenceIdentity === persistenceBinding.identity
          const listOptions = signal === undefined ? undefined : { signal }
          const before = await persistence.list(listOptions)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          // [R3-fix] incremental per-session commit: isolate per-session failures,
          // commit each observed session immediately, and narrow the stability
          // comparison to the sessions this attempt actually cold-read.
          const coldReadRevisions = new Map<SessionId, SessionPersistenceRevision>()
          const coldReadFailures: { id: SessionId, error: unknown }[] = []
          let coldReadAttempts = 0
          let coldReadSuccesses = 0
          let skippedAsIndexed = 0
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) {
              skippedAsIndexed += 1
              continue
            }
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
              // [R3-fix] index-level commit failures are not isolatable read failures.
              if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_INDEX_FAILED') throw error
              coldReadFailures.push({ id: entry.header.id, error })
              try {
                this.ctx.logger('session-query-sqlite').warn(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`)
              } catch {
                // Best-effort logging must never affect reconciliation.
              }
            }
          }
          // [R3-fix] fuse only for total failure: any revision-gated skip proves
          // the list+index path is usable, so isolated bad archives must not
          // fail quiet follow-up searches whose only cold reads are known-bad.
          if (coldReadAttempts > 0 && coldReadSuccesses === 0 && skippedAsIndexed === 0) {
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
        } catch (error: unknown) {
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (!sameSessionIds(initiallyLive, live)) continue
      return { persistenceBinding, persisted, live }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _replaceLiveSession(entry: ObservedSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

function selectedDocumentsParams(query: string, persistenceVisible: boolean): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8'),
  ]
}

function observeLive(session: Session): ObservedSession {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
}

function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function sameSessionIds(
  before: ReadonlySet<SessionId>,
  after: ReadonlyMap<SessionId, ObservedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const id of before) {
    if (!after.has(id)) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine
"""

LIB_CONTENT = r"""import { createHash, randomUUID } from "node:crypto";
import { SESSION_FORMAT_VERSION, SessionSeq } from "@deepseek-ai/dsh-session";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import SessionQueryEngine, { SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY, SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE, SESSION_QUERY_READ_WINDOW_MAX, SessionQueryError, SessionSearchCursor, assertSessionHeadersCompatible, buildSessionEventSearchDocuments, materializeSessionEventResultFilters, materializeSessionResultFilters, readColdSessionLog } from "@deepseek-ai/dsh-session-query";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
//#region lib/types/schema.js
/** SQLite schema for the disposable session full-text read model. */
/** Current derived-index schema version. Incompatible versions reset in place. */
const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8;
/** SQLite application id protecting unrelated databases from derived resets. */
const SESSION_QUERY_SQLITE_APPLICATION_ID = 1146308689;
const DERIVED_USER_TABLES = new Set([
	"search_state",
	"persisted_sessions",
	"persisted_docs",
	"persisted_docs_data",
	"persisted_docs_idx",
	"persisted_docs_content",
	"persisted_docs_docsize",
	"persisted_docs_config"
]);
/**
* Exclusively create a missing database file with owner-only permissions.
* Existing files retain their modes, and errors other than `EEXIST` propagate.
*/
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
/**
* Open, validate, and initialize persistent and connection-local schemas.
* @param path - dedicated derived-index path or `:memory:`; missing filesystem paths are created owner-only.
* @param journalMode - validated SQLite journal mode.
* @returns initialized database handle owned by the search service.
*/
async function openSearchDatabase(path, journalMode) {
	const actual = path === ":memory:" ? path : resolve(path);
	if (actual !== ":memory:") {
		await mkdir(dirname(actual), {
			recursive: true,
			mode: 448
		});
		await createDatabaseFile(actual);
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(actual);
	try {
		const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
		const { user_version: version } = db.prepare("PRAGMA user_version").get();
		const userTables = listUserTables(db);
		if (applicationId !== 0 && applicationId !== 1146308689) throw new Error(`session-search database at "${actual}" belongs to another application`);
		if (applicationId === 0 && userTables.length > 0) throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`);
		if (applicationId === 1146308689) {
			assertDerivedUserTables(actual, userTables);
			if (version !== 8) resetDerivedSchema(db, userTables);
		}
		db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
		ensurePersistentSchema(db);
		ensureTemporarySchema(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
function listUserTables(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map((row) => row.name);
}
function assertDerivedUserTables(path, userTables) {
	const unknownTables = userTables.filter((name) => !DERIVED_USER_TABLES.has(name));
	if (unknownTables.length > 0) throw new Error(`session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(", ")}`);
}
function resetDerivedSchema(db, userTables) {
	for (const name of userTables) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
	db.exec("PRAGMA user_version = 0");
}
function ensurePersistentSchema(db) {
	db.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)");
	db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `);
	db.exec(`PRAGMA user_version = 8`);
}
function ensureTemporarySchema(db) {
	db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `);
}
function quoteIdentifier(value) {
	return `"${value.replaceAll("\"", "\"\"")}"`;
}
/** Largest page size whose internal lookahead remains an exact SQLite integer binding. */
const SQLITE_MAX_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1;
/** Portable host-parameter ceiling shared by predicate and statement builders. */
const SQLITE_PORTABLE_VARIABLE_LIMIT = 32766;
/**
* Reject prospective SQLite binding growth beyond the portable ceiling.
* @param count - binding count at the current construction boundary.
*/
function assertPortableBindingCount(count) {
	if (count > 32766) throw new SessionQueryError(`session-search request exceeds SQLite's portable ${SQLITE_PORTABLE_VARIABLE_LIMIT}-variable limit; reduce filter values`, "SESSION_QUERY_INVALID_FILTER");
}
/**
* Reject compiled outer predicates beyond the supported FTS5 planner budget.
* @param count - predicate count including fixed statement predicates.
*/
function assertFts5OuterPredicateCount(count) {
	if (count > 14) throw new SessionQueryError(`session-search request exceeds the supported SQLite FTS5 outer-predicate budget of 14; reduce filters`, "SESSION_QUERY_INVALID_FILTER");
}
/**
* Validate and canonicalize a cross-session request.
* @param request - caller-provided query, filters, limit, and cursor.
* @param limits - configured default and maximum page sizes.
* @returns normalized request with explicit arrays and limit.
*/
function normalizeSessionRequest(request, limits) {
	const sessionFilters = materializeSessionResultFilters(request.sessionFilters ?? []);
	const eventFilters = materializeMetadataFilters(request.eventFilters ?? []);
	const cursor = materializeCursor(request.cursor);
	return {
		query: normalizeQuery(request.query),
		sessionFilters,
		eventFilters,
		limit: normalizeLimit(request.limit, limits),
		...cursor === void 0 ? {} : { cursor }
	};
}
/**
* Validate and canonicalize a within-session request.
* @param request - caller-provided target, query, filters, limit, and cursor.
* @param limits - configured default and maximum page sizes.
* @returns normalized request with an explicit filter array and limit.
*/
function normalizeEventRequest(request, limits) {
	if (typeof request.sessionId !== "string") throw new SessionQueryError("session-search session id must be text", "SESSION_QUERY_INVALID_FILTER");
	const filters = materializeMetadataFilters(request.filters ?? []);
	const cursor = materializeCursor(request.cursor);
	return {
		sessionId: request.sessionId,
		query: normalizeQuery(request.query),
		filters,
		limit: normalizeLimit(request.limit, limits),
		...cursor === void 0 ? {} : { cursor }
	};
}
/**
* Compile logical-session predicates against selected-document columns.
* @param filters - validated ANDed logical-session clauses.
* @returns parameterized SQL fragment and ordered bindings.
*/
function buildSessionWhere(filters) {
	const clauses = [];
	const params = [];
	for (const filter of filters) switch (filter.kind) {
		case "id":
			addList(clauses, params, "session_id", filter.values);
			break;
		case "cwd":
			addNullableList(clauses, params, "cwd", filter.values);
			break;
		case "created-at":
			addRange(clauses, params, "created_at", filter);
			break;
		case "parent":
			addNullableList(clauses, params, "parent_session", filter.values);
			break;
		case "availability": {
			const availability = [...new Set(filter.values)];
			if (availability.length === 0) clauses.push("0");
			else if (availability.length === 1) {
				const value = availability[0];
				switch (value) {
					case "live":
						clauses.push("live = 1");
						break;
					case "persisted":
						clauses.push("persisted = 1");
						break;
					default: unknownAvailability(value);
				}
			}
			break;
		}
		default: unknownFilter(filter);
	}
	assertFts5OuterPredicateCount(clauses.length);
	return {
		sql: clauses.join(" AND "),
		params,
		predicateCount: clauses.length
	};
}
/**
* Compile event metadata predicates against selected-document columns.
* @param filters - validated ANDed event metadata clauses.
* @returns parameterized SQL fragment and ordered bindings.
*/
function buildEventWhere(filters) {
	const clauses = [];
	const params = [];
	for (const filter of filters) switch (filter.kind) {
		case "seq":
			addRange(clauses, params, "seq", filter);
			break;
		case "time":
			addRange(clauses, params, "time", filter);
			break;
		case "type":
			addList(clauses, params, "type", filter.values);
			break;
		case "surface":
			addList(clauses, params, "surface", filter.values);
			break;
		default: unknownFilter(filter);
	}
	assertFts5OuterPredicateCount(clauses.length);
	return {
		sql: clauses.join(" AND "),
		params,
		predicateCount: clauses.length
	};
}
/**
* Quote caller text as one FTS5 phrase so query syntax remains inert data.
* @param query - normalized caller query.
* @returns FTS5 expression containing one escaped literal phrase.
*/
function quoteFtsData(query) {
	return `"${query.replaceAll("\"", "\"\"")}"`;
}
/**
* Remove reserved marker collisions before text enters FTS5 or MATCH.
* @param text - extracted document text or normalized caller query.
* @returns text with reserved noncharacters mapped to replacement characters.
*/
function sanitizeFtsText(text) {
	return text.replaceAll("\0", "�").replaceAll("﷐", "�").replaceAll("﷑", "�");
}
/**
* Build the stable normalized request identity stored in opaque cursors.
* @param request - normalized request whose filter ordering is canonicalized.
* @returns deterministic JSON identity for cursor binding.
*/
function requestFingerprint(request) {
	if ("sessionId" in request) return JSON.stringify({
		scope: "events",
		sessionId: request.sessionId,
		query: request.query,
		filters: canonicalFilters(request.filters),
		limit: request.limit
	});
	return JSON.stringify({
		scope: "sessions",
		query: request.query,
		sessionFilters: canonicalFilters(request.sessionFilters),
		eventFilters: canonicalFilters(request.eventFilters),
		limit: request.limit
	});
}
/**
* Build a whitespace-normalized excerpt no longer than `maxChars`.
* @param markedText - complete document with FTS5 `highlight()` markers.
* @param maxChars - maximum result length in Unicode code points.
* @returns bounded plain-text snippet.
*/
function makeSnippet(markedText, maxChars) {
	const { text: clean, matchStart } = normalizeMarkedText(markedText);
	const characters = Array.from(clean);
	if (characters.length <= maxChars) return clean;
	if (maxChars === 1) return "…";
	const matchedIndex = Math.min(matchStart, characters.length - 1);
	let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3));
	const prefix = start > 0 ? "…" : "";
	let suffix = "…";
	let contentLength = maxChars - prefix.length - suffix.length;
	if (contentLength < 1) {
		start = matchedIndex;
		suffix = "";
		contentLength = maxChars - prefix.length - suffix.length;
	} else if (matchedIndex >= start + contentLength) start = matchedIndex - contentLength + 1;
	let end = Math.min(characters.length, start + contentLength);
	if (end === characters.length) {
		suffix = "";
		contentLength = maxChars - prefix.length;
		start = Math.max(0, end - contentLength);
	}
	end = Math.min(characters.length, start + contentLength);
	return `${prefix}${characters.slice(start, end).join("")}${suffix}`;
}
function normalizeMarkedText(markedText) {
	const characters = [];
	let matchStart;
	for (const character of markedText) {
		if (character === "﷐") {
			matchStart ??= characters.length;
			continue;
		}
		if (character === "﷑") continue;
		if (/\s/u.test(character)) {
			if (characters.length > 0 && characters.at(-1) !== " ") characters.push(" ");
		} else characters.push(character);
	}
	if (characters.at(-1) === " ") characters.pop();
	return {
		text: characters.join(""),
		matchStart: matchStart ?? 0
	};
}
function normalizeQuery(value) {
	if (typeof value !== "string") throw new SessionQueryError("session-search query must be text", "SESSION_QUERY_INVALID_QUERY");
	const query = value.trim().replace(/\s+/gu, " ");
	if (query.length === 0) throw new SessionQueryError("session-search query must contain non-whitespace text", "SESSION_QUERY_INVALID_QUERY");
	if (query.includes("\0")) throw new SessionQueryError("session-search query must not contain NUL", "SESSION_QUERY_INVALID_QUERY");
	return sanitizeFtsText(query);
}
function materializeCursor(cursor) {
	if (cursor === void 0) return void 0;
	if (typeof cursor !== "string") throw new SessionQueryError("session-search cursor must be text", "SESSION_QUERY_INVALID_CURSOR");
	return cursor;
}
function materializeMetadataFilters(filters) {
	const candidates = filters;
	for (const filter of candidates) switch (filter.kind) {
		case "seq":
		case "time":
		case "type":
		case "surface": break;
		case "text": throw new SessionQueryError("session-search metadata filters do not accept text clauses", "SESSION_QUERY_INVALID_FILTER");
		default: unknownFilter(filter);
	}
	return materializeSessionEventResultFilters(filters);
}
function normalizeLimit(value, limits) {
	const limit = value ?? limits.defaultLimit;
	const maxLimit = Math.min(limits.maxLimit, SQLITE_MAX_PAGE_LIMIT);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new SessionQueryError(`session-search limit must be an integer between 1 and ${maxLimit}`, "SESSION_QUERY_INVALID_LIMIT");
	return limit;
}
function addList(clauses, params, column, values) {
	if (values.length === 0) {
		clauses.push("0");
		return;
	}
	clauses.push(`${column} IN (${appendListBindings(params, values)})`);
}
function addNullableList(clauses, params, column, values) {
	if (values.length === 0) {
		clauses.push("0");
		return;
	}
	const concrete = values.filter((value) => value !== null);
	const parts = [];
	if (concrete.length > 0) parts.push(`${column} IN (${appendListBindings(params, concrete)})`);
	if (values.includes(null)) parts.push(`${column} IS NULL`);
	clauses.push(`(${parts.join(" OR ")})`);
}
function addRange(clauses, params, column, range) {
	if (range.from !== void 0) {
		assertPortableBindingCount(params.length + 1);
		clauses.push(`CAST(${column} AS INTEGER) >= ?`);
		params.push(range.from);
	}
	if (range.to !== void 0) {
		assertPortableBindingCount(params.length + 1);
		clauses.push(`CAST(${column} AS INTEGER) <= ?`);
		params.push(range.to);
	}
}
function appendListBindings(params, values) {
	assertPortableBindingCount(params.length + values.length);
	for (const value of values) params.push(value);
	return values.map(() => "?").join(", ");
}
function canonicalFilters(filters) {
	return filters.map((filter) => {
		if ("values" in filter) return {
			...filter,
			values: [...filter.values].sort(compareNullable)
		};
		return {
			kind: filter.kind,
			from: filter.from ?? null,
			to: filter.to ?? null
		};
	}).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function compareNullable(a, b) {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	return a.localeCompare(b);
}
function unknownAvailability(value) {
	throw new SessionQueryError(`session availability filter contains unknown value "${String(value)}"`, "SESSION_QUERY_INVALID_FILTER");
}
function unknownFilter(filter) {
	const kind = filter.kind;
	throw new SessionQueryError(`session filter contains unknown kind ${typeof kind === "string" ? `"${kind}"` : "(missing)"}`, "SESSION_QUERY_INVALID_FILTER");
}
//#endregion
//#region lib/types/index.js
/**
* Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
*
* @module @deepseek-ai/dsh-session-query-sqlite
*/
/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
const SESSION_QUERY_SQLITE_PATH_KEY = "launcherSessionQueryPath";
/** Default result page size. */
const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20;
/** Maximum accepted result page size. */
const SESSION_QUERY_SQLITE_MAX_LIMIT = 100;
/** Default maximum snippet length in Unicode code points. */
const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240;
const STABLE_OBSERVATION_ATTEMPTS = 2;
/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
var SqliteSessionQueryEngine = class extends SessionQueryEngine {
	static inject = ["sessions"];
	static Config = z.object({
		path: z.string().required(),
		openAt: z.union([
			"startup",
			"first-search",
			"never"
		]).default("startup"),
		journalMode: z.union([
			"wal",
			"delete",
			"truncate",
			"persist"
		]).default("wal"),
		defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(20),
		maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(100),
		snippetChars: z.number().step(1).min(1).default(240),
		readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
		persistedReadConcurrency: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
		preparedSessionCacheSize: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE)
	});
	/** Validated and defaulted backend configuration. */
	config;
	_instance = randomUUID();
	_ready;
	_db;
	_persistenceBinding = { identity: Symbol() };
	_lastPersistenceIdentity;
	_persistenceEpoch = 0;
	_globalGeneration = 0;
	_localGeneration = 0;
	_tail = Promise.resolve();
	_closed = false;
	_closePromise;
	_prewarmAbort = new AbortController();
	_optionalPersistenceFiber;
	constructor(ctx, config) {
		super(ctx, config = resolveConfig(config));
		this.config = config;
		this._optionalPersistenceFiber = ctx.inject(["sessionPersistence"], (childCtx) => {
			const service = childCtx.sessionPersistence;
			const binding = {
				identity: Symbol(),
				service
			};
			this._persistenceBinding = binding;
			childCtx.effect(() => () => {
				/* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
				if (this._persistenceBinding !== binding) return;
				this._persistenceBinding = { identity: Symbol() };
			}, "sessionQuerySqlite.persistenceBinding");
		});
		ctx.effect(() => {
			return () => this._optionalPersistenceFiber.dispose();
		}, "sessionQuerySqlite.optionalPersistence");
		ctx.effect(() => async () => this.close(), "sessionQuerySqlite.close");
	}
	/** Open eagerly only when activation owns the configured readiness boundary. */
	async [Service.init]() {
		if (this.config.openAt !== "startup") return;
		await this._ensureReady(void 0);
		// [R3-fix] startup background pre-warm: build the index off the tool budget.
		// Fire-and-forget so activation never blocks; failures are only logged.
		void this._serialized(this._prewarmAbort.signal, async () => {
			await this._reconcile(this._prewarmAbort.signal);
		}).catch((error) => {
			if (isAbort(error)) return;
			try {
				this.ctx.logger("session-query-sqlite").warn(`[R3-fix] startup pre-warm failed: ${errorMessage(error)}`);
			} catch {}
		});
	}
	async searchSessions(request, exec) {
		this._assertSearchEnabled();
		const normalized = normalizeSessionRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			await this._ensureReady(signal);
			const persistenceBinding = await this._reconcile(signal);
			assertNotAborted(signal);
			const generation = String(this._globalGeneration);
			const fingerprint = requestFingerprint(normalized);
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "sessions", fingerprint, generation);
			return page(this._querySessions(normalized, offset, persistenceBinding), normalized.limit, (row) => this._sessionHit(row), (cursorOffset) => encodeCursor({
				version: 1,
				instance: this._instance,
				scope: "sessions",
				fingerprint,
				generation,
				offset: cursorOffset
			}), offset);
		});
	}
	async searchEvents(request, exec) {
		this._assertSearchEnabled();
		const normalized = normalizeEventRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			await this._ensureReady(signal);
			const persistenceBinding = await this._reconcile(signal);
			assertNotAborted(signal);
			const target = this._targetObservation(normalized.sessionId, persistenceBinding);
			const fingerprint = requestFingerprint(normalized);
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "events", fingerprint, target.generation);
			const rows = this._queryEvents(normalized, offset, persistenceBinding);
			return {
				session: target.header,
				...page(rows, normalized.limit, (row) => this._eventHit(row), (cursorOffset) => encodeCursor({
					version: 1,
					instance: this._instance,
					scope: "events",
					fingerprint,
					generation: target.generation,
					offset: cursorOffset
				}), offset)
			};
		});
	}
	/** Close the database after every accepted operation reaches quiescence. */
	close() {
		this._closePromise ??= this._close();
		return this._closePromise;
	}
	/**
	* Refuse full-text calls under `openAt: 'never'` before any request
	* normalization or SQLite work, so a disabled deployment never imports
	* node:sqlite, opens the index, or observes sources.
	*/
	_assertSearchEnabled() {
		if (this.config.openAt !== "never") return;
		throw new SessionQueryError("session search is disabled: this deployment configures the session-query index with openAt \"never\"", "SESSION_QUERY_SEARCH_DISABLED");
	}
	async _close() {
		this._closed = true;
		this._prewarmAbort.abort();
		await this._tail;
		if (this._ready !== void 0) try {
			await this._ready;
		} catch {}
		this._db?.close();
		this._db = void 0;
	}
	async _open() {
		this._db = await openSearchDatabase(this.config.path, this.config.journalMode);
		const state = this._db.prepare("SELECT global_generation FROM search_state WHERE singleton = 1").get();
		this._globalGeneration = state.global_generation;
		this._localGeneration = state.global_generation;
	}
	async _ensureReady(signal) {
		this._ready ??= this._open();
		try {
			await waitWithAbort(this._ready, signal);
		} catch (error) {
			if (isAbort(error)) throw error;
			throw new SessionQueryError(`session-search SQLite index failed to open: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
		}
	}
	async _serialized(signal, operation) {
		if (this._isClosed()) throw indexClosed();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const prior = this._tail;
		this._tail = prior.then(() => gate);
		try {
			await waitWithAbort(prior, signal);
		} catch (error) {
			release();
			throw error;
		}
		if (this._isClosed()) {
			release();
			throw indexClosed();
		}
		try {
			assertNotAborted(signal);
			return await operation();
		} finally {
			release();
		}
	}
	async _reconcile(signal) {
		assertNotAborted(signal);
		const db = this._requireDb();
		const persistedRows = db.prepare("SELECT id, revision, generation FROM persisted_sessions").all();
		const liveRows = db.prepare("SELECT id, fingerprint, persisted, generation FROM temp.live_sessions").all();
		const persistedById = new Map(persistedRows.map((row) => [row.id, row]));
		const liveById = new Map(liveRows.map((row) => [row.id, row]));
		// [R3-fix] incremental per-session commit: fix the target generation before
		// observing so every cold-read session can be committed atomically on its own.
		const nextMainGeneration = this._mainGeneration() + 1;
		let persistedWriteCount = 0;
		const commitPersisted = (entry, observed) => {
			let began = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				began = true;
				this._replacePersistedSession(observed, entry.revision, nextMainGeneration);
				// [R3-fix] keep the persisted generation in sync with committed rows even
				// if the round aborts later (idempotent within the round).
				db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(nextMainGeneration);
				db.exec("COMMIT");
			} catch (error) {
				/* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
				if (began)
					/* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
					try {
						db.exec("ROLLBACK");
					} catch {}
				throw new SessionQueryError(`session-search reconciliation failed: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
			}
			persistedWriteCount += 1;
			persistedById.set(entry.header.id, { id: entry.header.id, revision: entry.revision, generation: nextMainGeneration });
		};
		let observation;
		try {
			observation = await this._observeStable(persistedById, signal, commitPersisted);
		} catch (error) {
			// [R3-fix] an aborted/failed round keeps its committed rows: advance the
			// session-cursor change token so stale cursors are rejected after partial
			// progress (the persisted generation was already synced per commit).
			if (persistedWriteCount > 0) this._globalGeneration += 1;
			throw error;
		}
		assertNotAborted(signal);
		const persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => !observation.persisted.has(row.id));
		const liveChanges = [...observation.live.values()].filter((entry) => {
			const indexed = liveById.get(entry.header.id);
			const persisted = observation.persisted.has(entry.header.id) ? 1 : 0;
			return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted;
		});
		const liveDeletes = liveRows.filter((row) => !observation.live.has(row.id));
		const pointerChanged = this._lastPersistenceIdentity !== void 0 && this._lastPersistenceIdentity !== observation.persistenceBinding.identity;
		const hasWrites = persistedWriteCount > 0 || persistentDeletes.length > 0 || liveChanges.length > 0 || liveDeletes.length > 0;
		let nextLocalGeneration = this._localGeneration;
		const liveReplacements = liveChanges.map((entry) => {
			nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1;
			return {
				entry,
				generation: nextLocalGeneration,
				persisted: observation.persisted.has(entry.header.id)
			};
		});
		if (hasWrites) {
			let began = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				began = true;
				for (const row of persistentDeletes) this._deleteSession("persisted", row.id);
				if (persistedWriteCount > 0 || persistentDeletes.length > 0) db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(nextMainGeneration);
				for (const row of liveDeletes) this._deleteSession("live", row.id);
				for (const { entry, generation, persisted } of liveReplacements) this._replaceLiveSession(entry, generation, persisted);
				db.exec("COMMIT");
			} catch (error) {
				/* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
				if (began)
 /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
				try {
					db.exec("ROLLBACK");
				} catch {}
				// [R3-fix] trailing-transaction failure: committed rows already advanced
				// the persisted generation; keep the session-cursor token in sync too.
				if (persistedWriteCount > 0) this._globalGeneration += 1;
				throw new SessionQueryError(`session-search reconciliation failed: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
			}
		}
		if (hasWrites || pointerChanged) this._globalGeneration += 1;
		if (pointerChanged) this._persistenceEpoch += 1;
		this._localGeneration = nextLocalGeneration;
		this._lastPersistenceIdentity = observation.persistenceBinding.identity;
		return observation.persistenceBinding;
	}
	async _observeStable(indexed, signal, commitPersisted) {
		for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
			assertNotAborted(signal);
			const persistenceBinding = this._persistenceBinding;
			const persistence = persistenceBinding.service;
			const initiallyLive = new Set(this.ctx.sessions.list().map((session) => session.id));
			let persisted = /* @__PURE__ */ new Map();
			if (persistence !== void 0) try {
				const canReuseIndexed = this._lastPersistenceIdentity === void 0 || this._lastPersistenceIdentity === persistenceBinding.identity;
				const listOptions = signal === void 0 ? void 0 : { signal };
				const before = await persistence.list(listOptions);
				assertNotAborted(signal);
				persisted = materializePersistenceSnapshots(before);
				// [R3-fix] incremental per-session commit: isolate per-session failures,
				// commit each observed session immediately, and narrow the stability
				// comparison to the sessions this attempt actually cold-read.
				const coldReadRevisions = /* @__PURE__ */ new Map();
				const coldReadFailures = [];
				let coldReadAttempts = 0;
				let coldReadSuccesses = 0;
				let skippedAsIndexed = 0;
				for (const entry of persisted.values()) {
					if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) {
						skippedAsIndexed += 1;
						continue;
					}
					if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== void 0) continue;
					assertNotAborted(signal);
					coldReadRevisions.set(entry.header.id, entry.revision);
					coldReadAttempts += 1;
					try {
						const loaded = await readColdSessionLog(persistence, entry.header.id, signal);
						assertNotAborted(signal);
						assertSessionHeadersCompatible(entry.header, loaded.header);
						const observed = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events);
						commitPersisted(entry, observed);
						coldReadSuccesses += 1;
					} catch (error) {
						if (isAbort(error) || signal?.aborted) throw error;
						if (this._persistenceBinding !== persistenceBinding) throw error;
						// [R3-fix] index-level commit failures are not isolatable read failures.
						if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_INDEX_FAILED") throw error;
						coldReadFailures.push({ id: entry.header.id, error });
						try {
							this.ctx.logger("session-query-sqlite").warn(`session-search cold read failed for session "${entry.header.id}": ${errorMessage(error)}`);
						} catch {}
					}
				}
				// [R3-fix] fuse only for total failure: any revision-gated skip proves
				// the list+index path is usable, so isolated bad archives must not
				// fail quiet follow-up searches whose only cold reads are known-bad.
				if (coldReadAttempts > 0 && coldReadSuccesses === 0 && skippedAsIndexed === 0) {
					const firstFailure = coldReadFailures[0];
					throw new SessionQueryError(`session-search persistence observation failed: ${errorMessage(firstFailure?.error)}`, "SESSION_QUERY_PERSISTENCE_FAILED", { cause: firstFailure?.error });
				}
				assertNotAborted(signal);
				const afterSnapshots = await persistence.list(listOptions);
				assertNotAborted(signal);
				const after = materializePersistenceSnapshots(afterSnapshots);
				let coldReadStable = true;
				for (const [id, revision] of coldReadRevisions) {
					const first = persisted.get(id);
					const second = after.get(id);
					if (first === void 0 || second === void 0 || revision !== second.revision || !sameHeader(first.header, second.header)) {
						coldReadStable = false;
						break;
					}
				}
				if (!coldReadStable) continue;
				if (this._persistenceBinding !== persistenceBinding) continue;
			} catch (error) {
				if (isAbort(error) || signal?.aborted) throw new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED", { cause: error });
				if (this._persistenceBinding !== persistenceBinding) continue;
				if (error instanceof SessionQueryError) throw error;
				throw new SessionQueryError(`session-search persistence observation failed: ${errorMessage(error)}`, "SESSION_QUERY_PERSISTENCE_FAILED", { cause: error });
			}
			const live = /* @__PURE__ */ new Map();
			for (const session of this.ctx.sessions.list()) {
				const observed = observeLive(session);
				const durable = persisted.get(session.id);
				if (durable !== void 0) assertSessionHeadersCompatible(observed.header, durable.header);
				live.set(session.id, observed);
			}
			if (!sameSessionIds(initiallyLive, live)) continue;
			return {
				persistenceBinding,
				persisted,
				live
			};
		}
		throw new SessionQueryError("session-search persistence observation did not stabilize after one retry", "SESSION_QUERY_PERSISTENCE_FAILED");
	}
	_mainGeneration() {
		return this._requireDb().prepare("SELECT global_generation FROM search_state WHERE singleton = 1").get().global_generation;
	}
	_deleteSession(source, id) {
		const db = this._requireDb();
		if (source === "persisted") {
			db.prepare("DELETE FROM persisted_docs WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM persisted_sessions WHERE id = ?").run(id);
		} else {
			db.prepare("DELETE FROM temp.live_docs WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM temp.live_sessions WHERE id = ?").run(id);
		}
	}
	_replacePersistedSession(entry, revision, generation) {
		this._deleteSession("persisted", entry.header.id);
		const db = this._requireDb();
		db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headerBindings(entry.header, entry.inheritedEventCount), revision, generation);
		const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
		for (const document of entry.documents) {
			const text = sanitizeFtsText(document.text);
			insert.run(text, document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length);
		}
	}
	_replaceLiveSession(entry, generation, persisted) {
		this._deleteSession("live", entry.header.id);
		const db = this._requireDb();
		db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headerBindings(entry.header, entry.inheritedEventCount), entry.fingerprint, persisted ? 1 : 0, generation);
		const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
		for (const document of entry.documents) {
			const text = sanitizeFtsText(document.text);
			insert.run(text, document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length);
		}
	}
	_querySessions(request, offset, persistenceBinding) {
		const selected = selectedDocumentsSql();
		const sessionWhere = buildSessionWhere(request.sessionFilters);
		const eventWhere = buildEventWhere(request.eventFilters);
		assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount);
		const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(" AND ");
		const bindings = [
			...selectedDocumentsParams(request.query, persistenceBinding.service !== void 0),
			...sessionWhere.params,
			...eventWhere.params,
			request.limit + 1,
			offset
		];
		assertPortableBindingCount(bindings.length);
		return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? "" : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings);
	}
	_queryEvents(request, offset, persistenceBinding) {
		const selected = selectedDocumentsSql();
		const eventWhere = buildEventWhere(request.filters);
		assertFts5OuterPredicateCount(1 + eventWhere.predicateCount);
		const where = ["session_id = ?", eventWhere.sql].filter(Boolean).join(" AND ");
		const bindings = [
			...selectedDocumentsParams(request.query, persistenceBinding.service !== void 0),
			request.sessionId,
			...eventWhere.params,
			request.limit + 1,
			offset
		];
		assertPortableBindingCount(bindings.length);
		return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings);
	}
	_targetObservation(sessionId, persistenceBinding) {
		const db = this._requireDb();
		const live = db.prepare(`SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`).get(sessionId);
		if (live !== void 0) return {
			header: rowHeader(live),
			generation: `live:${live.generation}`
		};
		if (persistenceBinding.service !== void 0) {
			const persisted = db.prepare(`SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`).get(sessionId);
			if (persisted !== void 0) return {
				header: rowHeader(persisted),
				generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`
			};
		}
		throw new SessionQueryError(`session "${sessionId}" not found`, "SESSION_QUERY_SESSION_NOT_FOUND");
	}
	_sessionHit(row) {
		return {
			header: rowHeader(row),
			live: row.live === 1,
			persisted: row.persisted === 1,
			bestMatch: this._eventHit(row)
		};
	}
	_eventHit(row) {
		return {
			sessionId: row.session_id,
			seq: SessionSeq(row.seq),
			type: row.type,
			time: row.time,
			surface: row.surface,
			snippet: makeSnippet(row.marked_text, this.config.snippetChars)
		};
	}
	_requireDb() {
		/* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
		if (this._db === void 0) throw indexClosed();
		return this._db;
	}
	_isClosed() {
		return this._closed;
	}
};
/**
* The header columns both session upserts bind, in the order their INSERT
* lists them. The two statements differ only in what they append after these.
* @param header - the session header being written.
* @returns one bound value per header column.
*/
function headerBindings(header, inheritedEventCount) {
	return [
		header.id,
		header.version,
		header.createdAt,
		header.cwd ?? null,
		header.parentSession ?? null,
		header.isSeeded ? inheritedEventCount : null,
		header.delegationDepth ?? null,
		header.agentPreset ?? null
	];
}
function selectedDocumentsSql() {
	return { sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )` };
}
function selectedDocumentsParams(query, persistenceVisible) {
	const expression = quoteFtsData(query);
	const visible = persistenceVisible ? 1 : 0;
	return [
		"﷐",
		"﷑",
		expression,
		visible,
		visible,
		"﷐",
		"﷑",
		expression,
		"﷐",
		Buffer.byteLength("﷐", "utf8")
	];
}
function observeLive(session) {
	return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents());
}
function observeSession(header, inheritedEventCount, events) {
	const detachedHeader = structuredClone(header);
	const detachedEvents = events.map((event) => structuredClone(event));
	return {
		header: detachedHeader,
		inheritedEventCount,
		documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
		fingerprint: createHash("sha256").update(JSON.stringify({
			header: detachedHeader,
			inheritedEventCount,
			events: detachedEvents
		})).digest("base64url")
	};
}
function materializePersistenceSnapshots(snapshots) {
	if (!isRuntimeArray(snapshots)) throw new Error("persistence snapshots must be an array");
	const result = /* @__PURE__ */ new Map();
	for (const snapshot of snapshots) {
		if (typeof snapshot.revision !== "string") throw new Error("persistence snapshot revision must be a string");
		const header = structuredClone(snapshot.header);
		if (result.has(header.id)) throw new Error(`persistence listed duplicate session "${header.id}"`);
		result.set(header.id, {
			header,
			revision: snapshot.revision
		});
	}
	return result;
}
function sameSessionIds(before, after) {
	if (before.size !== after.size) return false;
	for (const id of before) if (!after.has(id)) return false;
	return true;
}
function sameHeader(a, b) {
	return a.id === b.id && a.createdAt === b.createdAt && a.cwd === b.cwd && a.parentSession === b.parentSession && a.isSeeded === b.isSeeded && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0) && a.agentPreset === b.agentPreset;
}
function rowHeader(row) {
	return {
		version: SESSION_FORMAT_VERSION,
		id: row.session_id,
		createdAt: row.created_at,
		...row.cwd === null ? {} : { cwd: row.cwd },
		...row.parent_session === null ? {} : { parentSession: row.parent_session },
		isSeeded: row.seed_length !== null,
		...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
		...row.agent_preset === null ? {} : { agentPreset: row.agent_preset }
	};
}
function page(rows, limit, convert, nextCursor, offset) {
	const hasMore = rows.length > limit;
	return {
		items: rows.slice(0, limit).map(convert),
		...hasMore ? { nextCursor: nextCursor(offset + limit) } : {}
	};
}
function encodeCursor(payload) {
	return SessionSearchCursor(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
}
function decodeCursor(cursor, instance, scope, fingerprint, generation) {
	let decoded;
	try {
		decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch (error) {
		throw invalidCursor(error);
	}
	if (decoded.version !== 1 || decoded.instance !== instance || decoded.scope !== scope || decoded.fingerprint !== fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset === void 0 || decoded.offset < 0) throw invalidCursor(/* @__PURE__ */ new Error("cursor does not belong to this normalized request"));
	if (decoded.generation !== generation) throw new SessionQueryError("session-search cursor is stale because its relevant corpus changed", "SESSION_QUERY_STALE_CURSOR");
	return decoded.offset;
}
function invalidCursor(cause) {
	return new SessionQueryError("session-search cursor is invalid", "SESSION_QUERY_INVALID_CURSOR", { cause });
}
function resolveConfig(config) {
	const resolved = {
		path: config.path,
		openAt: config.openAt ?? "startup",
		journalMode: config.journalMode ?? "wal",
		defaultLimit: config.defaultLimit ?? 20,
		maxLimit: config.maxLimit ?? 100,
		snippetChars: config.snippetChars ?? 240,
		readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
		persistedReadConcurrency: config.persistedReadConcurrency ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
		preparedSessionCacheSize: config.preparedSessionCacheSize ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE
	};
	if (typeof resolved.path !== "string" || resolved.path.trim().length === 0) throw invalidConfig("path must not be blank");
	if (![
		"startup",
		"first-search",
		"never"
	].includes(resolved.openAt)) throw invalidConfig("openAt is not supported");
	assertPageLimit("defaultLimit", resolved.defaultLimit);
	assertPageLimit("maxLimit", resolved.maxLimit);
	assertPositiveInteger("snippetChars", resolved.snippetChars);
	if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) throw invalidConfig("readWindowMax must be a non-negative integer");
	if (!Number.isSafeInteger(resolved.persistedReadConcurrency) || resolved.persistedReadConcurrency < 1) throw invalidConfig("persistedReadConcurrency must be a positive safe integer");
	if (!Number.isSafeInteger(resolved.preparedSessionCacheSize) || resolved.preparedSessionCacheSize < 1) throw invalidConfig("preparedSessionCacheSize must be a positive safe integer");
	if (resolved.defaultLimit > resolved.maxLimit) throw invalidConfig("defaultLimit must be less than or equal to maxLimit");
	if (![
		"wal",
		"delete",
		"truncate",
		"persist"
	].includes(resolved.journalMode)) throw invalidConfig("journalMode is not supported");
	return resolved;
}
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`);
}
function assertPageLimit(name, value) {
	if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`);
}
function invalidConfig(detail) {
	return new SessionQueryError(`session-search SQLite config: ${detail}`, "SESSION_QUERY_INVALID_CONFIG");
}
function indexClosed() {
	return new SessionQueryError("session-search SQLite index is closed", "SESSION_QUERY_INDEX_FAILED");
}
function assertNotAborted(signal) {
	if (signal?.aborted) throw new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED");
}
function waitWithAbort(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.reject(new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(asError(error));
		});
	});
}
function isAbort(error) {
	return error instanceof SessionQueryError && error.code === "SESSION_QUERY_ABORTED";
}
function asError(error) {
	return error instanceof Error ? error : new Error("session-search dependency rejected with a non-Error value", { cause: error });
}
function errorMessage(error) {
	return error instanceof Error ? error.message : "unknown error";
}
function isRuntimeArray(value) {
	return Array.isArray(value);
}
//#endregion
export { SESSION_QUERY_SQLITE_APPLICATION_ID, SESSION_QUERY_SQLITE_DEFAULT_LIMIT, SESSION_QUERY_SQLITE_MAX_LIMIT, SESSION_QUERY_SQLITE_PATH_KEY, SESSION_QUERY_SQLITE_SCHEMA_VERSION, SESSION_QUERY_SQLITE_SNIPPET_CHARS, SqliteSessionQueryEngine, SqliteSessionQueryEngine as default };
"""

PATCHED_CONTENT = {"src/index.ts": SRC_CONTENT, "lib/index.js": LIB_CONTENT}


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
