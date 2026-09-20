/**
 * Page-side favicon "click" for tab switches.
 *
 * Extensions cannot draw on Chrome's tab strip, but a page can swap its own
 * favicon, and the strip follows. The host drives a three-frame sequence from
 * the service worker (background tabs throttle their own timers) and finishes
 * with `restore`. Serialized by chrome.scripting.executeScript: fully
 * self-contained, no imports.
 */

export type FaviconFrame = {
  step: 0 | 1 | 2 | 'restore'
  /** Data URL of the tab's current favicon, fetched host-side. Absent: neutral tile. */
  icon?: string
}

export async function renderFaviconPulse(frame: FaviconFrame): Promise<void> {
  type Backup = { link: HTMLLinkElement; href: string | null; created: boolean }
  const scope = window as typeof window & { __aiFaviconPulse?: { backups: Backup[]; icon?: HTMLImageElement | null } }

  if (frame.step === 'restore') {
    const state = scope.__aiFaviconPulse
    if (!state) return
    for (const { link, href, created } of state.backups) {
      if (created) link.remove()
      else if (href === null) link.removeAttribute('href')
      else link.setAttribute('href', href)
    }
    delete scope.__aiFaviconPulse
    return
  }

  if (!document.head) return
  if (!scope.__aiFaviconPulse) {
    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
      .filter((link) => !/apple-touch|mask-icon/i.test(link.rel))
    const backups: Backup[] = links.map((link) => ({ link, href: link.getAttribute('href'), created: false }))
    if (backups.length === 0) {
      const link = document.createElement('link')
      link.rel = 'icon'
      document.head.append(link)
      backups.push({ link, href: null, created: true })
    }
    scope.__aiFaviconPulse = { backups }
  }
  const state = scope.__aiFaviconPulse

  // Decode the icon once; a slow or broken image falls back to a neutral tile.
  if (state.icon === undefined) {
    state.icon = null
    if (frame.icon) {
      state.icon = await new Promise<HTMLImageElement | null>((resolve) => {
        const image = new Image()
        const timer = setTimeout(() => resolve(null), 150)
        image.onload = () => { clearTimeout(timer); resolve(image) }
        image.onerror = () => { clearTimeout(timer); resolve(null) }
        image.src = frame.icon!
      })
    }
  }

  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const accent = '#b4a1ff'

  if (state.icon) {
    try { ctx.drawImage(state.icon, 0, 0, size, size) } catch { state.icon = null }
  }
  if (!state.icon) {
    ctx.fillStyle = '#d9d9de'
    ctx.beginPath()
    ctx.roundRect(2, 2, size - 4, size - 4, 7)
    ctx.fill()
  }

  // Frame choreography: 0 = pointer lands, 1 = press + tight ring, 2 = release + wide faint ring.
  const press = frame.step === 1
  const ringRadius = frame.step === 1 ? 6 : frame.step === 2 ? 11 : 0
  const ringAlpha = frame.step === 1 ? .75 : .28
  const tipX = 15, tipY = 15
  if (ringRadius) {
    ctx.beginPath()
    ctx.arc(tipX, tipY, ringRadius, 0, Math.PI * 2)
    ctx.strokeStyle = accent
    ctx.globalAlpha = ringAlpha
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  const pointer = new Path2D('M4.35 3.15C3.48 2.8 2.8 3.48 3.15 4.35L9.8 20.55C10.16 21.44 11.46 21.37 11.72 20.44L13.33 14.75C13.52 14.08 14.08 13.52 14.75 13.33L20.44 11.72C21.37 11.46 21.44 10.16 20.55 9.8Z')
  const scale = (press ? .56 : .62)
  ctx.save()
  // The silhouette's tip is at (3,3) in path space; pin it to the tip point.
  ctx.translate(tipX - 3 * scale, tipY - 3 * scale)
  ctx.scale(scale, scale)
  ctx.shadowColor = 'rgba(0,0,0,.35)'
  ctx.shadowBlur = 2
  ctx.shadowOffsetY = 1
  ctx.fillStyle = '#202126'
  ctx.fill(pointer)
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5 / scale
  ctx.lineJoin = 'round'
  ctx.stroke(pointer)
  ctx.restore()

  let url: string
  try { url = canvas.toDataURL('image/png') } catch { return } // Tainted canvas: leave the favicon alone.
  for (const { link } of state.backups) link.setAttribute('href', url)
}
