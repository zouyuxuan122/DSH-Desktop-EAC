/**
 * Zat-DSH Engine build: a Node ESM host half plus a browser CJS client half.
 *
 * The client bundle is fetched by the dsh web shell and executed through
 * `window.__ModuleLoader__.load({ id, factory })`. Externals are exactly the
 * frozen platform module table (react, cordis, the shared client packages);
 * everything else (zod) is inlined. The host half externalizes every
 * `@deepseek-ai/*` peer so it resolves against the dsh installation's shared
 * instance at runtime.
 */

import { defineConfig } from 'tsdown'
import { typertPlugin } from 'file:///D:/deepseek-harness/packages/typert/generator/lib/types/tsdown-plugin.js'

/** The frozen module-table specifiers shared by the web shell. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Host-half peers resolved from the dsh installation, never bundled. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
] as const

export default defineConfig([
  {
    name: 'zat-dsh-engine',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [typertPlugin()],
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    name: 'zat-dsh-engine/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    // The frozen module table stays external; everything else inlines.
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "zat-dsh-engine", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
