// packages/omo-opencode/src/v2/ask-resolver.ts
import type { OhMyOpenCodeConfig } from "../config"
import { tokenizeCommand } from "../tools/interactive-bash/tools"

/**
 * V2 has no interactive permission prompt: `ToolContext.ask` is absent, and the plugin API exposes
 * no way to create a permission request (`ctx.permission` can list, get and reply to requests the
 * host created, and `ctx.permission.hook("evaluate")` only decides ones that already exist).
 *
 * The V2 tool mapping therefore fails closed by default. This resolver makes the one ask site omo
 * actually has usable: the monitor's bash gate, whose documented fallback is
 * `monitor.allowed_commands` when the host exposes no bash permission gate. Everything else stays
 * denied with an explicit message rather than a silent grant.
 */

export type V1AskInput = {
  readonly permission: string
  readonly patterns?: readonly string[]
  readonly always?: readonly string[]
  readonly metadata?: Record<string, unknown>
}

export type V1AskResolver = (input: V1AskInput) => Promise<void>

/** The program (first token) of a command, mirroring the monitor's own allowlist matching. */
export function commandProgram(command: string): string | undefined {
  const tokens = tokenizeCommand(command)
  return tokens.length > 0 ? tokens[0] : undefined
}

export function createV2AskResolver(pluginConfig: OhMyOpenCodeConfig): V1AskResolver {
  return async (input) => {
    if (input.permission !== "bash") {
      throw new Error(
        `permission "${input.permission}" cannot be approved: this host exposes no interactive permission prompt`,
      )
    }

    const command = typeof input.metadata?.command === "string"
      ? input.metadata.command
      : input.patterns?.[0]
    const program = typeof command === "string" ? commandProgram(command) : undefined
    const allowed = pluginConfig.monitor?.allowed_commands ?? []

    if (program !== undefined && allowed.includes(program)) return

    throw new Error(
      `bash permission denied: "${program ?? "unknown"}" is not in monitor.allowed_commands, and this host exposes no interactive permission prompt`,
    )
  }
}
