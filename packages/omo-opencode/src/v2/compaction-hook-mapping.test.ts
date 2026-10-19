// packages/omo-opencode/src/v2/compaction-hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { applyV1Compacting, toV1Compacting } from "./compaction-hook-mapping"

describe("toV1Compacting", () => {
  it("builds the V1 pair from a V2 compaction event", () => {
    expect(toV1Compacting({ sessionID: "ses_1", system: [], messages: [] })).toEqual({
      input: { sessionID: "ses_1" },
      output: { context: [] },
    })
  })

  it("returns undefined for malformed events", () => {
    expect(toV1Compacting(null)).toBeUndefined()
    expect(toV1Compacting({ system: [] })).toBeUndefined()
    expect(toV1Compacting({ sessionID: 1 })).toBeUndefined()
  })
})

describe("applyV1Compacting", () => {
  it("injects collected context as extra system text parts", () => {
    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      system: [{ type: "text", text: "base", cache: { type: "ephemeral" } }],
    }
    applyV1Compacting(event, { context: ["preserved todos", "  ", "session notes"] })
    expect(event.system).toEqual([
      { type: "text", text: "base", cache: { type: "ephemeral" } },
      { type: "text", text: "preserved todos" },
      { type: "text", text: "session notes" },
    ])
  })

  it("skips injection when a summary is already supplied (model request skipped)", () => {
    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      system: [{ type: "text", text: "base" }],
      result: { summary: "already summarized" },
    }
    applyV1Compacting(event, { context: ["preserved todos"] })
    expect(event.system).toEqual([{ type: "text", text: "base" }])
  })

  it("is a no-op when the handler collected nothing", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", system: [] }
    applyV1Compacting(event, { context: [] })
    expect(event.system).toEqual([])
  })

  it("tolerates a missing system array and malformed events", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1" }
    applyV1Compacting(event, { context: ["x"] })
    expect(event.system).toEqual([{ type: "text", text: "x" }])
    expect(() => applyV1Compacting(null, { context: ["x"] })).not.toThrow()
  })
})
