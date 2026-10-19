// packages/omo-opencode/src/v2/request-message-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 request-message bridge for `session.hook("context")` → V1
 * `experimental.chat.messages.transform`.
 *
 * V2 `SessionContext.messages` are `@opencode/ai` `Message` objects
 * (`{id, role, content: ContentPart[], metadata?, providerMetadata?, native?}`) whose parts are a
 * tagged union (`text` / `media` / `tool-call` / `tool-result` / `reasoning` / `compaction` /
 * `effort`). V1 hooks expect `{info, parts}` and rely on a specific tool-part contract
 * (`hooks/tool-pair-validator/tool-part-ids.ts`):
 *
 * - a tool **call** is `{type:"tool", callID, state:{status}}`, and a `completed`/`error` status
 *   makes `getToolUseID` return null — so calls **with** a result must map to `completed` and
 *   calls **without** one to `running`, which is what makes the repair fire;
 * - a tool **result** is `{type:"tool_result", toolUseId, tool_use_id, isError?, content:[…]}`.
 *
 * Only the part kinds V1 touches are converted; `media` / `compaction` / `effort` parts are
 * handed through as the original objects so they can never be corrupted. Every converted part
 * records its origin so write-back can merge (preserving `cache` / `providerMetadata` / `native`)
 * instead of rebuilding from scratch.
 */

export type V1RequestPart = Record<string, unknown>
export type V1RequestMessage = {
  info: Record<string, unknown>
  parts: V1RequestPart[]
}
export type PartOrigins = WeakMap<object, Record<string, unknown>>
export type MessageOrigins = WeakMap<object, Record<string, unknown>>

export type RequestMessageOrigins = { parts: PartOrigins; messages: MessageOrigins }

export function createRequestMessageOrigins(): RequestMessageOrigins {
  return { parts: new WeakMap(), messages: new WeakMap() }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** V2 `ToolResultValue` → the V1 `content` block list. */
export function v1ContentFromV2Result(result: unknown): Array<{ type: "text"; text: string }> {
  if (!isRecord(result)) return []
  if (result.type === "content") {
    return Array.isArray(result.value)
      ? result.value.filter(isRecord).map((block) => ({ type: "text" as const, text: asText(block.text) }))
      : []
  }
  return [{ type: "text", text: asText(result.value) }]
}

function v1ContentText(part: Record<string, unknown>): string {
  const content = part.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.filter(isRecord).map((block) => asText(block.text)).join("")
  }
  return ""
}

function convertPart(part: Record<string, unknown>, hasResult: boolean, origins: RequestMessageOrigins): V1RequestPart {
  const record = (v1: V1RequestPart): V1RequestPart => {
    origins.parts.set(v1, part)
    return v1
  }

  switch (part.type) {
    case "text":
      return record({ type: "text", text: asText(part.text) })
    case "reasoning":
      return record({ type: "reasoning", text: asText(part.text) })
    case "tool-call":
      return record({
        type: "tool",
        callID: part.id,
        ...(typeof part.name === "string" ? { tool: part.name } : {}),
        state: { status: hasResult ? "completed" : "running", ...(part.input === undefined ? {} : { input: part.input }) },
      })
    case "tool-result":
      return record({
        type: "tool_result",
        toolUseId: part.id,
        tool_use_id: part.id,
        ...(isRecord(part.result) && part.result.type === "error" ? { isError: true } : {}),
        content: v1ContentFromV2Result(part.result),
      })
    default:
      // media / compaction / effort: untouched, never mapped, never rebuilt.
      return part
  }
}

/** Project V2 request messages onto the V1 `{info, parts}` view the transform hooks mutate. */
export function toV1RequestMessages(
  messages: unknown,
  sessionID: string,
  origins: RequestMessageOrigins,
): V1RequestMessage[] {
  if (!Array.isArray(messages)) return []

  const records = messages.filter(isRecord)
  // V2 keeps a tool result in its OWN message, not in the message that carries the tool call. The
  // V1 view marks a call terminal through `state.status`, so result ids must be collected across the
  // whole request. Looking only inside the call's own message marked every finished call as
  // `running`, which made `tool-pair-validator` "repair" a healthy conversation by injecting a
  // `tool_result` part into a user message; OpenAI-compatible lowering rejects exactly that
  // ("user messages only support text and media content"). See
  // `.omo/evidence/20260923-v2-alignment/live-tool-turn-bug.md`.
  const resultIDs = new Set<string>()
  for (const message of records) {
    const content = Array.isArray(message.content) ? message.content : []
    for (const part of content) {
      if (isRecord(part) && part.type === "tool-result" && typeof part.id === "string") resultIDs.add(part.id)
    }
  }

  return records.map((message) => {
    const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : []
    const info: Record<string, unknown> = {
      ...(typeof message.role === "string" ? { role: message.role } : {}),
      ...(typeof message.id === "string" ? { id: message.id } : {}),
      sessionID,
    }
    const v1: V1RequestMessage = {
      info,
      parts: parts.map((part) => convertPart(part, typeof part.id === "string" && resultIDs.has(part.id as string), origins)),
    }
    origins.messages.set(v1, message)
    return v1
  })
}

function v2ResultFromV1Part(part: Record<string, unknown>, origin: Record<string, unknown> | undefined) {
  const text = v1ContentText(part)
  const originResult = origin !== undefined && isRecord(origin.result) ? origin.result : undefined
  if (originResult !== undefined && originResult.type === "content") {
    return { type: "content", value: [{ type: "text", text }] }
  }
  if (originResult !== undefined && typeof originResult.type === "string") {
    return { type: originResult.type, value: text }
  }
  return { type: part.isError === true ? "error" : "text", value: text }
}

function v2PartFromV1(
  part: V1RequestPart,
  origins: RequestMessageOrigins,
  nameById: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const origin = origins.parts.get(part)

  if (part.type === "text" && typeof part.text === "string") {
    return origin === undefined ? { type: "text", text: part.text } : { ...origin, type: "text", text: part.text }
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return origin === undefined ? { type: "reasoning", text: part.text } : { ...origin, type: "reasoning", text: part.text }
  }
  if (part.type === "tool" && typeof part.callID === "string") {
    const state = isRecord(part.state) ? part.state : {}
    return {
      ...(origin ?? {}),
      type: "tool-call",
      id: part.callID,
      name: typeof part.tool === "string" ? part.tool : nameById.get(part.callID) ?? "unknown",
      input: state.input ?? (origin?.input ?? {}),
    }
  }
  if (part.type === "tool_result") {
    const id = typeof part.toolUseId === "string" ? part.toolUseId : typeof part.tool_use_id === "string" ? part.tool_use_id : undefined
    if (id === undefined) return undefined
    return {
      ...(origin ?? {}),
      type: "tool-result",
      id,
      name: typeof part.tool === "string" ? part.tool : nameById.get(id) ?? "unknown",
      result: v2ResultFromV1Part(part, origin),
    }
  }

  // Unknown kinds that carry an origin pass through untouched; anything else is dropped rather
  // than handed to V2 as an invalid part.
  return origin
}

function buildContent(
  parts: V1RequestPart[],
  origins: RequestMessageOrigins,
): { content: Record<string, unknown>[]; nameById: Map<string, string> } {
  const nameById = new Map<string, string>()
  for (const part of parts) {
    if (part.type === "tool" && typeof part.callID === "string" && typeof part.tool === "string") {
      nameById.set(part.callID, part.tool)
    }
  }
  const content: Record<string, unknown>[] = []
  for (const part of parts) {
    const mapped = v2PartFromV1(part, origins, nameById)
    if (mapped !== undefined) content.push(mapped)
  }
  return { content, nameById }
}

/**
 * Rebuild V2 request messages from the (possibly mutated) V1 view. Messages the hooks inserted
 * have no origin and get a synthesized id, since V2 requires one.
 */
export function fromV1RequestMessages(
  v1Messages: unknown,
  origins: RequestMessageOrigins,
  synthesizeMessageID: (index: number) => string = (index) => `msg_synth_${index}`,
): Record<string, unknown>[] {
  if (!Array.isArray(v1Messages)) return []
  return v1Messages.filter(isRecord).map((message, index) => {
    const origin = origins.messages.get(message)
    const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : []
    const { content } = buildContent(parts, origins)
    const info = isRecord(message.info) ? message.info : {}
    const id = typeof info.id === "string" ? info.id : origin !== undefined && typeof origin.id === "string" ? origin.id : synthesizeMessageID(index)
    const role = typeof info.role === "string" ? info.role : origin !== undefined && typeof origin.role === "string" ? origin.role : "user"
    return { ...(origin ?? {}), id, role, content }
  })
}
