import { useEffect, useState } from 'react'
import type { ExtensionSummary } from '../../shared/extensions'
import { getRuntime } from '../../runtime'
import { subscribeVfsChanges } from '../../storage/vfs'

/** Personal capabilities live next to their editable source in Files → Skills. */
export function ReplExtensions({ onSource }: { onSource: (path: string) => void }): React.ReactElement {
  const [entries, setEntries] = useState<ExtensionSummary[]>([])
  const [learning, setLearning] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = (op: string, input?: unknown) => getRuntime().vfs.extensions(op, input)
  useEffect(() => {
    let live = true
    const refresh = async () => {
      try {
        const [items, settings] = await Promise.all([request('list'), request('settings')])
        if (live) { setEntries(items as ExtensionSummary[]); setLearning((settings as { learningEnabled: boolean }).learningEnabled) }
      } catch (e) { if (live) setError(String(e)) }
    }
    void refresh()
    const unsubscribe = subscribeVfsChanges((change) => { if (change.path.startsWith('/skills')) void refresh() })
    return () => { live = false; unsubscribe() }
  }, [])
  async function change(op: string, input: unknown) {
    setBusy(true); setError('')
    try {
      await request(op, input)
      setEntries(await request('list') as ExtensionSummary[])
      setLearning((await request('settings') as { learningEnabled: boolean }).learningEnabled)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="repl-library">
    <div className="repl-library__header">
      <span>Learned functions</span>
      <label><input type="checkbox" checked={learning} disabled={busy} onChange={(e) => void change('settings', { learningEnabled: e.target.checked })} /> Learn useful shortcuts</label>
    </div>
    {entries.map((entry) => {
      const previous = [...entry.revisions].reverse().find((r) => r < entry.revision)
      return <div key={entry.id} className="repl-library__entry">
        <button className="icon-btn" title={entry.description} onClick={() => onSource(`${entry.path}/index.js`)}>{entry.id} · v{entry.revision}</button>
        <span className="repl-library__detail">{entry.enabled ? `${Object.keys(entry.manifest.actions).length} functions` : 'Disabled'}</span>
        <button className="icon-btn" disabled={busy} onClick={() => onSource(`${entry.path}/extension.json`)}>Docs &amp; matching</button>
        <button className="icon-btn" disabled={busy} onClick={() => void change('disable', { id: entry.id, disabled: entry.enabled })}>{entry.enabled ? 'Disable' : 'Enable'}</button>
        {previous !== undefined && <button className="icon-btn" disabled={busy} title="Restore the previous published implementation" onClick={() => void change('rollback', { id: entry.id, revision: previous, expectedRevision: entry.revision })}>Undo</button>}
        <button className="icon-btn" disabled={busy} title="Remove the published function; working source files remain" onClick={() => void change('remove', { id: entry.id })}>Remove</button>
      </div>
    })}
    {error && <div role="alert" className="file-panel__status">{error}</div>}
  </div>
}
