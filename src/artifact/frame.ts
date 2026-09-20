/**
 * Runs INSIDE artifact-frame.html — a manifest-sandboxed page (opaque origin,
 * permissive CSP: inline scripts + eval allowed, no chrome.*). It exists only
 * so the artifact document underneath can run author-written JavaScript,
 * which the extension page's own CSP (`script-src 'self'`) forbids.
 *
 * Job: hold one nested <iframe srcdoc> per render and relay messages between
 * it and the parent viewer (artifact.html) in both directions. The nested
 * document gets a fresh opaque origin, so this relay is the only channel.
 */

import type { ArtifactDocumentToHost, ArtifactHostToDocument } from '../shared/artifacts'

let inner: HTMLIFrameElement | undefined

function post(message: ArtifactDocumentToHost): void {
  window.parent.postMessage(message, '*')
}

function render(html: string): void {
  inner?.remove()
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'artifact')
  frame.setAttribute('allow', 'clipboard-write; fullscreen')
  frame.srcdoc = html
  document.body.appendChild(frame)
  inner = frame
}

window.addEventListener('message', (event: MessageEvent<ArtifactHostToDocument | ArtifactDocumentToHost>) => {
  const data = event.data
  if (!data || typeof data !== 'object' || !('kind' in data)) return
  if (event.source === window.parent) {
    if (data.kind === 'artifact-frame-ping') {
      post({ kind: 'artifact-frame-ready' })
      return
    }
    if (data.kind === 'artifact-render') {
      render(data.html)
      return
    }
    inner?.contentWindow?.postMessage(data, '*')
    return
  }
  if (inner && event.source === inner.contentWindow) {
    post(data as ArtifactDocumentToHost)
  }
})

post({ kind: 'artifact-frame-ready' })
