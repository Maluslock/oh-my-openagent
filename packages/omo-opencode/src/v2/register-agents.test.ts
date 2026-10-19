// packages/omo-opencode/src/v2/register-agents.test.ts
import { describe, expect, it } from "bun:test"
import { mergeAgentPermissions } from "./register-agents"

const rule = (action: string, effect: string, resource = "*") => ({ action, resource, effect })

describe("mergeAgentPermissions", () => {
  it("appends incoming rules after existing and preserves the seeded defaults", () => {
    const existing = [rule("*", "allow"), rule("external_directory", "ask", "/tmp/*")]
    const incoming = [rule("edit", "deny")]

    expect(mergeAgentPermissions(existing, incoming)).toEqual([...existing, rule("edit", "deny")])
  })

  it("does not duplicate an incoming rule whose (action, resource) already exists", () => {
    const existing = [rule("read", "allow")]
    const incoming = [rule("read", "allow"), rule("edit", "deny")]

    expect(mergeAgentPermissions(existing, incoming)).toEqual([
      rule("read", "allow"),
      rule("edit", "deny"),
    ])
  })

  it("keeps rules that share (action, resource) but differ in effect", () => {
    const existing = [rule("*", "allow")]
    const incoming = [rule("*", "deny"), rule("read", "allow")]

    const out = mergeAgentPermissions(existing, incoming)

    expect(out).toEqual([rule("*", "allow"), rule("*", "deny"), rule("read", "allow")])
    expect(out?.some((p) => p.action === "*" && p.resource === "*" && p.effect === "deny")).toBe(true)
    expect(out?.some((p) => p.action === "*" && p.resource === "*" && p.effect === "allow")).toBe(true)
  })

  it("returns a copy of existing when incoming is undefined", () => {
    const existing = [rule("read", "allow")]

    const out = mergeAgentPermissions(existing, undefined)

    expect(out).toEqual(existing)
    expect(out).not.toBe(existing)
  })

  it("returns incoming when existing is undefined", () => {
    const incoming = [rule("edit", "deny")]

    expect(mergeAgentPermissions(undefined, incoming)).toEqual(incoming)
  })

  it("returns undefined when both inputs are absent or incoming is empty", () => {
    expect(mergeAgentPermissions(undefined, undefined)).toBeUndefined()
    expect(mergeAgentPermissions(undefined, [])).toBeUndefined()
  })
})
