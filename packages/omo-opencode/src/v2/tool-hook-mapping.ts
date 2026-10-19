// packages/omo-opencode/src/v2/tool-hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 → V1 tool-hook adapters.
 *
 * omo's `tool.execute.before` / `tool.execute.after` handlers were written against the V1
 * plugin context, which handed them a two-argument pair:
 *
 *   before: input `{tool, sessionID, callID}` (where `input.tool` may be rewritten, e.g. the
 *           `mcp_` prefix strip) + output `{args}` (wholesale-replaced by `replaceToolArgs`)
 *   after:  input `{tool, sessionID, callID, args?}` + output `{title, output, metadata}`
 *
 * V2 instead mutates a single event object: `execute.before` carries a mutable `input`, and
 * `execute.after` carries a `result` (completed) or `error` (failed). These functions bridge the
 * two shapes in both directions so the existing handlers run unchanged.
 *
 * The V1 `{title, output, metadata}` ↔ V2 `{content, metadata, metadata.title}` convention is
 * the same one P2's `normalizeToolResult` already used, so tool results round-trip.
 */

export type V1ToolBeforeInput = { tool: string; sessionID: string; callID: string }
export type V1ToolBeforeOutput = { args: Record<string, unknown> }
export type V1ToolAfterInput = { tool: string; sessionID: string; callID: string; args?: Record<string, unknown> }
export type V1ToolAfterOutput = { title: string; output: string; metadata: Record<string, unknown> }

function asArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function asMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/** Flatten a V2 `Tool.Result` content into the V1 plain-text `output`. */
export function resultContentText(result: Record<string, unknown>): string {
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
  }
  return typeof result.output === "string" ? result.output : ""
}

/** Best-effort message for a V2 `Tool.Error`. */
export function toolErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message
    if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message
  }
  return ""
}

/** Build the V1 (input, output) pair for a V2 `execute.before` event. */
export function toV1ToolBefore(
  event: unknown,
): { input: V1ToolBeforeInput; output: V1ToolBeforeOutput } | undefined {
  if (!isRecord(event)) return undefined
  const tool = event.tool
  const sessionID = event.sessionID
  const callID = event.id
  if (typeof tool !== "string" || typeof sessionID !== "string" || typeof callID !== "string") return undefined
  return {
    input: { tool, sessionID, callID },
    output: { args: asArgs(event.input) },
  }
}

/**
 * Write a mutated V1 before-pair back onto the V2 event: the tool id (so `mcp_` stripping and
 * similar rewrites stick) and the replaced args.
 */
export function applyV1ToolBefore(
  event: unknown,
  input: V1ToolBeforeInput,
  output: V1ToolBeforeOutput,
): void {
  if (!isRecord(event)) return
  if (typeof event.tool === "string") event.tool = input.tool
  event.input = output.args
}

/** Build the V1 (input, output) pair for a V2 `execute.after` event. */
export function toV1ToolAfter(
  event: unknown,
): { input: V1ToolAfterInput; output: V1ToolAfterOutput } | undefined {
  if (!isRecord(event)) return undefined
  const tool = event.tool
  const sessionID = event.sessionID
  if (typeof tool !== "string" || typeof sessionID !== "string") return undefined
  const input: V1ToolAfterInput = {
    tool,
    sessionID,
    callID: typeof event.id === "string" ? event.id : "",
    ...(isRecord(event.input) ? { args: { ...event.input } } : {}),
  }

  if (event.status === "completed") {
    const result = isRecord(event.result) ? event.result : {}
    const metadata = asMetadata(result.metadata)
    return {
      input,
      output: {
        title: typeof metadata.title === "string" ? metadata.title : "",
        output: resultContentText(result),
        metadata,
      },
    }
  }

  return { input, output: { title: "", output: toolErrorText(event.error), metadata: {} } }
}

/**
 * Write a mutated V1 after-pair back onto a **completed** V2 event. A failed call carries a
 * `Tool.Error` rather than a result, so there is nothing meaningful to write back and the
 * failure is preserved unchanged.
 */
export function applyV1ToolAfter(event: unknown, output: V1ToolAfterOutput): void {
  if (!isRecord(event) || event.status !== "completed") return
  const result = isRecord(event.result) ? event.result : {}
  const metadata = { ...asMetadata(result.metadata), ...output.metadata }
  if (output.title.length > 0) metadata.title = output.title
  event.result = { ...result, content: output.output, metadata }
}
