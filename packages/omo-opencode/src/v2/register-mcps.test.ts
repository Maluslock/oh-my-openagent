// packages/omo-opencode/src/v2/register-mcps.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import { registerOmoMcps, resetOmoMcpCache } from "./register-mcps"

type Registered = { name: string; config: Record<string, unknown> }

function createFixture() {
  const setCalls: Registered[] = []
  const updateCalls: string[] = []
  const registry = new Map<string, Record<string, unknown>>()
  const makeCtx = (directory: string) => ({
    location: { directory },
    mcp: {
      transform: async (
        callback: (editor: {
          get: (name: string) => Record<string, unknown> | undefined
          set: (name: string, config: Record<string, unknown>) => void
          update: (name: string, update: (config: Record<string, unknown>) => void) => void
        }) => void,
      ) => {
        callback({
          get: (name) => registry.get(name),
          set: (name, config) => {
            registry.set(name, config)
            setCalls.push({ name, config })
          },
          update: (name, update) => {
            update(registry.get(name) ?? {})
            updateCalls.push(name)
          },
        })
        return { dispose: async () => {} }
      },
    },
  })

  const deps = {
    createBuiltinMcps: (() => ({
      grep_app: { type: "remote", url: "https://mcp.grep.app", enabled: true, oauth: false },
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true, oauth: false },
      lsp: { type: "local", command: ["node", "/opt/lsp/cli.js"], enabled: true, environment: { A: "1" } },
      codegraph: { type: "local", command: ["node", "/opt/cg/cli.js"], enabled: false },
    })) as never,
  }

  return { makeCtx, deps, setCalls, updateCalls, registry }
}

beforeEach(() => {
  resetOmoMcpCache()
})

describe("registerOmoMcps", () => {
  it("registers every built-in MCP through the V2 editor", async () => {
    const { makeCtx, deps, setCalls } = createFixture()
    await registerOmoMcps(makeCtx("/work") as never, {} as never, deps)

    expect(setCalls.map((call) => call.name).sort()).toEqual(["codegraph", "context7", "grep_app", "lsp"])
    const lsp = setCalls.find((call) => call.name === "lsp")!.config
    expect(lsp).toEqual({
      type: "local",
      command: ["node", "/opt/lsp/cli.js"],
      environment: { A: "1" },
    })
    // A missing local CLI is registered as disabled, not dropped.
    expect(setCalls.find((call) => call.name === "codegraph")!.config).toEqual({
      type: "local",
      command: ["node", "/opt/cg/cli.js"],
      disabled: true,
    })
  })

  it("is idempotent for the same context", async () => {
    const { makeCtx, deps, setCalls } = createFixture()
    const ctx = makeCtx("/work")
    await registerOmoMcps(ctx as never, {} as never, deps)
    await registerOmoMcps(ctx as never, {} as never, deps)
    expect(setCalls).toHaveLength(4)
  })

  it("merges into the existing server when the context changes", async () => {
    const { makeCtx, deps, updateCalls } = createFixture()
    await registerOmoMcps(makeCtx("/work") as never, {} as never, deps)
    await registerOmoMcps(makeCtx("/work") as never, {} as never, deps)
    expect(updateCalls.sort()).toEqual(["codegraph", "context7", "grep_app", "lsp"])
  })

  it("skips registration when the V2 mcp domain is unavailable", async () => {
    const { deps, setCalls } = createFixture()
    await registerOmoMcps({ location: { directory: "/work" } } as never, {} as never, deps)
    expect(setCalls).toHaveLength(0)
  })
})
