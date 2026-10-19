// packages/omo-opencode/src/v2/session-prompt-config.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import {
  applySessionPromptConfig,
  clearSessionPromptConfig,
  getSessionPromptConfig,
  normalizeSystemContent,
  normalizeToolMap,
  recordSessionPromptConfig,
  resetSessionPromptConfigs,
  resolveAdvertisedTool,
} from "./session-prompt-config"

describe("normalizeSystemContent", () => {
  it("accepts a single string and a list of strings", () => {
    expect(normalizeSystemContent("hello")).toEqual(["hello"])
    expect(normalizeSystemContent(["a", "b"])).toEqual(["a", "b"])
  })

  it("drops empty strings, non-strings and absent values", () => {
    expect(normalizeSystemContent("")).toEqual([])
    expect(normalizeSystemContent(["a", "", 3, null])).toEqual(["a"])
    expect(normalizeSystemContent(undefined)).toEqual([])
    expect(normalizeSystemContent({ text: "a" })).toEqual([])
  })
})

describe("normalizeToolMap", () => {
  it("keeps the effects V1 allows", () => {
    expect(normalizeToolMap({ task: false, bash: true, edit: "deny", write: "ask" })).toEqual({
      task: false,
      bash: true,
      edit: "deny",
      write: "ask",
    })
  })

  it("drops unknown effects and returns undefined for an unusable map", () => {
    expect(normalizeToolMap({ task: "nope", bash: 1 })).toBeUndefined()
    expect(normalizeToolMap(undefined)).toBeUndefined()
    expect(normalizeToolMap(["task"])).toBeUndefined()
  })
})

describe("recordSessionPromptConfig", () => {
  beforeEach(() => resetSessionPromptConfigs())

  it("stores the system content and tool map of a create or prompt body", () => {
    recordSessionPromptConfig("ses_1", { system: "skill body", tools: { task: false } })
    expect(getSessionPromptConfig("ses_1")).toEqual({ system: ["skill body"], tools: { task: false } })
  })

  it("ignores calls that carry neither field and calls without a session id", () => {
    recordSessionPromptConfig("ses_1", {})
    recordSessionPromptConfig("ses_1", { system: "", tools: {} })
    recordSessionPromptConfig(undefined, { tools: { task: false } })
    recordSessionPromptConfig(42, { tools: { task: false } })
    expect(getSessionPromptConfig("ses_1")).toBeUndefined()
    expect(getSessionPromptConfig(42)).toBeUndefined()
  })

  it("replaces only the field that is supplied, so a later prompt keeps the earlier create value", () => {
    recordSessionPromptConfig("ses_1", { system: "from create", tools: { task: false } })
    recordSessionPromptConfig("ses_1", { tools: { bash: false } })
    expect(getSessionPromptConfig("ses_1")).toEqual({ system: ["from create"], tools: { bash: false } })

    recordSessionPromptConfig("ses_1", { system: "from prompt" })
    expect(getSessionPromptConfig("ses_1")).toEqual({ system: ["from prompt"], tools: { bash: false } })
  })

  it("replaces instead of appending, so per-turn resends cannot duplicate the content", () => {
    recordSessionPromptConfig("ses_1", { system: "skill body" })
    recordSessionPromptConfig("ses_1", { system: "skill body" })
    expect(getSessionPromptConfig("ses_1")?.system).toEqual(["skill body"])
  })

  it("evicts the oldest session once the bound is reached", () => {
    for (let index = 0; index < 513; index++) {
      recordSessionPromptConfig(`ses_${index}`, { tools: { task: false } })
    }
    expect(getSessionPromptConfig("ses_0")).toBeUndefined()
    expect(getSessionPromptConfig("ses_1")).toEqual({ tools: { task: false } })
    expect(getSessionPromptConfig("ses_512")).toEqual({ tools: { task: false } })
  })

  it("clearSessionPromptConfig forgets one session only", () => {
    recordSessionPromptConfig("ses_1", { tools: { task: false } })
    recordSessionPromptConfig("ses_2", { tools: { task: false } })
    clearSessionPromptConfig("ses_1")
    expect(getSessionPromptConfig("ses_1")).toBeUndefined()
    expect(getSessionPromptConfig("ses_2")).toEqual({ tools: { task: false } })
  })
})

describe("resolveAdvertisedTool", () => {
  const advertised = { shell: {}, edit: {}, write: {}, subagent: {}, read: {} }

  it("matches an identity name and the renamed V1 tools", () => {
    expect(resolveAdvertisedTool(advertised, "read")).toBe("read")
    expect(resolveAdvertisedTool(advertised, "bash")).toBe("shell")
    expect(resolveAdvertisedTool(advertised, "task")).toBe("subagent")
    expect(resolveAdvertisedTool(advertised, "patch")).toBe("edit")
    expect(resolveAdvertisedTool(advertised, "apply_patch")).toBe("edit")
  })

  it("returns undefined when neither the name nor its counterpart is advertised", () => {
    expect(resolveAdvertisedTool(advertised, "todowrite")).toBeUndefined()
    expect(resolveAdvertisedTool({}, "bash")).toBeUndefined()
  })

  it("finds the adapter's own namespaced id when the V1 body used the bare name", () => {
    const namespaced = { omo_look_at: {}, omo_call_omo_agent: {}, shell: {} }
    expect(resolveAdvertisedTool(namespaced, "look_at", "omo")).toBe("omo_look_at")
    expect(resolveAdvertisedTool(namespaced, "call_omo_agent", "omo")).toBe("omo_call_omo_agent")
    // Without the namespace the bare name is still unmapped, which is what the report is for.
    expect(resolveAdvertisedTool(namespaced, "look_at")).toBeUndefined()
    expect(resolveAdvertisedTool(namespaced, "bash", "omo")).toBe("shell")
    expect(resolveAdvertisedTool(namespaced, "absent", "omo")).toBeUndefined()
  })
})

describe("applySessionPromptConfig", () => {
  const collect = () => {
    const reports: Array<[string, string]> = []
    return { reports, report: (reason: "unmapped" | "ask", name: string) => reports.push([reason, name]) }
  }

  it("appends the recorded system content after the host's own parts", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", system: [{ type: "text", text: "host" }] }
    const { reports, report } = collect()
    applySessionPromptConfig(event, { system: ["a", "b"] }, report)

    expect(event.system).toEqual([
      { type: "text", text: "host" },
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
    expect(reports).toEqual([])
  })

  it("removes denied tools, including the renamed ones, and leaves allowed ones alone", () => {
    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      tools: { shell: {}, read: {}, subagent: {}, edit: {}, write: {} },
    }
    const { reports, report } = collect()
    applySessionPromptConfig(
      event,
      { tools: { bash: false, task: "deny", read: true, write: "allow", edit: "ask" } },
      report,
    )

    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["read", "edit", "write"])
    expect(reports).toEqual([["ask", "edit"]])
  })

  it("reports a denial it cannot express instead of guessing a counterpart", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", tools: { shell: {} } }
    const { reports, report } = collect()
    applySessionPromptConfig(event, { tools: { todowrite: false, bash: false } }, report)

    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual([])
    expect(reports).toEqual([["unmapped", "todowrite"]])
  })

  it("turns off the adapter's own tool when the V1 body denied it by bare name", () => {
    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      tools: { omo_look_at: {}, omo_call_omo_agent: {}, shell: {}, question: {} },
    }
    const { reports, report } = collect()
    applySessionPromptConfig(
      event,
      { tools: { look_at: false, call_omo_agent: false, task: false } },
      report,
      { namespace: "omo" },
    )

    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["shell", "question"])
    expect(reports).toEqual([["unmapped", "task"]])
  })

  it("never adds a tool the host does not advertise", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", tools: { shell: {} } }
    const { reports, report } = collect()
    applySessionPromptConfig(event, { tools: { bash: false, task: false, webfetch: true } }, report)

    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual([])
    expect(reports).toEqual([["unmapped", "task"]])
  })

  it("does nothing when the event has no mutable system parts or tool map", () => {
    const { reports, report } = collect()
    const bare: Record<string, unknown> = { sessionID: "ses_1" }
    expect(() => applySessionPromptConfig(bare, { system: ["a"], tools: { bash: false } }, report)).not.toThrow()
    expect(reports).toEqual([])
  })

  it("is a no-op for an empty config", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", system: [], tools: { shell: {} } }
    const { reports, report } = collect()
    applySessionPromptConfig(event, {}, report)
    expect(event.system).toEqual([])
    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["shell"])
    expect(reports).toEqual([])
  })
})
