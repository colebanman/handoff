// Rename the built extension in dist-dev/ so the side-by-side "dev variant" is
// distinguishable from the primary install in chrome://extensions and the side
// panel. Data isolation comes from loading a different folder (different
// extension id) — this only changes the display name/description.
//
// Run by `npm run build:dev` after `vite build --outDir dist-dev`.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = process.argv[2] ?? 'dist-dev'
const path = resolve(process.cwd(), dir, 'manifest.json')

const manifest = JSON.parse(readFileSync(path, 'utf8'))
manifest.name = 'Handoff (Dev)'
manifest.description = `${manifest.description} (dev build — isolated data)`
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Patched ${dir}/manifest.json → name="${manifest.name}"`)
