import { describe, expect, it } from 'vitest'
import {
  ARTIFACTS_DIR,
  artifactKitDisabled,
  buildArtifactDocument,
  extractArtifactLinks,
  findExternalScripts,
  inlineExternalScripts,
  isArtifactAllowedApiPath,
  normalizeArtifactPath,
} from './artifacts'

describe('normalizeArtifactPath', () => {
  it('lands bare names in the artifacts directory with an .html extension', () => {
    expect(normalizeArtifactPath('week')).toBe(`${ARTIFACTS_DIR}/week.html`)
    expect(normalizeArtifactPath('week.html')).toBe(`${ARTIFACTS_DIR}/week.html`)
    expect(normalizeArtifactPath('artifacts/week.html')).toBe(`${ARTIFACTS_DIR}/week.html`)
    expect(normalizeArtifactPath('workspace/artifacts/week')).toBe(`${ARTIFACTS_DIR}/week.html`)
    expect(normalizeArtifactPath('canvas/week.htm')).toBe(`${ARTIFACTS_DIR}/canvas/week.htm`)
  })

  it('keeps explicit VFS paths and strips traversal', () => {
    expect(normalizeArtifactPath('/workspace/reports/q3')).toBe('/workspace/reports/q3.html')
    expect(normalizeArtifactPath('/workspace/artifacts/../../etc/x.html')).toBe('/workspace/artifacts/etc/x.html')
    expect(() => normalizeArtifactPath('/Users/me/x.html')).toThrow(/artifact paths live under/)
    expect(() => normalizeArtifactPath('   ')).toThrow(/required/)
  })
})

describe('extractArtifactLinks', () => {
  it('finds HTML artifact paths once each, in order, ignoring other files', () => {
    const text =
      'Here is your [week view](/workspace/artifacts/week.html) and the [notes](/workspace/notes.md).\n' +
      'Also see /workspace/artifacts/inbox.html, and again [week](/workspace/artifacts/week.html).'
    expect(extractArtifactLinks(text)).toEqual(['/workspace/artifacts/week.html', '/workspace/artifacts/inbox.html'])
  })

  it('does not treat a trailing period as part of the path', () => {
    expect(extractArtifactLinks('Open /workspace/artifacts/a.html.')).toEqual(['/workspace/artifacts/a.html'])
  })
})

describe('buildArtifactDocument', () => {
  const meta = { path: '/workspace/artifacts/x.html', url: 'chrome-extension://id/artifact.html?path=x' }

  it('injects the runtime at the top of <head> and a new-tab base', () => {
    const out = buildArtifactDocument('<!doctype html><html><head><title>T</title></head><body>hi</body></html>', 'RUNTIME()', meta)
    const headAt = out.indexOf('<head>')
    const scriptAt = out.indexOf('<script data-artifact-runtime="1">')
    const titleAt = out.indexOf('<title>')
    expect(scriptAt).toBeGreaterThan(headAt)
    expect(scriptAt).toBeLessThan(titleAt)
    expect(out).toContain('window.__ARTIFACT__={"path":"/workspace/artifacts/x.html"')
    expect(out).toContain('RUNTIME()')
    expect(out).toContain('<base target="_blank" data-artifact-runtime="1">')
  })

  it('injects the kit after the runtime unless the document opts out', () => {
    const kit = { css: '.card{}', js: 'KIT()' }
    const out = buildArtifactDocument('<html><head></head><body></body></html>', 'R', { ...meta, theme: 'light' }, kit)
    expect(out.indexOf('R')).toBeLessThan(out.indexOf('<style data-artifact-runtime="1">'))
    expect(out).toContain('.card{}')
    expect(out).toContain('KIT()')
    expect(out).toContain('"theme":"light"')

    const optOut = '<html><head><meta name="artifact-kit" content="off"></head><body></body></html>'
    expect(artifactKitDisabled(optOut)).toBe(true)
    const plain = buildArtifactDocument(optOut, 'R', meta, kit)
    expect(plain).not.toContain('KIT()')
    expect(plain).not.toContain('.card{}')
    expect(plain).toContain('R')
  })

  it('synthesizes a head when the fragment has none and respects an existing <base>', () => {
    const fragment = buildArtifactDocument('<h1>Hello</h1>', 'R', meta)
    expect(fragment.startsWith('<!doctype html><html><head>')).toBe(true)
    expect(fragment).toContain('<body><h1>Hello</h1></body>')

    const withHtml = buildArtifactDocument('<html><body><base href="https://x/"><p>a</p></body></html>', 'R', meta)
    expect(withHtml).toContain('<html><head><script data-artifact-runtime="1">')
    expect(withHtml).not.toContain('<base target="_blank"')
  })
})

describe('external script inlining', () => {
  const html =
    '<html><head><script src="https://cdn.example.com/lib.js" defer></script>' +
    "<script src='/local.js'></script><script>inline()</script></head></html>"

  it('finds only remote scripts and keeps their other attributes', () => {
    const refs = findExternalScripts(html)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.url).toBe('https://cdn.example.com/lib.js')
    expect(refs[0]?.attrs).toBe('defer')
  })

  it('replaces fetched sources inline and surfaces failures as console errors', () => {
    const ok = inlineExternalScripts(html, new Map([['https://cdn.example.com/lib.js', 'var lib = 1; // </script> trick']]))
    expect(ok).toContain('<script defer data-artifact-src="https://cdn.example.com/lib.js">var lib = 1; // <\\/script> trick</script>')
    expect(ok).toContain("<script src='/local.js'></script>")

    const failed = inlineExternalScripts(html, new Map([['https://cdn.example.com/lib.js', new Error('403 Forbidden')]]))
    expect(failed).toContain('console.error("artifact: could not load https://cdn.example.com/lib.js: 403 Forbidden")')
  })
})

describe('isArtifactAllowedApiPath', () => {
  it('permits filesystem, fetch, and browser inventory calls but not page driving', () => {
    expect(isArtifactAllowedApiPath('fs.readText')).toBe(true)
    expect(isArtifactAllowedApiPath('fetch')).toBe(true)
    expect(isArtifactAllowedApiPath('tabs.create')).toBe(true)
    expect(isArtifactAllowedApiPath('cdp')).toBe(false)
    expect(isArtifactAllowedApiPath('page.eval')).toBe(false)
    expect(isArtifactAllowedApiPath('artifacts.eval')).toBe(false)
    expect(isArtifactAllowedApiPath('fetchy')).toBe(false)
  })
})
