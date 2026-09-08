import type { DesktopWidget, PomodoroWidgetData, TodoWidgetData } from '../src/types'

export interface PetMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  interrupted?: boolean
}

export interface PetState {
  revision: number
  model: string
  enabled?: boolean
  reminderSoundEnabled?: boolean
  messages: PetMessage[]
  busy: boolean
  reply: string
  error: string
  reaction: { kind: 'happy' | 'focus' | 'rest'; startedAt: number; endsAt: number | null } | null
  focus?: { running: boolean; endsAt?: number }
  focusNotice?: { id: string; text: string; expiresAt: number } | null
  reminders?: PetReminders | null
  memory?: PetMemory | null
  chatPreferences?: ChatPreferences
  voice?: VoiceState
  voiceBubble?: { id: string; phase: VoiceState['phase'] | 'thinking' | 'reply' | 'error'; text?: string; transcript?: string } | null
  meowing?: boolean
}

export interface VoiceState {
  phase: 'idle' | 'downloading' | 'requesting' | 'recording' | 'transcribing'
  surface?: 'pet' | 'chat' | null
  level?: number
  startedAt?: number
  ready: boolean
  progress: number
  error: string
  trigger: number
  cancelRevision: number
  shortcut: string
  shortcutAvailable: boolean
  cancelShortcutAvailable?: boolean
}

export interface WeatherCity { id: string; name: string; label: string }
export interface ChatPreferences {
  preferredName: string | null
  replyLength: 'short' | 'normal' | 'detailed'
  followUp: 'avoid' | 'natural'
}
export interface PetMemoryEntry {
  id: string
  label: string
  at?: number
  updatedAt?: number
  source?: { text: string; at: number }
}
export interface PetMemory { revision: number; habits: PetMemoryEntry[]; operations: PetMemoryEntry[] }
export interface PetReminders {
  revision: number
  weather: { enabled: boolean; city: WeatherCity | null; time: string; repeat: 'daily' | 'weekdays' }
  todo: { enabled: boolean; leadMinutes: number }
  reminders: { id: string; text: string; at: number }[]
}
export interface ReminderSettingsInput {
  context: string
  weather: { enabled: boolean; cityId: string; time: string; repeat: 'daily' | 'weekdays' }
  todo: { enabled: boolean; leadMinutes: number }
}

export interface PetAPI {
  getState: () => Promise<PetState>
  listModels: () => Promise<string[]>
  setModel: (model: string) => Promise<void>
  setReminderSound: (enabled: boolean) => Promise<void>
  saveChatPreferences: (patch: Partial<ChatPreferences>) => Promise<ChatPreferences>
  send: (text: string) => Promise<void>
  reset: () => Promise<PetState>
  forgetMemories: (ids: string[]) => Promise<PetMemory>
  beginVoice: () => Promise<string | null>
  voiceRecording: (id: string) => Promise<boolean>
  transcribeVoice: (id: string, samples: Float32Array) => Promise<{ id: string; text: string } | null>
  cancelVoice: () => Promise<void>
  voiceLevel: (id: string, level: number) => void
  voiceError: (message: string) => void
  toggleVoice: () => void
  dismissVoice: () => void
  setMeowing: (playing: boolean) => void
  searchWeatherCities: (query: string) => Promise<WeatherCity[]>
  saveReminderSettings: (input: ReminderSettingsInput) => Promise<PetReminders>
  previewWeather: () => Promise<string>
  getFocusWidget: () => Promise<DesktopWidget | null>
  getPreviewTodo: () => Promise<DesktopWidget | null>
  updatePreviewTodo: (data: TodoWidgetData) => Promise<void>
  updateFocusWidget: (data: PomodoroWidgetData) => Promise<void>
  stop: () => void
  openChat: () => void
  closeChat: () => void
  drag: (phase: 'start' | 'move' | 'end', delta?: { x: number; y: number }) => void
  menu: () => void
  onState: (callback: (state: PetState) => void) => () => void
  onChatOpened: (callback: () => void) => () => void
}

declare global { interface Window { petAPI?: PetAPI } }
