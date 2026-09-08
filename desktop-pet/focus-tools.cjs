const { CHAT_SCHEMA, readString } = require('./reply-format.cjs')
const { explicitMinutes, durationSource } = require('./duration.cjs')

const TOOLS = ['none', 'focus.start', 'focus.stop', 'focus.status']
const FOCUS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'response'],
  properties: {
    decision: {
      type: 'object', additionalProperties: false, required: ['name', 'minutes'],
      properties: { name: { type: 'string', enum: TOOLS }, minutes: { type: 'integer' } },
    },
    response: {
      type: 'object', additionalProperties: false, required: ['text', 'visual'],
      properties: { text: { type: 'string', minLength: 1 }, visual: CHAT_SCHEMA.properties.action },
    },
  },
}

// Explicit materials are not commands. Ordinary first-person statements remain
// available to semantic interpretation under the agreed work-start habit.
function focusPermission(text) {
  const input = text.trim().replace(/^小栖[，,：:]?\s*/, '')
  if (/^(?:请|帮我|麻烦你)?\s*(?:把.+?)?(?:翻译|解释|分析|改写|润色|复述)|^[“「"`]|^(?:例如|比如|假设|假如|举个例子|如果)/.test(input)) return 'material'
  if (/^(?:你)?(?:能不能|会不会|是否能|是否可以|能|可以|会|支持)(?:够)?(?:帮我|给我)?(?:计时|开番茄钟|用番茄钟)(?:吗|么|[？?]|$)/.test(input)) return 'capability-question'
  // Focus can act now, but cannot schedule a future start. Keep that request in
  // conversation instead of silently executing it early.
  const future = new RegExp(`(?:明天|后天|大后天|下周|下个月|今晚|明早|明晚|稍后|待会儿?|一会儿后|${durationSource}\\s*(?:之后|后)|\\d+\\s*天后|(?:上午|下午|晚上|凌晨)?\\s*\\d{1,2}\\s*(?:点|[:：]))`)
  const focusAction = /(?:开始|开启|打开|设|定|计时|专注|番茄钟|工作|学习|写|画|做)/
  if (future.test(input) && focusAction.test(input)) return 'deferred'
  return 'available'
}
function focusSchema(permission, context) {
  const active = context?.state && context.state !== 'idle'
  if (permission === 'available' && !active) return FOCUS_SCHEMA
  return { ...FOCUS_SCHEMA, properties: { ...FOCUS_SCHEMA.properties, decision: {
    ...FOCUS_SCHEMA.properties.decision,
    properties: {
      name: { type: 'string', enum: permission === 'available' ? ['none', 'focus.stop', 'focus.status'] : ['none'] },
      minutes: { type: 'integer', enum: [0] },
    },
  } } }
}

const FOCUS_PROMPT = `输出 JSON：{"decision":{"name":"none|focus.start|focus.stop|focus.status","minutes":整数},"response":{"text":"正文","visual":"none|happy|focus|rest"}}。
用户自己现在要进入一段有明确目标的专注活动，或明确要求计时时选 focus.start；没说时长填 0，程序采用 defaultMinutes。询问剩余时间或运行状态选 focus.status。明确停止当前计时选 focus.stop。其他情况选 none。
未来计划、否定、尚未准备好、娱乐休息、第三方、假设、转述、翻译和能力询问都不执行。结合最近对话理解“开始吧”等接话；用户明确这次不计时，直到改口前都选 none。
response.text 必须是自然回应；工具是否成功由程序返回，不能提前声称完成。仅支持立即开始 1–240 个整数分钟、停止和查询；不支持预约、秒级或修改运行中的计时。`

const ACTIVE_FOCUS_PROMPT = `已有番茄钟在运行。输出 JSON：{"decision":{"name":"none|focus.stop|focus.status","minutes":0},"response":{"text":"正文","visual":"none|happy|focus|rest"}}。
明确结束工作、停止倒数、改口说先别开始，或改为聊天休息选 focus.stop；询问剩余时间、运行状态或要求重开选 focus.status；明确继续当前活动、普通聊天、抱怨、告别聊天窗口、未来计划、引用或假设选 none。response.text 必须自然且非空，不能声称未实际完成的操作。`

function focusPrompt(context) { return context?.state && context.state !== 'idle' ? ACTIVE_FOCUS_PROMPT : FOCUS_PROMPT }

// Parse the small protocol incrementally. Ollama emits schema properties in
// lexical order, so the complete decision arrives before response.text. This
// restores normal chat streaming while tool proposals still wait for a valid
// final document and the transport's done marker.
function readObject(input, start) {
  const fields = new Map()
  if (input[start] !== '{') return { fields, complete: false, invalid: true, duplicate: false, end: start }
  let index = start + 1, duplicate = false, invalid = false
  const space = () => { while (index < input.length && /\s/.test(input[index])) index++ }
  while (index < input.length) {
    space()
    if (input[index] === '}') return { fields, complete: true, invalid, duplicate, end: index + 1 }
    const key = readString(input, index)
    if (!key?.complete) return { fields, complete: false, invalid, duplicate, end: index }
    index = key.end
    space()
    if (input[index] !== ':') return { fields, complete: false, invalid: index < input.length || invalid, duplicate, end: index }
    index++
    space()
    let value
    if (input[index] === '"') {
      const string = readString(input, index)
      if (!string) return { fields, complete: false, invalid: true, duplicate, end: index }
      value = { type: 'string', value: string.value, complete: string.complete, end: string.end }
    } else if (input[index] === '{') {
      const object = readObject(input, index)
      value = { type: 'object', value: object, complete: object.complete, end: object.end }
    } else if (input[index] === '[') {
      const array = readArray(input, index)
      value = { type: 'array', value: array, complete: array.complete, end: array.end }
    } else {
      const number = input.slice(index).match(/^-?\d+/)
      if (!number) return { fields, complete: false, invalid: index < input.length || invalid, duplicate, end: index }
      const after = index + number[0].length
      const rest = input.slice(after).match(/^\s*([,}])/)
      value = { type: 'number', value: Number(number[0]), complete: Boolean(rest), end: after }
    }
    if (fields.has(key.value)) duplicate = true
    else fields.set(key.value, value)
    if (!value.complete) return { fields, complete: false, invalid: invalid || value.value?.invalid === true, duplicate: duplicate || value.value?.duplicate === true, end: value.end }
    invalid ||= value.value?.invalid === true
    duplicate ||= value.value?.duplicate === true
    index = value.end
    space()
    if (input[index] === ',') { index++; continue }
    if (input[index] === '}') return { fields, complete: true, invalid, duplicate, end: index + 1 }
    return { fields, complete: false, invalid: index < input.length || invalid, duplicate, end: index }
  }
  return { fields, complete: false, invalid, duplicate, end: index }
}

function readArray(input, start) {
  const items = []; let index = start + 1, duplicate = false
  while (index < input.length) {
    while (/\s/.test(input[index] || '') && index < input.length) index++
    if (input[index] === ']') return { items, complete: true, end: index + 1, duplicate }
    let item
    if (input[index] === '{') {
      const value = readObject(input, index); item = { type: 'object', value, complete: value.complete, end: value.end }
    } else if (input[index] === '"') {
      const value = readString(input, index); item = value && { type: 'string', ...value }
    }
    if (!item || !item.complete || item.value?.invalid) return { items, complete: false, invalid: !item || item.value?.invalid, end: index }
    duplicate ||= item.value?.duplicate === true; items.push(item); index = item.end
    while (/\s/.test(input[index] || '') && index < input.length) index++
    if (input[index] === ']') return { items, complete: true, end: index + 1, duplicate }
    if (input[index] !== ',') return { items, complete: false, invalid: index < input.length, end: index }
    index++
    if (/^\s*\]/.test(input.slice(index))) return { items, complete: false, invalid: true, end: index }
  }
  return { items, complete: false, end: index }
}

function exactFields(object, names) {
  return object?.complete && !object.invalid && !object.duplicate
    && object.fields.size === names.length && names.every(name => object.fields.has(name))
}

function scalar(object, name, type) {
  const field = object?.fields.get(name)
  return field?.type === type && field.complete ? field.value : undefined
}

function readFocusEnvelope(raw, final = false) {
  const input = raw.trimStart()
  if (!input) return { text: '', state: final ? 'invalid' : 'pending', kind: null }
  const document = readObject(input, 0)
  const decisionField = document.fields.get('decision')
  const decision = decisionField?.type === 'object' ? decisionField.value : null
  const responseField = document.fields.get('response')
  const response = responseField?.type === 'object' ? responseField.value : null
  const name = scalar(decision, 'name', 'string')
  const minutes = scalar(decision, 'minutes', 'number')
  const decisionReady = exactFields(decision, ['name', 'minutes'])
    && name === 'none' && minutes === 0
  const textField = response?.fields.get('text')
  const text = decisionReady && textField?.type === 'string' ? textField.value : ''
  if (!final) return { text, state: 'pending', kind: null }

  let parsed
  try { parsed = JSON.parse(input) } catch {}
  const responseText = scalar(response, 'text', 'string')
  const visual = scalar(response, 'visual', 'string')
  const valid = parsed && document.complete && input.slice(document.end).trim() === ''
    && exactFields(document, ['decision', 'response'])
    && exactFields(decision, ['name', 'minutes']) && exactFields(response, ['text', 'visual'])
    && TOOLS.includes(name) && Number.isSafeInteger(minutes)
    && typeof responseText === 'string' && responseText.length > 0
    && CHAT_SCHEMA.properties.action.enum.includes(visual)
    && (name === 'focus.start' || minutes === 0)
  if (!valid) return { text: '', state: 'invalid', kind: null }
  if (name === 'none') {
    return { text: responseText, state: 'model', kind: visual === 'none' ? null : visual, tool: null }
  }
  return { text: '', state: 'tool', kind: null, tool: { name, minutes } }
}

function remainingText(seconds) {
  const whole = Math.max(0, Math.ceil(seconds))
  return whole >= 60 ? `${Math.floor(whole / 60)} 分${whole % 60 ? `${whole % 60} 秒` : '钟'}` : `${whole} 秒`
}
function focusReply(result) {
  const left = remainingText(result.remainingSeconds || 0)
  switch (result.status) {
    case 'started': return `${result.minutes} 分钟开始啦，小栖陪你，一起慢慢来～`
    case 'stopped': return '计时停下啦，按你的节奏来，小栖在呢～'
    case 'running': return `${result.mode === 'break' ? '休息' : '专注'}还剩 ${left}，小栖帮你看着时间呢～`
    case 'already-running': return `这段${result.mode === 'break' ? '休息' : '专注'}还在计时，剩 ${left}，接着陪你呀～`
    case 'idle': return '番茄钟正歇着呢，想专注时叫小栖就好～'
    case 'ambiguous': return '现在有多个番茄钟在计时，请先在组件里选定要操作的那一个。'
    case 'invalid-arguments': return '专注时长需要是 1 到 240 的整数分钟，这次没有开始计时。'
    case 'cancelled': return '这次计时操作已取消。'
    default: return '这次没能完成计时操作，请检查番茄钟后再试。'
  }
}
module.exports = { FOCUS_SCHEMA, FOCUS_PROMPT, focusPrompt, readFocusEnvelope, focusReply, focusPermission, focusSchema, explicitMinutes, readObject, exactFields, scalar }
