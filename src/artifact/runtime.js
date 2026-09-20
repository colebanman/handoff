/*
 * Artifact runtime — injected at the top of <head> of every HTML artifact by
 * artifact.html (see shared/artifacts.ts buildArtifactDocument). Plain,
 * dependency-free JS because it is inlined as text (`?raw`) into a sandboxed
 * document with no module graph.
 *
 * Exposes `window.ai` (alias `window.artifact`):
 *   ai.fs.*, ai.fetch, ai.tabs.*, ai.history.*, ai.bookmarks.*, …  — the same
 *     API the code sandbox has (minus CDP/page driving), round-tripped to the
 *     viewer over postMessage as `api-call` / `api-result`.
 *   ai.invoke(prompt, { chat? })  — send a prompt to the side panel and await
 *     the assistant's final text.
 *   ai.save()                     — write the live DOM back into the file.
 *   ai.state.get/set/all          — durable per-artifact key/value store.
 *   ai.loadScript(url) / ai.loadStyle(url) — load libraries the sandbox CSP
 *     would otherwise block (<script src> tags in the file are inlined for you).
 *   ai.open(url)                  — open a URL in a new tab.
 *   ai.autosave()                 — persist user edits (contenteditable, inputs).
 *   ai.waitFor(fn, { timeoutMs })  — poll until fn() is truthy (async data loaded).
 *
 * It also answers `artifact-request` messages from the viewer so the agent can
 * `api.artifacts.eval(path, code)` inside this document and read its console.
 */
;(function () {
  'use strict'
  if (window.ai && window.ai.__artifactRuntime) return

  var meta = window.__ARTIFACT__ || { path: '', url: '' }
  // The kit's tokens follow the side panel theme unless the author pins one.
  if (meta.theme && document.documentElement && !document.documentElement.hasAttribute('data-theme')) {
    document.documentElement.setAttribute('data-theme', meta.theme)
  }
  var pending = new Map()
  var seq = 0
  var loadedScripts = new Map()
  var activeLogs = null

  function uid(prefix) {
    seq += 1
    return prefix + '-' + Date.now().toString(36) + '-' + seq.toString(36)
  }

  function post(message) {
    try {
      window.parent.postMessage(message, '*')
    } catch (_e) {
      /* detached frame */
    }
  }

  /* ---------------- value serialization (JSON-safe, DOM-aware) ---------------- */

  var MAX_STRING = 20000

  function clip(text, max) {
    max = max || MAX_STRING
    return text.length > max ? text.slice(0, max) + '…(+' + (text.length - max) + ' chars)' : text
  }

  function serialize(value, seen, depth) {
    seen = seen || new WeakSet()
    depth = depth || 0
    if (value === undefined || value === null) return null
    var t = typeof value
    if (t === 'string') return clip(value)
    if (t === 'number') return Number.isFinite(value) ? value : String(value)
    if (t === 'boolean') return value
    if (t === 'bigint') return value.toString()
    if (t === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']'
    if (t === 'symbol') return value.toString()
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ? clip(value.stack, 2000) : undefined }
    if (value instanceof Date) return value.toISOString()
    if (typeof Node !== 'undefined' && value instanceof Node) {
      if (value.nodeType === 1) return clip(value.outerHTML)
      if (value.nodeType === 9) return clip('<!doctype html>\n' + value.documentElement.outerHTML)
      return clip(value.textContent || '')
    }
    if (depth > 6) return Array.isArray(value) ? '[Array]' : '[Object]'
    if (seen.has(value)) return '[Circular]'
    if (t === 'object') seen.add(value)
    if (Array.isArray(value) || (typeof NodeList !== 'undefined' && value instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && value instanceof HTMLCollection)) {
      var arr = []
      var list = Array.from(value)
      for (var i = 0; i < list.length && i < 500; i++) arr.push(serialize(list[i], seen, depth + 1))
      if (list.length > 500) arr.push('…(+' + (list.length - 500) + ' more)')
      return arr
    }
    if (value instanceof Map) return serialize(Array.from(value.entries()), seen, depth + 1)
    if (value instanceof Set) return serialize(Array.from(value.values()), seen, depth + 1)
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return '[binary ' + (value.byteLength || 0) + ' bytes]'
    if (typeof value.toJSON === 'function') {
      try {
        return serialize(value.toJSON(), seen, depth + 1)
      } catch (_e) {
        /* fall through */
      }
    }
    var out = {}
    var keys = Object.keys(value)
    for (var k = 0; k < keys.length && k < 500; k++) out[keys[k]] = serialize(value[keys[k]], seen, depth + 1)
    return out
  }

  function inspect(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.name + ': ' + value.message
    try {
      var json = JSON.stringify(serialize(value))
      return json === undefined ? String(value) : clip(json, 2000)
    } catch (_e) {
      return String(value)
    }
  }

  /* ---------------- console forwarding ---------------- */

  var levels = ['log', 'info', 'debug', 'warn', 'error']
  levels.forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {}
    console[level] = function () {
      var args = Array.from(arguments)
      try {
        original.apply(null, args)
      } catch (_e) {
        /* ignore */
      }
      var text = args.map(inspect).join(' ')
      var mapped = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'
      if (activeLogs) activeLogs.push('[' + mapped + '] ' + text)
      post({ kind: 'artifact-console', level: mapped, text: text })
    }
  })
  window.addEventListener('error', function (event) {
    var where = event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : ''
    var text = 'Uncaught ' + (event.message || String(event.error)) + where
    if (activeLogs) activeLogs.push('[error] ' + text)
    post({ kind: 'artifact-console', level: 'error', text: text })
  })
  window.addEventListener('unhandledrejection', function (event) {
    var text = 'Unhandled rejection: ' + inspect(event.reason)
    if (activeLogs) activeLogs.push('[error] ' + text)
    post({ kind: 'artifact-console', level: 'error', text: text })
  })

  /* ---------------- api bridge ---------------- */

  function call(path, args) {
    return new Promise(function (resolve, reject) {
      // Display summaries are lossy; RPC arguments (especially saved files)
      // must retain their complete strings and collections.
      var values = JSON.parse(JSON.stringify(args || []))
      var callId = uid('c')
      pending.set(callId, { resolve: resolve, reject: reject })
      post({ kind: 'api-call', callId: callId, path: path, args: values })
    })
  }

  function makeNode(prefix) {
    var target = function () {}
    return new Proxy(target, {
      get: function (_t, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop === 'then') return undefined
        if (prefix === '' && prop === 'ui') return window.AiKit
        if (prefix === '' && Object.prototype.hasOwnProperty.call(LOCAL, prop)) return LOCAL[prop]
        return makeNode(prefix ? prefix + '.' + prop : prop)
      },
      apply: function (_t, _this, args) {
        if (!prefix) return Promise.reject(new Error('ai is a namespace — call ai.fs.readText(...), ai.fetch(...), ai.invoke(...), …'))
        return call(prefix, args)
      },
    })
  }

  /* ---------------- document save ---------------- */

  function cloneForSave(node) {
    var copy = node.cloneNode(false)
    var authored = window.AiKit && window.AiKit.sourceChildren(node)
    Array.from(authored || node.childNodes).forEach(function (child) { copy.appendChild(cloneForSave(child)) })
    if (node instanceof HTMLTemplateElement) copy.content.appendChild(node.content.cloneNode(true))
    if (node instanceof HTMLInputElement) {
      // File/password values are never serialized into a portable document.
      if (node.type !== 'file' && node.type !== 'password') copy.setAttribute('value', node.value)
      if (node.type === 'checkbox' || node.type === 'radio') copy.toggleAttribute('checked', node.checked)
    } else if (node instanceof HTMLTextAreaElement) copy.textContent = node.value
    else if (node instanceof HTMLOptionElement) copy.toggleAttribute('selected', node.selected)
    return copy
  }

  function serializeDocument() {
    var root = cloneForSave(document.documentElement)
    root.querySelectorAll('[data-artifact-runtime]').forEach(function (node) {
      node.remove()
    })
    root.querySelectorAll('script[data-artifact-src]').forEach(function (node) {
      var script = document.createElement('script')
      Array.from(node.attributes).forEach(function (attr) {
        if (attr.name !== 'data-artifact-src') script.setAttribute(attr.name, attr.value)
      })
      script.setAttribute('src', node.getAttribute('data-artifact-src'))
      node.replaceWith(script)
    })
    var doctype = document.doctype ? '<!doctype ' + document.doctype.name + '>' : '<!doctype html>'
    return doctype + '\n' + root.outerHTML
  }

  /* ---------------- eval (agent → document) ---------------- */

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  function isBareExpression(code) {
    var trimmed = code.trim()
    if (!trimmed || trimmed.indexOf('\n') !== -1 || trimmed.indexOf(';') !== -1) return false
    if (/^(return|const|let|var|if|for|while|do|switch|try|throw|function|class|async|await\s+[^(])\b/.test(trimmed)) return false
    return true
  }

  function runEval(code, timeoutMs) {
    var logs = []
    activeLogs = logs
    var body = isBareExpression(code) ? 'return (' + code + ')' : code
    var timer
    var timeout = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error('artifact eval timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
    })
    var run = Promise.resolve().then(function () {
      var fn = new AsyncFunction('ai', 'artifact', body)
      return fn(ai, ai)
    })
    return Promise.race([run, timeout])
      .then(
        function (value) {
          return { ok: true, value: serialize(value), logs: logs }
        },
        function (error) {
          return { ok: false, error: error instanceof Error ? error.name + ': ' + error.message : String(error), logs: logs }
        },
      )
      .finally(function () {
        clearTimeout(timer)
        if (activeLogs === logs) activeLogs = null
      })
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'api-result') {
      var waiter = pending.get(msg.callId)
      if (!waiter) return
      pending.delete(msg.callId)
      if (msg.ok) waiter.resolve(msg.value === undefined ? null : msg.value)
      else waiter.reject(new Error(msg.error || 'api call failed'))
      return
    }
    if (msg.kind === 'artifact-request') {
      var respond = function (result) {
        post({
          kind: 'artifact-response',
          requestId: msg.requestId,
          ok: result.ok,
          value: result.value,
          error: result.error,
          logs: result.logs,
        })
      }
      if (msg.op === 'ping') return respond({ ok: true, value: { ready: document.readyState, title: document.title } })
      if (msg.op === 'save') {
        try {
          return respond({ ok: true, value: serializeDocument() })
        } catch (e) {
          return respond({ ok: false, error: String(e && e.message ? e.message : e) })
        }
      }
      if (msg.op === 'eval') {
        runEval(String(msg.code || ''), Math.max(100, Number(msg.timeoutMs) || 15000)).then(respond)
        return
      }
      respond({ ok: false, error: 'unknown artifact request op ' + String(msg.op) })
    }
  })

  /* ---------------- local API surface ---------------- */

  var LOCAL = {
    __artifactRuntime: true,
    path: meta.path,
    url: meta.url,
    meta: meta,
    log: function () {
      console.log.apply(console, arguments)
    },
    save: function () {
      return call('artifact.save', [serializeDocument()])
    },
    invoke: function (prompt, opts) {
      if (typeof prompt !== 'string' || !prompt.trim()) return Promise.reject(new Error('ai.invoke(prompt): prompt is required'))
      return call('artifact.invoke', [prompt, opts || {}])
    },
    open: function (url) {
      return call('artifact.open', [String(url)])
    },
    state: {
      get: function (key) {
        return call('artifact.state.get', [String(key)])
      },
      set: function (key, value) {
        return call('artifact.state.set', [String(key), value === undefined ? null : value])
      },
      all: function () {
        return call('artifact.state.all', [])
      },
      clear: function () {
        return call('artifact.state.clear', [])
      },
    },
    waitFor: function (predicate, opts) {
      var timeoutMs = (opts && opts.timeoutMs) || 10000
      var intervalMs = (opts && opts.intervalMs) || 100
      var started = Date.now()
      var fn = typeof predicate === 'function' ? predicate : function () { return document.querySelector(String(predicate)) }
      return new Promise(function (resolve, reject) {
        var tick = function () {
          Promise.resolve()
            .then(fn)
            .then(function (value) {
              if (value) return resolve(value)
              if (Date.now() - started >= timeoutMs) {
                return reject(new Error('ai.waitFor: condition not met within ' + timeoutMs + 'ms'))
              }
              setTimeout(tick, intervalMs)
            })
            .catch(function (e) {
              if (Date.now() - started >= timeoutMs) return reject(e)
              setTimeout(tick, intervalMs)
            })
        }
        tick()
      })
    },
    loadScript: function (url) {
      url = String(url)
      if (loadedScripts.has(url)) return loadedScripts.get(url)
      var promise = call('artifact.script', [url]).then(function (source) {
        if (typeof source !== 'string') throw new Error('ai.loadScript: no source returned for ' + url)
        var script = document.createElement('script')
        script.setAttribute('data-artifact-src', url)
        script.textContent = source
        ;(document.head || document.documentElement).appendChild(script)
        return true
      })
      promise.catch(function () {
        loadedScripts.delete(url)
      })
      loadedScripts.set(url, promise)
      return promise
    },
    loadStyle: function (url) {
      return new Promise(function (resolve, reject) {
        var link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = String(url)
        link.onload = function () {
          resolve(true)
        }
        link.onerror = function () {
          reject(new Error('ai.loadStyle: failed to load ' + url))
        }
        ;(document.head || document.documentElement).appendChild(link)
      })
    },
    autosave: function (opts) {
      var debounceMs = (opts && opts.debounceMs) || 800
      var timer = null
      var saving = false
      var dirty = false
      var flush = function () {
        timer = null
        if (saving) {
          dirty = true
          return
        }
        saving = true
        LOCAL.save()
          .catch(function (e) {
            console.error('autosave failed:', e && e.message ? e.message : e)
          })
          .finally(function () {
            saving = false
            if (dirty) {
              dirty = false
              schedule()
            }
          })
      }
      var schedule = function () {
        if (timer) clearTimeout(timer)
        timer = setTimeout(flush, debounceMs)
      }
      var observer = new MutationObserver(schedule)
      var start = function () {
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
      }
      if (document.body) start()
      else document.addEventListener('DOMContentLoaded', start, { once: true })
      document.addEventListener('input', schedule, true)
      document.addEventListener('change', schedule, true)
      return function stop() {
        observer.disconnect()
        document.removeEventListener('input', schedule, true)
        document.removeEventListener('change', schedule, true)
        if (timer) clearTimeout(timer)
      }
    },
  }

  var ai = makeNode('')
  Object.defineProperty(window, 'ai', { value: ai, configurable: true, writable: true })
  Object.defineProperty(window, 'artifact', { value: ai, configurable: true, writable: true })

  var announce = function () {
    post({ kind: 'artifact-ready' })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce, { once: true })
  else announce()
})()
