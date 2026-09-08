class WeatherClient {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; this.cities = new Map() }
  async json(url, signal) {
    const response = await this.fetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(8000)]) })
    if (!response.ok) throw new Error('呜，暂时连不上天气服务，等一小会儿再问小栖吧～')
    return response.json()
  }
  async search(query, signal) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 60) throw new Error('请输入至少两个字的城市名称。')
    const data = await this.json(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query.trim(), count: '5', language: 'zh', format: 'json' })}`, signal)
    const cities = (data.results || []).filter(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && typeof c.name === 'string')
      .map(c => ({ id: String(c.id), name: c.name, label: [...new Set([c.name, c.admin1, c.country].filter(Boolean))].join(' · '), latitude: c.latitude, longitude: c.longitude }))
    for (const city of cities) this.cities.set(city.id, city)
    if (this.cities.size > 100) this.cities = new Map(cities.map(c => [c.id, c]))
    return cities
  }
  async forecast(city, signal) {
    const data = await this.json(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ latitude: String(city.latitude), longitude: String(city.longitude), daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max', timezone: 'auto', forecast_days: '1' })}`, signal)
    const daily = data.daily, low = daily?.temperature_2m_min?.[0], high = daily?.temperature_2m_max?.[0], code = daily?.weather_code?.[0], rain = daily?.precipitation_probability_max?.[0]
    if (![low, high, code].every(Number.isFinite) || typeof daily?.time?.[0] !== 'string') throw new Error('呜，这次查到的天气数据不完整，等一小会儿再问小栖吧～')
    const description = code === 0 ? '晴' : code <= 3 ? '多云' : [45, 48].includes(code) ? '有雾' : code >= 95 ? '雷雨' : [71, 73, 75, 77, 85, 86].includes(code) ? '有雪' : code >= 51 && code <= 82 ? '有雨' : '天气有变化'
    // All weather entry points share this voice; facts still come directly from the forecast.
    const tip = description === '雷雨' ? '带好小伞，打雷时去室内躲一躲喵～'
      : description === '有雪' ? '把自己裹暖一点，走路慢慢来喵～'
      : description === '有雨' || Number.isFinite(rain) && rain >= 50 ? '出门记得带伞，别被雨滴偷袭喵～'
      : description === '有雾' ? '雾蒙蒙的，出门慢一点，小栖等你回来～'
      : low <= 10 ? '出门多穿一点，别把自己冻成小冰块喵～'
      : high >= 30 ? '天气热乎乎，记得喝水，别把自己热蔫啦～'
      : description === '晴' ? '太阳来串门啦，带上好心情出门吧～'
      : description === '多云' ? '云朵在天上散步，小栖在这里陪你～'
      : '小栖把天气带到啦，出门留意一下天空喵～'
    const [, month, day] = daily.time[0].split('-').map(Number)
    return { date: daily.time[0], fetchedAt: Date.now(), text: `小栖查到啦～${city.name}${month}月${day}日${description === '晴' ? '是晴天' : description}，${Math.round(low)}–${Math.round(high)}℃。${tip}（Open-Meteo）` }
  }
}
module.exports = { WeatherClient }
