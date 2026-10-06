/**
 * Chrome adds an Origin header to extension fetches. Anthropic applies its
 * browser/CORS organization policy to that header, even with native OAuth
 * bearer credentials. The OAuth token endpoint also rejects browser User-Agent
 * strings with 429 before validating the grant. Match the exchange client's
 * axios User-Agent only on that endpoint; inference has a separate protocol.
 * https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
 */
const RULE_IDS = [510001, 510002]
// Token exchange uses Claude Code 2.1.289's bundled Axios client, not the
// claude-cli inference User-Agent. Keep these two request identities separate.
export const CLAUDE_OAUTH_USER_AGENT = 'axios/1.15.2'
let installing: Promise<void> | undefined
let installedExtensionId: string | undefined

export async function ensureAnthropicBrowserTransport(): Promise<void> {
  // Node-based callers and transport tests already send native HTTP requests.
  const extensionId = typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined
  if (!extensionId) return
  if (installedExtensionId === extensionId) return
  if (installing) return installing
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    throw new Error('Claude browser access requires the updated extension permission. Reload the extension in chrome://extensions and try again.')
  }

  const task = (async (): Promise<void> => {
    const endpoints = [
      '^https://api\\.anthropic\\.com/v1/messages(\\?[^#]*)?$',
      '^https://platform\\.claude\\.com/v1/oauth/token(\\?[^#]*)?$',
    ]
    const addRules: chrome.declarativeNetRequest.Rule[] = endpoints.map((regexFilter, index) => ({
      id: RULE_IDS[index]!,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          { header: 'Origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
          // Chrome may ignore a JS fetch User-Agent override. DNR changes the
          // actual wire header, for both authorization-code and refresh grants.
          ...(index === 1 ? [{ header: 'User-Agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: CLAUDE_OAUTH_USER_AGENT }] : []),
        ],
      },
      condition: {
        regexFilter,
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [extensionId],
        requestMethods: ['post' as chrome.declarativeNetRequest.RequestMethod],
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
      },
    }))
    try {
      // One atomic replacement is safe when another extension context installs
      // these same IDs concurrently. No unrelated session rules are removed.
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS, addRules })
      installedExtensionId = extensionId
    } catch (cause) {
      throw new Error('Claude browser access could not be configured. Reload the extension with its declarativeNetRequestWithHostAccess permission and try again.', { cause })
    }
  })()
  installing = task
  try {
    await task
  } finally {
    if (installing === task) installing = undefined
  }
}
