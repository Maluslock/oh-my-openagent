/**
 * The only place the adapter touches `bun:sqlite`.
 *
 * `opencode-adapter-bun-runtime-audit.test.ts` forbids raw `bun:*` imports in production adapter
 * source unless the file is an approved `bun-*-shim.ts`. Keeping the module access here lets
 * `sqlite-storage.ts` stay a plain reader with no runtime-specific import, and lets the import fail
 * on a non-Bun host (where `bun:sqlite` does not resolve) instead of breaking plugin load.
 */

export type SqliteStatement = {
  readonly all: (...params: unknown[]) => unknown[]
}

export type SqliteDatabase = {
  readonly query: (sql: string) => SqliteStatement
  readonly close: () => void
}

type BunSqliteModule = {
  readonly Database: new (path: string, options: { readonly: boolean }) => SqliteDatabase
}

/** Opens the database read-only, or returns null when this runtime cannot provide SQLite. */
export async function openReadonlyDatabase(path: string): Promise<SqliteDatabase | null> {
  try {
    const sqlite = (await import("bun:sqlite")) as unknown as BunSqliteModule
    return new sqlite.Database(path, { readonly: true })
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}
