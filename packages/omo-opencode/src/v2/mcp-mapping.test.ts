// packages/omo-opencode/src/v2/mcp-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { toV2McpConfig, toV2McpConfigs } from "./mcp-mapping"

describe("toV2McpConfig", () => {
  it("maps an enabled V1 remote config onto the V2 shape", () => {
    expect(
      toV2McpConfig({
        type: "remote",
        url: "https://mcp.grep.app",
        enabled: true,
        oauth: false,
      }),
    ).toEqual({ type: "remote", url: "https://mcp.grep.app", oauth: false })
  })

  it("passes remote headers through and inverts enabled:false into disabled:true", () => {
    expect(
      toV2McpConfig({
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: false,
        headers: { Authorization: "Bearer x" },
      }),
    ).toEqual({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer x" },
      disabled: true,
    })
  })

  it("maps an enabled V1 local config with its command and environment", () => {
    expect(
      toV2McpConfig({
        type: "local",
        command: ["node", "/opt/lsp/cli.js"],
        enabled: true,
        environment: { LSP_TOOLS_MCP_USER_CONFIG: "/home/user/.config/opencode/lsp.json" },
      }),
    ).toEqual({
      type: "local",
      command: ["node", "/opt/lsp/cli.js"],
      environment: { LSP_TOOLS_MCP_USER_CONFIG: "/home/user/.config/opencode/lsp.json" },
    })
  })

  it("inverts enabled:false on a local config into disabled:true", () => {
    expect(toV2McpConfig({ type: "local", command: ["npx", "x"], enabled: false })).toEqual({
      type: "local",
      command: ["npx", "x"],
      disabled: true,
    })
  })

  it("omits absent optional keys instead of emitting explicit undefined", () => {
    // The host declares these fields with `optionalKey`, which accepts an absent key but rejects an
    // explicit `undefined` value, so a rounded-trip through JSON must not grow undefined entries.
    const remote = toV2McpConfig({ type: "remote", url: "https://mcp.grep.app", enabled: true })
    const local = toV2McpConfig({ type: "local", command: ["node", "cli.js"], enabled: true })
    expect(Object.keys(remote ?? {})).toEqual(["type", "url"])
    expect(Object.keys(local ?? {})).toEqual(["type", "command"])
    expect(JSON.parse(JSON.stringify(remote))).toEqual(remote)
  })

  it("ignores non-string header and environment values", () => {
    expect(
      toV2McpConfig({
        type: "remote",
        url: "https://mcp.grep.app",
        enabled: true,
        headers: { Authorization: "Bearer x", broken: 42 },
      }),
    ).toEqual({ type: "remote", url: "https://mcp.grep.app", headers: { Authorization: "Bearer x" } })
    expect(
      toV2McpConfig({
        type: "local",
        command: ["node", "cli.js"],
        enabled: true,
        environment: { OK: "1", NOPE: null },
      }),
    ).toEqual({ type: "local", command: ["node", "cli.js"], environment: { OK: "1" } })
  })

  it("drops malformed or unknown shapes", () => {
    expect(toV2McpConfig(null)).toBeUndefined()
    expect(toV2McpConfig({})).toBeUndefined()
    expect(toV2McpConfig({ type: "remote" })).toBeUndefined()
    expect(toV2McpConfig({ type: "remote", url: "" })).toBeUndefined()
    expect(toV2McpConfig({ type: "local" })).toBeUndefined()
    expect(toV2McpConfig({ type: "local", command: [] })).toBeUndefined()
    expect(toV2McpConfig({ type: "stdio", command: ["x"] })).toBeUndefined()
  })

  it("filters a whole MCP record", () => {
    expect(
      toV2McpConfigs({
        grep_app: { type: "remote", url: "https://mcp.grep.app", enabled: true },
        lsp: { type: "local", command: ["node", "cli.js"], enabled: true },
        broken: { type: "remote" },
      }),
    ).toEqual({
      grep_app: { type: "remote", url: "https://mcp.grep.app" },
      lsp: { type: "local", command: ["node", "cli.js"] },
    })
    expect(toV2McpConfigs(null)).toEqual({})
  })
})
