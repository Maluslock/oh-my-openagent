import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"
import { createPluginModule } from "./testing/create-plugin-module"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps the V1 server export aligned with the default module", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes a V2 definition (id + setup) on the default export", () => {
    expect(pluginModule.id).toBe("oh-my-openagent")
    expect(typeof pluginModule.setup).toBe("function")
  })

  it("V2 keys come from createV2Plugin, not the V1 module", () => {
    const raw = createPluginModule() as Record<string, unknown>
    expect(raw.setup).toBeUndefined()
    expect(typeof (pluginModule as Record<string, unknown>).setup).toBe("function")
  })
})
