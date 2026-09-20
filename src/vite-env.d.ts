/// <reference types="vite/client" />

/**
 * Vite `define` substitutions. These are textual replacements performed at build
 * time, not real runtime bindings — reading one in a source file that Vite never
 * processes (a plain node script, a test run outside vite) throws.
 */

/** True only in `npm run build:dev` (HANDOFF_DEV=1). */
declare const __DEV_BUILD__: boolean
