/**
 * App shell: <Header/>, <Feed/>, file sheet, <Composer/>. Owns settings-modal
 * visibility and the file-sheet state (open/focused path). Shows a gentle
 * inline prompt to open Settings when no apiKey is configured. The whole panel
 * is a drop target: dragged-in images stage as composer attachments (a
 * full-panel overlay shows while dragging files).
 *
 * Perf: every callback handed to memoized children (Header, Feed rows,
 * FilePanel, Composer) is identity-stable (useCallback/module fn) — an inline
 * closure here would defeat the memoization that keeps streaming cheap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from './components/Header'
import { Feed } from './components/Feed'
import { Composer } from './components/Composer'
import { isCompacting } from '../shared/compaction'
import { RateLimitBanner } from './components/RateLimitBanner'
import { StepPromptBanner } from './components/StepPromptBanner'
import { UserPromptCard, type UserPromptSubmission } from './components/UserPromptCard'
import { DeadTurnChip } from './components/DeadTurnChip'
import { Settings, type SectionId } from './components/Settings'
import { Onboarding } from './components/Onboarding'
import { FilePanel } from './components/FilePanel'
import { TaskTray } from './components/TaskTray'
import { applyReveal } from './reveal'
import { initBridgePanel } from './bridge-client'
import {
  useStore,
  initStore,
  newChat,
  selectChat,
  deleteChat,
  sendMessage,
  answerStepPrompt,
  answerUserPrompt,
  retryDeadTurn,
  setComposerDraft,
  appendDraftMention,
  acceptNextPrompt,
  dismissNextPrompt,
  addSteering,
  clearSteering,
  clearQueuedMessages,
  revertToMessage,
  stop,
  saveSettings,
  setModelId,
  switchToGrok,
  hasXaiKey,
  hasActiveCredential,
  isOpenAIModel,
  setChatGPTConnectionStatus,
  availableModelProviders,
  resolveStarterPrompts,
  registerFileViewer,
  attachImageFiles,
  removeAttachment,
  removeBrowserContext,
  captureAppshot,
  clearAttachmentNotice,
  nudgeTask,
  cancelTask,
} from './store'
import type { Settings as SettingsShape } from '../shared/types'

/** Draft syntax for "read this file" — the file panel's Attach button emits it. */
const fileMention = (path: string): string => `@file(${path})`

const onSelectChat = (id: string): void => void selectChat(id)
const onDeleteChat = (id: string): void => void deleteChat(id)
const onRevert = (itemId: string): void => void revertToMessage(itemId)
const onModelChange = (id: string): void => void setModelId(id)
const onSend = (text: string): void => void sendMessage(text)
const onNudgeTask = (taskId: string, text: string): void => nudgeTask(taskId, text)
const onCancelTask = (taskId: string): void => cancelTask(taskId)
const onAttachFiles = (files: File[]): void => void attachImageFiles(files)
const onAppshot = (): void => void captureAppshot()
const onSaveSettings = (next: SettingsShape): Promise<void> => saveSettings(next)
const onStepPromptAnswer = (keepGoing: boolean): void => answerStepPrompt(keepGoing)
const onRetryDeadTurn = (): void => void retryDeadTurn()
const onSwitchToGrok = (scope: 'all' | 'subagents'): void => void switchToGrok(scope)
const onChatGPTConnectionChange = (connected: boolean): void => setChatGPTConnectionStatus(connected)
const attachFile = (path: string, opts?: { folder?: boolean }): void =>
  appendDraftMention(opts?.folder ? `@folder(${path})` : fileMention(path))

export function App(): React.ReactElement {
  const state = useStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId>('account')
  const [sheet, setSheet] = useState<{ open: boolean; path?: string; nonce: number }>({ open: false, nonce: 0 })
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)

  // Panel-wide image drop target. Depth-counted enter/leave so crossing child
  // elements doesn't flicker the overlay; only OS file drags activate it.
  const dragHasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!dragHasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    // relatedTarget is null when the drag leaves the window entirely — the
    // depth counter can be desynced at that point (enter/leave don't always
    // pair up across children), so reset it outright.
    if (e.relatedTarget === null) dragDepth.current = 0
    if (dragDepth.current === 0) setDropActive(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) void attachImageFiles(files)
  }

  // Safety net for drags that end outside the panel (dropped elsewhere,
  // cancelled with Esc, window loses focus): no dragleave/drop reaches the
  // app element in those cases, which would leave the overlay stuck on.
  useEffect(() => {
    const reset = (): void => {
      dragDepth.current = 0
      setDropActive(false)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const openFile = useCallback((path?: string): void => setSheet((s) => ({ open: true, path, nonce: s.nonce + 1 })), [])
  const closeSheet = useCallback((): void => setSheet((s) => ({ ...s, open: false })), [])
  const toggleFiles = useCallback(
    (): void => setSheet((s) => (s.open ? { ...s, open: false } : { open: true, path: undefined, nonce: s.nonce + 1 })),
    [],
  )
  const openSettings = useCallback((): void => { setSettingsSection('account'); setSettingsOpen(true) }, [])
  const closeSettings = useCallback((): void => setSettingsOpen(false), [])
  const composerDraft = state.drafts[state.current.id] ?? ''

  useEffect(() => {
    void initStore()
    // Local coding agents reach the panel through the service worker; the port
    // it opens is also what tells the worker the panel is available at all.
    initBridgePanel()
  }, [])


  // The fullscreen file sheet is App-local state, but `openMemoryFile` is called
  // from places with no prop path to it (the memory chip in the feed, the Settings
  // row). Lend the store this opener rather than growing a second viewer path.
  useEffect(() => registerFileViewer(openFile), [openFile])

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme ?? 'dark'
  }, [state.settings.theme])

  const hasCredential = hasActiveCredential()
  // Only the pass launched inside first-run onboarding gates the composer.
  // Upgrade migrations and explicit Settings re-runs happen in the background.
  const configuring = state.setupBlocksComposer && state.setup.status === 'running'
  const queuedMessages = state.queuedMessages.filter((message) => message.chatId === state.current.id)
  const isRunning = state.runningChatIds.includes(state.current.id)
  const compacting = isRunning && isCompacting(state.current.transcript)
  const contextUsage = state.contextUsage[state.current.id]
  // Per-agent rate-limit waits: main's feeds the banner; subagent entries are
  // rendered under their delegation cards in the feed.
  const chatRateLimits = state.rateLimits[state.current.id]
  const mainRateLimit = chatRateLimits?.['main']
  const pendingSteering = state.steering[state.current.id]
  const stepPrompt = state.stepPrompts[state.current.id]
  const userPrompt = state.userPrompts[state.current.id]
  // Bound to the chat that raised it, not to "the current chat", so an answer
  // can never land on a prompt belonging to a chat switched to mid-decision.
  const promptChatId = userPrompt ? state.current.id : undefined
  const onUserPromptAnswer = useCallback(
    (submission: UserPromptSubmission): void => {
      if (promptChatId) answerUserPrompt(promptChatId, submission)
    },
    [promptChatId],
  )
  const runTimer = state.runTimer[state.current.id]
  const deadTurn = state.deadTurns[state.current.id]
  const pendingAttachments = state.attachments[state.current.id] ?? []
  const pendingBrowserContexts = state.browserContexts[state.current.id] ?? []
  const attachmentNotice = state.attachmentNotices[state.current.id]
  const appshotBusy = state.appshotBusy[state.current.id] ?? false
  // Predicted follow-up for this chat. The composer decides whether it is
  // showable (empty draft, idle, enabled) — App only routes it.
  const nextPrompt = state.nextPrompt[state.current.id]

  // Stable array identity per credential state, so the memoized Composer
  // doesn't re-render every frame for an unchanged provider list.
  const modelProviders = useMemo(
    () => availableModelProviders(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.settings, state.chatgptConnected],
  )

  const chatTasks = useMemo(
    () => Object.values(state.tasks).filter((t) => t.chatId === state.current.id),
    [state.tasks, state.current.id],
  )

  // Stable array identity per setup record, so the empty-state chips don't
  // re-create their handlers on unrelated renders.
  const starterPrompts = useMemo(() => resolveStarterPrompts(state.setup), [state.setup])

  // Stable identity so the memoized Header only re-renders when usage moves.
  const headerUsage = useMemo(
    () => (contextUsage ? { modelId: contextUsage.modelId, usage: contextUsage.usage } : undefined),
    [contextUsage],
  )

  // Stream jitter buffer: slice the still-arriving part back to what has been
  // revealed and withhold whatever the model produced after it, so bursts and
  // inter-step gaps both come out at one steady pace (see reveal.ts). An idle
  // chat has no entries and this hands back the transcript untouched.
  const revealedItems = useMemo(
    () => applyReveal(state.current.transcript, state.reveal),
    [state.current.transcript, state.reveal],
  )
  // The reserve outlives the turn by a tail, and the feed's trailing group
  // should stay live until the last word has actually landed. Derived from the
  // transform rather than from the counts: an entry that has caught up is
  // still in the map (its part is open), but it owes the user nothing.
  const revealing = revealedItems !== state.current.transcript

  // Steering typed mid-turn shows in the feed immediately as a pending bubble
  // (render-only — the real item appears when the model receives it at the
  // next step boundary, which can be a while when subagents are running).
  const feedItems =
    isRunning && pendingSteering
      ? [
          ...revealedItems,
          { kind: 'user' as const, id: 'pending-steering', text: pendingSteering, at: Date.now(), steered: true, pending: true },
        ]
      : revealedItems

  if (!state.loaded) {
    const message = state.startupPhase === 'loading'
      ? 'Loading your chats…'
      : state.startupPhase === 'connecting'
        ? 'Connecting to background tasks…'
        : 'Restoring task progress…'
    return <main className="panel-standby" role="status">{message}</main>
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Header
        chats={state.chats}
        currentId={state.current.id}
        runningChatIds={state.runningChatIds}
        settings={state.settings}
        contextUsage={headerUsage}
        isRunning={isRunning}
        transcriptCount={state.current.transcript.length}
        onNewChat={newChat}
        onSelectChat={onSelectChat}
        onDeleteChat={onDeleteChat}
        onOpenFiles={toggleFiles}
        onOpenSettings={openSettings}
      />

      {!hasCredential ? (
        <div className="apikey-prompt">
          <span>
            {isOpenAIModel(state.current.modelId) && state.settings.openaiAuthMode === 'chatgpt'
              ? 'ChatGPT sign-in required.'
              : 'No API key set.'}
          </span>
          <button onClick={openSettings}>Open Settings</button>
          <span>to start chatting.</span>
        </div>
      ) : null}

      <Feed
        items={feedItems}
        streaming={isRunning || revealing}
        agentWaits={chatRateLimits}
        subagentModelBadge={
          state.modelOverride &&
          (state.modelOverride.scope === 'all' || state.modelOverride.scope === 'subagents')
            ? 'Grok'
            : undefined
        }
        starterPrompts={state.starterPromptsPending ? state.starterPromptsDraft : starterPrompts}
        starterPromptsPending={state.starterPromptsPending}
        configuring={configuring}
        userName={state.settings.userName}
        onRevert={onRevert}
        onOpenFile={openFile}
        onStarterPrompt={setComposerDraft}
      />

      <FilePanel
        open={sheet.open}
        onClose={closeSheet}
        focusPath={sheet.path}
        focusNonce={sheet.nonce}
        onAttach={attachFile}
      />

      {isRunning && mainRateLimit ? (
        <RateLimitBanner
          status={mainRateLimit}
          showGrokSwitch={isOpenAIModel(state.current.modelId) || Boolean(state.modelOverride)}
          hasXaiKey={hasXaiKey()}
          modelOverride={state.modelOverride}
          onSwitchToGrok={onSwitchToGrok}
        />
      ) : null}

      {isRunning && stepPrompt ? <StepPromptBanner prompt={stepPrompt} onAnswer={onStepPromptAnswer} /> : null}

      {/* Keyed by prompt id so a new prompt never inherits the previous one's
          half-typed answer. Not gated on isRunning: the card only exists while
          a turn is parked on it, and it must survive a chat switch. */}
      {userPrompt ? (
        <UserPromptCard key={userPrompt.id} prompt={userPrompt} onAnswer={onUserPromptAnswer} />
      ) : null}

      {!isRunning && deadTurn ? <DeadTurnChip status={deadTurn} onRetry={onRetryDeadTurn} /> : null}

      <TaskTray
        tasks={chatTasks}
        transcript={state.current.transcript}
        onNudge={onNudgeTask}
        onCancel={onCancelTask}
      />

      <Composer
        value={composerDraft}
        isRunning={isRunning}
        disabled={!hasCredential || configuring || compacting}
        disabledReason={compacting ? 'Compacting conversation…' : configuring ? 'We’re still configuring Handoff for you…' : undefined}
        queuedCount={queuedMessages.length}
        pendingSteering={pendingSteering}
        modelId={state.current.modelId}
        provider={state.settings.provider}
        openaiAuthMode={state.settings.openaiAuthMode}
        modelProviders={modelProviders}
        attachments={pendingAttachments}
        browserContexts={pendingBrowserContexts}
        appshotBusy={appshotBusy}
        attachmentNotice={attachmentNotice}
        runStartedAt={runTimer?.startedAt}
        nextPrompt={nextPrompt}
        onModelChange={onModelChange}
        onChange={setComposerDraft}
        onSend={onSend}
        onSteer={addSteering}
        onClearSteering={clearSteering}
        onClearQueue={clearQueuedMessages}
        onStop={stop}
        onAttachFiles={onAttachFiles}
        onRemoveAttachment={removeAttachment}
        onRemoveBrowserContext={removeBrowserContext}
        onAppshot={onAppshot}
        onClearNotice={clearAttachmentNotice}
        onAcceptNextPrompt={acceptNextPrompt}
        onDismissNextPrompt={dismissNextPrompt}
      />

      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__card">Drop images to attach</div>
        </div>
      ) : null}

      {settingsOpen ? (
        <Settings
          initialSection={settingsSection}
          settings={state.settings}
          onSave={onSaveSettings}
          onClose={closeSettings}
          onChatGPTConnectionChange={onChatGPTConnectionChange}
        />
      ) : null}

      {state.showOnboarding ? <Onboarding /> : null}
    </div>
  )
}
