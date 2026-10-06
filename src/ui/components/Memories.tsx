import { useEffect, useMemo, useState } from 'react'
import { memoryContentSchema, memoryLife, subjectKey, type MemoryContent, type MemoryRecord, type MemorySnapshot } from '../../shared/continuity'
import { memoryCommand, watchMemories } from '../memory-client'
import { openMemoryFile, selectChat } from '../store'
import { formatError } from '../../shared/errors'
import '../memory.css'

const lifeLabels = { active: 'Current', upcoming: 'Upcoming', review: 'Needs review', dormant: 'Dormant', historical: 'Past' }
const date = (value: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(value)
function displayDate(value?: string, timeZone?: string): string {
  if (!value) return 'No cutoff'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${value}T12:00:00Z`))
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(Date.parse(value)) } catch { return value }
}

export function MemoriesPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('current')
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<string>()
  const [limit, setLimit] = useState(30)
  const [clock, setClock] = useState(Date.now())

  useEffect(() => {
    let mounted = true
    let request = 0
    const refresh = async () => {
      const id = ++request
      try { const value = await memoryCommand({ command: 'list' }); if (mounted && id === request) setSnapshot(value) }
      catch (err) { if (mounted) setError(formatError(err)) }
    }
    void refresh()
    const unsubscribe = watchMemories(() => void refresh())
    const timer = setInterval(() => setClock(Date.now()), 30_000)
    return () => { mounted = false; unsubscribe(); clearInterval(timer) }
  }, [])

  const records = snapshot?.records ?? []
  const current = records.filter((r) => ['active', 'upcoming', 'review'].includes(memoryLife(r, records, clock))).length
  const visible = useMemo(() => records.filter((r) => {
    const life = memoryLife(r, records, clock)
    if (filter === 'current' && !['active', 'upcoming', 'review'].includes(life)) return false
    if (filter === 'past' && !['historical', 'dormant'].includes(life)) return false
    return !query.trim() || [r.title, r.body, r.subject, ...r.triggers, ...r.entities, ...r.scopes].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }).sort((a, b) => b.updatedAt - a.updatedAt), [records, query, filter, clock])
  const active = records.find((r) => r.id === selected)

  const act = async (payload: Parameters<typeof memoryCommand>[0]) => {
    setBusy(true); setError('')
    try {
      const value = await memoryCommand<MemorySnapshot | { scheduled: boolean }>(payload)
      if ('records' in value) setSnapshot(value)
      setConfirm(undefined)
      if (payload.command === 'forget' || payload.command === 'clear') { setSelected(undefined); setEditing(false) }
      return true
    } catch (err) { setError(formatError(err)); return false }
    finally { setBusy(false) }
  }
  const configure = (patch: Partial<MemorySnapshot['state']['config']>) => snapshot && void act({ command: 'configure', config: { ...snapshot.state.config, ...patch } })
  const exportMemory = async () => {
    setBusy(true); setError('')
    try {
      const value = await memoryCommand<unknown>({ command: 'export' })
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = `handoff-memories-${new Date().toISOString().slice(0, 10)}.json`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
    } catch (err) { setError(formatError(err)) }
    finally { setBusy(false) }
  }
  const openSource = async (record: MemoryRecord, index: number) => {
    const source = record.sources[index]
    try {
      if (source?.chatId) { await selectChat(source.chatId); onClose() }
      else if (source?.path) openMemoryFile(source.path)
    } catch (err) { setError(formatError(err)) }
  }

  return <section className="memories" aria-label="Saved memories">
    <div className="memory-overview">
      <div className="memory-overview__icon" aria-hidden="true">✧</div>
      <div><h3>What Handoff remembers</h3><p>Useful context, ready when it matters.</p></div>
      <span className="memory-count">{current}</span>
    </div>
    {error && <p className="memory-error" role="alert">{error}</p>}
    {!snapshot ? <p className="memory-empty" role="status">Loading memories…</p> : <>
      <div className="memory-controls">
        <label className="settings-row"><span className="settings-row__label">Learn from conversations</span><input type="checkbox" checked={snapshot.state.config.learning} disabled={busy} onChange={(e) => configure({ learning: e.target.checked })} /></label>
        <label className="settings-row"><span className="settings-row__label">Use saved memories</span><input type="checkbox" checked={snapshot.state.config.recall} disabled={busy} onChange={(e) => configure({ recall: e.target.checked })} /></label>
      </div>
      <p className="memory-save-note">Memory changes save immediately.</p>
      <p className="memory-status" role="status">
        <span className={`memory-status__dot${snapshot.state.running ? ' memory-status__dot--working' : ''}`} />
        {!snapshot.state.config.learning ? 'Learning paused' : snapshot.state.running === 'consolidating' ? 'Connecting recent experiences…'
          : snapshot.state.running ? 'Learning in the background…' : snapshot.pending ? 'Background learning queued'
            : snapshot.state.lastRunAt ? `Last learned ${date(snapshot.state.lastRunAt)}` : 'Ready to learn as you work'}
      </p>
      {snapshot.state.error && <p className="memory-notice">{snapshot.state.error}</p>}

      {active ? <div className="memory-detail">
        <button className="memory-back" type="button" onClick={() => { setSelected(undefined); setEditing(false); setConfirm(undefined) }}>← All memories</button>
        {editing ? <MemoryEditor key={`${active.id}:edit`} record={active} busy={busy} onCancel={() => setEditing(false)} onSave={async (content) => {
          if (await act({ command: 'edit', id: active.id, revision: active.revision, content })) setEditing(false)
        }} /> : <>
          <div className="memory-detail__heading"><span className="memory-kind">{active.kind}</span><span className={`memory-life memory-life--${memoryLife(active, records, clock)}`}>{lifeLabels[memoryLife(active, records, clock)]}</span></div>
          <h3>{active.title}</h3><p className="memory-detail__body">{active.body}</p>
          <dl className="memory-facts">
            <div><dt>Comes to mind</dt><dd>{active.useWhen}</dd></div>
            <div><dt>Current through</dt><dd>{displayDate(active.expiresAt ?? active.validUntil ?? active.eventEnd, active.timeZone)}{active.expiresWith && <> · linked to {records.find((r) => subjectKey(r.subject) === subjectKey(active.expiresWith!))?.title ?? active.expiresWith}</>}</dd></div>
            {active.reviewAt && <div><dt>Review after</dt><dd>{displayDate(active.reviewAt, active.timeZone)}</dd></div>}
            <div><dt>Updated</dt><dd>{date(active.updatedAt)}{active.edited ? ' · edited by you' : ''}</dd></div>
          </dl>
          {(active.scopes.length > 0 || active.triggers.length > 0) && <div className="memory-cues" aria-label="Relevant pages and topics">
            {[...active.scopes, ...active.triggers].map((cue) => <span key={cue} title={cue}>{cue}</span>)}
          </div>}
          <MemoryConnections record={active} records={records} onSelect={(id) => { setSelected(id); setConfirm(undefined) }} />
          {active.guide && <button className="memory-link" type="button" onClick={() => openMemoryFile(active.guide!)}>Open field guide ↗</button>}
          {active.edited && <p className="memory-fine-print">Your edit is protected. <button className="memory-link" type="button" disabled={busy} onClick={() => void act({ command: 'unlock', id: active.id, revision: active.revision })}>Allow automatic updates</button></p>}
          <details className="memory-sources"><summary>Sources <span>{active.sources.length}</span></summary>
            <ol>{active.sources.map((source, index) => <li key={source.id}>
              <div><span>{source.origin === 'human' ? 'You' : source.origin === 'tool' ? 'Observed result' : source.origin === 'legacy' ? 'Existing memory' : source.origin}</span><time>{date(source.at)}</time></div>
              <p>{source.label}</p>{source.excerpt && <blockquote>{source.excerpt}</blockquote>}
              {(source.chatId || source.path) && <button className="memory-link" type="button" onClick={() => void openSource(active, index)}>{source.chatId ? 'Open conversation ↗' : 'Open source file ↗'}</button>}
            </li>)}</ol>
          </details>
          <div className="memory-actions"><button className="btn btn--ghost" type="button" disabled={busy} onClick={() => setEditing(true)}>Edit memory</button><button className="memory-link memory-link--danger" type="button" disabled={busy} onClick={() => setConfirm(active.id)}>Forget</button></div>
          {confirm === active.id && <div className="memory-confirm"><p>Forget this memory? Its original conversations stay in history.</p><div><button className="btn btn--ghost" type="button" disabled={busy} onClick={() => setConfirm(undefined)}>Keep it</button><button className="btn memory-danger" type="button" disabled={busy} onClick={() => void act({ command: 'forget', id: active.id })}>Forget memory</button></div></div>}
        </>}
      </div> : <>
        <label className="memory-search"><input type="search" aria-label="Search memories" placeholder="Search a topic, person, or website…" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(30) }} /></label>
        <div className="memory-filters" aria-label="Filter memories">{[['current', `Current ${current}`], ['past', `Past ${records.length - current}`], ['all', 'All']].map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => { setFilter(id!); setLimit(30) }}>{label}</button>)}</div>
        {visible.length ? <ul className="memory-list">{visible.slice(0, limit).map((record) => <li key={record.id}>
          <button className="memory-card" type="button" onClick={() => setSelected(record.id)}>
            <span className="memory-card__top"><span className="memory-kind">{record.kind}</span><span className={`memory-life memory-life--${memoryLife(record, records, clock)}`}>{lifeLabels[memoryLife(record, records, clock)]}</span></span>
            <strong>{record.title}</strong><span className="memory-card__body">{record.body}</span><span className="memory-card__foot">{record.sources.length} source{record.sources.length === 1 ? '' : 's'}<span>{date(record.updatedAt)} <span aria-hidden="true">↗</span></span></span>
          </button>
        </li>)}</ul> : <div className="memory-empty"><span aria-hidden="true">✧</span><p>{query ? 'No memories match this search.' : records.length ? 'Nothing in this view.' : 'Your context will grow here.'}</p>{!records.length && <small>Handoff keeps useful facts and decisions from your conversations, with sources and a lifetime.</small>}</div>}
        {visible.length > limit && <button className="memory-link" type="button" onClick={() => setLimit((n) => n + 30)}>Show more ({visible.length - limit})</button>}
      </>}

      <details className="memory-options"><summary>Learning &amp; data</summary>
        <label className="settings-row"><span className="settings-row__label">Background model</span><select aria-label="Memory background model" value={snapshot.state.config.model} disabled={busy} onChange={(e) => configure({ model: e.target.value as 'gpt-6-luna' | 'gpt-6-sol' })}><option value="gpt-6-luna">GPT-6 Luna</option><option value="gpt-6-sol">GPT-6 Sol</option></select></label>
        <label className="settings-row"><span className="settings-row__label">Daily learning budget</span><select aria-label="Daily memory learning budget" value={snapshot.state.config.dailyTokenBudget} disabled={busy} onChange={(e) => configure({ dailyTokenBudget: Number(e.target.value) })}>{[50_000, 250_000, 1_000_000, 2_000_000].map((n) => <option key={n} value={n}>{n.toLocaleString()} tokens</option>)}</select></label>
        <p className="memory-fine-print">Learning runs in the background on your configured OpenAI account or request route. It never delays a reply. Saved context stays below 10,000 tokens per request. Changes here save immediately.</p>
        <div className="memory-actions"><button className="btn btn--ghost" type="button" disabled={busy || !snapshot.state.config.learning || !!snapshot.state.running} onClick={() => void act({ command: 'run' })}>Review now</button><button className="btn btn--ghost" type="button" disabled={busy} onClick={() => void exportMemory()}>Export</button><button className="memory-link memory-link--danger" type="button" disabled={busy || !records.length} onClick={() => setConfirm('all')}>Forget all</button></div>
        {confirm === 'all' && <div className="memory-confirm"><p>Remove all saved memories? Earlier chats will not be learned again automatically. Your chats and files stay intact.</p><div><button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button><button type="button" className="btn memory-danger" disabled={busy} onClick={() => void act({ command: 'clear' })}>Forget all memories</button></div></div>}
      </details>
    </>}
  </section>
}

function MemoryConnections({ record, records, onSelect }: { record: MemoryRecord; records: MemoryRecord[]; onSelect(id: string): void }) {
  const linked = records.filter((r) => r.id !== record.id && (record.relatedTo.includes(subjectKey(r.subject)) || r.relatedTo.includes(subjectKey(record.subject)) || record.entities.some((entity) => r.entities.includes(entity)))).slice(0, 6)
  if (!linked.length) return null
  return <div className="memory-connections"><span>Connected context</span><div>{linked.map((r) => <button key={r.id} type="button" onClick={() => onSelect(r.id)}><span aria-hidden="true">↳</span>{r.title}</button>)}</div></div>
}

function MemoryEditor({ record, busy, onSave, onCancel }: { record: MemoryRecord; busy: boolean; onSave(value: MemoryContent): Promise<void>; onCancel(): void }) {
  const [draft, setDraft] = useState<MemoryContent>(() => Object.fromEntries(Object.keys(memoryContentSchema.shape).map((key) => [key, record[key as keyof MemoryRecord]])) as MemoryContent)
  const [error, setError] = useState('')
  const field = <K extends keyof MemoryContent>(key: K, value: MemoryContent[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    const parsed = memoryContentSchema.safeParse({ ...draft, triggers: draft.triggers.map((s) => s.trim()).filter(Boolean), scopes: draft.scopes.map((s) => s.trim()).filter(Boolean) })
    if (!parsed.success) { setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')); return }
    await onSave(parsed.data)
  }
  return <form className="memory-editor" onSubmit={(e) => void save(e)}>
    <h3>Edit memory</h3><p className="memory-fine-print">Your edits take priority over automatic learning.</p>
    <label className="field"><span className="field__label">Title</span><input value={draft.title} maxLength={120} required onChange={(e) => field('title', e.target.value)} /></label>
    <label className="field"><span className="field__label">What to remember</span><textarea rows={5} value={draft.body} maxLength={2400} required onChange={(e) => field('body', e.target.value)} /></label>
    <label className="field"><span className="field__label">When this helps</span><textarea rows={2} value={draft.useWhen} minLength={8} maxLength={400} required onChange={(e) => field('useWhen', e.target.value)} /></label>
    <label className="field"><span className="field__label">Matching phrases · one per line</span><textarea rows={2} value={draft.triggers.join('\n')} onChange={(e) => field('triggers', e.target.value.split('\n'))} /></label>
    <details className="memory-options"><summary>Dates &amp; pages</summary>
      <label className="field"><span className="field__label">Matching websites · one pattern per line</span><textarea rows={2} value={draft.scopes.join('\n')} onChange={(e) => field('scopes', e.target.value.split('\n'))} placeholder="school.example.com/courses/123/**" /></label>
      {([['validFrom', 'Applies from'], ['validUntil', 'Applies through'], ['eventStart', 'Event starts'], ['eventEnd', 'Event ends'], ['expiresAt', 'Stop using after'], ['reviewAt', 'Review after']] as const).map(([key, label]) => <label className="field" key={key}><span className="field__label">{label}</span><input value={draft[key] ?? ''} onChange={(e) => field(key, e.target.value || undefined)} placeholder="YYYY-MM-DD or a time with its UTC offset" /></label>)}
      <label className="field"><span className="field__label">Time zone for dates</span><input value={draft.timeZone} onChange={(e) => field('timeZone', e.target.value)} placeholder="America/New_York" /></label>
      <label className="field"><span className="field__label">Availability</span><select value={draft.state} onChange={(e) => field('state', e.target.value as MemoryContent['state'])}><option value="active">Current when relevant</option><option value="dormant">Keep dormant</option><option value="historical">Historical context only</option></select></label>
    </details>
    {error && <p className="memory-error" role="alert">{error}</p>}
    <div className="memory-actions"><button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save memory'}</button></div>
  </form>
}
