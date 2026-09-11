// Reatom 1001.3.0 opens a default persistence BroadcastChannel during import on Node 26.
// Own and close those native channels explicitly: this benchmark never uses persistence.
// Keep native behavior during import, restore the constructor, and never force process.exit.
const NativeChannel = globalThis.BroadcastChannel
const channels = []
if (NativeChannel !== undefined) {
  globalThis.BroadcastChannel = class extends NativeChannel {
    constructor(...args) {
      super(...args)
      channels.push(this)
    }
  }
}
let native
try {
  native = await import('../../../packages/reatom/node_modules/@reatom/core/dist/index.js')
} finally {
  globalThis.BroadcastChannel = NativeChannel
  for (const channel of channels) channel.close()
}
export const { bind, context, notify, wrap } = native
