// packages/omo-opencode/src/v2/prompt-hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 `session.hook("prompt")` → V1 `chat.message` bridge.
 *
 * The two are not equivalent. V1 handed the handler a mutable message draft
 * (`output.message` + `output.parts`) before durable admission; V2's `SessionPrompt` carries the
 * admitted prompt itself (`prompt: PromptInput.Prompt`), its `messageID`, and a `delivery`. Only
 * the **prompt text** is expressible on the V2 side, so:
 *
 * - the V1 view is `parts: [{type:"text", text}]` plus `message: { id: messageID }` (the id lets
 *   omo's ultrawork DB-level model override run instead of mutating a message object);
 * - write-back applies the parts' text back onto `prompt.text` **only when it changed**;
 * - `message.model` / `message.variant` / `message.thinking` / `message.agent` have no V2 prompt
 *   equivalent. They are reported through `onUnmapped` (default: log once per field) rather than
 *   dropped silently.
 */

export type V1ChatMessageInput = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
}
export type V1ChatMessageOutput = {
  message: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

/** Fields the V1 handler may set that the V2 prompt cannot carry. */
export const UNMAPPED_MESSAGE_FIELDS = ["model", "variant", "thinking", "agent"] as const

function promptText(event: Record<string, unknown>): string {
  const prompt = isRecord(event.prompt) ? event.prompt : {}
  return typeof prompt.text === "string" ? prompt.text : ""
}

export function toV1ChatMessage(
  event: unknown,
): { input: V1ChatMessageInput; output: V1ChatMessageOutput } | undefined {
  if (!isRecord(event) || typeof event.sessionID !== "string") return undefined
  const text = promptText(event)
  const message: Record<string, unknown> = {}
  if (typeof event.messageID === "string") message.id = event.messageID
  return {
    input: { sessionID: event.sessionID },
    output: {
      message,
      parts: text.length > 0 ? [{ type: "text", text }] : [],
    },
  }
}

function textFromParts(parts: ReadonlyArray<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n")
}

/**
 * Write the handler's text back onto the V2 prompt and report the message-level fields that the
 * V2 prompt cannot express.
 */
export function applyV1ChatMessage(
  event: unknown,
  output: V1ChatMessageOutput,
  onUnmapped: (field: string) => void,
): void {
  if (!isRecord(event)) return
  const prompt = isRecord(event.prompt) ? event.prompt : undefined
  if (prompt === undefined) return

  const next = textFromParts(output.parts)
  if (next !== promptText(event)) prompt.text = next

  for (const field of UNMAPPED_MESSAGE_FIELDS) {
    if (output.message[field] !== undefined) onUnmapped(field)
  }
}
