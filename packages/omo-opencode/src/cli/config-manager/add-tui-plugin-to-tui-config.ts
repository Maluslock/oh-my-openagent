import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  isOurFilePluginEntry,
  isOmoManagedTuiEntry,
  isServerPluginEntry,
  tuiPluginSpecName,
} from "../doctor/checks/tui-plugin-config"
import {
  LEGACY_PLUGIN_NAME,
  PLUGIN_NAME,
  V2_CLIENT_CONFIG_SCHEMA,
  getOpenCodeConfigDir,
  parseJsonc,
  resolveClientConfigTarget,
} from "../../shared"
import { writeFileAtomically } from "../../shared/write-file-atomically"

type ConfigShape = {
  plugin?: unknown
  [key: string]: unknown
}

type ClientConfigKey = "plugin" | "plugins"

export type EnsureTuiPluginEntryResult = {
  readonly changed: boolean
  readonly reason: string
}

function readConfig(path: string): ConfigShape | null {
  try {
    const parsed = parseJsonc<unknown>(readFileSync(path, "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConfigShape
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  return null
}

function readServerConfig(configDir: string): ConfigShape | null {
  const jsoncPath = join(configDir, "opencode.jsonc")
  if (existsSync(jsoncPath)) return readConfig(jsoncPath)

  const jsonPath = join(configDir, "opencode.json")
  if (existsSync(jsonPath)) return readConfig(jsonPath)

  return null
}

function pluginEntries(config: ConfigShape, key: ClientConfigKey = "plugin"): unknown[] {
  const value = config[key]
  if (Array.isArray(value)) return value
  if (typeof value === "string") return [value]
  return []
}

function pluginFieldInvalid(config: ConfigShape, key: ClientConfigKey = "plugin"): boolean {
  const value = config[key]
  return value !== undefined && !Array.isArray(value) && typeof value !== "string"
}

function serverPluginEntry(config: ConfigShape): string | undefined {
  for (const entry of pluginEntries(config)) {
    const name = tuiPluginSpecName(entry)
    if (name !== null && isServerPluginEntry(name)) return name
  }
  return undefined
}

function desiredTuiEntry(serverEntry: string): string | null {
  if (serverEntry === PLUGIN_NAME || serverEntry.startsWith(`${PLUGIN_NAME}@`)) {
    return serverEntry
  }
  if (serverEntry === LEGACY_PLUGIN_NAME || serverEntry.startsWith(`${LEGACY_PLUGIN_NAME}@`)) {
    return serverEntry
  }
  if (serverEntry.startsWith("file:") && isOurFilePluginEntry(serverEntry)) {
    return serverEntry
  }
  return null
}

function readClientConfig(configPath: string): { config: ConfigShape; malformed: boolean } {
  if (!existsSync(configPath)) {
    return { config: {}, malformed: false }
  }
  const config = readConfig(configPath)
  return config ? { config, malformed: false } : { config: {}, malformed: true }
}

function formatConfig(config: ConfigShape): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function ensureTuiPluginEntry(opts: { configDir?: string; hostVersion?: string | null } = {}): EnsureTuiPluginEntryResult {
  const configDir = opts.configDir ?? getOpenCodeConfigDir({ binary: "opencode", version: null })
  const serverConfig = readServerConfig(configDir)
  const serverEntry = serverConfig ? serverPluginEntry(serverConfig) : undefined
  if (!serverEntry) {
    return { changed: false, reason: "no-server-entry" }
  }

  const desiredEntry = desiredTuiEntry(serverEntry)
  if (!desiredEntry) {
    return { changed: false, reason: "no-server-entry" }
  }

  const target = resolveClientConfigTarget(configDir, opts.hostVersion)
  const { config, malformed } = readClientConfig(target.path)
  if (malformed || pluginFieldInvalid(config, target.key)) {
    return { changed: false, reason: "malformed" }
  }

  // Drop every entry that belongs to this plugin, whatever spec it carries, so
  // an entry an older installer wrote (`<pkg>@latest`, the legacy package name,
  // the `<pkg>/tui` subpath) cannot survive alongside the one written now and
  // load the plugin twice. Foreign entries keep their position and shape.
  const entries = pluginEntries(config, target.key)
  const otherEntries = entries.filter((entry) => !isOmoManagedTuiEntry(entry))
  const clientIsArray = Array.isArray(config[target.key])
  const isOnlyDesiredEntry =
    clientIsArray && entries.length === otherEntries.length + 1 && entries.includes(desiredEntry)
  if (isOnlyDesiredEntry) {
    return { changed: false, reason: "already-present" }
  }

  const next: ConfigShape = target.v2
    // The host adds `$schema` when it creates or migrates this file; do the same so a fresh install
    // gets validation and autocomplete without waiting for a client start.
    ? { $schema: V2_CLIENT_CONFIG_SCHEMA, ...config, [target.key]: [...otherEntries, desiredEntry] }
    : { ...config, [target.key]: [...otherEntries, desiredEntry] }

  mkdirSync(configDir, { recursive: true })
  writeFileAtomically(target.path, formatConfig(next))
  return { changed: true, reason: "added" }
}
