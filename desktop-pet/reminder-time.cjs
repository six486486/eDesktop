const { number, durationSource, durationMinutes } = require('./duration.cjs')
const pad = value => String(value).padStart(2, '0')
const dayKey = value => { const d = new Date(value); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const clockTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
function atTime(day, time) {
  if (!clockTime(time)) return NaN
  const d = new Date(day), [h, m] = time.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}
const clockSource = '(?:(?:今天|明天|后天))?(?:凌晨|早上|早晨|上午|中午|下午|晚上|今晚|明早|明晚)?[0-9零〇一二两三四五六七八九十]+(?:[:：][0-9]{2}|点(?:半|一刻|三刻|[0-9零〇一二两三四五六七八九十]+分?)?)'
// The model interprets the missing half-day from meaning/history. Only the runtime
// computes dates; an explicit day/period always wins over a conflicting proposal.
function parseWhen(phrase, now, timeOfDay = 'auto') {
  if (typeof phrase !== 'string' || !['auto', 'am', 'pm'].includes(timeOfDay)) return NaN
  const s = phrase.replace(/\s/g, '').replace(/之后$/, '后')
  const relative = s.match(new RegExp(`^(?:再过|过|再)?(${durationSource})(?:后)?$`))
  if (relative && (s.endsWith('后') || /^(再过|过|再)/.test(s))) {
    const mins = durationMinutes(relative[1])
    return Number.isInteger(mins) && mins >= 1 && mins <= 10080 ? now + mins * 60000 : NaN
  }
  const exact = s.match(/^(?:(今天|明天|后天))?(凌晨|早上|早晨|上午|中午|下午|晚上|今晚|明早|明晚)?(\d{1,2}|[零〇一二两三四五六七八九十]+)(?:[:：](\d{2})|点(?:(半|一刻|三刻)|(\d{1,2}|[零〇一二三四五六七八九十]+)分?)?)$/)
  if (!exact) return NaN
  let h = number(exact[3]), m = exact[4] ? Number(exact[4]) : exact[5] ? ({ 半: 30, 一刻: 15, 三刻: 45 })[exact[5]] : exact[6] ? number(exact[6]) : 0
  const period = exact[2] || ''
  if (h > 23 || m > 59 || !Number.isInteger(h) || !Number.isInteger(m)) return NaN
  if (/凌晨|早上|早晨|上午|明早/.test(period) && h > 12) return NaN
  if (/下午|晚上|今晚|明晚/.test(period) && h < 12) h += 12
  if (period === '中午' && h < 11) h += 12
  if (period === '凌晨' && h === 12) h = 0
  const fixedClock = Boolean(period) || h === 0 || h > 12
  if (fixedClock && timeOfDay !== 'auto' && (h < 12 ? 'am' : 'pm') !== timeOfDay) return NaN
  const hours = fixedClock ? [h] : timeOfDay !== 'auto' ? [h % 12 + (timeOfDay === 'pm' ? 12 : 0)]
    : exact[1] ? [h] : [h % 12, h % 12 + 12]
  const offset = exact[1] === '后天' ? 2 : exact[1] === '明天' || /明早|明晚/.test(period) ? 1 : 0
  const fixedDay = Boolean(exact[1]) || /今晚|明早|明晚/.test(period)
  const candidates = (fixedDay ? [offset] : [0, 1]).flatMap(days => hours.map(hour => {
    const day = new Date(now); day.setDate(day.getDate() + days); day.setHours(hour, m, 0, 0)
    return day.getTime()
  })).filter(at => at > now)
  return candidates.length ? Math.min(...candidates) : NaN
}
const displayWhen = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
function clockCandidates(phrase) {
  if (!new RegExp(`^${clockSource}$`).test(phrase)) return []
  const anchor = new Date(2000, 0, 1).getTime()
  return [...new Set(['auto', 'am', 'pm'].map(hint => parseWhen(phrase, anchor, hint)).filter(Number.isFinite)
    .map(at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }))]
}
function conflictingTimeContext(text, phrase, now, at) {
  // A short extracted clock must not silently drop a date/period elsewhere in the
  // same request. Conflicting cross-clause evidence needs clarification, not a guess.
  if (!new RegExp(`^${clockSource}$`).test(phrase) || /今天|明天|后天|今晚|明早|明晚/.test(phrase)) return null
  const clues = [...new Set([...text.matchAll(/(?:今天|明天|后天)(?:凌晨|早上|早晨|上午|中午|下午|晚上)?/g)].map(m => m[0]))]
  if (clues.length !== 1) return null
  const clue = clues[0], expected = new Date(now), actual = new Date(at)
  expected.setDate(expected.getDate() + (clue.startsWith('明天') ? 1 : clue.startsWith('后天') ? 2 : 0))
  if (dayKey(expected) !== dayKey(actual)) return clue
  if (/凌晨|早上|早晨|上午/.test(clue) && actual.getHours() >= 12 || /下午|晚上/.test(clue) && actual.getHours() < 12) return clue
  return null
}
function timePhrases(text) {
  const pattern = new RegExp(`(?:再过|过|再)?${durationSource}(?:之后|后)|(?:再过|过|再)${durationSource}|${clockSource}`, 'g')
  return [...new Set([...text.matchAll(pattern)].map(m => m[0]))]
}
module.exports = { dayKey, clockTime, atTime, number, parseWhen, displayWhen, timePhrases, conflictingTimeContext, clockCandidates }
