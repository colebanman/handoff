// Cross-platform development build with storage reset/debug tools enabled.
import { spawnSync } from 'node:child_process'

for (const [entry, args] of [
  ['node_modules/vite/bin/vite.js', ['build', '--outDir', 'dist-dev', '--emptyOutDir']],
  ['scripts/patch-dev-manifest.mjs', ['dist-dev']],
]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: { ...process.env, HANDOFF_DEV: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
