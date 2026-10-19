import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2Plugin } from "./create-v2-plugin"

type MutableAgent = {
  id: string
  name?: string
  permissions: Array<{ action: string; resource: string; effect: string }>
  model?: { providerID?: string; id?: string; variant?: string }
  request?: {
    settings?: Record<string, unknown>
    headers?: Record<string, unknown>
    body?: Record<string, unknown>
  }
}

// The rules `Agent.Info.default(id)` seeds when the V2 editor creates a missing id
// (wildcard allow, external_directory ask, the `.env` read guards). Kept in sync with
// the observed host seed so the merge behaviour is exercised against the real shapes.
const SEEDED_DEFAULT_PERMISSIONS = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

function createMockEditor() {
  const registry = new Map<string, MutableAgent>()
  return {
    registry,
    list: () => [...registry.values()],
    get: (id: string) => registry.get(id),
    default: (_id: string | undefined) => {},
    update: (id: string, fn: (agent: MutableAgent) => void) => {
      const agent = registry.get(id) ?? {
        id,
        // Emulate the seed `Agent.Info.default(id)` the V2 editor prepends: the default
        // permission rules, and a `request` with all three keys (`settings`/`headers`/`body`).
        permissions: SEEDED_DEFAULT_PERMISSIONS.map((permission) => ({ ...permission })),
        request: { settings: { seeded: true }, headers: {}, body: {} },
      }
      if (!registry.has(id)) registry.set(id, agent)
      fn(agent)
    },
    remove: (id: string) => registry.delete(id),
  }
}

describe("createV2Plugin", () => {
  it("returns a V2 definition with the omo id and a setup function", () => {
    const plugin = createV2Plugin()
    expect(plugin.id).toBe("oh-my-openagent")
    expect(typeof plugin.setup).toBe("function")
  })

  it("setup() resolves on a malformed ctx so the plugin stays loadable", async () => {
    const plugin = createV2Plugin()
    await expect(Promise.resolve(plugin.setup({} as never))).resolves.toBeUndefined()
  })

  it("setup() registers a synchronous agent transform for a real location", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-register-"))
    const home = mkdtempSync(join(tmpdir(), "omo-v2-home-"))
    const previousHome = process.env.HOME
    const previousXdg = process.env.XDG_CONFIG_HOME
    try {
      // Isolate the config chain: without this the loader reads the developer's
      // `~/.omo/omo.jsonc`, making the test environment-dependent.
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = join(home, "xdg-config")
      mkdirSync(join(home, ".omo"), { recursive: true })
      writeFileSync(
        join(home, ".omo", "omo.jsonc"),
        `${JSON.stringify({
          "[opencode]": {
            agents: { oracle: { model: "litellm/deepseek-flash", reasoning: "max" } },
          },
        })}\n`,
      )

      let captured: ((editor: ReturnType<typeof createMockEditor>) => void) | undefined
      const ctx = {
        location: { directory },
        agent: {
          transform: async (callback: (editor: ReturnType<typeof createMockEditor>) => void) => {
            captured = callback
            return { dispose: async () => {} }
          },
        },
      }

      const plugin = createV2Plugin()
      await expect(Promise.resolve(plugin.setup(ctx as never))).resolves.toBeUndefined()

      // The transform is registered and its callback is synchronous (returns undefined, not a Promise).
      expect(typeof captured).toBe("function")
      const editor = createMockEditor()
      const returned = captured?.(editor)
      expect(returned).toBeUndefined()

      // Agents are injected, and for every agent that received incoming rules the
      // editor-seeded default permission is still present (merge, not replace).
      expect(editor.registry.size).toBeGreaterThan(0)
      const agentsWithIncoming = [...editor.registry.values()].filter(
        (agent) => agent.permissions.length > SEEDED_DEFAULT_PERMISSIONS.length,
      )
      expect(agentsWithIncoming.length).toBeGreaterThan(0)
      for (const agent of agentsWithIncoming) {
        expect(agent.permissions.some((p) => p.action === "*" && p.effect === "allow")).toBe(true)
      }

      // A deny that shares `(action, resource)` with the seeded wildcard allow must survive:
      // the read-only looker declares `{"*":"deny", read:"allow"}`.
      const looker = editor.registry.get("multimodal-looker")
      expect(looker).toBeDefined()
      expect(looker?.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
      expect(looker?.permissions).toContainEqual({ action: "*", resource: "*", effect: "allow" })

      // A configured reasoning level is lowered onto the model descriptor at registration.
      const oracle = editor.registry.get("oracle")
      expect(oracle?.model).toMatchObject({ providerID: "litellm", id: "deepseek-flash", variant: "max" })

      // The `request` is merged, not replaced: the V2 list endpoint requires
      // `request.settings` and `request.headers`, so they must survive for every agent.
      for (const agent of editor.registry.values()) {
        expect(agent.request?.settings).toBeDefined()
        expect(agent.request?.headers).toBeDefined()
      }
      const agentsWithRequestBody = [...editor.registry.values()].filter(
        (agent) => Object.keys(agent.request?.body ?? {}).length > 0,
      )
      // Prove the merge path actually ran (at least one agent received a mapped request body).
      expect(agentsWithRequestBody.length).toBeGreaterThan(0)
      for (const agent of agentsWithRequestBody) {
        expect(agent.request?.settings).toEqual({ seeded: true })
        expect(agent.request?.headers).toEqual({})
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      rmSync(directory, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
