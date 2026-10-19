// packages/omo-opencode/src/v2/register-session-index.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  disposeOmoSessionIndex,
  registerOmoSessionIndex,
  resetOmoSessionIndexCache,
} from "./register-session-index"
import { SESSION_INDEX_STORAGE_KEY } from "./session-index"
import type { SessionIndexEntry } from "./session-index"

type PromiseQueue = {
  push: (value: unknown) => void
  close: () => void
  iterable: AsyncIterable<unknown>
}

function createQueue(): PromiseQueue {
  const pending: unknown[] = []
  const waiters: Array<(value: IteratorResult<unknown>) => void> = []
  let closed = false
  return {
    push: (value) => {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else pending.push(value)
    },
    close: () => {
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: async () => {
            if (pending.length > 0) return { value: pending.shift(), done: false }
            if (closed) return { value: undefined, done: true }
            return await new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve))
          },
        }
      },
    },
  }
}

function createFixture(options: { withStorage?: boolean } = {}) {
  const withStorage = options.withStorage ?? true
  const saved = new Map<string, unknown>()
  const hookNames: string[] = []
  const queue = createQueue()
  let promptCallback: ((event: unknown) => void) | undefined

  const ctx: Record<string, unknown> = {
    location: { directory: "/proj" },
    storage: withStorage
      ? {
          get: async (key: string) => saved.get(key),
          set: async (key: string, value: unknown) => {
            saved.set(key, value)
          },
        }
      : undefined,
    session: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        hookNames.push(name)
        if (name === "prompt") promptCallback = callback
        return { dispose: async () => {} }
      },
      get: async (input: { sessionID: string }) => ({
        id: input.sessionID,
        projectID: "proj_1",
        title: `title of ${input.sessionID}`,
        agent: "sisyphus",
        time: { created: 111, updated: 222 },
      }),
    },
    event: { subscribe: () => queue.iterable },
  }

  return { ctx, saved, hookNames, queue, firePrompt: (event: unknown) => promptCallback?.(event) }
}

beforeEach(() => {
  resetOmoSessionIndexCache()
})

// The installed enumeration source is process-global, so it must not outlive this file: the
// session-manager storage tests assert the SDK/file path.
afterEach(() => {
  resetOmoSessionIndexCache()
})

describe("registerOmoSessionIndex", () => {
  it("registers the prompt hook and the event feed", async () => {
    const { ctx, hookNames } = createFixture()
    await registerOmoSessionIndex(ctx as never, {} as never)
    expect(hookNames).toEqual(["prompt"])
  })

  it("skips when ctx.storage is unavailable", async () => {
    const { ctx, hookNames } = createFixture({ withStorage: false })
    await registerOmoSessionIndex(ctx as never, {} as never)
    expect(hookNames).toEqual([])
  })

  it("is idempotent per runtime key", async () => {
    const { ctx, hookNames } = createFixture()
    await registerOmoSessionIndex(ctx as never, {} as never)
    await registerOmoSessionIndex(ctx as never, {} as never)
    expect(hookNames).toEqual(["prompt"])
  })

  it("records a session seen through the prompt hook and enriches it from the host", async () => {
    // given
    const { ctx, saved, firePrompt } = createFixture()
    await registerOmoSessionIndex(ctx as never, {} as never)

    // when
    firePrompt({ sessionID: "ses_a" })
    await new Promise((resolve) => setTimeout(resolve, 10))

    // then the index is served to the session tools and persisted on dispose
    const { getMainSessions } = await import("../tools/session-manager/storage")
    const listed = await getMainSessions({ directory: "/proj" })
    expect(listed.map((entry) => entry.id)).toContain("ses_a")

    await disposeOmoSessionIndex(await import("./register-tools").then((m) => m.omoRuntimeKeyFor(ctx as never, {} as never)))
    const stored = saved.get(SESSION_INDEX_STORAGE_KEY) as SessionIndexEntry[]
    expect(stored.find((entry) => entry.id === "ses_a")).toMatchObject({ title: "title of ses_a", projectID: "proj_1" })
  })

  it("records sessions reported by the event stream", async () => {
    // given
    const { ctx, queue } = createFixture()
    await registerOmoSessionIndex(ctx as never, {} as never)

    // when an event carries a session id and its own location
    queue.push({ type: "session.execution.started", location: { directory: "/other" }, data: { sessionID: "ses_evt" } })
    await new Promise((resolve) => setTimeout(resolve, 10))

    // then it is indexed under that location
    const { getMainSessions } = await import("../tools/session-manager/storage")
    expect((await getMainSessions({ directory: "/other" })).map((entry) => entry.id)).toEqual(["ses_evt"])
    expect(await getMainSessions({ directory: "/proj" })).toEqual([])
  })

  it("ignores events without a session id", async () => {
    const { ctx, queue } = createFixture()
    await registerOmoSessionIndex(ctx as never, {} as never)
    queue.push({ type: "mcp.status.changed", data: { name: "lsp" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const { getAllSessions } = await import("../tools/session-manager/storage")
    expect(await getAllSessions()).toEqual([])
  })
})
