/**
 * Cosmetic Chrome tab-group labels for subagent activity. This never feeds back
 * into model prompts, tool schemas, or tool results; all failures are logged and
 * ignored so tab grouping cannot affect agent execution.
 */

import { debugLog } from '../shared/debug-log'

type TabGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'
type GroupTabIds = number | [number, ...number[]]

export interface AgentTabGroups {
  ensureAgent(args: { agentId: string; isSubagent: boolean; tabIds: number[] }): Promise<void>
  addTabs(agentId: string, tabIds: number[]): Promise<void>
  /** Dissolve the agent's group: ungroup its surviving tabs so no stale label lingers in the tab strip. */
  finishAgent(agentId: string): Promise<void>
}

interface AgentGroupState {
  agentId: string
  shortName: string
  baseTitle: string
  color: TabGroupColor
  tabIds: Set<number>
  groupsByWindow: Map<number, number>
}

const SUBAGENT_COLORS: TabGroupColor[] = ['purple', 'cyan', 'green', 'pink', 'orange', 'yellow']

class AgentTabGroupCoordinator implements AgentTabGroups {
  private readonly states = new Map<string, AgentGroupState>()
  /** First-claim tab ownership: agents often share a tab (e.g. every subagent
   * scoped to the same Outlook tab); regrouping a claimed tab would pull it out
   * of the owner's group, Chrome would delete the emptied group, and the two
   * agents would steal the tab back and forth on every tool call. */
  private readonly tabOwners = new Map<number, string>()

  async ensureAgent(args: { agentId: string; isSubagent: boolean; tabIds: number[] }): Promise<void> {
    if (!args.isSubagent) return
    const state = this.stateFor(args.agentId, args.isSubagent)
    await this.assignTabs(state, args.tabIds)
    await this.updateGroups(state, state.baseTitle)
  }

  async addTabs(agentId: string, tabIds: number[]): Promise<void> {
    if (!isSubagentId(agentId)) return
    const state = this.stateFor(agentId, isSubagentId(agentId))
    await this.assignTabs(state, tabIds)
    await this.updateGroups(state, state.baseTitle)
  }

  async finishAgent(agentId: string): Promise<void> {
    if (!isSubagentId(agentId)) return
    const state = this.states.get(agentId)
    if (!state) return
    for (const [tabId, owner] of [...this.tabOwners]) {
      if (owner === agentId) this.tabOwners.delete(tabId)
    }
    // The group label marks live agent activity; once the agent is done the
    // browser should look normal again. Ungrouping every surviving tab makes
    // Chrome delete the emptied group. (A resumed task simply regroups.)
    await ungroupTabs([...state.tabIds])
    this.states.delete(agentId)
  }

  private stateFor(agentId: string, isSubagent: boolean): AgentGroupState {
    const existing = this.states.get(agentId)
    if (existing) return existing

    const label = randomLabel()
    const role = isSubagent ? 'sub' : 'main'
    const shortName = `${role} ${label}`
    const state: AgentGroupState = {
      agentId,
      shortName,
      baseTitle: shortName,
      color: isSubagent ? SUBAGENT_COLORS[label.charCodeAt(0) % SUBAGENT_COLORS.length]! : 'blue',
      tabIds: new Set(),
      groupsByWindow: new Map(),
    }
    this.states.set(agentId, state)
    debugLog.log('agent', 'tab group label created', { agentId, title: state.baseTitle, color: state.color })
    return state
  }

  private async assignTabs(state: AgentGroupState, tabIds: number[]): Promise<void> {
    if (!hasTabGroupApis()) return

    const tabsByWindow = new Map<number, number[]>()
    for (const tabId of uniqueValidTabIds(tabIds)) {
      const owner = this.tabOwners.get(tabId)
      if (owner !== undefined && owner !== state.agentId) continue
      const tab = await getTab(tabId)
      if (!tab || tab.id === undefined) continue
      this.tabOwners.set(tab.id, state.agentId)
      const windowTabs = tabsByWindow.get(tab.windowId) ?? []
      windowTabs.push(tab.id)
      tabsByWindow.set(tab.windowId, windowTabs)
      state.tabIds.add(tab.id)
    }

    for (const [windowId, ids] of tabsByWindow) {
      await this.assignWindowTabs(state, windowId, ids)
    }
  }

  private async assignWindowTabs(state: AgentGroupState, windowId: number, tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return
    const existingGroupId = state.groupsByWindow.get(windowId)
    const groupId = await this.groupTabs(tabIds, existingGroupId)
    if (groupId === undefined && existingGroupId !== undefined) {
      state.groupsByWindow.delete(windowId)
      const recreated = await this.groupTabs(tabIds)
      if (recreated !== undefined) state.groupsByWindow.set(windowId, recreated)
      return
    }
    if (groupId !== undefined) state.groupsByWindow.set(windowId, groupId)
  }

  private async groupTabs(tabIds: number[], groupId?: number): Promise<number | undefined> {
    try {
      const ids = toGroupTabIds(tabIds)
      if (ids === undefined) return undefined
      if (groupId !== undefined) {
        return await groupTabsApi({ groupId, tabIds: ids })
      }
      return await groupTabsApi({ tabIds: ids })
    } catch (err) {
      // A cached group id going stale (Chrome deletes emptied groups) is
      // expected and self-heals by recreating — not an error.
      if (groupId !== undefined) {
        debugLog.log('agent', `tab group ${groupId} stale, recreating`)
      } else {
        debugLog.error('agent', 'tab group assign', err)
      }
      return undefined
    }
  }

  private async updateGroups(state: AgentGroupState, title: string): Promise<void> {
    if (!hasTabGroupApis()) return
    for (const [windowId, groupId] of [...state.groupsByWindow]) {
      try {
        await updateTabGroupApi(groupId, {
          title,
          color: state.color,
          collapsed: false,
        })
      } catch (err) {
        state.groupsByWindow.delete(windowId)
        debugLog.error('agent', 'tab group update', err)
      }
    }
  }
}

function hasTabGroupApis(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.tabs?.group && !!chrome.tabGroups?.update
}

/** Ungroup tabs one by one so an already-closed tab doesn't fail the rest. */
async function ungroupTabs(tabIds: number[]): Promise<void> {
  if (typeof chrome === 'undefined' || typeof chrome.tabs?.ungroup !== 'function') return
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.ungroup(tabId)
    } catch {
      // Tab closed or never grouped — nothing to undo.
    }
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch (err) {
    debugLog.error('agent', `tab group get tab ${tabId}`, err)
    return undefined
  }
}

function uniqueValidTabIds(tabIds: number[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const id of tabIds) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function toGroupTabIds(tabIds: number[]): GroupTabIds | undefined {
  if (tabIds.length === 0) return undefined
  if (tabIds.length === 1) return tabIds[0]!
  return [tabIds[0]!, ...tabIds.slice(1)]
}

function groupTabsApi(options: { tabIds: GroupTabIds; groupId?: number }): Promise<number> {
  const group = chrome.tabs.group as unknown as (opts: { tabIds: GroupTabIds; groupId?: number }) => Promise<number>
  return group(options)
}

function updateTabGroupApi(
  groupId: number,
  updateProperties: { title: string; color: TabGroupColor; collapsed: boolean },
): Promise<void> {
  const update = chrome.tabGroups.update as unknown as (
    id: number,
    props: { title: string; color: TabGroupColor; collapsed: boolean },
  ) => Promise<unknown>
  return update(groupId, updateProperties).then(() => undefined)
}

function isSubagentId(agentId: string): boolean {
  return agentId !== 'main'
}

function randomLabel(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let label = ''
  for (let i = 0; i < 5; i += 1) {
    label += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'x'
  }
  return label
}

export function createAgentTabGroups(): AgentTabGroups {
  return new AgentTabGroupCoordinator()
}
