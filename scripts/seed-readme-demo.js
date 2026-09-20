// Run in the side-panel page of a disposable Handoff installation only.
// Browser-console script; also accepts `agent-browser eval --stdin < ...`.
// Replaces this installation's chat list and settings with fictional demo data.
(async () => {
  const at = Date.UTC(2026, 0, 1, 12)
  const id = 'readme-demo'
  const prompt = 'Compare these three venues for a team dinner. We need room for 20 people and a budget under $600.'
  const answer = '**The Garden Room is the best fit.** It seats 24 and comes to $540, including the room fee.\n\n| Venue | Capacity | Total |\n| --- | --- | --- |\n| Garden Room | 24 | $540 |\n| North Hall | 30 | $720 |\n| Corner Table | 16 | $420 |\n\nNorth Hall is over budget. Corner Table is too small.\n\nI saved the comparison to [venues.md](/workspace/venues.md). Nothing has been booked.'
  const tool = (toolName, input, output, durationMs, index) => ({
    kind: 'tool', id: `demo-tool-${index}`, agentId: 'main', toolName,
    input, inputText: JSON.stringify(input), output, status: 'done', durationMs, at: at + index * 1000,
  })
  const chat = {
    id, title: 'Team dinner', createdAt: at, updatedAt: at, modelId: 'demo-model',
    messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: answer }],
    transcript: [
      { kind: 'user', id: 'demo-user', text: prompt, at },
      { kind: 'reasoning', id: 'demo-reasoning', agentId: 'main', text: 'Check capacity, pricing, and room fees for each venue.', streaming: false, durationMs: 1800 },
      tool('browser_tabs', {}, 'Three venue pages open.', 240, 1),
      tool('browser_snapshot', { tabId: 1 }, 'Garden Room: 24 guests, $540 total.', 420, 2),
      tool('browser_snapshot', { tabId: 2 }, 'North Hall: 30 guests, $720 total.', 380, 3),
      tool('browser_snapshot', { tabId: 3 }, 'Corner Table: 16 guests, $420 total.', 350, 4),
      tool('sandbox_exec', { code: "await api.fs.writeText('/workspace/venues.md', comparison)" }, 'Saved /workspace/venues.md', 160, 5),
      { kind: 'text', id: 'demo-answer', agentId: 'main', text: answer, streaming: false, at: at + 6000 },
    ], checkpoints: [],
  }
  await chrome.storage.local.set({
    settings: { provider: 'openai-compatible', modelId: 'demo-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'demo-only', onboardingComplete: true, suggestNextPrompt: false, bridgeEnabled: false, theme: 'dark' },
    onboardingSetup: { status: 'done', starterPrompts: [] }, memoryBootstrapVersion: 1,
    'chat-ids': [id], [`chat:${id}`]: chat,
    [`meta:${id}`]: { id, title: chat.title, createdAt: at, updatedAt: at, preview: prompt },
  })
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('handoff-vfs')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const content = '# Team dinner\n\n20 guests · Budget: $600\n\n## Recommendation\n\nGarden Room fits both requirements: space for 24 guests and a total of $540, including the room fee.\n\n| Venue | Guests | Total | Fits? |\n| --- | --- | --- | --- |\n| Garden Room | 24 | $540 | Yes |\n| North Hall | 30 | $720 | Over budget |\n| Corner Table | 16 | $420 | Too small |\n\n## Before booking\n\n- Confirm availability for the chosen date.\n- Ask about dietary requirements.\n- Check the cancellation policy.\n\nNo reservation has been made.\n'
  const blob = new Blob([content], { type: 'text/markdown' })
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({ path: '/workspace/venues.md', root: 'workspace', name: 'venues.md', mediaType: 'text/markdown', size: blob.size, createdAt: at, updatedAt: at, blob })
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return 'Fictional demo content saved. Reload the side panel.'
})()
