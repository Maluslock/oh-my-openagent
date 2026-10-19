// packages/omo-opencode/src/v2/chat-headers-mapping.ts
import { isRecord } from "../shared"
import type { HookRegistration, V2SessionHookRegistrar } from "./register-hooks"

/**
 * V1 `chat.headers` on the V2 `model.request` hook.
 *
 * Official mapping: V1 `chat.headers` -> `ctx.session.hook("model.request", ...)` (the V2 docs
 * "Migrate request hooks" show exactly `event.headers["x-plugin"] = "review"`). V2's payload carries
 * `{sessionID, agent, model, kind, baseURL, headers}` with a mutable `headers` object.
 *
 * The V1 handler omo has is Copilot-specific: it sets `x-initiator: agent` when the turn was started
 * by an omo-internal prompt (one carrying `OMO_INTERNAL_INITIATOR_MARKER`) for a Copilot provider,
 * and it needs the user message id to look that up through `client.session.message`. V2 does not put
 * a message on `model.request`, so the id is remembered from the `prompt` hook, which does carry
 * `messageID`. Without an id the lookup is simply skipped, which is the safe default (no header).
 *
 * Auxiliary requests are ignored: `model.request` also fires for `kind: "title"`/`"generate"`, and
 * V1's `chat.headers` only ever applied to the agent loop.
 */

/** The main loop only; auxiliary model requests (title/generate) never carried this hook in V1. */
export const PRIMARY_REQUEST_KIND = "primary"

const MAX_TRACKED_SESSIONS = 500

export type V1ChatHeadersInput = {
  readonly sessionID: string
  readonly provider: { readonly id: string }
  readonly message: { readonly id?: string; readonly role: string }
}

export type V1ChatHeadersOutput = {
  headers: Record<string, string>
}

export type V1ChatHeadersHandler = (
  input: V1ChatHeadersInput,
  output: V1ChatHeadersOutput,
) => Promise<void> | void

export type PromptMessageTracker = {
  readonly record: (event: unknown) => void
  readonly get: (sessionID: string) => string | undefined
  readonly reset: () => void
  readonly size: () => number
}

/** Remembers the newest prompt message id per session, bounded so a long-lived host cannot grow. */
export function createPromptMessageTracker(): PromptMessageTracker {
  const lastMessageIDs = new Map<string, string>()
  return {
    record(event: unknown): void {
      if (!isRecord(event)) return
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
      const messageID = typeof event.messageID === "string" ? event.messageID : undefined
      if (sessionID === undefined || messageID === undefined) return
      lastMessageIDs.delete(sessionID)
      lastMessageIDs.set(sessionID, messageID)
      while (lastMessageIDs.size > MAX_TRACKED_SESSIONS) {
        const oldest = lastMessageIDs.keys().next()
        if (oldest.done === true) break
        lastMessageIDs.delete(oldest.value)
      }
    },
    get(sessionID: string): string | undefined {
      return lastMessageIDs.get(sessionID)
    },
    reset(): void {
      lastMessageIDs.clear()
    },
    size(): number {
      return lastMessageIDs.size
    },
  }
}

/** Project a primary `model.request` event onto the V1 `chat.headers` input. */
export function toV1ChatHeaders(event: unknown, messageID?: string): V1ChatHeadersInput | undefined {
  if (!isRecord(event)) return undefined
  if (event.kind !== PRIMARY_REQUEST_KIND) return undefined
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
  const model = isRecord(event.model) ? event.model : undefined
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  if (sessionID === undefined || providerID === undefined) return undefined
  return {
    sessionID,
    provider: { id: providerID },
    message: { role: "user", ...(messageID !== undefined ? { id: messageID } : {}) },
  }
}

/** Copy the handler's headers onto the V2 request headers object. */
export function applyV1ChatHeaders(event: unknown, output: V1ChatHeadersOutput): void {
  if (!isRecord(event)) return
  const target = isRecord(event.headers) ? event.headers : undefined
  if (target === undefined) return
  for (const [key, value] of Object.entries(output.headers)) {
    if (typeof value === "string") target[key] = value
  }
}

/**
 * Register the header hook: one `prompt` registration to remember message ids, one `model.request`
 * registration to run the V1 handler and copy its headers onto the request.
 */
export async function registerOmoChatHeadersHook(
  registrar: V2SessionHookRegistrar,
  handler: V1ChatHeadersHandler,
  tracker: PromptMessageTracker,
): Promise<HookRegistration[]> {
  const promptRegistration = await registrar("prompt", async (event) => {
    tracker.record(event)
  })

  const requestRegistration = await registrar("model.request", async (event) => {
    const input = toV1ChatHeaders(event, isRecord(event) && typeof event.sessionID === "string" ? tracker.get(event.sessionID) : undefined)
    if (input === undefined) return
    const output: V1ChatHeadersOutput = { headers: {} }
    await handler(input, output)
    applyV1ChatHeaders(event, output)
  })

  return [promptRegistration, requestRegistration]
}
