/**
 * Key table + modifier math for Input.dispatchKeyEvent.
 *
 * CDP modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift.
 *
 * The key table maps a logical key name to
 * `[windowsVirtualKeyCode, code, text]`. `text` is only set for keys that
 * produce printable/insertable characters (Enter -> "\r", Tab -> "\t",
 * Space -> " "); navigation/edit keys leave it empty so no `char` event is
 * emitted for them.
 */

/** [windowsVirtualKeyCode, code (DOM UIEvents), text] */
export type KeyDef = readonly [number, string, string]

/** Named keys we support in pressKey / type-submit. Values are lowercased on lookup. */
export const KEY_TABLE: Readonly<Record<string, KeyDef>> = {
  enter: [13, 'Enter', '\r'],
  tab: [9, 'Tab', '\t'],
  backspace: [8, 'Backspace', ''],
  escape: [27, 'Escape', ''],
  esc: [27, 'Escape', ''],
  delete: [46, 'Delete', ''],
  del: [46, 'Delete', ''],
  space: [32, 'Space', ' '],
  arrowleft: [37, 'ArrowLeft', ''],
  arrowup: [38, 'ArrowUp', ''],
  arrowright: [39, 'ArrowRight', ''],
  arrowdown: [40, 'ArrowDown', ''],
  left: [37, 'ArrowLeft', ''],
  up: [38, 'ArrowUp', ''],
  right: [39, 'ArrowRight', ''],
  down: [40, 'ArrowDown', ''],
  home: [36, 'Home', ''],
  end: [35, 'End', ''],
  pageup: [33, 'PageUp', ''],
  pagedown: [34, 'PageDown', ''],
}

/** CDP modifier bit values. */
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const

/** A single key event's parameters as passed to Input.dispatchKeyEvent. */
export interface KeyEventParams {
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  /** Present only when a printable character is produced. */
  text?: string
  modifiers: number
}

export interface ParsedCombo {
  /** The base (non-modifier) key token, e.g. "a", "enter", "arrowdown". */
  baseKey: string
  /** Modifier bitfield (1=Alt 2=Ctrl 4=Meta 8=Shift). */
  modifiers: number
}

/** Map a modifier token to its bit, or 0 if not a modifier. */
function modifierBit(token: string): number {
  switch (token) {
    case 'alt':
    case 'option':
    case 'opt':
      return MOD.Alt
    case 'ctrl':
    case 'control':
      return MOD.Ctrl
    case 'meta':
    case 'cmd':
    case 'command':
    case 'super':
    case 'win':
      return MOD.Meta
    case 'shift':
      return MOD.Shift
    default:
      return 0
  }
}

/**
 * Parse a combo like "ctrl+a", "cmd+shift+k", "Enter", "ArrowDown" into a base
 * key + modifier bitfield. The last non-modifier token is the base key; any
 * modifier tokens contribute to the bitfield. Case-insensitive.
 */
export function parseCombo(input: string): ParsedCombo {
  const raw = input.trim()
  if (raw === '') throw new Error('pressKey: empty key')
  // A lone "+" should be treated as the literal key, not a separator.
  const tokens = raw === '+' ? ['+'] : raw.split('+').map((t) => t.trim()).filter((t) => t.length > 0)
  let modifiers = 0
  let baseKey: string | undefined
  for (const tok of tokens) {
    const bit = modifierBit(tok.toLowerCase())
    if (bit !== 0) {
      modifiers |= bit
    } else {
      // The base key is the last non-modifier token seen.
      baseKey = tok
    }
  }
  if (baseKey === undefined) {
    // Combo was all modifiers (e.g. "shift"); treat the literal input as base.
    baseKey = raw
  }
  return { baseKey, modifiers }
}

/**
 * Resolve a base key token to CDP key event fields. Named keys come from
 * KEY_TABLE; a single printable character maps to itself (uppercased vkey).
 */
export function resolveKey(baseKey: string): { key: string; code: string; vk: number; text: string } {
  const lower = baseKey.toLowerCase()
  const def = KEY_TABLE[lower]
  if (def) {
    const [vk, code, text] = def
    return { key: keyNameForCode(code), code, vk, text }
  }
  if (baseKey.length === 1) {
    const ch = baseKey
    const upper = ch.toUpperCase()
    const cc = upper.charCodeAt(0)
    // Letter -> KeyA..KeyZ, digit -> Digit0..Digit9, otherwise a generic code.
    let code: string
    let vk: number
    if (cc >= 65 && cc <= 90) {
      code = `Key${upper}`
      vk = cc
    } else if (cc >= 48 && cc <= 57) {
      code = `Digit${upper}`
      vk = cc
    } else {
      code = ''
      vk = upper.charCodeAt(0)
    }
    return { key: ch, code, vk, text: ch }
  }
  throw new Error(`pressKey: unknown key "${baseKey}"`)
}

/** DOM `key` value for a named `code` (Enter/Tab/etc. use the code as the key). */
function keyNameForCode(code: string): string {
  if (code === 'Space') return ' '
  return code
}

/**
 * Build the ordered list of Input.dispatchKeyEvent payloads for a single key
 * press: keyDown/rawKeyDown, optional char, keyUp.
 *
 * CRITICAL: when Ctrl/Alt/Meta is held (a shortcut like ctrl+a), we emit only
 * rawKeyDown + keyUp and NEVER the `char` event — otherwise Chrome treats the
 * key as printable text instead of a shortcut.
 */
export function keyEventSequence(baseKey: string, modifiers: number): Array<{ type: 'keyDown' | 'rawKeyDown' | 'char' | 'keyUp' } & KeyEventParams> {
  const { key, code, vk, text } = resolveKey(baseKey)
  // Shift is fine; only Alt/Ctrl/Meta suppress the char event.
  const hasNonShiftMod = (modifiers & (MOD.Alt | MOD.Ctrl | MOD.Meta)) !== 0
  const printable = text.length > 0 && !hasNonShiftMod

  const base: KeyEventParams = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  }

  const out: Array<{ type: 'keyDown' | 'rawKeyDown' | 'char' | 'keyUp' } & KeyEventParams> = []
  if (hasNonShiftMod) {
    // Shortcut path: rawKeyDown (no text) then keyUp, no char.
    out.push({ type: 'rawKeyDown', ...base })
    out.push({ type: 'keyUp', ...base })
    return out
  }

  // Normal path: keyDown for key listeners, char for insertion, keyUp.
  // Do not put `text` on keyDown for printable input. Chrome may insert both
  // keyDown.text and char.text, producing doubled characters.
  out.push({ type: 'keyDown', ...base })
  if (printable) {
    out.push({ type: 'char', ...base, text })
  }
  out.push({ type: 'keyUp', ...base })
  return out
}
