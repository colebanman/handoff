import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Locate a test browser without depending on one user's Playwright revision. */
export async function findChrome({ extensionCapable = false } = {}) {
  const override = extensionCapable ? process.env.CHROME_EXTENSION_PATH : process.env.CHROME_PATH
  const usable = async path => {
    try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true }
    catch { return false }
  }
  if (override) {
    if (await usable(override)) return override
    throw new Error(`${extensionCapable ? 'CHROME_EXTENSION_PATH' : 'CHROME_PATH'} must name an executable browser.`)
  }

  const desktop = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter(Boolean).map(root => join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  if (!extensionCapable) for (const path of desktop) if (await usable(path)) return path

  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'ms-playwright')
        : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright')
  const installs = (await readdir(cache).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  const executables = process.platform === 'darwin'
    ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32' ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
      : ['chrome-linux64/chrome', 'chrome-linux/chrome']
  for (const install of installs) for (const executable of executables) {
    const path = join(cache, install, executable)
    if (await usable(path)) return path
  }
  if (extensionCapable) {
    const chromium = process.platform === 'darwin'
      ? ['/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : desktop.filter(path => path.includes('chromium'))
    for (const path of chromium) if (await usable(path)) return path
  }
  throw new Error(`Install ${extensionCapable ? 'Chrome for Testing or Chromium' : 'Chrome'}, or set ${extensionCapable ? 'CHROME_EXTENSION_PATH' : 'CHROME_PATH'} to its executable.`)
}
