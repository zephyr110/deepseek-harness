import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/main/index.ts'],
    outDir: 'dist/main',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    platform: 'node',
    // electron is provided at runtime by the electron binary; bundling it would
    // break the lazy binary-download in its index.js.
    external: ['electron'],
    // tsdown defaults fixedExtension to true on the node platform (.mjs/.cjs);
    // the app is "type": "module", so main lands on dist/main/index.js and the
    // sandboxed preload on dist/preload/index.cjs.
    fixedExtension: false,
    // Private app, no type consumers; the dts plugin also chokes on
    // electron's electron.d.ts (MISSING_EXPORT).
    dts: false,
  },
  {
    entry: ['src/preload/index.ts'],
    outDir: 'dist/preload',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    platform: 'node',
    external: ['electron'],
    dts: false,
    fixedExtension: false,
    // Preload runs sandboxed: CJS, no ESM features.
  },
])
