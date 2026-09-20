import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { build as bundleContentScript } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Chrome MV3 multi-entry build:
//  - sidepanel.html  -> chat UI (React)
//  - artifact.html   -> fullscreen virtual filesystem artifact viewer
//  - artifact-frame.html -> sandboxed host for interactive HTML artifacts (manifest "sandbox")
//  - stream-debug.html -> live provider stream inspector (plain DOM, opt-in debug tool)
//  - sandbox.html    -> sandboxed eval page (manifest "sandbox", allows unsafe-eval)
//  - offscreen.html  -> compact navigation/runtime anchor while the panel is closed
//  - background.js   -> ES-module service worker (must land at dist root, name pinned by manifest)
//
// A second, side-by-side "dev variant" is produced by `npm run build:dev`, which
// builds to dist-dev/ (via --outDir) and renames the extension afterward (see
// scripts/patch-dev-manifest.mjs). Loading it unpacked from a different folder
// gives it its own extension id, so its storage is fully isolated from the
// primary install — the rename is only to tell the two apart in the UI.

// tsconfig pins `types` to chrome + vite/client; declare the build environment.
declare const process: { env: Record<string, string | undefined> }

const devBuild = process.env.HANDOFF_DEV === '1'
const buildDefines = { __DEV_BUILD__: JSON.stringify(devBuild) }

export default defineConfig({
  plugins: [react(), {
    name: 'stickies-content-script',
    async generateBundle() {
      const bundle = await bundleContentScript({
        entryPoints: ['src/stickies/main.tsx'], outfile: 'stickies.js', bundle: true, write: false, metafile: true,
        format: 'iife', minify: true, target: 'chrome120', jsx: 'automatic',
        define: { ...buildDefines, 'process.env.NODE_ENV': '"production"' },
        plugins: [{ name: 'inline-css', setup(builder) {
          builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace('?inline', '')), namespace: 'inline-css' }))
          builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
        } }],
      })
      for (const input of Object.keys(bundle.metafile!.inputs)) this.addWatchFile(input.replace(/^inline-css:/, ''))
      this.emitFile({ type: 'asset', fileName: 'stickies.js', source: bundle.outputFiles![0]!.contents })
    },
  }],
  // The dev-only fresh-start reset (src/shared/dev-reset.ts) is destructive, so
  // it is gated on a COMPILE-TIME constant rather than a runtime environment
  // check: only `npm run build:dev` sets HANDOFF_DEV=1, every other build
  // substitutes `false`, and Rollup then deletes the guarded branches outright.
  // A production bundle therefore has no reachable path that wipes storage.
  define: buildDefines,
  // Run the extension and bridge regression suites.
  test: { include: ['src/**/*.test.ts', 'bridge/test/**/*.test.mjs'] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        ...(devBuild && process.env.HANDOFF_REPL_E2E === '1' ? { replTest: 'scripts/repl-e2e-entry.ts' } : {}),
        sidepanel: 'sidepanel.html',
        artifact: 'artifact.html',
        artifactFrame: 'artifact-frame.html',
        sandbox: 'sandbox.html',
        // The inspector exposes raw provider traffic and implementation details.
        // Do not ship its page or entry chunk in production builds.
        ...(devBuild ? { streamDebug: 'stream-debug.html' } : {}),
        offscreen: 'offscreen.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
