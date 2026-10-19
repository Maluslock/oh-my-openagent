// packages/omo-opencode/src/tools/session-manager/sqlite-storage.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getSqliteAllSessionIds,
  getSqliteMainSessions,
  resetSqliteSessionBackfillWarning,
  sqliteSessionDbPath,
  sqliteSessionExists,
} from "./sqlite-storage"

const tempRoots: string[] = []
const originalDbPath = process.env.OMO_SESSION_DB_PATH

/** Points the reader at a throwaway store, the way the harness does for every other suite. */
function createDataHome(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-sqlite-storage-"))
  tempRoots.push(root)
  process.env.OMO_SESSION_DB_PATH = join(root, "opencode.db")
  return root
}

const SESSION_TABLE_SQL = `
  create table session_v2 (
    id text primary key,
    project_id text,
    directory text,
    title text,
    parent_id text,
    version text,
    time_created integer,
    time_updated integer
  )
`

function createSessionDb(rows: Array<{
  id: string
  directory?: string
  title?: string | null
  parentID?: string | null
  timeCreated?: number
  timeUpdated?: number
}>): void {
  const dbPath = sqliteSessionDbPath()
  mkdirSync(join(dbPath, ".."), { recursive: true })
  const db = new Database(dbPath)
  db.run(SESSION_TABLE_SQL)
  const insert = db.prepare(
    "insert into session_v2 (id, project_id, directory, title, parent_id, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const row of rows) {
    insert.run(
      row.id,
      "proj_1",
      row.directory ?? "/work/alpha",
      row.title === undefined ? `title ${row.id}` : row.title,
      row.parentID ?? null,
      "2.0.11",
      row.timeCreated ?? 1000,
      row.timeUpdated ?? 1000,
    )
  }
  db.close()
}

beforeEach(() => {
  resetSqliteSessionBackfillWarning()
})

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  if (originalDbPath === undefined) delete process.env.OMO_SESSION_DB_PATH
  else process.env.OMO_SESSION_DB_PATH = originalDbPath
  resetSqliteSessionBackfillWarning()
})

describe("getSqliteMainSessions", () => {
  it("lists top-level sessions newest first and skips child sessions", async () => {
    // given a store with two main sessions and one child session
    createDataHome()
    createSessionDb([
      { id: "ses_old", timeUpdated: 100 },
      { id: "ses_new", timeUpdated: 300 },
      { id: "ses_child", parentID: "ses_new", timeUpdated: 400 },
    ])

    // when
    const sessions = await getSqliteMainSessions()

    // then the child is not a "main" session and ordering follows the update time
    expect(sessions.map((session) => session.id)).toEqual(["ses_new", "ses_old"])
    expect(sessions[0]).toEqual({
      id: "ses_new",
      projectID: "proj_1",
      directory: "/work/alpha",
      title: "title ses_new",
      version: "2.0.11",
      time: { created: 1000, updated: 300 },
    })
  })

  it("filters by directory when one is given", async () => {
    // given sessions from two projects
    createDataHome()
    createSessionDb([
      { id: "ses_alpha", directory: "/work/alpha" },
      { id: "ses_beta", directory: "/work/beta" },
    ])

    // when / then
    expect((await getSqliteMainSessions("/work/alpha")).map((session) => session.id)).toEqual(["ses_alpha"])
    expect((await getSqliteMainSessions("/work/none")).map((session) => session.id)).toEqual([])
    expect((await getSqliteMainSessions()).map((session) => session.id).sort()).toEqual(["ses_alpha", "ses_beta"])
  })

  it("omits an absent title instead of emitting an empty one", async () => {
    // given a session row without a title
    createDataHome()
    createSessionDb([{ id: "ses_untitled", title: null }])

    // when
    const [session] = await getSqliteMainSessions()

    // then
    expect(session).toBeDefined()
    expect("title" in (session as object)).toBe(false)
  })

  it("drops rows that cannot form metadata", async () => {
    // given a row missing its directory and timestamps
    createDataHome()
    createSessionDb([{ id: "ses_good" }])
    const db = new Database(sqliteSessionDbPath())
    db.run("insert into session_v2 (id, project_id, directory, parent_id) values ('ses_broken', 'p', null, null)")
    db.close()

    // when
    const sessions = await getSqliteMainSessions()

    // then only the complete row survives
    expect(sessions.map((session) => session.id)).toEqual(["ses_good"])
  })

  it("returns an empty list when the host has no session database", async () => {
    // given an empty data home
    createDataHome()

    // when / then
    expect(await getSqliteMainSessions()).toEqual([])
    expect(await getSqliteAllSessionIds()).toEqual([])
    expect(await sqliteSessionExists("ses_anything")).toBe(false)
  })

  it("returns an empty list when the database has no session table", async () => {
    // given a valid SQLite file from another schema
    createDataHome()
    const dbPath = sqliteSessionDbPath()
    mkdirSync(join(dbPath, ".."), { recursive: true })
    const db = new Database(dbPath)
    db.run("create table unrelated (id text)")
    db.close()

    // when / then the backfill degrades instead of throwing
    expect(await getSqliteMainSessions()).toEqual([])
  })

  it("returns an empty list when the file is not a database", async () => {
    // given a corrupt file where the store should be
    createDataHome()
    const dbPath = sqliteSessionDbPath()
    mkdirSync(join(dbPath, ".."), { recursive: true })
    writeFileSync(dbPath, "not a database")

    // when / then
    expect(await getSqliteMainSessions()).toEqual([])
  })
})

describe("getSqliteAllSessionIds", () => {
  it("includes child sessions so search can walk them", async () => {
    // given
    createDataHome()
    createSessionDb([
      { id: "ses_main" },
      { id: "ses_child", parentID: "ses_main" },
    ])

    // when
    const ids = await getSqliteAllSessionIds()

    // then
    expect([...ids].sort()).toEqual(["ses_child", "ses_main"])
  })
})

describe("sqliteSessionExists", () => {
  it("reports existence for a known id and false otherwise", async () => {
    // given
    createDataHome()
    createSessionDb([{ id: "ses_known" }])

    // when / then
    expect(await sqliteSessionExists("ses_known")).toBe(true)
    expect(await sqliteSessionExists("ses_unknown")).toBe(false)
  })
})
