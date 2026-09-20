/** Mutable context lives in append-only user messages, never in the system prefix. */
import type { ModelMessage } from 'ai'
import type { ExtensionSummary } from '../shared/extensions'
import { extensionContext, observeExtensionContext } from './extension-context'
import { reconcileReplContext } from '../shared/repl-context'
import type { TaskInfo, VirtualFileSystemService, VfsEntry, VfsSkillMetadata } from '../shared/types'
import { isCompactionCheckpoint, latestCompactionBoundary } from '../shared/compaction'
import { sliceWellFormed, toWellFormed } from '../shared/text'
import { contextText, isRuntimeContextText, RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { redactSecrets } from '../shared/redact'
import { debugLog } from '../shared/debug-log'
import type { TypeSafeSession, RelevanceCandidate } from './typesafe'
import { matchesTask, supportsUrl } from '../shared/extension-matching'
import { readStickies, renderStickiesSection, stickyContext, type DeliveredSticky } from './stickies-context'
import { scanDeliveredStickies } from '../shared/stickies'
import { MEMORY_PATH, memoryIndexLines, readMemory } from './memory'
import {
  SITE_MEMORY_PATH, SITE_MEMORY_MAX_MATCHES, matchSiteMemories, normalizeUrlForScope,
  readSiteMemory, renderSiteMemories, scopeMatches, scopeSpecificity, siteGuideMatchesTask, type SiteMemoryIndexEntry,
} from './site-memory'

export interface ContextTab { id?: number; url?: string; pendingUrl?: string; active?: boolean }
export interface RuntimeContextOptions {
  isSubagent: boolean
  currentTabId: number
  allowedTabIds?: number[]
  offlineOnly?: boolean
  observedTabIds?: number[]
  task?: string
  pendingTasks?: TaskInfo[]
  /** Main agent: the chat this turn belongs to (sticky edits made from it are not re-announced). */
  chatId?: string
}

export function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

export function latestTaskText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user' || isCompactionCheckpoint(message)) continue
    const text = messageText(message)
    if (!text.trim() || isRuntimeContextText(text)) continue
    // The open-tabs inventory is context, not a request to work on every site.
    return text.replace(/<context>[\s\S]*?<\/context>/g, (block) => {
      const active = /Active tab: \[(\d+)\]/.exec(block)?.[1]
      return active ? `@tab(${active})` : ''
    })
      .replace(/<site-memory\b[^>]*>[\s\S]*?<\/site-memory>/g, '')
      .replace(/<(appshot|browser_context)>[\s\S]*?<\/\1>/g, (block) =>
        (block.match(/^(?:url|page URL|frame URL|target URL): .+$/gm) ?? []).join('\n'))
  }
  return ''
}

export function selectSiteMemories(
  entries: SiteMemoryIndexEntry[], task: string, tabs: ContextTab[], options: RuntimeContextOptions,
): SiteMemoryIndexEntry[] {
  if (options.offlineOnly) return []
  const available = tabs.filter((tab) => tab.id !== undefined &&
    (!options.isSubagent || options.allowedTabIds?.includes(tab.id)))
  const urls = new Set<string>()
  const add = (url?: string): void => { if (url && normalizeUrlForScope(url)) urls.add(url) }
  const current = available.find((tab) => tab.id === options.currentTabId) ??
    (!options.isSubagent ? available.find((tab) => tab.active) : undefined)
  add(current?.url || current?.pendingUrl)
  if (options.isSubagent) for (const tab of available) add(tab.url || tab.pendingUrl)
  for (const tab of available) if (options.observedTabIds?.includes(tab.id!)) add(tab.url || tab.pendingUrl)
  const referencedIds = new Set([...task.matchAll(/@tab\((\d+)\b/g)].map((m) => Number(m[1])))
  for (const tab of available) if (referencedIds.has(tab.id!)) add(tab.url || tab.pendingUrl)
  // A subagent's task text never grants access to additional tabs/sites.
  if (!options.isSubagent) {
    for (const match of task.matchAll(/https?:\/\/[^\s<>"']+/g)) add(match[0].replace(/[),.;\]]+$/, ''))
  }
  const guides = options.isSubagent ? [] : entries.filter((entry) => siteGuideMatchesTask(entry, task))
  for (const guide of guides) {
    for (const tab of available) {
      const url = tab.url || tab.pendingUrl
      if (url && matchSiteMemories([guide], url).length) add(url)
    }
  }
  const selected = new Map<string, SiteMemoryIndexEntry>()
  for (const url of urls) for (const entry of matchSiteMemories(entries, url)) selected.set(entry.title, entry)
  for (const guide of guides) selected.set(guide.title, guide)
  // Sort across pages too: a broad active-tab match must not push a specific
  // requested-course rule below the inline budget. File order breaks ties.
  const score = (entry: SiteMemoryIndexEntry) => Math.max(-1, ...entry.scopes
    .filter((scope) => [...urls].some((url) => scopeMatches(scope, url))).map(scopeSpecificity))
  return [...selected.values()].sort((a, b) => score(b) - score(a) || entries.indexOf(a) - entries.indexOf(b))
}

export function workspaceContext(files: VfsEntry[], skills: VfsSkillMetadata[], scores?: Map<string, number>, task = ''): string {
  const listed = files.filter((file) => file.root === 'workspace' && file.path !== MEMORY_PATH && file.path !== SITE_MEMORY_PATH && !file.path.startsWith('/workspace/.tool-output/'))
    .sort((a, b) => a.path.localeCompare(b.path))
  const explicit = (skill: VfsSkillMetadata) => matchesTask(skill.name, task) || task.includes(skill.path)
  const sortedSkills = [...skills].sort((a, b) => scores
    ? Number(explicit(b)) - Number(explicit(a)) || (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || a.path.localeCompare(b.path)
    : a.path.localeCompare(b.path))
  const limit = scores ? Math.max(12, skills.filter(explicit).length) : 40
  const fileLines = listed.slice(0, 50).map((file) =>
    `- ${contextText(file.path)} (${contextText(file.mediaType)}, ${file.size} bytes; updated ${file.updatedAt})`)
  if (listed.length > 50) fileLines.push(`- ${listed.length - 50} more; api.fs.list('/workspace') for all.`)
  const skillLines = sortedSkills.slice(0, limit).map((skill) =>
    `- $${contextText(skill.name)}: ${contextText(skill.description)} [${contextText(skill.path)}]`)
  if (sortedSkills.length > limit) skillLines.push(`- ${sortedSkills.length - limit} more; api.fs.skills() for all.`)
  return `<workspace>\nAvailable skills (read relevant bodies with api.fs.readText):\n${skillLines.join('\n') || '- none'}\nWorkspace files:\n${fileLines.join('\n') || '- none'}\n</workspace>`
}

/** Compare against the last delivered section, including on resumed/persisted chats. */
export class RuntimeContextDelivery {
  private readonly delivered = new Map<string, string>()
  extensionBlock: string | undefined
  extensionRevisions: Record<string, number> = {}

  restoreExtensions(messages: ModelMessage[]): ModelMessage[] {
    return reconcileReplContext(messages, this.extensionBlock, (content) => ({ role: 'user', content }))
  }
  private boundaryKey?: string
  private compacted = false
  /** Sticky revision the model last saw in this chat, per sticky id. */
  private stickies = new Map<string, DeliveredSticky>()

  constructor(history: ModelMessage[], private readonly typeSafe?: TypeSafeSession) {
    this.syncBoundary(history)
  }

  private syncBoundary(history: ModelMessage[]): void {
    const boundary = latestCompactionBoundary(history)
    if (boundary.key === this.boundaryKey) return
    this.boundaryKey = boundary.key
    this.compacted = boundary.index >= 0
    this.delivered.clear()
    this.stickies.clear()
    // Pre-checkpoint sections may only survive as opaque state. Only explicit
    // deliveries after this boundary count, including when reopening a chat.
    for (const message of history.slice(boundary.index + 1)) {
      if (message.role !== 'user') continue
      const text = messageText(message)
      if (!isRuntimeContextText(text)) continue
      for (const tag of ['workspace', 'user-memory', 'site-memory', 'active-task', 'repl-extensions']) {
        const block = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`).exec(text)?.[0]
        if (block) this.delivered.set(tag, block)
      }
      for (const [id, revision] of scanDeliveredStickies(text)) this.stickies.set(id, revision)
    }
  }

  async next(
    vfs: VirtualFileSystemService, messages: ModelMessage[], tabs: ContextTab[], options: RuntimeContextOptions,
  ): Promise<ModelMessage | undefined> {
    this.syncBoundary(messages)
    const [filesystem, memory, sites, extensions, extensionSettings] = await Promise.all([
      vfs.summary(), options.isSubagent ? Promise.resolve([]) : readMemory(vfs),
      options.offlineOnly ? Promise.resolve([]) : readSiteMemory(vfs),
      vfs.extensions ? vfs.extensions('list').catch(() => []) as Promise<ExtensionSummary[]> : Promise.resolve([]),
      vfs.extensions ? vfs.extensions('settings').catch(() => ({ learningEnabled: true })) as Promise<{ learningEnabled: boolean }> : Promise.resolve({ learningEnabled: true }),
    ])
    const permittedTabs = options.offlineOnly ? [] : tabs.filter((t) => !options.isSubagent || options.allowedTabIds?.includes(t.id!))
    const task = latestTaskText(messages)
    const skills = filesystem.skills.filter((skill) => !extensions.some((e) => skill.path.startsWith(`${e.path}/`)))
    const candidates: RelevanceCandidate[] = skills.map((s) => ({ id: s.path, description: `${s.name}: ${s.description}` }))
    for (const entry of extensions.filter((e) => e.enabled)) {
      for (const [path, action] of Object.entries(entry.manifest.actions)) {
        if (action.effects !== 'local' && !permittedTabs.some((t) => supportsUrl(entry.manifest, t.url ?? t.pendingUrl ?? ''))) continue
        candidates.push({ id: `${entry.id}.${path}@${entry.revision}`, description: `${entry.description}: ${path} — ${action.description}` })
      }
    }
    const scores = await this.typeSafe?.rank(task, candidates)
    const sensed = await observeExtensionContext(extensions, permittedTabs)
    const extensionDocs = extensionContext(extensions, task, tabs, options, sensed, extensionSettings.learningEnabled, scores)
    this.extensionRevisions = extensionDocs.revisions
    this.extensionBlock = extensionDocs.block || ((this.delivered.has('repl-extensions') || this.extensionBlock)
      ? '<repl-extensions>\nNo saved extensions are available. Earlier inventories are superseded.\n</repl-extensions>' : undefined)
    const selected = selectSiteMemories(sites, latestTaskText(messages), tabs, options)
    const guides = [...new Set(selected.slice(0, SITE_MEMORY_MAX_MATCHES).flatMap((entry) => entry.guide ? [entry.guide] : []))]
    const guideVersions = await Promise.all(guides.map(async (path) => {
      const entry = await vfs.getEntry(path)
      return `<guide-file path="${contextText(path)}" state="${entry ? 'available' : 'missing'}"${entry ? ` updated="${entry.updatedAt}" size="${entry.size}"` : ''} />`
    }))
    const sections = new Map<string, string>([
      ['workspace', workspaceContext(filesystem.entries, skills, scores, task)],
      ['site-memory', `<site-memory>\n${selected.length ? 'Saved guidance for the task and selected pages. Apply each entry only within its scopes. Updated entries supersede earlier versions; re-read a guide if its file changed.\n' + renderSiteMemories(selected) + '\n' + guideVersions.join('\n') : 'No site memories apply to the current task and selected pages. Earlier site-specific guidance remains scoped to its original pages.'}\n</site-memory>`],
    ])
    if (this.extensionBlock) sections.set('repl-extensions', this.extensionBlock)
    const revision = options.isSubagent ? '' : Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(JSON.stringify(memory)),
    ))).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
    if (!options.isSubagent) sections.set('user-memory', `<user-memory>\nIndex of ${MEMORY_PATH} (revision ${revision}); read relevant entries with api.fs.readLines. This replaces earlier indexes; re-read relevant entries if the revision changed.\n${memoryIndexLines(memory).map(contextText).join('\n') || '- none'}\n</user-memory>`)
    if (this.compacted && !this.delivered.has('active-task')) {
      const recent = messages.filter((message) => message.role === 'user' && !isCompactionCheckpoint(message) &&
        !isRuntimeContextText(messageText(message)) && messageText(message).trim()).slice(-3)
      const excerpt = (text: string, limit: number): string => text.length <= limit ? text :
        `${sliceWellFormed(text, limit / 2)}\n[…excerpt; full message remains in chat history…]\n${toWellFormed(text.slice(-limit / 2))}`
      const pending = (options.pendingTasks ?? []).filter((task) => ['running', 'cancelling', 'orphaned'].includes(task.status))
      sections.set('active-task', `<active-task>\nContext restored after compaction, not a new user message. Continue from the current progress; do not repeat completed actions. Latest user directions take precedence over earlier ones. Re-read relevant memory entries or skill/guide bodies if needed; the index is not their full content.\n${options.task ? `Assigned task: ${contextText(excerpt(options.task, 2000))}\n` : ''}Recent user directions (oldest first):\n${recent.map((message) => contextText(excerpt(latestTaskText([message]), 2000))).join('\n---\n')}\nPending task references:\n${pending.slice(0, 12).map((task) => `- ${contextText(task.id)} (${task.status}): ${contextText(excerpt(task.description, 240))}`).join('\n') || '- none'}${pending.length > 12 ? '\nMore tasks are available via task_status.' : ''}\n</active-task>`)
    }
    if (!options.isSubagent) {
      try {
        const snapshots = await readStickies(vfs, filesystem.entries)
        if (snapshots.length || this.stickies.size) {
          const result = stickyContext(snapshots, this.stickies, options.chatId)
          if (result.fragments.length) {
            sections.set('stickies', renderStickiesSection(result.fragments))
            for (const [id, revision] of result.delivered) this.stickies.set(id, revision)
          }
        }
      } catch (err) {
        debugLog.error('agent', 'sticky context', err)
      }
    }
    const changed: string[] = []
    for (const [tag, raw] of sections) {
      const block = redactSecrets(raw)
      if (this.delivered.get(tag) === block) continue
      changed.push(block)
      this.delivered.set(tag, block)
    }
    if (!changed.length) return undefined
    return { role: 'user', content: `${RUNTIME_CONTEXT_START}${changed.join('\n\n')}\n</context>` }
  }
}
