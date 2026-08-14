import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    // Workspace client packages resolve to SOURCE, mirroring apps/web: their
    // package.json exports point at lib for Node/type consumers, but the
    // browser bundle must compile src directly so CSS rides vite's pipeline
    // and — critically — the CJS `__ModuleLoader__.load` client bundles never
    // execute inside the shell bundle. Plugin packages stay unaliased: they
    // arrive as runtime bundles through the client module system.
    alias: [
      // Browserization of the vendored cordis Loader: its only node-only
      // import; the two process probes are mapped by `define` below.
      { find: /^node:module$/, replacement: src('./src/renderer/node-module-stub.ts') },
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src('../../packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src('../../packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src('../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src('../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-attachment$/, replacement: src('../../packages/client/ui-attachment/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-schema-form$/, replacement: src('../../packages/client/schema-form/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: src('../../packages/client/modules/src/client/index.ts') },
    ],
  },
  define: {
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
})
