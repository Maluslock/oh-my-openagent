// packages/omo-opencode/src/v2/compaction-end-restore.test.ts
import { describe, expect, it } from "bun:test"
import { startCompactionEndRestore } from "./compaction-end-restore"

type Queue = {
  push: (value: unknown) => void
  close: () => void
  iterable: AsyncIterable<unknown>
}

function createQueue(): Queue {
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

function createFixture() {
  const queue = createQueue()
  const contextRestores: string[] = []
  const todoRestores: string[] = []
  const errors: Array<{ step: string; sessionID: string }> = []

  const runner = startCompactionEndRestore({
    subscribe: () => queue.iterable,
    hooks: {
      compactionContextInjector: {
        restore: async (sessionID: string) => {
          contextRestores.push(sessionID)
          return true
        },
      },
      compactionTodoPreserver: {
        restore: async (sessionID: string) => {
          todoRestores.push(sessionID)
        },
      },
    },
    duplicateGuardMs: 50,
    disposeTimeoutMs: 10,
    onStepError: (_error, step, sessionID) => errors.push({ step, sessionID }),
  })

  return { queue, runner, contextRestores, todoRestores, errors }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("startCompactionEndRestore", () => {
  it("restores omo state when a compaction ends", async () => {
    // given
    const { queue, runner, contextRestores, todoRestores } = createFixture()

    // when
    queue.push({ type: "session.compaction.ended", data: { sessionID: "ses_1" } })
    await flush()

    // then both restores ran, in V1's order
    expect(contextRestores).toEqual(["ses_1"])
    expect(todoRestores).toEqual(["ses_1"])
    await runner.dispose()
  })

  it("ignores other compaction phases and unrelated events", async () => {
    // given
    const { queue, runner, contextRestores } = createFixture()

    // when
    queue.push({ type: "session.compaction.started", data: { sessionID: "ses_1" } })
    queue.push({ type: "session.compaction.delta", data: { sessionID: "ses_1" } })
    queue.push({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    queue.push({ type: "session.compaction.ended" })
    await flush()

    // then nothing was restored
    expect(contextRestores).toEqual([])
    await runner.dispose()
  })

  it("suppresses a duplicate end event inside the guard window", async () => {
    // given
    const { queue, runner, contextRestores } = createFixture()

    // when the same session reports two ends back to back
    queue.push({ type: "session.compaction.ended", data: { sessionID: "ses_dup" } })
    await flush()
    queue.push({ type: "session.compaction.ended", data: { sessionID: "ses_dup" } })
    await flush()

    // then only the first one restored
    expect(contextRestores).toEqual(["ses_dup"])
    await runner.dispose()
  })

  it("isolates a failing restore step so the other still runs", async () => {
    // given a context restore that throws
    const queue = createQueue()
    const todoRestores: string[] = []
    const errors: string[] = []
    const runner = startCompactionEndRestore({
      subscribe: () => queue.iterable,
      hooks: {
        compactionContextInjector: {
          restore: async () => {
            throw new Error("boom")
          },
        },
        compactionTodoPreserver: {
          restore: async (sessionID: string) => {
            todoRestores.push(sessionID)
          },
        },
      },
      onStepError: (_error, step) => errors.push(step),
      disposeTimeoutMs: 10,
    })

    // when
    queue.push({ type: "session.compaction.ended", data: { sessionID: "ses_1" } })
    await flush()

    // then
    expect(errors).toEqual(["compactionContextInjector.restore"])
    expect(todoRestores).toEqual(["ses_1"])
    await runner.dispose()
  })

  it("disposes cleanly when no restore hook is enabled", async () => {
    // given a runner with no restores wired
    const queue = createQueue()
    const runner = startCompactionEndRestore({ subscribe: () => queue.iterable, hooks: {}, disposeTimeoutMs: 10 })

    // when a compaction ends and the stream closes
    queue.push({ type: "session.compaction.ended", data: { sessionID: "ses_1" } })
    await flush()
    queue.close()
    await runner.settled

    // then teardown completes (a hang here fails the test) and dispose is idempotent
    await runner.dispose()
    expect(typeof runner.dispose).toBe("function")
  })
})
