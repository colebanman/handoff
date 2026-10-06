import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

// Test the same CdpService implementation used by tools and sandbox dispatch.
const result = await build({
  stdin: { contents: "export { CdpServiceImpl } from './src/cdp/service'; export { guardFormActions } from './src/cdp/form-gate';", resolveDir: process.cwd() },
  define: { __DEV_BUILD__: 'false' }, bundle: true, platform: 'browser', format: 'iife',
  globalName: 'FormDriver', target: 'es2022', write: false, logLevel: 'silent',
})
const shadow = process.argv.includes('--shadow')
const combobox = process.argv.includes('--combobox')
const directory = combobox ? '/tmp/form-fill-combobox' : shadow ? '/tmp/form-fill-shadow-e2e' : '/tmp/form-fill-e2e'
await mkdir(directory, { recursive: true })
await writeFile(`${directory}/run.js`, result.outputFiles[0].text + '\n' + await readFile(combobox ? 'scripts/test-combobox-form-fill-browser.cjs' : shadow ? 'scripts/test-shadow-form-fill-browser.cjs' : 'scripts/test-form-fill-browser.cjs', 'utf8'))
console.log(`${directory}/run.js`)

if (combobox) {
  const fixture = '/tmp/form-fill-combobox/fixture'
  await build({ stdin: { contents: await readFile('scripts/fixtures/form-combobox.jsx', 'utf8'), resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' },
    outfile: `${fixture}/fixture.js`, logLevel: 'silent' })
  await writeFile(`${fixture}/index.html`, '<!doctype html><meta charset="utf-8"><title>Combobox fixture</title><link rel="icon" href="data:,"><style>body{font:16px system-ui;padding:20px}form{width:400px}label{display:block}section{margin:14px 0}</style><div id="app"></div><script src="/fixture.js?v=' + Date.now() + '"></script>')
}
