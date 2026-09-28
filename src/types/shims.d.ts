// Ambient module shims for optional peer dependencies referenced only in
// third-party .d.ts files that we never actually import at runtime.
declare module '@swc/core' {
  // electron-vite imports TransformConfig as a type; we don't call swc, so
  // any-typed placeholders are safe here.
  export type TransformConfig = unknown;
  export type Options = unknown;
}
