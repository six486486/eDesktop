// Hold possible follow-up questions until the model finishes, so they never flash in the UI.
function shouldLimitFollowUps(preferences, userText) {
  return preferences.followUp === 'avoid' && !/问题|问句|面试题|问号|翻译|英文|英语|怎么问|如何问|引用|[“”「」`"]|(?:请|可以|希望你|让你|来|多|继续)(?:适当)?(?:问(?:问)?我|提问|追问)/.test(userText)
}

function withoutTrailingQuestions(raw, final = false) {
  const sentences = raw.match(/[^。！？!?]*[。！？!?]/g) || []
  let visible = '', pending = '', consumed = 0, hasStatement = false, questions = 0
  for (const sentence of sentences) {
    consumed += sentence.length
    if (hasStatement && /[？?]$/.test(sentence)) {
      pending += sentence
      questions += 1
    } else {
      // A later statement can answer a rhetorical question, so keep both.
      visible += pending + sentence
      pending = ''
      questions = 0
      if (!/[？?]$/.test(sentence) && sentence.trim()) hasStatement = true
    }
  }
  const tail = raw.slice(consumed)
  if (!hasStatement || (final && tail.trim())) return { text: visible + pending + tail, removed: 0 }
  return { text: visible, removed: final ? questions : 0 }
}

module.exports = { shouldLimitFollowUps, withoutTrailingQuestions }
