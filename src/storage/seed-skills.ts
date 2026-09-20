/**
 * Bundled-skill seeding.
 *
 * Skills authored in `src/skills/<name>/**` are bundled at build time (Vite
 * `import.meta.glob`, raw text) and written into the VFS on first run so the
 * agent ships with them by default — no manual import needed.
 *
 * ADDITIVE ONLY. Seeding never clears the VFS and never touches user files:
 *  - It writes ONLY the bundled skill's own files under `/skills/<name>/`.
 *  - Each skill is seeded once per version, tracked in chrome.storage.local.
 *    A skill the user later deletes is NOT resurrected on reload (its version
 *    is already recorded). Bumping a skill's `version:` re-seeds it (an
 *    intentional update), which may overwrite edits to that one skill only.
 *
 * If chrome.storage is unavailable, seeding is skipped entirely rather than
 * risking repeated writes — the skill can still be dragged in via the Files
 * panel.
 */

import type { VirtualFileSystemService } from '../shared/types'
import { debugLog } from '../shared/debug-log'

const SEED_MARKER_KEY = 'seededSkills'

// Raw text of every file under src/skills/. Keys are module-relative paths like
// '../skills/google-docs/SKILL.md'. Eager so we can group synchronously.
const BUNDLED = import.meta.glob('../skills/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

interface BundledSkill {
  name: string
  version: string
  files: Array<{ rel: string; text: string }>
}

/** '../skills/google-docs/SKILL.md' -> { skill: 'google-docs', rel: 'SKILL.md' }. */
function splitSkillPath(globPath: string): { skill: string; rel: string } | undefined {
  const m = /\/skills\/([^/]+)\/(.+)$/.exec(globPath)
  if (!m) return undefined
  return { skill: m[1]!, rel: m[2]! }
}

/** Read `version:` from SKILL.md frontmatter; defaults to "1" when absent. */
function versionOf(skillMd: string): string {
  if (!skillMd.startsWith('---')) return '1'
  const end = skillMd.indexOf('\n---', 3)
  if (end === -1) return '1'
  for (const line of skillMd.slice(3, end).split(/\r?\n/)) {
    const m = /^\s*version:\s*(.+)\s*$/.exec(line)
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, '') || '1'
  }
  return '1'
}

function collectBundledSkills(): BundledSkill[] {
  const bySkill = new Map<string, Array<{ rel: string; text: string }>>()
  for (const [globPath, text] of Object.entries(BUNDLED)) {
    const parts = splitSkillPath(globPath)
    if (!parts) continue
    const list = bySkill.get(parts.skill) ?? []
    list.push({ rel: parts.rel, text })
    bySkill.set(parts.skill, list)
  }

  const skills: BundledSkill[] = []
  for (const [name, files] of bySkill) {
    const skillMd = files.find((f) => f.rel.toLowerCase() === 'skill.md')
    if (!skillMd) continue // a skill dir without SKILL.md isn't a skill
    skills.push({ name, version: versionOf(skillMd.text), files })
  }
  return skills
}

async function readMarker(): Promise<Record<string, string>> {
  const out = await chrome.storage.local.get(SEED_MARKER_KEY)
  const raw = out[SEED_MARKER_KEY]
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
}

/**
 * Seed any bundled skill whose recorded version differs from its current one.
 * Fire-and-forget from the VFS factory; never throws.
 */
export async function seedBundledSkills(vfs: VirtualFileSystemService): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    const skills = collectBundledSkills()
    if (skills.length === 0) return

    const personal = new Set((await vfs.extensions?.('list') as Array<{ id: string }> | undefined ?? []).map((e) => e.id))
    const marker = await readMarker()
    let changed = false

    for (const skill of skills) {
      if (personal.has(skill.name)) continue // Never overwrite the working source of a personal extension.
      if (marker[skill.name] === skill.version) continue // already seeded at this version
      for (const file of skill.files) {
        const path = `/skills/${skill.name}/${file.rel}`
        try {
          await vfs.writeText(path, file.text, {
            mediaType: file.rel.toLowerCase().endsWith('.md') ? 'text/markdown' : undefined,
          })
        } catch (err) {
          debugLog.error('storage', `seed skill file ${path}`, err)
        }
      }
      marker[skill.name] = skill.version
      changed = true
      debugLog.log('storage', `seeded bundled skill "${skill.name}" v${skill.version}`)
    }

    if (changed) await chrome.storage.local.set({ [SEED_MARKER_KEY]: marker })
  } catch (err) {
    debugLog.error('storage', 'seedBundledSkills', err)
  }
}
