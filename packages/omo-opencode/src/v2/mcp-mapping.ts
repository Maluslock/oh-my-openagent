// packages/omo-opencode/src/v2/mcp-mapping.ts
import type { Mcp } from "@opencode/plugin"
import { isRecord } from "../shared"

/**
 * V1 → V2 MCP server config mapping.
 *
 * omo's built-in MCP definitions use the V1 shape:
 *   remote: `{type:"remote", url, enabled, headers?, oauth?:false}`
 *   local:  `{type:"local", command: string[], enabled, environment?}`
 *
 * V2's `ctx.mcp.transform` editor takes `Mcp.ServerConfig`, a tagged union on `type` whose
 * enablement is **inverted** (`disabled?: boolean` rather than `enabled: boolean`). The `oauth`
 * field accepts `OAuthConfig | false`, so V1's `oauth: false` passes through.
 *
 * Unrecognised shapes are dropped rather than handed to the host as invalid config.
 */

export type V1RemoteMcpConfig = {
  readonly type: "remote"
  readonly url: string
  readonly enabled: boolean
  readonly headers?: Record<string, string>
  readonly oauth?: false
}

export type V1LocalMcpConfig = {
  readonly type: "local"
  readonly command: string[]
  readonly enabled: boolean
  readonly environment?: Record<string, string>
}

export type V1McpConfig = V1RemoteMcpConfig | V1LocalMcpConfig

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

/** Project one V1 MCP config onto the V2 `Mcp.ServerConfig` shape. */
export function toV2McpConfig(v1: unknown): Mcp.ServerConfig | undefined {
  if (!isRecord(v1)) return undefined
  // V2 inverts enablement. Build the object key-by-key: the host's schema declares these fields
  // with `optionalKey`, which tolerates an ABSENT key but not an explicit `undefined` value.
  const disabled = v1.enabled === false

  if (v1.type === "remote") {
    if (typeof v1.url !== "string" || v1.url.length === 0) return undefined
    const remote: {
      type: "remote"
      url: string
      headers?: Record<string, string>
      oauth?: false
      disabled?: boolean
    } = { type: "remote", url: v1.url }
    const headers = toStringRecord(v1.headers)
    if (headers !== undefined) remote.headers = headers
    if (v1.oauth === false) remote.oauth = false
    if (disabled) remote.disabled = true
    return remote
  }

  if (v1.type === "local") {
    const command = Array.isArray(v1.command) ? v1.command.filter((entry) => typeof entry === "string") : []
    if (command.length === 0) return undefined
    const local: {
      type: "local"
      command: string[]
      environment?: Record<string, string>
      disabled?: boolean
    } = { type: "local", command }
    const environment = toStringRecord(v1.environment)
    if (environment !== undefined) local.environment = environment
    if (disabled) local.disabled = true
    return local
  }

  return undefined
}

/** Map a whole built-in MCP record, dropping entries the V2 shape cannot express. */
export function toV2McpConfigs(mcps: unknown): Record<string, Mcp.ServerConfig> {
  if (!isRecord(mcps)) return {}
  const mapped: Record<string, Mcp.ServerConfig> = {}
  for (const [name, config] of Object.entries(mcps)) {
    const converted = toV2McpConfig(config)
    if (converted !== undefined) mapped[name] = converted
  }
  return mapped
}
