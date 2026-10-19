// packages/omo-opencode/src/v2/tool-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { normalizeToolResult, stripForeignJsonSchemaOverride, toV2Tool } from "./tool-mapping"

describe("normalizeToolResult", () => {
  it("wraps a plain string", () => {
    expect(normalizeToolResult("ok")).toEqual({ content: "ok" })
  })
  it("maps V1 {output,title,metadata} preserving title", () => {
    const out = normalizeToolResult({ output: "body", title: "T", metadata: { a: 1 } })
    expect(out.content).toBe("body")
    expect(out.metadata).toEqual({ title: "T", a: 1 })
  })
  it("maps attachments to file content entries", () => {
    const out = normalizeToolResult({
      output: "done",
      attachments: [{ type: "file", mime: "image/png", url: "file:///x.png", filename: "x.png" }],
    })
    expect(Array.isArray(out.content)).toBe(true)
    expect(out.content).toEqual([
      { type: "text", text: "done" },
      { type: "file", uri: "file:///x.png", mime: "image/png", name: "x.png" },
    ])
  })

  it("gives the explicit V1 title precedence over metadata.title", () => {
    const out = normalizeToolResult({ output: "body", title: "T", metadata: { title: "M" } })
    expect(out.metadata).toEqual({ title: "T" })
  })
})

describe("toV2Tool", () => {
  it("passes zod args through and namespaces the tool", () => {
    const v2 = toV2Tool(
      "glob",
      { description: "d", args: { pattern: tool.schema.string() }, execute: async () => "ok" },
      { namespace: "omo", directory: "/tmp" },
    )
    expect(v2.name).toBe("glob")
    expect(v2.description).toBe("d")
    expect(v2.options).toEqual({ namespace: "omo", codemode: false })
    expect(typeof v2.input.parse).toBe("function") // z.object(...) StandardSchema
  })

  it("builds the input schema with the args' own zod instance (tool.schema) and still validates", () => {
    // Mirrors production: omo's args are declared with `@opencode-ai/plugin`'s `tool.schema`,
    // so the wrapper must come from the same instance for V2's JSON-Schema extraction.
    const v2 = toV2Tool(
      "glob",
      {
        description: "d",
        args: { pattern: tool.schema.string(), path: tool.schema.string().optional() },
        execute: async () => "ok",
      },
      { namespace: "omo", directory: "/tmp" },
    )
    expect(v2.input.parse({ pattern: "x" })).toEqual({ pattern: "x" })
    expect(v2.input.parse({ pattern: "x", path: "src" })).toEqual({ pattern: "x", path: "src" })
    expect(() => v2.input.parse({})).toThrow()
    // Same module instance as the args' harness: conversion to JSON Schema must not throw.
    expect(typeof tool.schema.toJSONSchema(v2.input)).toBe("object")

    // DISCRIMINATING provenance check. Root zod (this package's `zod`) marks its schemas with
    // `_zod.processJSONSchema`; `tool.schema`'s bundled zod (4.1.8) does not. If `toV2Tool`
    // regressed to `z.object(def.args)` (root zod wrapping tool.schema fields), this would be a
    // function and V2's extraction would throw `undefined is not an object (evaluating 'seen.ref')`,
    // silently dropping the tool. The control asserts the root-zod marker exists so the test truly
    // separates the two constructions.
    expect(
      (v2.input as { _zod?: { processJSONSchema?: unknown } })._zod?.processJSONSchema,
    ).toBeUndefined()
    expect(
      typeof (z.object({ pattern: z.string() }) as { _zod?: { processJSONSchema?: unknown } })._zod
        ?.processJSONSchema,
    ).toBe("function")
  })

  it("fails loudly on args built with root zod while the wrapper uses tool.schema", () => {
    expect(() =>
      toV2Tool(
        "glob",
        { description: "d", args: { pattern: z.string() }, execute: async () => "ok" },
        { namespace: "omo", directory: "/tmp" },
      ),
    ).toThrow(/mismatched zod instance.*pattern/)
  })

  it("shims V1 context (directory/sessionID/agent/metadata/abort) and normalizes result", async () => {
    let seenCtx: Record<string, unknown> | undefined
    const v2 = toV2Tool(
      "probe",
      {
        description: "d",
        args: { text: tool.schema.string() },
        execute: async (args: { text: string }, ctx: Record<string, unknown>) => {
          seenCtx = ctx
          return `echo:${args.text}`
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    const res = await v2.execute(
      { text: "hi" },
      { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} } as never,
    )
    expect(res).toEqual({ content: "echo:hi" })
    expect(seenCtx?.sessionID).toBe("ses_1")
    expect(seenCtx?.agent).toBe("build")
    expect(seenCtx?.directory).toBe("/work")
    // V2 names the tool-call id `id`; V1 consumers (hashline-edit) read callID/callId/call_id.
    expect(seenCtx?.callID).toBe("call_1")
    expect(seenCtx?.callId).toBe("call_1")
    expect(seenCtx?.call_id).toBe("call_1")
    expect(typeof seenCtx?.metadata).toBe("function")
    expect(seenCtx?.abort).toBeInstanceOf(AbortSignal)
  })

  it("fails closed when no ask resolver is supplied", async () => {
    const v2 = toV2Tool(
      "gated",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { ask: (i: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void> }) => {
          await ctx.ask({ permission: "shell", patterns: [], always: [], metadata: {} })
          return "approved"
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    await expect(
      v2.execute({}, { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never),
    ).rejects.toThrow("ask() is not available in this host; refusing to auto-approve")
  })

  it("supplies a distinct abort signal per execute call when the host exposes none", async () => {
    const signals: AbortSignal[] = []
    const v2 = toV2Tool(
      "probe",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { abort: AbortSignal }) => {
          signals.push(ctx.abort)
          return "ok"
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    const ctx = { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never
    await v2.execute({}, ctx)
    await v2.execute({}, ctx)
    expect(signals).toHaveLength(2)
    expect(signals[0]).not.toBe(signals[1])
    expect(signals[0]?.aborted).toBe(false)
  })

  it("hands the tool the host's own abort signal so an interrupt reaches a running call", async () => {
    // given a host that cancels tool calls (the 2.0.15+ ToolContext exposes `signal`)
    const host = new AbortController()
    const signals: AbortSignal[] = []
    const v2 = toV2Tool(
      "probe",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { abort: AbortSignal }) => {
          signals.push(ctx.abort)
          return "ok"
        },
      },
      { namespace: "omo", directory: "/work" },
    )

    // when a tool runs and the user then interrupts the session
    await v2.execute(
      {},
      { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {}, signal: host.signal } as never,
    )
    host.abort()

    // then the tool observes the very signal the host aborted, not a detached non-aborting one
    expect(signals[0]).toBe(host.signal)
    expect(signals[0]?.aborted).toBe(true)
  })

  it("forwards ask to opts.ask when supplied", async () => {
    const seen: Array<{ permission: string }> = []
    const v2 = toV2Tool(
      "gated",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { ask: (i: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void> }) => {
          await ctx.ask({ permission: "shell", patterns: ["*"], always: [], metadata: {} })
          return "done"
        },
      },
      { namespace: "omo", directory: "/work", ask: async (i) => { seen.push(i) } },
    )
    const res = await v2.execute({}, { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never)
    expect(res).toEqual({ content: "done" })
    expect(seen).toEqual([{ permission: "shell", patterns: ["*"], always: [], metadata: {} }])
  })
})

describe("stripForeignJsonSchemaOverride", () => {
  it("removes the _zod.toJSONSchema override installed by normalizeToolArgSchemas", () => {
    const schema: Record<string, unknown> = { _zod: { toJSONSchema: () => ({}) } }
    expect(stripForeignJsonSchemaOverride(schema)).toBe(true)
    expect("toJSONSchema" in (schema._zod as Record<string, unknown>)).toBe(false)
  })

  it("reports false when there is nothing to strip", () => {
    expect(stripForeignJsonSchemaOverride({ _zod: {} })).toBe(false)
    expect(stripForeignJsonSchemaOverride({})).toBe(false)
    expect(stripForeignJsonSchemaOverride(null)).toBe(false)
    expect(stripForeignJsonSchemaOverride("x")).toBe(false)
  })
})
