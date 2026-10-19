// packages/omo-opencode/src/v2/compaction-hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 `session.hook("compaction")` → V1 `experimental.session.compacting` bridge.
 *
 * The two shapes are not equivalent:
 * - V1 handed the handler `output.context: string[]` — extra context to fold into the compaction
 *   request — plus an optional `prompt`.
 * - V2's `SessionCompaction` extends `SessionContext`, so it carries the request itself
 *   (`system` / `messages` / `options`) and an optional `result.summary` that, when set, **skips
 *   the model request**.
 *
 * Therefore the collected V1 context is injected as additional `system` text parts on the
 * compaction request (the only channel that reaches the summary request), and it is skipped
 * entirely when `result` is already present because no request will be made. V1's `prompt` has no
 * V2 equivalent and is ignored.
 */

export type V1CompactingInput = { sessionID: string }
export type V1CompactingOutput = { context: string[]; prompt?: string }

export function toV1Compacting(
  event: unknown,
): { input: V1CompactingInput; output: V1CompactingOutput } | undefined {
  if (!isRecord(event) || typeof event.sessionID !== "string") return undefined
  return { input: { sessionID: event.sessionID }, output: { context: [] } }
}

export function applyV1Compacting(event: unknown, output: V1CompactingOutput): void {
  if (!isRecord(event)) return
  const context = output.context.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  if (context.length === 0) return
  // `result` present means the summary is supplied and the model request is skipped.
  if (event.result !== undefined && event.result !== null) return
  const system = Array.isArray(event.system) ? event.system : []
  event.system = [...system, ...context.map((text) => ({ type: "text", text }))]
}
