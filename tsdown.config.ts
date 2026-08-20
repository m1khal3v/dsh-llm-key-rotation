import { defineConfig, type UserConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { transform } from 'lightningcss'
import { resolve as resolvePath, dirname } from 'node:path'

// Standalone build for @m1khal3v/dsh-llm-key-rotation.
//
// Two build artifacts:
//   1. Node-half: lib/index.js + lib/invariant.js (ESM, platform: node)
//   2. Browser-half: lib/client.js (CJS, platform: browser, wrapped in
//      window.__ModuleLoader__.load(...) for the dsh module system)
//
// Every @deepseek-ai/* and react import stays external and resolves from the
// host dsh installation's module table at runtime. The browser bundle inlines
// everything else (the controller, CSS modules, locale dictionaries).
//
// CSS modules are compiled by lightningcss and inlined into the JS bundle as
// style-injection side effects — matching the dsh convention so the browser
// never fetches a separate .css file for a dynamic plugin.

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
  /^@deepseek-ai\/dsh-client-ui-settings-plugins($|\/)/,
  /^@deepseek-ai\/dsh-api-remotes($|\/)/,
]

const PACKAGE_ID = '@m1khal3v/dsh-llm-key-rotation'

/** Virtual id prefix keeping CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'

/** Emit one plugin-owned style injector and CSS Modules class-map export. */
function styleInjectionModule(id: string, fileId: string, css: string, classMap: Record<string, string>): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${fileId.split('/').pop()}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(`export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** A rolldown plugin that inlines .module.css imports as style-injection code. */
const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    // Resolve the relative .module.css against its importer
    const abs = resolvePath(dirname(importer), source)
    return CSS_VIRTUAL_PREFIX + abs + '.mjs'
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -4) // strip .mjs
    const cssSource = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: cssSource,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      classMap[local] = exp.name
    }
    return styleInjectionModule(PACKAGE_ID, fileId, code.toString(), classMap)
  },
}

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
  } satisfies UserConfig,
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
    plugins: [cssModulesPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  } satisfies UserConfig,
])
