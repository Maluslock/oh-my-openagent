// packages/omo-opencode/src/v2/register-hooks.test.ts
import { describe, expect, it } from "bun:test"
import {
  registerOmoCompactionHook,
  registerOmoMessagesHook,
  registerOmoSessionPromptConfigHook,
  registerOmoSystemHook,
  registerOmoToolHooks,
} from "./register-hooks"
import type { HookRegistration, V2SessionHookRegistrar, V2ToolHookRegistrar } from "./register-hooks"
import type { V1ToolAfterInput, V1ToolAfterOutput, V1ToolBeforeInput, V1ToolBeforeOutput } from "./tool-hook-mapping"

function createRegistrar() {
  const callbacks = new Map<string, (event: unknown) => Promise<void>>()
  const disposed: string[] = []
  const registrar: V2ToolHookRegistrar = async (name, callback) => {
    if (callbacks.has(name)) throw new Error(`duplicate registration: ${name}`)
    callbacks.set(name, callback)
    const registration: HookRegistration = { dispose: async () => { disposed.push(name) } }
    return registration
  }
  return {
    registrar,
    callbacks,
    disposed,
    invoke: (name: string, event: unknown) => {
      const callback = callbacks.get(name)
      if (callback === undefined) throw new Error(`not registered: ${name}`)
      return callback(event)
    },
  }
}

describe("registerOmoToolHooks", () => {
  it("registers only the handlers that were supplied", async () => {
    const { registrar, callbacks } = createRegistrar()
    await registerOmoToolHooks(registrar, {})
    expect(callbacks.size).toBe(0)

    const { registrar: onlyAfter, callbacks: afterOnly } = createRegistrar()
    await registerOmoToolHooks(onlyAfter, { after: () => {} })
    expect([...afterOnly.keys()]).toEqual(["execute.after"])
  })

  it("invokes the V1 before-handler with the V1 pair and writes mutations back", async () => {
    const { registrar, invoke } = createRegistrar()
    const seen: V1ToolBeforeInput[] = []
    await registerOmoToolHooks(registrar, {
      before: (input, output) => {
        seen.push({ ...input })
        input.tool = "omo_glob"
        output.args = { ...output.args, extra: 1 }
      },
    })

    const event: Record<string, unknown> = {
      tool: "mcp_omo_glob",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "*.md" },
    }
    await invoke("execute.before", event)

    expect(seen).toEqual([{ tool: "mcp_omo_glob", sessionID: "ses_1", callID: "call_1" }])
    expect(event.tool).toBe("omo_glob")
    expect(event.input).toEqual({ pattern: "*.md", extra: 1 })
  })

  it("lets a before-handler throw so the tool call is blocked", async () => {
    const { registrar, invoke } = createRegistrar()
    await registerOmoToolHooks(registrar, {
      before: () => {
        throw new Error("blocked")
      },
    })

    await expect(invoke("execute.before", { tool: "bash", sessionID: "ses_1", id: "c", input: {} })).rejects.toThrow("blocked")
  })

  it("invokes the V1 after-handler and writes result mutations back", async () => {
    const { registrar, invoke } = createRegistrar()
    const seen: V1ToolAfterInput[] = []
    await registerOmoToolHooks(registrar, {
      after: (input, output) => {
        seen.push({ ...input })
        output.output = `${output.output}\n\n[truncated]`
        output.title = "Result"
      },
    })

    const event: Record<string, unknown> = {
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "x" },
      status: "completed",
      result: { content: "match", metadata: {} },
    }
    await invoke("execute.after", event)

    expect(seen).toEqual([{ tool: "grep", sessionID: "ses_1", callID: "call_1", args: { pattern: "x" } }])
    expect(event.result).toEqual({ content: "match\n\n[truncated]", metadata: { title: "Result" } })
  })

  it("isolates an after-handler failure and leaves the result untouched", async () => {
    const { registrar, invoke } = createRegistrar()
    await registerOmoToolHooks(registrar, {
      after: () => {
        throw new Error("post boom")
      },
    })

    const event: Record<string, unknown> = {
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      result: { content: "match", metadata: {} },
    }
    await expect(invoke("execute.after", event)).resolves.toBeUndefined()
    expect(event.result).toEqual({ content: "match", metadata: {} })
  })

  it("skips malformed events without calling the handler", async () => {
    const { registrar, invoke } = createRegistrar()
    let called = 0
    await registerOmoToolHooks(registrar, {
      before: () => { called += 1 },
      after: () => { called += 1 },
    })

    await invoke("execute.before", { tool: "x" })
    await invoke("execute.after", null)
    expect(called).toBe(0)
  })

  it("returns dispose handles for both registrations", async () => {
    const { registrar, disposed } = createRegistrar()
    const registrations = await registerOmoToolHooks(registrar, { before: () => {}, after: () => {} })
    expect(registrations).toHaveLength(2)
    for (const registration of registrations) await registration.dispose()
    expect(disposed).toEqual(["execute.before", "execute.after"])
  })
})

function createSessionRegistrar() {
  const callbacks = new Map<string, (event: unknown) => Promise<void>>()
  const registrar: V2SessionHookRegistrar = async (name, callback) => {
    if (callbacks.has(name)) throw new Error(`duplicate registration: ${name}`)
    callbacks.set(name, callback)
    return { dispose: async () => { callbacks.delete(name) } }
  }
  return {
    registrar,
    invoke: (name: string, event: unknown) => {
      const callback = callbacks.get(name)
      if (callback === undefined) throw new Error(`not registered: ${name}`)
      return callback(event)
    },
  }
}

describe("registerOmoSystemHook", () => {
  it("runs the V1 system transform on the V2 context hook and writes changes back", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    const seen: Array<{ sessionID?: string; model: { id: string; providerID: string } }> = []
    await registerOmoSystemHook(registrar, (input, output) => {
      seen.push(input)
      output.system.push("<ultrawork-mode>on</ultrawork-mode>")
    })

    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      model: { id: "sonnet", providerID: "anthropic" },
      system: [{ type: "text", text: "base" }],
    }
    await invoke("context", event)

    expect(seen).toEqual([{ sessionID: "ses_1", model: { id: "sonnet", providerID: "anthropic" } }])
    expect(event.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "<ultrawork-mode>on</ultrawork-mode>" },
    ])
  })

  it("leaves system untouched when the V1 handler makes no change", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    await registerOmoSystemHook(registrar, () => {})

    const original = [{ type: "text", text: "base", cache: { type: "ephemeral" } }]
    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      model: { id: "sonnet", providerID: "anthropic" },
      system: structuredClone(original),
    }
    await invoke("context", event)
    expect(event.system).toEqual(original)
  })

  it("skips malformed context events without invoking the handler", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    let called = 0
    await registerOmoSystemHook(registrar, () => { called += 1 })
    await invoke("context", { sessionID: "ses_1" })
    expect(called).toBe(0)
  })
})

describe("registerOmoSessionPromptConfigHook", () => {
  it("replays the recorded system content and tool denials onto the request", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    await registerOmoSessionPromptConfigHook(registrar, (sessionID) =>
      sessionID === "ses_1" ? { system: ["skill body"], tools: { bash: false, task: false, read: true } } : undefined,
    )

    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      system: [{ type: "text", text: "base" }],
      tools: { shell: {}, subagent: {}, read: {} },
    }
    await invoke("context", event)

    expect(event.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "skill body" },
    ])
    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["read"])
  })

  it("leaves the request untouched for a session with no recorded config", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    await registerOmoSessionPromptConfigHook(registrar, () => undefined)

    const event: Record<string, unknown> = {
      sessionID: "ses_1",
      system: [{ type: "text", text: "base" }],
      tools: { shell: {} },
    }
    await invoke("context", event)
    expect(event.system).toEqual([{ type: "text", text: "base" }])
    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["shell"])
  })

  it("ignores context events without a session id", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    let calls = 0
    await registerOmoSessionPromptConfigHook(registrar, () => {
      calls += 1
      return { tools: { bash: false } }
    })
    await invoke("context", { tools: { shell: {} } })
    expect(calls).toBe(0)
  })
})

describe("registerOmoMessagesHook", () => {
  const event = () => ({
    sessionID: "ses_1",
    model: { id: "sonnet", providerID: "anthropic" },
    system: [],
    messages: [
      { id: "msg_u1", role: "user", content: [{ type: "text", text: "hi", cache: { type: "ephemeral" } }] },
      {
        id: "msg_a1",
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", id: "call_1", name: "grep", input: { pattern: "x" } },
        ],
      },
    ],
  })

  it("presents the V1 {info, parts} view and rebuilds it back onto the event", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    const seen: unknown[] = []
    await registerOmoMessagesHook(registrar, (_input, output) => {
      seen.push(output.messages.map((message) => message.info))
      // The V1 validator's repair, in miniature.
      const assistant = output.messages[1]!
      assistant.parts.push({
        type: "tool_result",
        toolUseId: "call_1",
        tool_use_id: "call_1",
        isError: true,
        content: [{ type: "text", text: "[tool result missing]" }],
      })
    })

    const target = event() as Record<string, unknown>
    await invoke("context", target)

    expect(seen).toEqual([
      [
        { role: "user", id: "msg_u1", sessionID: "ses_1" },
        { role: "assistant", id: "msg_a1", sessionID: "ses_1" },
      ],
    ])
    const content = (target.messages as Record<string, unknown>[])[1]!.content as Record<string, unknown>[]
    expect(content[2]).toEqual({
      type: "tool-result",
      id: "call_1",
      name: "grep",
      result: { type: "error", value: "[tool result missing]" },
    })
    // Untouched parts keep their origin fields.
    const userContent = (target.messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[]
    expect(userContent[0]).toEqual({ type: "text", text: "hi", cache: { type: "ephemeral" } })
  })

  it("skips malformed context events", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    let called = 0
    await registerOmoMessagesHook(registrar, () => { called += 1 })
    await invoke("context", { model: { id: "m", providerID: "p" } })
    expect(called).toBe(0)
  })
})

describe("registerOmoCompactionHook", () => {
  it("runs the V1 compacting handler and injects its context into system", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    const seen: string[] = []
    await registerOmoCompactionHook(registrar, (input, output) => {
      seen.push(input.sessionID)
      output.context.push("preserved todos")
    })

    const event: Record<string, unknown> = { sessionID: "ses_1", system: [{ type: "text", text: "base" }] }
    await invoke("compaction", event)

    expect(seen).toEqual(["ses_1"])
    expect(event.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "preserved todos" },
    ])
  })

  it("isolates a throwing compacting handler and leaves system untouched", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    await registerOmoCompactionHook(registrar, () => {
      throw new Error("capture boom")
    })

    const event: Record<string, unknown> = { sessionID: "ses_1", system: [{ type: "text", text: "base" }] }
    await expect(invoke("compaction", event)).resolves.toBeUndefined()
    expect(event.system).toEqual([{ type: "text", text: "base" }])
  })

  it("skips malformed events", async () => {
    const { registrar, invoke } = createSessionRegistrar()
    let called = 0
    await registerOmoCompactionHook(registrar, () => { called += 1 })
    await invoke("compaction", { system: [] })
    expect(called).toBe(0)
  })
})
