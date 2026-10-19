// packages/omo-opencode/src/v2/session-index.test.ts
import { describe, expect, it } from "bun:test"
import {
  parseSessionIndex,
  selectSessionIndexEntries,
  sessionIndexIds,
  toSessionMetadata,
  upsertSessionIndexEntry,
  type SessionIndexEntry,
} from "./session-index"

function entry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return { id: "ses_1", directory: "/work", created: 1_000, updated: 2_000, ...overrides }
}

describe("parseSessionIndex", () => {
  it("keeps well-formed entries and drops everything else", () => {
    expect(parseSessionIndex([entry(), { id: "x" }, null, "nope"])).toHaveLength(1)
    expect(parseSessionIndex(undefined)).toEqual([])
    expect(parseSessionIndex({ entries: [] })).toEqual([])
  })
})

describe("upsertSessionIndexEntry", () => {
  it("inserts newest-first", () => {
    // given / when
    const first = upsertSessionIndexEntry([], { id: "a", directory: "/w" }, { now: 10 })
    const second = upsertSessionIndexEntry(first, { id: "b", directory: "/w" }, { now: 20 })

    // then
    expect(second.map((e) => e.id)).toEqual(["b", "a"])
  })

  it("merges a patch without erasing fields it does not carry", () => {
    // given an entry enriched from the host
    const enriched = upsertSessionIndexEntry([], {
      id: "a",
      directory: "/w",
      title: "Title",
      agent: "sisyphus",
      projectID: "p1",
      created: 5,
      updated: 6,
    }, { now: 6 })

    // when a bare event touches the same session
    const touched = upsertSessionIndexEntry(enriched, { id: "a" }, { now: 30 })

    // then the title, agent, project and creation time survive, and updated moves forward
    expect(touched[0]).toMatchObject({ title: "Title", agent: "sisyphus", projectID: "p1", created: 5, updated: 30 })
  })

  it("keeps created sticky and never moves updated backwards", () => {
    const seeded = upsertSessionIndexEntry([], { id: "a", directory: "/w", created: 100, updated: 200 }, { now: 200 })
    const older = upsertSessionIndexEntry(seeded, { id: "a", created: 999, updated: 150 }, { now: 150 })
    expect(older[0].created).toBe(100)
    expect(older[0].updated).toBe(200)
  })

  it("bounds the index", () => {
    let entries: SessionIndexEntry[] = []
    for (let i = 0; i < 10; i++) entries = upsertSessionIndexEntry(entries, { id: `s${i}`, directory: "/w" }, { now: i, max: 3 })
    expect(entries.map((e) => e.id)).toEqual(["s9", "s8", "s7"])
  })
})

describe("selectSessionIndexEntries", () => {
  const entries = [
    entry({ id: "a", directory: "/p1", updated: 10 }),
    entry({ id: "b", directory: "/p2", updated: 30 }),
    entry({ id: "c", directory: "/p1", updated: 20 }),
  ]

  it("filters by directory and returns newest-first", () => {
    expect(selectSessionIndexEntries(entries, { directory: "/p1" }).map((e) => e.id)).toEqual(["c", "a"])
    expect(sessionIndexIds(entries)).toEqual(["b", "c", "a"])
  })

  it("honours a limit", () => {
    expect(selectSessionIndexEntries(entries, { limit: 2 }).map((e) => e.id)).toEqual(["b", "c"])
    expect(selectSessionIndexEntries(entries, { limit: 0 })).toHaveLength(3)
  })

  it("does not mutate the caller's array", () => {
    const input = [entry({ id: "a", updated: 1 }), entry({ id: "b", updated: 2 })]
    selectSessionIndexEntries(input)
    expect(input.map((e) => e.id)).toEqual(["a", "b"])
  })
})

describe("toSessionMetadata", () => {
  it("projects onto the shape the session tools consume", () => {
    const metadata = toSessionMetadata(entry({ id: "ses_9", directory: "/w", title: "T", created: 7, updated: 8 }))
    expect(metadata).toMatchObject({
      id: "ses_9",
      directory: "/w",
      title: "T",
      projectID: "unknown",
      time: { created: 7, updated: 8 },
    })
  })

  it("omits absent optional fields instead of writing undefined", () => {
    const metadata = toSessionMetadata(entry()) as Record<string, unknown>
    expect(Object.keys(metadata).sort()).toEqual(["directory", "id", "projectID", "time"])
  })
})
