const ACTIONS = { none: null, happy: 'happy', focus: 'focus', rest: 'rest' }
const CHAT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'action'],
  properties: { reply: { type: 'string' }, action: { type: 'string', enum: Object.keys(ACTIONS) } },
}

// Decode only complete JSON string units. An unfinished escape/surrogate pair is held,
// so neither protocol syntax nor a replacement character flashes during streaming.
function readString(raw, start) {
  if (raw[start] !== '"') return null
  let end = start + 1
  while (end < raw.length) {
    if (raw[end] === '"') return { value: JSON.parse(raw.slice(start, end + 1)), end: end + 1, complete: true }
    if (raw[end] === '\\') {
      const size = raw[end + 1] === 'u' ? 6 : 2
      if (end + size > raw.length) break
      end += size
    } else end += 1
  }
  let value = JSON.parse(raw.slice(start, end) + '"')
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1)
  return { value, end, complete: false }
}

function readChatEnvelope(raw, final = false) {
  const input = raw.trimStart()
  if (!input) return { text: '', state: 'pending', kind: null }
  // Plain text remains usable with models/transports that ignore structured output.
  if (!input.startsWith('{')) return { text: raw, state: 'missing', kind: null }
  let index = 1, text = '', duplicate = false
  const seen = new Set()
  const whitespace = () => { while (/\s/.test(input[index] ?? '') && index < input.length) index += 1 }
  while (index < input.length) {
    whitespace()
    const key = readString(input, index)
    if (!key?.complete) break
    index = key.end
    whitespace()
    if (input[index++] !== ':') break
    whitespace()
    const value = readString(input, index)
    if (!value) break
    if (seen.has(key.value)) duplicate = true
    if (key.value === 'reply' && !seen.has(key.value)) text = value.value
    if (!value.complete) break
    seen.add(key.value)
    index = value.end
    whitespace()
    if (input[index++] !== ',') break
  }
  if (!final) return { text, state: 'pending', kind: null }
  // Action metadata is optional to the experience. If generation hits its token
  // limit after readable speech, retain that speech and decline the gesture.
  let parsed
  try { parsed = JSON.parse(input) } catch { return { text, state: 'invalid', kind: null } }
  if (duplicate || typeof parsed.reply !== 'string' || parsed.reply !== text) return { text, state: 'invalid', kind: null }
  const valid = Object.keys(parsed).length === 2 && seen.has('action') && typeof parsed.action === 'string' && Object.hasOwn(ACTIONS, parsed.action)
  return { text, state: valid ? 'model' : 'invalid', kind: valid ? ACTIONS[parsed.action] : null }
}

module.exports = { CHAT_SCHEMA, readChatEnvelope, readString }
