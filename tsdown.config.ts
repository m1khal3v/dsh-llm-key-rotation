import { defineConfig } from 'tsdown'

// Standalone build for @m1khal3v/dsh-llm-key-rotation.
//
// Two build artifacts:
//   1. Node-half: lib/index.js + lib/invariant.js (ESM, platform: node)
//   2. Browser-half: lib/client.js (CJS, platform: browser, wrapped in
//      window.__ModuleLoader__.load(...) for the dsh module system)
//
// Every @deepseek-ai/* and react import stays external and resolves from the
// host dsh installation's module table at runtime. The browser bundle inlines
// everything else (the minimal YAML parser, the controller logic).

/** Platform modules provided by the dsh browser shell — stay external. */
const PLATFORM_EXTERNALS = [
  /^react($|\/)/,
  /^@deepseek-ai\/cordis($|\/)/,
  /^@deepseek-ai\/dsh-client-runtime($|\/)/,
  /^@deepseek-ai\/dsh-client-ui-slots($|\/)/,
  /^@deepseek-ai\/dsh-client-ui-primitives($|\/)/,
  /^@deepseek-ai\/dsh-client-connection($|\/)/,
  /^@deepseek-ai\/dsh-client-locale($|\/)/,
  /^@deepseek-ai\/dsh-client-ui-settings($|\/)/,
  /^@deepseek-ai\/dsh-api-remotes($|\/)/,
]

const PACKAGE_ID = '@m1khal3v/dsh-llm-key-rotation'

export default defineConfig([
  // ── Node-half: server plugin + invariant companion ──────────────────
  {
    entry: ['src/index.ts', 'src/invariant.ts'],
    format: 'esm',
    outDir: 'lib',
    clean: true,
    dts: false,
    sourcemap: false,
    target: 'node22',
    platform: 'node',
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^node:/],
    },
    outExtensions: () => ({ js: '.js' }),
  },
  // ── Browser-half: client plugin bundle ───────────────────────────────
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) =>
        PLATFORM_EXTERNALS.some(pattern => pattern.test(specifier)),
      alwaysBundle: (specifier: string) =>
        !PLATFORM_EXTERNALS.some(pattern => pattern.test(specifier)),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
