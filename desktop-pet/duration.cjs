// Extract complete quantities, never just the "half an hour" inside "one and a half".
const numeral = '[+-]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百点]+)'
const minuteSource = `${numeral}\\s*分(?:钟)?`
const hourSource = `(?:${numeral}\\s*(?:个\\s*)?半|半\\s*个?|${numeral}\\s*个?)\\s*(?:小时|钟头)`
const durationSource = `(?:${hourSource}(?:\\s*(?:又|零|加)?\\s*${minuteSource})?|${minuteSource}|${numeral}\\s*刻钟)`

function number(text) {
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const decimal = text.match(/^([零〇一二两三四五六七八九十百]+)点([零〇一二两三四五六七八九]+)$/)
  if (decimal) return number(decimal[1]) + number(decimal[2]) / 10 ** decimal[2].length
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(text) || /百[一二两三四五六七八九]$/.test(text)) return NaN
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (!/[十百]/.test(text)) return Number([...text].map(c => digits[c]).join(''))
  let total = 0, digit = 0
  for (const c of text) {
    if (c === '十' || c === '百') { total += (digit || 1) * (c === '十' ? 10 : 100); digit = 0 }
    else digit = digits[c]
  }
  return total + digit
}
function durationMinutes(phrase) {
  const s = phrase.replace(/\s/g, '')
  const hours = s.match(/^(.+?)(?:小时|钟头)(?:(?:又|零|加)?(.+?)分(?:钟)?)?$/)
  if (hours) {
    const amount = hours[1].replace(/个/g, '')
    const h = amount === '半' ? 0.5 : amount.endsWith('半') ? number(amount.slice(0, -1)) + 0.5 : number(amount)
    return h * 60 + (hours[2] ? number(hours[2]) : 0)
  }
  const minutes = s.match(/^(.+?)分(?:钟)?$/)
  if (minutes) return number(minutes[1])
  const quarter = s.match(/^(.+?)刻钟$/)
  return quarter ? number(quarter[1]) * 15 : NaN
}
function explicitMinutes(text) {
  const matches = [...text.matchAll(new RegExp(durationSource, 'g'))]
  if (matches.length !== 1) return null // The model must resolve alternatives or multiple activities.
  const match = matches[0], before = text.slice(0, match.index).trimEnd()
  const invalid = /[到至~～负]$/.test(before)
  return { minutes: invalid ? NaN : durationMinutes(match[0]), evidence: match[0] }
}
module.exports = { number, durationSource, durationMinutes, explicitMinutes }
