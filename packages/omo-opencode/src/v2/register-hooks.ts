// packages/omo-opencode/src/v2/register-hooks.ts
import { isRecord, log } from "../shared"
import {
  applyV1ToolAfter,
  applyV1ToolBefore,
  toV1ToolAfter,
  toV1ToolBefore,
  type V1ToolAfterInput,
  type V1ToolAfterOutput,
  type V1ToolBeforeInput,
  type V1ToolBeforeOutput,
} from "./tool-hook-mapping"
import {
  applyV1System,
  toV1System,
  type V1SystemInput,
  type V1SystemOutput,
} from "./system-hook-mapping"
import {
  createRequestMessageOrigins,
  fromV1RequestMessages,
  toV1RequestMessages,
  type V1RequestMessage,
} from "./request-message-mapping"
import {
  applyV1Compacting,
  toV1Compacting,
  type V1CompactingInput,
  type V1CompactingOutput,
} from "./compaction-hook-mapping"
import {
  applyV1ChatMessage,
  toV1ChatMessage,
  type V1ChatMessageInput,
  type V1ChatMessageOutput,
} from "./prompt-hook-mapping"
import { TOOL_NAMESPACE } from "./register-tools"
import {
  applySessionPromptConfig,
  type SessionPromptConfig,
} from "./session-prompt-config"
import {
  applyV1ChatParams,
  toV1ChatParams,
  type V1ChatParamsInput,
  type V1ChatParamsOutput,
} from "./model-request-hook-mapping"

/**
 * V2 hook registration layer.
 *
 * omo's V1 handlers are (input, output) pairs; the V2 domains expose single mutable events.
 * Each `registerOmo*Hooks` function bridges one domain by adapting the event, invoking the
 * existing V1 handler unchanged, and writing mutations back. Registration returns `dispose`
 * handles so `setup` reloads can tear the hooks down (the same lifecycle `register-tools.ts`
 * applies to managers).
 *
 * Error semantics follow V1:
 * - `execute.before` failures propagate: a guard that throws (write-existing-file-guard, the
 *   background-wait block) must abort the tool call.
 * - `execute.after` failures are isolated: the tool already ran, so a post-processing bug is
 *   logged instead of turning a successful call into an error.
 */

export type HookRegistration = { dispose: () => Promise<void> }

export type V1ToolBeforeHandler = (
  input: V1ToolBeforeInput,
  output: V1ToolBeforeOutput,
) => Promise<void> | void

export type V1ToolAfterHandler = (
  input: V1ToolAfterInput,
  output: V1ToolAfterOutput,
) => Promise<void> | void

export type V2ToolHookRegistrar = (
  name: "execute.before" | "execute.after",
  callback: (event: unknown) => Promise<void>,
) => Promise<HookRegistration>

export type RegisterToolHooksDeps = {
  readonly before?: V1ToolBeforeHandler
  readonly after?: V1ToolAfterHandler
}

export async function registerOmoToolHooks(
  registrar: V2ToolHookRegistrar,
  deps: RegisterToolHooksDeps,
): Promise<HookRegistration[]> {
  const { before, after } = deps
  const registrations: HookRegistration[] = []

  if (before !== undefined) {
    registrations.push(
      await registrar("execute.before", async (event) => {
        const pair = toV1ToolBefore(event)
        if (pair === undefined) return
        await before(pair.input, pair.output)
        applyV1ToolBefore(event, pair.input, pair.output)
      }),
    )
  }

  if (after !== undefined) {
    registrations.push(
      await registrar("execute.after", async (event) => {
        const pair = toV1ToolAfter(event)
        if (pair === undefined) return
        try {
          await after(pair.input, pair.output)
        } catch (error) {
          log("[v2] tool.execute.after hook failed", {
            tool: pair.input.tool,
            error: error instanceof Error ? error.message : String(error),
          })
          return
        }
        applyV1ToolAfter(event, pair.output)
      }),
    )
  }

  return registrations
}

export type V2SessionHookName = "context" | "compaction" | "model.request" | "prompt"

export type V2SessionHookRegistrar = (
  name: V2SessionHookName,
  callback: (event: unknown) => Promise<void>,
) => Promise<HookRegistration>

export type V1SystemTransformHandler = (
  input: V1SystemInput,
  output: V1SystemOutput,
) => Promise<void> | void

/**
 * Register V1 `experimental.chat.system.transform` on the V2 `context` hook. Only the `system`
 * field is bridged here; request `messages` go through `registerOmoMessagesHook`.
 */
export async function registerOmoSystemHook(
  registrar: V2SessionHookRegistrar,
  handler: V1SystemTransformHandler,
): Promise<HookRegistration> {
  return registrar("context", async (event) => {
    const pair = toV1System(event)
    if (pair === undefined) return
    await handler(pair.input, pair.output)
    applyV1System(event, pair.output)
  })
}

export type V1MessagesTransformHandler = (
  input: Record<string, never>,
  output: { messages: V1RequestMessage[] },
) => Promise<void> | void

/**
 * Register V1 `experimental.chat.messages.transform` on the V2 `context` hook. The V1 hooks
 * mutate `output.messages` in place (and may push/splice parts), so the bridge records origins
 * per invocation and rebuilds the V2 message list from the mutated view.
 */
export async function registerOmoMessagesHook(
  registrar: V2SessionHookRegistrar,
  handler: V1MessagesTransformHandler,
): Promise<HookRegistration> {
  return registrar("context", async (event) => {
    if (!isRecord(event) || typeof event.sessionID !== "string") return
    const origins = createRequestMessageOrigins()
    const messages = toV1RequestMessages(event.messages, event.sessionID, origins)
    await handler({}, { messages })
    event.messages = fromV1RequestMessages(messages, origins)
  })
}

export type V1CompactingHandler = (
  input: V1CompactingInput,
  output: V1CompactingOutput,
) => Promise<void> | void

/**
 * Register V1 `experimental.session.compacting` on the V2 `compaction` hook. Failures are
 * isolated and logged, matching V1's `runCompactionStep` so a broken compaction hook can never
 * abort the user's compaction.
 */
export async function registerOmoCompactionHook(
  registrar: V2SessionHookRegistrar,
  handler: V1CompactingHandler,
): Promise<HookRegistration> {
  return registrar("compaction", async (event) => {
    const pair = toV1Compacting(event)
    if (pair === undefined) return
    try {
      await handler(pair.input, pair.output)
    } catch (error) {
      log("[v2] session.compaction hook failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    applyV1Compacting(event, pair.output)
  })
}

export type V1ChatMessageHandler = (
  input: V1ChatMessageInput,
  output: V1ChatMessageOutput,
) => Promise<void> | void

/**
 * Register V1 `chat.message` on the V2 `prompt` hook. Only the prompt text round-trips; the
 * message-level fields the V2 prompt cannot carry are reported once per field instead of being
 * dropped silently (see `prompt-hook-mapping.ts`).
 */
export async function registerOmoPromptHook(
  registrar: V2SessionHookRegistrar,
  handler: V1ChatMessageHandler,
): Promise<HookRegistration> {
  const reported = new Set<string>()
  return registrar("prompt", async (event) => {
    const pair = toV1ChatMessage(event)
    if (pair === undefined) return
    await handler(pair.input, pair.output)
    applyV1ChatMessage(event, pair.output, (field) => {
      if (reported.has(field)) return
      reported.add(field)
      log(`[v2] chat.message cannot carry "${field}" on the V2 prompt`, { sessionID: pair.input.sessionID })
    })
  })
}

export type V1ChatParamsHandler = (
  input: V1ChatParamsInput,
  output: V1ChatParamsOutput,
) => Promise<void> | void

/**
 * Register V1 `chat.params` on the V2 `context` hook.
 *
 * Official migration mapping: V1 `chat.params` -> `ctx.session.hook("context", ...)` (see the V2
 * docs "Migrate request hooks"), which is what this does. `chat.headers` maps to
 * `ctx.session.hook("model.request", ...)` (or `http.request`) and is a separate registration.
 *
 * The agent's reasoning/variant is ALSO applied at agent registration (`resolveModelVariant` in
 * `agent-mapping.ts` sets the agent's `model.variant`). The request-time path runs here too: the
 * bridge synthesizes the `message` record the V1 handler requires from the host's current variant,
 * so `applyAgentVariant` and the `reasoningEffort` fallback for models with no declared variants
 * both work. The lowered variant is written back onto `event.model.variant`, which the host may
 * ignore; `options.reasoningEffort` is the path that always reaches the request.
 */
export async function registerOmoModelRequestHook(
  registrar: V2SessionHookRegistrar,
  handler: V1ChatParamsHandler,
): Promise<HookRegistration> {
  return registrar("context", async (event) => {
    const pair = toV1ChatParams(event)
    if (pair === undefined) return
    await handler(pair.input, pair.output)
    applyV1ChatParams(event, pair.output, pair.input)
  })
}

export type SessionPromptConfigResolver = (sessionID: string) => SessionPromptConfig | undefined

/**
 * Apply the per-session `system`/`tools` that the V1 create and prompt bodies carried and the V2
 * forms cannot (recorded by the client shim, see `session-prompt-config.ts`).
 *
 * Registered as its own `context` handler next to the V1 `experimental.chat.system.transform`
 * bridge: that one carries the *global* transform hooks, while this one replays what a specific
 * caller asked for when it created or prompted a session - the per-task skill content and tool
 * restrictions `delegate-task` / `background-agent` hand to their subagents.
 *
 * Unlike the V1 bridges, failures here must not break the request: a config that cannot be
 * expressed (a tool name with no V2 counterpart, an `"ask"` effect) is reported once and skipped.
 */
export async function registerOmoSessionPromptConfigHook(
  registrar: V2SessionHookRegistrar,
  resolve: SessionPromptConfigResolver,
): Promise<HookRegistration> {
  const reported = new Set<string>()
  return registrar("context", async (event) => {
    if (!isRecord(event) || typeof event.sessionID !== "string") return
    const config = resolve(event.sessionID)
    if (config === undefined) return
    applySessionPromptConfig(
      event,
      config,
      (reason, name) => {
        const key = `${reason}:${name}`
        if (reported.has(key)) return
        reported.add(key)
        log(
          reason === "ask"
            ? `[v2] session prompt config: "ask" for tool "${name}" cannot be enforced per request and the tool stays advertised`
            : `[v2] session prompt config: tool "${name}" has no V2 counterpart in this request and cannot be denied`,
          { sessionID: event.sessionID },
        )
      },
      // omo registers its own tools as `omo_*`, so a V1 body's bare `look_at` denial has to find
      // that id or it stays advertised.
      { namespace: TOOL_NAMESPACE },
    )
  })
}
