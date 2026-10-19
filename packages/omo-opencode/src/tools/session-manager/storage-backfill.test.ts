// packages/omo-opencode/src/tools/session-manager/storage-backfill.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sqliteSessionDbPath } from "./sqlite-storage"
import {
  getAllSessions,
  getMainSessions,
  resetSessionIndexSource,
  sessionExists,
  setSessionIndexSource,
} from "./storage"
import type { SessionMetadata } from "./types"

const tempRoots: string[] = []
const originalDbPath = process.env.OMO_SESSION_DB_PATH

function createStore(rows: Array<{ id: string; directory?: string; title?: string; updated?: number }>): void {
  const root = mkdtempSync(join(tmpdir(), "omo-backfill-"))
  tempRoots.push(root)
  process.env.OMO_SESSION_DB_PATH = join(root, "opencode.db")
  const db = new Database(process.env.OMO_SESSION_DB_PATH)
  db.run(`
    create table session_v2 (
      id text primary key, project_id text, directory text, title text, parent_id text,
      version text, time_created integer, time_updated integer
    )
  `)
  const insert = db.prepare(
    "insert into session_v2 (id, project_id, directory, title, parent_id, version, time_created, time_updated) values (?, 'p', ?, ?, null, '2.0.11', 1, ?)",
  )
  for (const row of rows) {
    insert.run(row.id, row.directory ?? "/work/project", row.title ?? `db ${row.id}`, row.updated ?? 100)
  }
  db.close()
}

function metadata(id: string, title: string, updated: number, directory = "/work/project"): SessionMetadata {
  return { id, projectID: "p", directory, title, time: { created: 1, updated } }
}

beforeEach(() => {
  resetSessionIndexSource()
})

afterEach(() => {
  resetSessionIndexSource()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalDbPath === undefined) delete process.env.OMO_SESSION_DB_PATH
  else process.env.OMO_SESSION_DB_PATH = originalDbPath
})

describe("session backfill from the host store", () => {
  it("lists sessions omo never observed", async () => {
    // given a store holding a session created before omo loaded
    createStore([{ id: "ses_before_omo", title: "older session", updated: 500 }])

    // when
    const sessions = await getMainSessions({ directory: "/work/project" })

    // then it is enumerable even though the index is empty
    expect(sessions.map((session) => session.id)).toEqual(["ses_before_omo"])
    expect(sessions[0]?.title).toBe("older session")
  })

  it("lets the live index win for a shared id and keeps backfill-only ids", async () => {
    // given a store row whose title is stale, and one the index has never seen
    createStore([
      { id: "ses_shared", title: "db title", updated: 100 },
      { id: "ses_db_only", title: "db only", updated: 200 },
    ])
    setSessionIndexSource({
      listMainSessions: async () => [metadata("ses_shared", "live title", 900), metadata("ses_index_only", "index only", 950)],
      listAllSessionIds: async () => ["ses_shared", "ses_index_only"],
    })

    // when
    const sessions = await getMainSessions({ directory: "/work/project" })

    // then the live title survives and ordering follows the newest source
    expect(sessions.map((session) => session.id)).toEqual(["ses_index_only", "ses_shared", "ses_db_only"])
    expect(sessions.find((session) => session.id === "ses_shared")?.title).toBe("live title")
  })

  it("unions backfilled ids into getAllSessions", async () => {
    // given store ids plus index ids
    createStore([{ id: "ses_db_only" }])
    setSessionIndexSource({
      listMainSessions: async () => [],
      listAllSessionIds: async () => ["ses_index_only"],
    })

    // when
    const ids = await getAllSessions()

    // then
    expect([...ids].sort()).toEqual(["ses_db_only", "ses_index_only"])
  })

  it("resolves existence for a backfilled session with no message directory", async () => {
    // given a session only the host store knows about
    createStore([{ id: "ses_db_only" }])

    // when / then
    expect(await sessionExists("ses_db_only")).toBe(true)
    expect(await sessionExists("ses_missing")).toBe(false)
  })

  it("filters the backfill by project directory", async () => {
    // given sessions from two projects
    createStore([
      { id: "ses_here", directory: "/work/project" },
      { id: "ses_elsewhere", directory: "/work/other" },
    ])

    // when / then
    expect((await getMainSessions({ directory: "/work/project" })).map((session) => session.id)).toEqual(["ses_here"])
  })

  it("returns nothing extra when the host has no session store", async () => {
    // given no store at all
    const root = mkdtempSync(join(tmpdir(), "omo-backfill-empty-"))
    tempRoots.push(root)
    process.env.OMO_SESSION_DB_PATH = join(root, "missing.db")

    // when / then
    expect(await getMainSessions({ directory: "/work/project" })).toEqual([])
    expect(await getAllSessions()).toEqual([])
  })
})
