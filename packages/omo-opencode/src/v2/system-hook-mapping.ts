// packages/omo-opencode/src/v2/system-hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 `session.hook("context")` → V1 `experimental.chat.system.transform` bridge.
 *
 * V1's system transform received `input = {sessionID?, model: {id, providerID}}` and mutated
 * `output.system: string[]`. V2's `SessionContext.system` is `SystemPart[]`
 * (`{type:"text", text, cache?, metadata?}`), so the adapter projects the texts for the handler
 * and, **only when the handler actually changed them**, rebuilds the parts.
 *
 * The conditional write-back matters: rewriting unconditionally would drop each part's `cache`
 * hint and `metadata`, which would defeat prompt caching on every request.
 */

export type V1SystemInput = { sessionID?: string; model: { id: string; providerID: string } }
export type V1SystemOutput = { system: string[] }

function textOf(part: unknown): string {
  return isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""
}

function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Build the V1 (input, output) pair for a V2 `context` event, or undefined when malformed. */
export function toV1System(
  event: unknown,
): { input: V1SystemInput; output: V1SystemOutput } | undefined {
  if (!isRecord(event)) return undefined
  const sessionID = event.sessionID
  if (typeof sessionID !== "string") return undefined
  const model = isRecord(event.model) ? event.model : {}
  const id = typeof model.id === "string" ? model.id : undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : undefined
  if (id === undefined || providerID === undefined) return undefined
  const system = Array.isArray(event.system) ? event.system : []
  return {
    input: { sessionID, model: { id, providerID } },
    output: { system: system.map(textOf) },
  }
}

/**
 * Write the handler's `system` back onto the V2 event, but only when the text list changed so
 * unchanged parts keep their `cache`/`metadata`. A changed list is rebuilt as plain text parts.
 */
export function applyV1System(event: unknown, output: V1SystemOutput): void {
  if (!isRecord(event)) return
  const current = Array.isArray(event.system) ? event.system : []
  const before = current.map(textOf)
  if (sameTexts(before, output.system)) return
  event.system = output.system.map((text) => ({ type: "text", text }))
}
