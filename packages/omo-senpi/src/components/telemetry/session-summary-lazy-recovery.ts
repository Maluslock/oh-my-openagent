import { join } from "node:path"
import type { TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import { listNames } from "./session-summary-files"
import type { SummaryPublisher } from "./session-summary-publisher"
import type { SummaryRecovery } from "./session-summary-recovery"
import type { adoptForeignWindow } from "./session-summary-adopt"
import type { RecoveryStorage } from "./session-summary-recovery-storage"
import type { ConsentScope, SummaryStorage } from "./session-summary-storage"

/** What the recorder takes from the `extensions/omo-telemetry-recovery.js` sidecar. */
export type SummarySidecar = Pick<typeof import("./session-summary-recovery"), "createSummaryRecovery" | "withRecoveryOps" | "sendSummaryRecord" | "adoptForeignWindow" | "purgeOptedOutQueue">

export type LoadSummaryRecovery = () => Promise<SummarySidecar>

export type LazySummaryRecovery = {
  readonly sweep: () => Promise<void> | undefined
  readonly load: () => Promise<void>
  readonly loaded: () => boolean
  /** Continues another process's window; undefined while the sidecar is not loaded. */
  readonly adopt: (input: Omit<Parameters<typeof adoptForeignWindow>[0], "storage">) => ReturnType<typeof adoptForeignWindow> | undefined
}

/** One load at a time; a failed load is forgotten, so the next caller tries again. */
export function memoizeLoad<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined
  return () => (loading ??= load().catch((error: unknown) => {
    loading = undefined
    throw error
  }))
}

// The sweep ships in the sidecar: a directory holding only this process's own windows and in-flight events
// has nothing a sweep would touch, so the common startup never loads it.
export function createLazySummaryRecovery(input: {
  readonly storage: SummaryStorage
  readonly publisher: SummaryPublisher
  readonly isScopeConsented: (scope: ConsentScope) => boolean
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly ownWindowKeys: () => Iterable<string>
  readonly load: () => Promise<SummarySidecar>
}): LazySummaryRecovery {
  const { storage, publisher } = input
  let ops: RecoveryStorage | undefined
  let recovery: SummaryRecovery | undefined
  let adopt: typeof adoptForeignWindow | undefined

  const ready = (): Promise<SummaryRecovery> => input.load().then((sidecar) => {
    adopt = sidecar.adoptForeignWindow
    const loadedOps = (ops ??= sidecar.withRecoveryOps(storage))
    return (recovery ??= sidecar.createSummaryRecovery({
      storage: loadedOps,
      publisher,
      isScopeConsented: input.isScopeConsented,
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    }))
  })

  // A temp or claim file left by any process, a pending event not in flight, or a window this process did not write.
  const hasWork = (): boolean => {
    const names = [...listNames(storage.dir), ...listNames(join(storage.dir, "pending"))]
    if (names.some((name) => name.endsWith(".tmp") || name.includes(".claimed-"))) return true
    if (storage.pendingUuids().some((uuid) => !publisher.isInFlight(uuid))) return true
    const own = new Set(input.ownWindowKeys())
    return storage.windowKeys().some((key) => !own.has(key))
  }

  return {
    sweep() {
      if (recovery !== undefined) {
        recovery.sweep()
        return undefined
      }
      if (!hasWork()) return undefined
      return ready().then((loaded) => loaded.sweep())
    },
    load: () => ready().then(() => undefined),
    loaded: () => ops !== undefined,
    adopt: (args) => (ops === undefined || adopt === undefined ? undefined : adopt({ storage: ops, ...args })),
  }
}
