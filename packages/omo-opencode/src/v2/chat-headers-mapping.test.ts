// packages/omo-opencode/src/v2/chat-headers-mapping.test.ts
import { describe, expect, it } from "bun:test"
import {
  applyV1ChatHeaders,
  createPromptMessageTracker,
  registerOmoChatHeadersHook,
  toV1ChatHeaders,
  type V1ChatHeadersInput,
  type V1ChatHeadersOutput,
} from "./chat-headers-mapping"

const PRIMARY = {
  sessionID: "ses_1",
  agent: "sisyphus",
  model: { providerID: "github-copilot", id: "gpt-4", variant: "default" },
  kind: "primary",
  baseURL: "https://api.githubcopilot.com",
  headers: { existing: "keep" },
}

describe("createPromptMessageTracker", () => {
  it("remembers the newest prompt message id per session", () => {
    const tracker = createPromptMessageTracker()
    tracker.record({ sessionID: "ses_1", messageID: "msg_1" })
    tracker.record({ sessionID: "ses_1", messageID: "msg_2" })
    tracker.record({ sessionID: "ses_2", messageID: "msg_3" })
    expect(tracker.get("ses_1")).toBe("msg_2")
    expect(tracker.get("ses_2")).toBe("msg_3")
    expect(tracker.get("missing")).toBeUndefined()
  })

  it("ignores events without a session or message id", () => {
    const tracker = createPromptMessageTracker()
    tracker.record({ sessionID: "ses_1" })
    tracker.record({ messageID: "msg_1" })
    tracker.record(null)
    expect(tracker.size()).toBe(0)
  })

  it("stays bounded", () => {
    const tracker = createPromptMessageTracker()
    for (let i = 0; i < 700; i++) tracker.record({ sessionID: `ses_${i}`, messageID: `msg_${i}` })
    expect(tracker.size()).toBeLessThanOrEqual(500)
    expect(tracker.get("ses_699")).toBe("msg_699")
  })
})

describe("toV1ChatHeaders", () => {
  it("maps a primary request onto the V1 input with the tracked message id", () => {
    expect(toV1ChatHeaders(PRIMARY, "msg_9")).toEqual({
      sessionID: "ses_1",
      provider: { id: "github-copilot" },
      message: { role: "user", id: "msg_9" },
    })
  })

  it("omits the message id when none was tracked, so the lookup is skipped safely", () => {
    expect(toV1ChatHeaders(PRIMARY)).toEqual({
      sessionID: "ses_1",
      provider: { id: "github-copilot" },
      message: { role: "user" },
    })
  })

  it("ignores auxiliary request kinds", () => {
    for (const kind of ["title", "generate", "compaction"]) {
      expect(toV1ChatHeaders({ ...PRIMARY, kind })).toBeUndefined()
    }
  })

  it("requires a session and a provider", () => {
    expect(toV1ChatHeaders({ ...PRIMARY, sessionID: undefined })).toBeUndefined()
    expect(toV1ChatHeaders({ ...PRIMARY, model: {} })).toBeUndefined()
    expect(toV1ChatHeaders(null)).toBeUndefined()
  })
})

describe("applyV1ChatHeaders", () => {
  it("copies handler headers onto the request without dropping existing ones", () => {
    const event = structuredClone(PRIMARY) as Record<string, unknown>
    applyV1ChatHeaders(event, { headers: { "x-initiator": "agent" } })
    expect(event.headers).toEqual({ existing: "keep", "x-initiator": "agent" })
  })

  it("ignores malformed events and non-string values", () => {
    expect(() => applyV1ChatHeaders(null, { headers: { a: "b" } })).not.toThrow()
    const event: Record<string, unknown> = { headers: {} }
    applyV1ChatHeaders(event, { headers: { bad: 42 as unknown as string } })
    expect(event.headers).toEqual({})
  })
})

describe("registerOmoChatHeadersHook", () => {
  function createRegistrar() {
    const hooks = new Map<string, (event: unknown) => Promise<void>>()
    const disposed: string[] = []
    const registrar = async (name: string, callback: (event: unknown) => Promise<void>) => {
      hooks.set(name, callback)
      return { dispose: async () => { disposed.push(name) } }
    }
    return { hooks, disposed, registrar }
  }

  it("records the prompt message id and applies the handler headers on a primary request", async () => {
    // given
    const { hooks, registrar } = createRegistrar()
    const calls: Array<{ input: V1ChatHeadersInput; output: V1ChatHeadersOutput }> = []
    const registrations = await registerOmoChatHeadersHook(
      registrar as never,
      (input, output) => {
        calls.push({ input, output })
        if (input.message.id === "msg_internal") output.headers["x-initiator"] = "agent"
      },
      createPromptMessageTracker(),
    )
    const event = structuredClone(PRIMARY) as Record<string, unknown>

    // when
    await hooks.get("prompt")!({ sessionID: "ses_1", messageID: "msg_internal" })
    await hooks.get("model.request")!(event)

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0].input.message).toEqual({ role: "user", id: "msg_internal" })
    expect(event.headers).toEqual({ existing: "keep", "x-initiator": "agent" })
    expect(registrations).toHaveLength(2)
  })

  it("does not call the handler for auxiliary requests", async () => {
    // given
    const { hooks, registrar } = createRegistrar()
    let called = 0
    await registerOmoChatHeadersHook(registrar as never, () => { called += 1 }, createPromptMessageTracker())

    // when
    await hooks.get("prompt")!({ sessionID: "ses_1", messageID: "msg_1" })
    await hooks.get("model.request")!({ ...PRIMARY, kind: "title" })

    // then
    expect(called).toBe(0)
  })
})
