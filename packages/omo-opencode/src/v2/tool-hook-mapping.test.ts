// packages/omo-opencode/src/v2/tool-hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import {
  applyV1ToolAfter,
  applyV1ToolBefore,
  resultContentText,
  toV1ToolAfter,
  toV1ToolBefore,
  toolErrorText,
} from "./tool-hook-mapping"

describe("tool.execute.before mapping", () => {
  it("builds the V1 pair from the V2 event", () => {
    const pair = toV1ToolBefore({
      tool: "mcp_omo_glob",
      sessionID: "ses_1",
      agent: "sisyphus",
      messageID: "msg_1",
      id: "call_1",
      input: { pattern: "*.md" },
    })

    expect(pair).toEqual({
      input: { tool: "mcp_omo_glob", sessionID: "ses_1", callID: "call_1" },
      output: { args: { pattern: "*.md" } },
    })
  })

  it("writes a rewritten tool name and replaced args back onto the event", () => {
    const event: Record<string, unknown> = {
      tool: "mcp_omo_glob",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "*.md" },
    }
    const pair = toV1ToolBefore(event)
    expect(pair).toBeDefined()
    // Simulate what the V1 handler does: strip the mcp_ prefix, then replace args.
    pair!.input.tool = "omo_glob"
    pair!.output.args = { ...pair!.output.args, extra: true }

    applyV1ToolBefore(event, pair!.input, pair!.output)

    expect(event.tool).toBe("omo_glob")
    expect(event.input).toEqual({ pattern: "*.md", extra: true })
  })

  it("returns undefined for malformed events instead of throwing", () => {
    expect(toV1ToolBefore(null)).toBeUndefined()
    expect(toV1ToolBefore({ tool: "x", sessionID: "s" })).toBeUndefined()
    expect(toV1ToolBefore({ tool: 1, sessionID: "s", id: "c" })).toBeUndefined()
  })
})

describe("tool.execute.after mapping", () => {
  it("maps a completed V2 result to the V1 {title, output, metadata} output", () => {
    const pair = toV1ToolAfter({
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "x" },
      status: "completed",
      result: {
        content: "line1\nline2",
        metadata: { title: "Grep results", count: 2 },
      },
    })

    expect(pair).toEqual({
      input: { tool: "grep", sessionID: "ses_1", callID: "call_1", args: { pattern: "x" } },
      output: { title: "Grep results", output: "line1\nline2", metadata: { title: "Grep results", count: 2 } },
    })
  })

  it("writes mutated title/output/metadata back and keeps the title in metadata", () => {
    const event: Record<string, unknown> = {
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      result: { content: "old", metadata: { keep: true } },
    }
    const pair = toV1ToolAfter(event)
    pair!.output.output = "old\n\n[truncated]"
    pair!.output.title = "Truncated"
    pair!.output.metadata = { ...pair!.output.metadata, matched: 3 }

    applyV1ToolAfter(event, pair!.output)

    expect(event.result).toEqual({
      content: "old\n\n[truncated]",
      metadata: { keep: true, title: "Truncated", matched: 3 },
    })
  })

  it("maps a failed V2 call to the error text and does not write back", () => {
    const event: Record<string, unknown> = {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      status: "error",
      error: { message: "exit 1" },
    }
    const pair = toV1ToolAfter(event)
    expect(pair?.output).toEqual({ title: "", output: "exit 1", metadata: {} })

    pair!.output.output = "rewritten"
    applyV1ToolAfter(event, pair!.output)
    // The failure is preserved verbatim.
    expect(event.result).toBeUndefined()
    expect(event.error).toEqual({ message: "exit 1" })
  })

  it("reads array content, nested error data, and missing fields defensively", () => {
    expect(resultContentText({ content: [{ type: "text", text: "a" }, { type: "file", name: "f" }, { type: "text", text: "b" }] })).toBe("ab")
    expect(resultContentText({ output: "fallback" })).toBe("fallback")
    expect(resultContentText({})).toBe("")
    expect(toolErrorText({ data: { message: "nested" } })).toBe("nested")
    expect(toolErrorText("plain")).toBe("plain")
    expect(toolErrorText({})).toBe("")
    expect(toV1ToolAfter(null)).toBeUndefined()
  })
})
