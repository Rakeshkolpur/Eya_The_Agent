/** The speech runtime's two files as full addresses, however the build wrote them (relative to the worker, or from the site's root). */
export function runtimeFiles(loader: string, wasm: string, base: string): { readonly mjs: string; readonly wasm: string } {
  return { mjs: new URL(loader, base).href, wasm: new URL(wasm, base).href };
}
