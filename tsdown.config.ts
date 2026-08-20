import { defineConfig } from 'tsdown'

// Standalone build for @m1khal3v/dsh-llm-key-rotation.
//
// `prepare` (git install) runs this transpile-only pass; it does not type-check
// and so does not require the @deepseek-ai/dsh-* peer types to be installed in
// the build sandbox. `build` (dev / npm publish) additionally emits .d.ts via
// tsc. Every @deepseek-ai/* import stays external and resolves from the host
// dsh installation at runtime, so no harness code is bundled here.
export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  format: 'esm',
  outDir: 'lib',
  clean: true,
  dts: false,
  sourcemap: false,
  target: 'node22',
  platform: 'node',
  external: [/^@deepseek-ai\//],
})
