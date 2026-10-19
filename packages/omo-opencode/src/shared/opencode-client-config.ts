import { join } from "node:path"

import { compareVersions, getOpenCodeVersion } from "./opencode-version"

/**
 * Where the terminal client plugin entry lives, per host generation.
 *
 * OpenCode 1.x reads a layered `tui.json` (`plugin` array). 2.x replaced it with one global client
 * config, `cli.json` (`plugins` array, entries may be a package name, a local path, a file URL, or
 * `{ package, options }`), which the terminal client owns and the background service does not read.
 * Unknown versions take the 2.x path, matching `isOpenCodeVersionAtLeast`'s "assume modern" behavior.
 */
export const V2_CLIENT_CONFIG_VERSION = "2.0.0"

export const V2_CLIENT_CONFIG_SCHEMA = "https://opencode.ai/v2/cli.json"

export type ClientConfigTarget = {
  readonly path: string
  readonly key: "plugin" | "plugins"
  readonly v2: boolean
}

/**
 * `hostVersion` lets a caller that already resolved the host version (the installers do) pin the
 * decision instead of re-detecting it. `undefined` means "detect"; `null` means "unknown", which
 * takes the 2.x path exactly like `isOpenCodeVersionAtLeast` does.
 */
export function resolveClientConfigTarget(configDir: string, hostVersion?: string | null): ClientConfigTarget {
  const version = hostVersion === undefined ? getOpenCodeVersion() : hostVersion
  const isV2 = version === null ? true : compareVersions(version, V2_CLIENT_CONFIG_VERSION) >= 0
  if (isV2) {
    return { path: join(configDir, "cli.json"), key: "plugins", v2: true }
  }
  return { path: join(configDir, "tui.json"), key: "plugin", v2: false }
}
