// packages/omo-opencode/src/v2/client-shim-messages.ts
import { isRecord } from "../shared"

/**
 * V1 `session.messages` returns `{ data: Array<{ info, parts }> }`; V2 `ctx.session.context`
 * returns a flat `SessionMessage.Info[]` whose shape is a tagged union (`type` = `"user"` |
 * `"assistant"` | `"system"` | `"synthetic"` | `"skill"` | `"shell"` | `"compaction"` |
 * `"agent-switched"` | `"model-switched"` | `"location-switched"`).
 *
 * omo's consumers (the prompt gate, `call_omo_agent`'s message processor, `look_at`'s
 * assistant extractor, `background_output`) only read `info.role`, `info.time.created`,
 * `info.time.completed`, `info.finish`, `info.error` and `parts[]` entries of type
 * `text` / `reasoning` / `tool` / `tool_result`. This module rebuilds exactly that surface.
 *
 * Mapping decisions (verified against `@opencode/schema@2.0.11` `session-message.d.ts`):
 * - `assistant.content[]` items of type `text`/`reasoning` map 1:1.
 * - `assistant.content[]` items of type `tool` map to a `tool` part while the tool is still
 *   streaming/running (so the gate's unresolved/waiting-tool detection keeps working) and to a
 *   `tool_result` part once the state is `completed` or `error` (with the tool output/error as
 *   `content`, which is how `call_omo_agent`'s `message-processor` reads tool output).
 * - `synthetic` messages map to role `user` because V1 emitted internal prompts as user
 *   messages carrying the internal-initiator marker; the gate's synthetic-message detection
 *   reads the marker from the parts.
 * - Every other tagged variant maps to role `system` so it can never be mistaken for a user or
 *   assistant turn.
 */

export type V1ShimMessage = {
  info: Record<string, unknown>
  parts: unknown[]
}

/** V2 encodes `DateTimeUtc` as epoch milliseconds; tolerate string/record encodings too. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (isRecord(value)) {
    for (const key of ["epochMillis", "epochMilliseconds", "millis", "epoch"]) {
      const candidate = value[key]
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
    }
  }
  return undefined
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function messageTime(raw: Record<string, unknown>): { created?: number; completed?: number } | undefined {
  const time = isRecord(raw.time) ? raw.time : undefined
  if (!time) return undefined
  const created = toEpochMs(time.created)
  const completed = toEpochMs(time.completed)
  if (created === undefined && completed === undefined) return undefined
  return omitUndefined({ created, completed })
}

function toolStateText(state: Record<string, unknown>): string | undefined {
  const content = state.content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      texts.push(block.text)
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined
}

function toolStateErrorText(state: Record<string, unknown>): string | undefined {
  const error = state.error
  if (typeof error === "string") return error
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message
    if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message
  }
  return undefined
}

export function mapAssistantContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  const parts: unknown[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const type = block.type
    if (type === "text" || type === "reasoning") {
      if (typeof block.text === "string") parts.push({ type, text: block.text })
      continue
    }
    if (type !== "tool") continue

    const name = typeof block.name === "string" ? block.name : undefined
    const state = isRecord(block.state) ? block.state : undefined
    const status = typeof state?.status === "string" ? state.status : undefined

    if (state && (status === "completed" || status === "error")) {
      const text = status === "completed" ? toolStateText(state) : toolStateErrorText(state)
      parts.push(omitUndefined({
        type: "tool_result",
        name,
        content: text,
        state: status,
      }))
      continue
    }

    parts.push(omitUndefined({
      type: "tool",
      name,
      state: status === undefined ? undefined : { status },
    }))
  }
  return parts
}

function userParts(raw: Record<string, unknown>): unknown[] {
  const parts: unknown[] = []
  if (typeof raw.text === "string" && raw.text.length > 0) parts.push({ type: "text", text: raw.text })
  if (Array.isArray(raw.files)) {
    for (const file of raw.files) {
      if (!isRecord(file)) continue
      const mime = typeof file.mime === "string" ? file.mime : undefined
      const name = typeof file.name === "string" ? file.name : undefined
      parts.push(omitUndefined({ type: "file", mime, filename: name }))
    }
  }
  return parts
}

/**
 * Rebuild one V1-shaped `{ info, parts }` message from a V2 `SessionMessage.Info`.
 * Unknown/absent fields degrade to an empty text message rather than throwing: the gate and
 * the pollers must keep running on partial data.
 */
export function toV1Message(raw: unknown): V1ShimMessage {
  const message = isRecord(raw) ? raw : {}
  const type = typeof message.type === "string" ? message.type : ""
  const id = typeof message.id === "string" ? message.id : undefined
  const time = messageTime(message)

  if (type === "assistant") {
    return {
      info: omitUndefined({
        role: "assistant",
        id,
        time,
        finish: message.finish,
        error: message.error,
      }),
      parts: mapAssistantContent(message.content),
    }
  }

  if (type === "user" || type === "synthetic") {
    return {
      info: omitUndefined({ role: "user", id, time }),
      parts: userParts(message),
    }
  }

  const text = typeof message.text === "string" ? message.text : undefined
  return {
    info: omitUndefined({ role: "system", id, time }),
    parts: text === undefined || text.length === 0 ? [] : [{ type: "text", text }],
  }
}
