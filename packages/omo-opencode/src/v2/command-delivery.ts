// packages/omo-opencode/src/v2/command-delivery.ts
import type { Plugin } from "@opencode/plugin"
import { isAgentRegistered, resolveRegisteredAgentName } from "../features/claude-code-session-state"
import { log } from "../shared"
import type { CommandDeliver } from "./command-mapping"

/**
 * Host-facing half of the command port: posts an already-expanded command prompt into the session,
 * switching the session agent first when the command declares one.
 *
 * This is not internal message injection. The user typed the command, the host invoked the
 * definition's `execute`, and the host's own `delivery` decision ("steer" vs "queue") is forwarded
 * verbatim - so the concurrency choice stays with the host. Routing it through the shared prompt
 * gate instead would let the gate drop a user's own command, which is why this module carries its
 * own `prompt-async-route-audit` allowlist entry rather than a gate call.
 *
 * Live contract (probed on opencode 2.0.11): `execute` receives
 * `{ sessionID, prompt, delivery }`; `ctx.session.prompt({ sessionID, text })` posts the user
 * message; `ctx.session.switchAgent({ sessionID, agent })` retargets the session.
 */

type V2Setup = NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>
type V2Context = Parameters<V2Setup>[0]
type V2Session = NonNullable<V2Context["session"]>
type V2SessionPromptInput = Parameters<V2Session["prompt"]>[0]

export function createCommandDeliver(ctx: V2Context): CommandDeliver {
  return async ({ invocation, command, text }) => {
    if (typeof command.agent === "string" && command.agent.length > 0) {
      // Command definitions name agents by config key ("atlas"), but V2 registers omo's agents under
      // their display ids ("Atlas - Plan Executor"). Switching to the bare key is accepted and then
      // fails later inside the session runner with AgentNotFoundError, which drops the prompt while
      // the command still answers 204. Resolve first, and say so when the name was never registered.
      const resolved = resolveRegisteredAgentName(command.agent) ?? command.agent
      if (!isAgentRegistered(command.agent)) {
        log("[v2] command agent not registered", { command: command.name, agent: command.agent, resolved })
      }
      await ctx.session.switchAgent({ sessionID: invocation.sessionID, agent: resolved })
    }

    // Attachments are forwarded so `/cmd @file` keeps the reference. Keys are written only when
    // present: the host declares them with `optionalKey`, which rejects an explicit `undefined`.
    const attachments = {
      ...(invocation.prompt.files ? { files: invocation.prompt.files } : {}),
      ...(invocation.prompt.skills ? { skills: invocation.prompt.skills } : {}),
    }
    const payload: V2SessionPromptInput = {
      sessionID: invocation.sessionID,
      text,
      delivery: invocation.delivery,
      ...attachments,
    }

    await ctx.session.prompt(payload)
  }
}
