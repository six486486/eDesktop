const REACTION_COOLDOWN_MS = 8000
const REACTION_PROMPT = `你的回复格式是 JSON：先写 reply，再写 action。reply 只放对用户说的自然中文，不写动作、角色标签或输出格式。
action 从以下四项中选一项，依据当前用户意图和你实际回复的内容，结合前文理解指代、反话和改口：
happy：用户真心夸奖你、感谢你，或分享自己的好消息。
focus：用户想让你解释问题、讨论技术或一起想办法，包括接着前文继续解释。
rest：用户结束聊天、告别、准备睡觉，或明确叫你趴下。
none：普通闲聊、安慰、吐槽、反话、翻译引用或不确定时。友好接话不等于 happy；累了但想继续聊不等于 rest。最新改口优先。
例如：用户“谢谢你一直陪我” → {"reply":"能陪着你，我也很开心。","action":"happy"}
用户“明天接着聊” → {"reply":"好，明天见。","action":"rest"}
前面用户在抱怨你没听懂，用户“你真聪明呢” → {"reply":"是我没理解好你的意思，抱歉。","action":"none"}
用户“先别讲道理了，听我吐槽就好” → {"reply":"好，我听着。","action":"none"}`

function reactionDecision(envelope, userText, lastReaction, now = Date.now()) {
  const source = envelope.state === 'model' ? 'model' : envelope.state === 'missing' ? 'rule' : 'none'
  const proposed = source === 'model' ? envelope.kind : source === 'rule' ? reactionForMessage(userText) : null
  const plain = userText.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"/g, '')
  let reason = proposed ? 'accepted' : envelope.state === 'invalid' ? 'invalid-action' : 'neutral'
  if (proposed && !['happy', 'focus', 'rest'].includes(proposed)) reason = 'invalid-action'
  else if (proposed && /(?:别|不要|不用|不必)(?:再|总是?|一直)?(?:乱动|动来动去|做动作|表演|蹦|摇尾巴|动(?:了|啦|[，。！]|$))/.test(plain)) reason = 'user-suppressed'
  else if (proposed && /^(?:请|帮我)?(?:把)?.{0,30}翻译|^(?:“|「|"|`)/.test(userText.trim())) reason = 'quoted-or-task'
  else if (proposed === 'rest') {
    const againstRest = /(?:不想|不要|别|还不)(?:现在|再|去)?(?:睡|休息|趴)/.test(plain)
    const keepChatting = /(?:陪我|和你|跟你).{0,8}(?:聊|待会)|(?:^|[，。！？])\s*(?:我不去忙了|继续聊|接着聊)/.test(plain)
    const explicitPose = /^(?:小栖[，,]?\s*)?(?:请|你)?(?:先|可以)?趴下/.test(plain.trim())
    if (againstRest || (keepChatting && !explicitPose)) reason = 'still-chatting'
  }
  if (reason === 'accepted' && proposed !== 'rest' && lastReaction?.kind === proposed && now - lastReaction.startedAt < REACTION_COOLDOWN_MS) reason = 'cooldown'
  return { proposed, kind: reason === 'accepted' ? proposed : null, source, reason }
}

// Conservative fallback if a model sends plain text instead of an action proposal.
function reactionForMessage(message) {
  const plain = message.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, '')
  const clauses = plain.split(/[，,。.!！\n；;]/).map((part) => part.trim()).filter(Boolean)
  const statements = clauses.filter((part) => !/[?？]|(?:如果|假如|例如|比如|是不是|是否|不是|不要|不用|不必|不想|不去|不打算|不能|还没|别|开玩笑)|吗[呀啊]?$/.test(part))
  const rest = /^(?:那|好|嗯|行)?我?(?:就|先|要|准备|得)?(?:去忙|忙去了|去睡|睡觉|去休息|休息一下|安静一会儿)(?:了|啦|咯|吧|会儿|一会儿|一下)?[呀啊哦哈~～]*$/
  const goodbye = /^(?:回头聊|再见|拜拜|晚安|先撤了)[呀啊啦哦~～]*$/
  const needRest = /^我(?:有点累|累了|困了)?(?:想|要|先)(?:休息(?:一下|一会儿)?|睡觉|安静(?:一下|一会儿)?)[了啦呀啊哦~～]*$/
  if (statements.some((part) => rest.test(part) || goodbye.test(part) || needRest.test(part))) return 'rest'
  const focus = /^(?:(?:请|我们|咱们|一起|帮我|我想|能不能|可以|能|来|先|认真|仔细)\s*)*(?:讨论|解释|分析|研究|想一想|想想|聊聊这个问题)/
  if (clauses.some((part) => focus.test(part))) return 'focus'
  const praise = /^(?:你|小栖)(?:真的?|好|很|太|超|非常|特别|挺|这么|那么|是|个|只|有点|也){0,4}(?:可爱|棒|聪明|贴心|厉害|温柔|乖)(?:极了|了|呀|啊|呢|啦|哦|~|～)*$/
  const thanks = /^(?:真棒|好可爱|太棒了|干得漂亮|谢谢(?:你|小栖)?|多谢(?:你|小栖)?)[呀啊啦呢哦~～]*$/
  const affection = /^我(?:很|真|真的|好|特别|也)*喜欢(?:你|小栖)[呀啊啦呢哦~～]*$/
  if (statements.some((part) => praise.test(part) || thanks.test(part) || affection.test(part))) return 'happy'
  return null
}

module.exports = { reactionForMessage, REACTION_PROMPT, REACTION_COOLDOWN_MS, reactionDecision }
