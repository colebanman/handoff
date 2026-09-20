const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
])

const REMOVE_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'])

export function sanitizeDocumentHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  sanitizeNode(template.content)
  return template.innerHTML
}

function sanitizeNode(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove()
      continue
    }

    if (node.nodeType !== Node.ELEMENT_NODE) continue

    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()

    if (REMOVE_WITH_CONTENT.has(tag)) {
      element.remove()
      continue
    }

    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes))
      sanitizeNode(parent)
      continue
    }

    sanitizeAttributes(element, tag)
    sanitizeNode(element)
  }
}

function sanitizeAttributes(element: HTMLElement, tag: string): void {
  const href = element.getAttribute('href') || ''
  const src = element.getAttribute('src') || ''
  const alt = element.getAttribute('alt')
  const colspan = element.getAttribute('colspan')
  const rowspan = element.getAttribute('rowspan')

  for (const attribute of Array.from(element.attributes)) {
    element.removeAttribute(attribute.name)
  }

  if (tag === 'a') {
    if (isSafeDocumentHref(href)) {
      element.setAttribute('href', href)
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noreferrer')
    }
    return
  }

  if (tag === 'img') {
    if (isSafeDocumentImageSrc(src)) element.setAttribute('src', src)
    if (alt) element.setAttribute('alt', alt)
    return
  }

  if (tag === 'td' || tag === 'th') {
    copyPositiveIntegerAttribute(element, 'colspan', colspan)
    copyPositiveIntegerAttribute(element, 'rowspan', rowspan)
  }
}

function copyPositiveIntegerAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (!value) return
  const number = Number(value)
  if (Number.isInteger(number) && number > 0 && number <= 100) {
    element.setAttribute(name, String(number))
  }
}

function isSafeDocumentHref(href: string): boolean {
  if (!href) return false
  return (
    href.startsWith('#') ||
    href.startsWith('/workspace/') ||
    href.startsWith('/skills/') ||
    /^https?:\/\//i.test(href) ||
    /^mailto:/i.test(href)
  )
}

function isSafeDocumentImageSrc(src: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src) || /^https?:\/\//i.test(src)
}
