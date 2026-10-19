// packages/omo-opencode/src/v2/system-hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { applyV1System, toV1System } from "./system-hook-mapping"

const CONTEXT_EVENT = {
  sessionID: "ses_1",
  agent: "sisyphus",
  model: { id: "sonnet", providerID: "anthropic", variant: "high" },
  system: [
    { type: "text", text: "base prompt", cache: { type: "ephemeral" } },
    { type: "text", text: "second" },
  ],
  messages: [],
  options: {},
  tools: {},
}

describe("toV1System", () => {
  it("projects the system texts and the model ref into the V1 pair", () => {
    expect(toV1System(CONTEXT_EVENT)).toEqual({
      input: { sessionID: "ses_1", model: { id: "sonnet", providerID: "anthropic" } },
      output: { system: ["base prompt", "second"] },
    })
  })

  it("returns undefined for malformed events", () => {
    expect(toV1System(null)).toBeUndefined()
    expect(toV1System({ model: { id: "m", providerID: "p" } })).toBeUndefined()
    expect(toV1System({ sessionID: "ses_1", model: { id: "m" } })).toBeUndefined()
    expect(toV1System({ sessionID: "ses_1", model: { providerID: "p" } })).toBeUndefined()
  })

  it("tolerates a missing system array", () => {
    expect(toV1System({ sessionID: "ses_1", model: { id: "m", providerID: "p" } })?.output.system).toEqual([])
  })
})

describe("applyV1System", () => {
  it("leaves the parts untouched when the texts are unchanged (preserves cache hints)", () => {
    const event = structuredClone(CONTEXT_EVENT)
    const pair = toV1System(event)!
    // Handler ran but changed nothing.
    applyV1System(event, pair.output)
    expect(event.system).toEqual(CONTEXT_EVENT.system)
    expect((event.system[0] as Record<string, unknown>).cache).toEqual({ type: "ephemeral" })
  })

  it("rebuilds plain text parts when the handler changed the list", () => {
    const event = structuredClone(CONTEXT_EVENT) as Record<string, unknown>
    const pair = toV1System(event)!
    pair.output.system = [...pair.output.system, "<ultrawork-mode>on</ultrawork-mode>"]
    applyV1System(event, pair.output)
    expect(event.system).toEqual([
      { type: "text", text: "base prompt" },
      { type: "text", text: "second" },
      { type: "text", text: "<ultrawork-mode>on</ultrawork-mode>" },
    ])
  })

  it("ignores non-record events", () => {
    expect(() => applyV1System(null, { system: ["x"] })).not.toThrow()
  })
})
