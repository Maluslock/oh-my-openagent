import { existsSync } from "node:fs"
import { join } from "node:path"

import { getDataDir } from "../../shared/data-path"
import { log } from "../../shared"
import { openReadonlyDatabase, type SqliteDatabase } from "./bun-sqlite-shim"
import type { SessionMetadata } from "./types"

/**
 * Read-only enumeration of the host's SQLite session store.
 *
 * OpenCode 2.x keeps sessions in `<data dir>/opencode/opencode.db` (`session_v2`), and V2 exposes no
 * session listing to server plugins. omo's own index (`register-session-index.ts`) covers every
 * session omo observed, but it starts when omo loads, so sessions created before that - or by a
 * host where omo was not loaded - are invisible to `session_list` / `session_search`. This module
 * reads those rows directly so enumeration is complete, mirroring what `file-storage.ts` does for
 * the legacy JSON layout.
 *
 * Deliberately narrow and fail-soft:
 * - only `session_v2` is read, only to list ids and metadata; messages keep flowing through the
 *   client shim (`ctx.session.context`), which works for any session id.
 * - the database is opened `readonly`, so a stray write can never touch the host's store.
 * - `bun:sqlite` is imported dynamically: the V2 host is a Bun single-file executable, but a Node
 *   runtime (or a future host that drops the table) must degrade to "no backfill", not crash.
 * - every failure logs once and returns `[]`, so the live index and the file layout stay usable.
 */

const DB_FILE_NAME = "opencode.db"

/** Log at most once per process; a missing table or a non-Bun runtime would otherwise spam. */
let reportedFailure = false

function reportOnce(message: string, detail: Record<string, unknown>): void {
  if (reportedFailure) return
  reportedFailure = true
  log(`[session-manager] sqlite session backfill unavailable: ${message}`, detail)
}

/** Test seam: clears the once-only failure report. */
export function resetSqliteSessionBackfillWarning(): void {
  reportedFailure = false
}

/**
 * Path of the host session store. `OMO_SESSION_DB_PATH` wins when set, which is how the test
 * harness keeps suites hermetic on a machine whose real store is populated (and how an operator can
 * point omo at a non-standard layout).
 */
export function sqliteSessionDbPath(): string {
  const override = process.env.OMO_SESSION_DB_PATH
  if (typeof override === "string" && override.length > 0) return override
  return join(getDataDir(), "opencode", DB_FILE_NAME)
}

type SessionRow = {
  id?: unknown
  project_id?: unknown
  directory?: unknown
  title?: unknown
  parent_id?: unknown
  version?: unknown
  time_created?: unknown
  time_updated?: unknown
}

async function withDatabase<T>(read: (db: SqliteDatabase) => T, fallback: T): Promise<T> {
  const dbPath = sqliteSessionDbPath()
  if (!existsSync(dbPath)) return fallback

  let database: SqliteDatabase | null = null
  try {
    database = await openReadonlyDatabase(dbPath)
    if (database === null) return fallback
    return read(database)
  } catch (error) {
    // A locked/absent table, a schema change, or a non-Bun runtime all land here.
    reportOnce("read failed", { dbPath, error: error instanceof Error ? error.message : String(error) })
    return fallback
  } finally {
    try {
      database?.close()
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function epochMillis(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function toSessionMetadata(row: SessionRow): SessionMetadata | null {
  const id = text(row.id)
  const directory = text(row.directory)
  const created = epochMillis(row.time_created)
  const updated = epochMillis(row.time_updated)
  if (id === undefined || directory === undefined || created === undefined || updated === undefined) {
    return null
  }
  return {
    id,
    projectID: text(row.project_id) ?? "",
    directory,
    ...(text(row.title) !== undefined ? { title: text(row.title) } : {}),
    ...(text(row.version) !== undefined ? { version: text(row.version) } : {}),
    time: { created, updated },
  }
}

/**
 * Top-level sessions (no parent), newest first, optionally filtered to one project directory.
 * Mirrors `getFileMainSessions`, which skips rows with a `parentID`.
 */
export async function getSqliteMainSessions(directory?: string): Promise<SessionMetadata[]> {
  return withDatabase((db) => {
    const rows = db
      .query(
        `select id, project_id, directory, title, parent_id, version, time_created, time_updated
         from session_v2
         where (parent_id is null or parent_id = '')
         ${directory === undefined ? "" : "and directory = ?"}
         order by time_updated desc`,
      )
      .all(...(directory === undefined ? [] : [directory])) as SessionRow[]

    return rows.flatMap((row) => {
      const metadata = toSessionMetadata(row)
      return metadata === null ? [] : [metadata]
    })
  }, [])
}

/** Every known session id, so `session_search` can walk sessions omo never observed. */
export async function getSqliteAllSessionIds(): Promise<string[]> {
  return withDatabase((db) => {
    const rows = db.query("select id from session_v2").all() as SessionRow[]
    return [...new Set(rows.flatMap((row) => {
      const id = text(row.id)
      return id === undefined ? [] : [id]
    }))]
  }, [])
}

/** Whether a single session id exists, for hosts with no message directory on disk. */
export async function sqliteSessionExists(sessionID: string): Promise<boolean> {
  return withDatabase((db) => {
    const rows = db.query("select id from session_v2 where id = ?").all(sessionID) as SessionRow[]
    return rows.length > 0
  }, false)
}
