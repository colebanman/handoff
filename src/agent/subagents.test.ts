import { describe, expect, it } from 'vitest'
import { createSurfaceAssignments, isBlankOrNewTab, subagentModelFor, surfaceKey, tabSurface } from './subagents'

describe('subagent model routing', () => {
  it.each([
    ['gpt-6-astra', 'gpt-5.6-sol'],
    ['openai/gpt-6-astra', 'openai/gpt-5.6-sol'],
    [' GPT-6-ASTRA ', 'gpt-5.6-sol'],
    ['gpt-6.1-sol', 'gpt-6.1-sol'],
    ['gpt-6-sol', 'gpt-6-sol'],
    ['gpt-6-luna', 'gpt-6-luna'],
    ['gpt-5.6-sol', 'gpt-5.6-terra'],
    ['gpt-5.6-terra', 'gpt-5.6-luna'],
    ['gpt-5.6-luna', 'gpt-5.6-luna'],
    ['grok-4.6', 'grok-4.6'],
  ])('%s delegates to %s', (parent, child) => {
    expect(subagentModelFor(parent)).toBe(child)
  })
})

describe('subagent browser starting tabs', () => {
  it.each([
    { url: 'about:blank', title: '' },
    { url: 'chrome://newtab/', title: 'New Tab' },
    { url: 'chrome://new-tab-page/', title: '' },
    { url: '', title: 'New Tab' },
  ])('treats blank Chrome surfaces as offline-only', (tab) => {
    expect(isBlankOrNewTab(tab)).toBe(true)
  })

  it('accepts a prepared web page for browser delegation', () => {
    expect(isBlankOrNewTab({ url: 'https://school.instructure.com/', title: 'Dashboard' })).toBe(false)
  })

  it('checks a pending navigation before the old blank URL', () => {
    expect(
      isBlankOrNewTab({
        url: 'about:blank',
        pendingUrl: 'https://school.instructure.com/',
        title: 'New Tab',
      }),
    ).toBe(true)
  })
})

describe('surface claims', () => {
  const firstTab = tabSurface(1)
  const secondTab = tabSurface(2)

  it('keys claims by tab id', () => {
    const surfaces = createSurfaceAssignments()
    expect(surfaces.claimSurfaces('sub-a', [firstTab])).toBeUndefined()
    // The same tab cannot be claimed by another agent.
    const conflict = surfaces.claimSurfaces('sub-b', [tabSurface(1)])
    expect(conflict?.ownerAgentId).toBe('sub-a')
    expect(surfaceKey(conflict!.surface)).toBe('tab:1')
  })

  it('grants disjoint surfaces to two agents', () => {
    const surfaces = createSurfaceAssignments()
    expect(surfaces.claimSurfaces('sub-a', [firstTab, tabSurface(7)])).toBeUndefined()
    expect(surfaces.claimSurfaces('sub-b', [secondTab, tabSurface(8)])).toBeUndefined()
    expect(surfaces.ownerOf(secondTab)).toBe('sub-b')
    expect(surfaces.surfacesOf('sub-a')).toEqual(['tab:1', 'tab:7'])
  })

  it('is all-or-nothing: a conflict on the second surface leaves the first unclaimed', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.claimSurfaces('sub-a', [secondTab])
    expect(surfaces.claimSurfaces('sub-b', [firstTab, secondTab])?.ownerAgentId).toBe('sub-a')
    expect(surfaces.ownerOf(firstTab)).toBeUndefined()
  })

  it('keeps the tab API and its conflict shape', () => {
    const surfaces = createSurfaceAssignments()
    expect(surfaces.claim('sub-a', [4, 5])).toBeUndefined()
    expect(surfaces.claim('sub-b', [5])).toMatchObject({ tabId: 5, ownerAgentId: 'sub-a', soft: false })
  })

  it('releaseAll frees one agent without touching another', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.claimSurfaces('sub-a', [firstTab, tabSurface(7)])
    surfaces.claimSurfaces('sub-b', [secondTab])
    surfaces.releaseAll('sub-a')
    expect(surfaces.ownerOf(firstTab)).toBeUndefined()
    expect(surfaces.ownerOf(tabSurface(7))).toBeUndefined()
    expect(surfaces.ownerOf(secondTab)).toBe('sub-b')
  })

  it('invalidateTabs drops all tab claims', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.claimSurfaces('sub-a', [firstTab, tabSurface(7)])
    surfaces.invalidateTabs()
    expect(surfaces.ownerOf(tabSurface(7))).toBeUndefined()
    expect(surfaces.ownerOf(firstTab)).toBeUndefined()
  })

  it('notifies subscribers so task UIs can render ownership', () => {
    const surfaces = createSurfaceAssignments()
    let changes = 0
    const off = surfaces.onChange(() => { changes++ })
    surfaces.claimSurfaces('sub-a', [firstTab])
    surfaces.releaseAll('sub-a')
    off()
    surfaces.claimSurfaces('sub-b', [firstTab])
    expect(changes).toBe(2)
  })
})

describe('main-agent soft claims', () => {
  const firstTab = tabSurface(1)

  it('rejects actual operations on another agent tab before invoking the browser', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.claim('sub-a', [1])
    expect(() => surfaces.beginUse('main:chat-b', [firstTab])).toThrow('no action was dispatched')
    expect(surfaces.ownerOf(firstTab)).toBe('sub-a')
  })

  it('keeps in-flight operations owned past the idle TTL and prevents mid-operation handoff', () => {
    let now = 0
    const surfaces = createSurfaceAssignments({ now: () => now, softTtlMs: 100 })
    const release = surfaces.beginUse('main:chat-a', [firstTab])
    now = 1000
    expect(() => surfaces.beginUse('main:chat-b', [firstTab])).toThrow('owned')
    expect(surfaces.claimSurfaces('sub-a', [firstTab], { handoffFromAgentId: 'main:chat-a' })).toBeDefined()
    release()
    expect(surfaces.claimSurfaces('sub-a', [firstTab], { handoffFromAgentId: 'main:chat-a' })).toBeUndefined()
    expect(surfaces.ownerOf(firstTab)).toBe('sub-a')
  })

  it('yields to a subagent instead of failing, and reports the granted subset', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.claimSurfaces('sub-a', [firstTab])
    expect(surfaces.softClaim('main', [firstTab, tabSurface(3)])).toEqual([tabSurface(3)])
    expect(surfaces.ownerOf(firstTab)).toBe('sub-a')
  })

  it('blocks a later spawn for a surface the main agent is mid-task on', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.softClaim('main', [firstTab])
    const conflict = surfaces.claimSurfaces('sub-a', [firstTab])
    expect(conflict).toMatchObject({ ownerAgentId: 'main', soft: true })
  })

  it('hands the parent soft claim to a delegated child without waiting for expiry', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.softClaim('main', [firstTab, tabSurface(2)])
    expect(surfaces.claimSurfaces('sub-a', [firstTab], { handoffFromAgentId: 'main' })).toBeUndefined()
    expect(surfaces.list().find((claim) => claim.surface.tabId === 1)).toMatchObject({ ownerAgentId: 'sub-a', soft: false })
    expect(surfaces.ownerOf(tabSurface(2))).toBe('main')
    expect(surfaces.claimSurfaces('sub-b', [firstTab], { handoffFromAgentId: 'main' })).toMatchObject({ ownerAgentId: 'sub-a', soft: false })
  })

  it('preserves every parent claim when a different assigned tab conflicts', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.softClaim('main', [firstTab])
    surfaces.claimSurfaces('sub-other', [tabSurface(2)])
    expect(surfaces.claimSurfaces('sub-a', [firstTab, tabSurface(2)], { handoffFromAgentId: 'main' })).toMatchObject({ ownerAgentId: 'sub-other' })
    expect(surfaces.ownerOf(firstTab)).toBe('main')
    expect(surfaces.surfacesOf('sub-a')).toEqual([])
  })

  it('does not transfer another agent soft claim or even its own parent hard claim', () => {
    const surfaces = createSurfaceAssignments()
    surfaces.softClaim('main-other', [firstTab])
    expect(surfaces.claimSurfaces('sub-a', [firstTab], { handoffFromAgentId: 'main' })).toMatchObject({ ownerAgentId: 'main-other', soft: true })
    surfaces.claimSurfaces('parent', [tabSurface(2)])
    expect(surfaces.claimSurfaces('sub-a', [tabSurface(2)], { handoffFromAgentId: 'parent' })).toMatchObject({ ownerAgentId: 'parent', soft: false })
  })

  it('expires on its own so an abandoned turn cannot strand a surface', () => {
    let now = 1_000
    const surfaces = createSurfaceAssignments({ now: () => now, softTtlMs: 5_000 })
    surfaces.softClaim('main', [firstTab])
    now += 4_000
    expect(surfaces.ownerOf(firstTab)).toBe('main')
    // Each further main-agent action refreshes it.
    surfaces.softClaim('main', [firstTab])
    now += 4_000
    expect(surfaces.ownerOf(firstTab)).toBe('main')
    now += 2_000
    expect(surfaces.ownerOf(firstTab)).toBeUndefined()
    expect(surfaces.claimSurfaces('sub-a', [firstTab])).toBeUndefined()
  })

  it('never downgrades an existing hard claim held by the same agent', () => {
    let now = 1_000
    const surfaces = createSurfaceAssignments({ now: () => now, softTtlMs: 1_000 })
    surfaces.claimSurfaces('sub-a', [firstTab])
    surfaces.softClaim('sub-a', [firstTab])
    now += 10_000
    expect(surfaces.ownerOf(firstTab)).toBe('sub-a')
  })
})
