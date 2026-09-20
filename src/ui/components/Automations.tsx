/**
 * Settings → Automations: every scheduled prompt with its cadence, next and
 * last run, and the chat it writes into. Creation and edits happen in chat
 * ("every weekday at 8, …"); this list is for a quick look, pause/resume, run
 * now, or delete. The service worker owns the alarms, so every action goes
 * through it rather than touching storage directly.
 */

import { useEffect, useState } from 'react'
import {
  describeSchedule,
  formatInZone,
  type AutomationRecord,
  type AutomationRuntimeMessage,
} from '../../shared/automations'
import { loadAutomations, subscribeAutomations } from '../../storage/automations'
import { debugLog } from '../../shared/debug-log'
import { selectChat } from '../store'

function command(id: string, cmd: AutomationRuntimeMessage['command']): Promise<unknown> {
  return chrome.runtime.sendMessage({ target: 'background', type: 'automation.command', command: cmd, id } satisfies AutomationRuntimeMessage)
}

export function AutomationsPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [list, setList] = useState<AutomationRecord[] | undefined>()
  const [busy, setBusy] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    loadAutomations()
      .then((records) => {
        if (active) setList(records)
      })
      .catch((err) => debugLog.error('ui', 'load automations', err))
    const unsubscribe = subscribeAutomations((records) => setList(records))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const run = async (id: string, cmd: AutomationRuntimeMessage['command']): Promise<void> => {
    setBusy(id)
    try {
      await command(id, cmd)
    } catch (err) {
      debugLog.error('ui', `automation ${cmd}`, err)
    } finally {
      setBusy(undefined)
    }
  }

  const openChat = async (chatId: string): Promise<void> => {
    await selectChat(chatId)
    onClose()
  }

  const sorted = [...(list ?? [])].sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))

  return (
    <>
      <div className="field">
        <span className="field__label">Scheduled runs</span>
        <p className="field__hint">
          Ask in chat to create one: &ldquo;every weekday at 8am, update the assignments artifact from Canvas&rdquo;. Runs
          happen in the background even with this panel closed; anything missed while the browser was closed runs once on
          the next start. The chat a run writes into moves to the top of history with a ⏰ badge.
        </p>
      </div>

      {list === undefined ? (
        <p className="field__hint">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="field__hint">No automations yet.</p>
      ) : (
        <ul className="automations">
          {sorted.map((record) => {
            const chatId = record.chat.mode === 'existing' ? record.chat.chatId : record.lastChatId
            return (
              <li key={record.id} className={`automation${record.enabled ? '' : ' automation--paused'}`}>
                <div className="automation__head">
                  <span className="automation__title" title={record.prompt}>
                    {record.title}
                  </span>
                  <span className={`automation__status automation__status--${record.runningRunId ? 'running' : record.lastStatus ?? 'idle'}`}>
                    {record.runningRunId
                      ? 'running'
                      : !record.enabled
                        ? 'paused'
                        : record.lastStatus === 'error'
                          ? 'last run failed'
                          : record.lastStatus === 'done'
                            ? 'ok'
                            : 'scheduled'}
                  </span>
                </div>
                <div className="automation__meta">
                  <span>{describeSchedule(record.schedule, record.timeZone)}</span>
                  <span>
                    {record.enabled && record.nextRunAt ? `Next ${formatInZone(record.nextRunAt, record.timeZone)}` : 'Not scheduled'}
                  </span>
                  {record.lastRunAt ? <span>Last {formatInZone(record.lastRunAt, record.timeZone)}</span> : null}
                  <span>{record.chat.mode === 'new' ? 'New chat per run' : 'Runs in its chat'}</span>
                </div>
                {record.lastError ? <div className="automation__error">{record.lastError}</div> : null}
                <div className="automation__actions">
                  <button type="button" className="btn btn--ghost" disabled={busy === record.id || Boolean(record.runningRunId)} onClick={() => void run(record.id, 'run')}>
                    Run now
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy === record.id} onClick={() => void run(record.id, record.enabled ? 'disable' : 'enable')}>
                    {record.enabled ? 'Pause' : 'Resume'}
                  </button>
                  {chatId ? (
                    <button type="button" className="btn btn--ghost" onClick={() => void openChat(chatId)}>
                      Open chat
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--ghost automation__delete" disabled={busy === record.id} onClick={() => void run(record.id, 'delete')}>
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
