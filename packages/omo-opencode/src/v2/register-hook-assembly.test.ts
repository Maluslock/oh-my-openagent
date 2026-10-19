// packages/omo-opencode/src/v2/register-hook-assembly.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import { registerOmoHooks, resetOmoHookCache } from "./register-hook-assembly"

type Calls = {
  subscribe: number
  toolHooks: string[]
  sessionHooks: string[]
  disposedRegistrations: string[]
  headers: number
  createdPluginInterfaces: number
  windows: number
}

function createFixture() {
  const calls: Calls = {
    subscribe: 0,
    toolHooks: [],
    sessionHooks: [],
    disposedRegistrations: [],
    headers: 0,
    createdPluginInterfaces: 0,
    windows: 0,
  }

  const runtime = {
    managers: {
      backgroundManager: {},
      modelFallbackControllerAccessor: {},
      tmuxSessionManager: {},
      skillMcpManager: {},
      configHandler: {},
    },
    toolsResult: { filteredTools: {}, mergedSkills: [], availableSkills: [] },
    client: {},
  }

  const deps = {
    resolveRuntime: (async () => runtime) as never,
    createHooks: (() => ({ disposeHooks: () => { calls.headers += 1 } })) as never,
    createPluginInterface: (() => {
      calls.createdPluginInterfaces += 1
      return {
        event: async () => {},
        "chat.message": async () => {},
        "chat.params": async () => {},
        "chat.headers": async () => {},
        "tool.execute.before": async () => {},
        "tool.execute.after": async () => {},
        "experimental.chat.messages.transform": async () => {},
        "experimental.chat.system.transform": async () => {},
      }
    }) as never,
    createSessionCompactingHandler: (() => async () => {}) as never,
    createFirstMessageVariantGate: (() => ({ markSessionCreated: () => {}, clear: () => {} })) as never,
    createModelCacheState: (() => ({})) as never,
  }

  const makeCtx = (directory: string) => ({
    location: { directory },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        calls.subscribe += 1
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve()
            options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        })() as AsyncIterable<unknown>
      },
    },
    tool: {
      hook: async (name: string) => {
        calls.toolHooks.push(name)
        return { dispose: async () => { calls.disposedRegistrations.push(`tool:${name}`) } }
      },
    },
    session: {
      hook: async (name: string) => {
        calls.sessionHooks.push(name)
        return { dispose: async () => { calls.disposedRegistrations.push(`session:${name}`) } }
      },
    },
  })

  return { calls, deps, makeCtx }
}

beforeEach(() => {
  resetOmoHookCache()
})

describe("registerOmoHooks", () => {
  it("registers the event stream, the compaction-end restore, both tool hooks and the session hooks", async () => {
    const { calls, deps, makeCtx } = createFixture()
    await registerOmoHooks(makeCtx("/work") as never, {} as never, deps)

    // two subscriptions: the V1 event dispatch, and the compaction-end state restore
    expect(calls.subscribe).toBe(2)
    expect(calls.toolHooks).toEqual(["execute.before", "execute.after"])
    expect(calls.sessionHooks).toEqual([
      "prompt",
      "context",
      "context",
      "context",
      // the per-session request config the client shim records (V2-only, see session-prompt-config.ts)
      "context",
      // chat.headers adds a prompt registration (message-id tracker) and a model.request registration
      "prompt",
      "model.request",
      "compaction",
    ])
    expect(calls.createdPluginInterfaces).toBe(1)
  })

  it("is idempotent for the same context", async () => {
    const { calls, deps, makeCtx } = createFixture()
    const ctx = makeCtx("/work")
    await registerOmoHooks(ctx as never, {} as never, deps)
    await registerOmoHooks(ctx as never, {} as never, deps)

    expect(calls.subscribe).toBe(2)
    expect(calls.toolHooks).toHaveLength(2)
    expect(calls.sessionHooks).toHaveLength(8)
    expect(calls.createdPluginInterfaces).toBe(1)
  })

  it("disposes the previous registrations and hooks when the context changes", async () => {
    const { calls, deps, makeCtx } = createFixture()
    await registerOmoHooks(makeCtx("/work") as never, {} as never, deps)
    await registerOmoHooks(makeCtx("/work") as never, {} as never, deps)

    expect(calls.headers).toBe(1)
    expect(calls.disposedRegistrations).toEqual([
      "tool:execute.before",
      "tool:execute.after",
      "session:prompt",
      "session:context",
      "session:context",
      "session:context",
      "session:context",
      "session:prompt",
      "session:model.request",
      "session:compaction",
    ])
  })

  it("skips registration when no V2 hook domain exists", async () => {
    const { calls, deps } = createFixture()
    await registerOmoHooks({ location: { directory: "/work" } } as never, {} as never, deps)
    expect(calls.subscribe).toBe(0)
    expect(calls.createdPluginInterfaces).toBe(0)
  })
})
