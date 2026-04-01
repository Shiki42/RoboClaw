import { create } from 'zustand'

export type RobotState = 'disconnected' | 'connected' | 'preparing' | 'teleoperating' | 'recording'
export type EpisodePhase = '' | 'recording' | 'saving' | 'resetting'

interface LogEntry {
  time: string
  message: string
  cls: 'info' | 'ok' | 'err'
}

interface Dataset {
  name: string
  total_episodes?: number
  total_frames?: number
  fps?: number
}

interface DataCollectionStore {
  state: RobotState
  loading: string | null
  datasets: Dataset[]
  logs: LogEntry[]
  episodePhase: EpisodePhase
  savedEpisodes: number
  targetEpisodes: number
  cameraFeeds: Record<string, string>

  // Actions
  doConnect: () => Promise<void>
  doDisconnect: () => Promise<void>
  doTeleopStart: () => Promise<void>
  doTeleopStop: () => Promise<void>
  doRecordStart: (params: {
    dataset_name: string
    task: string
    fps: number
    num_episodes: number
  }) => Promise<void>
  doRecordStop: () => Promise<void>
  doSaveEpisode: () => Promise<void>
  doDiscardEpisode: () => Promise<void>
  doSkipReset: () => Promise<void>
  loadDatasets: () => Promise<void>
  deleteDataset: (name: string) => Promise<void>
  addLog: (message: string, cls?: 'info' | 'ok' | 'err') => void
  clearLog: () => void
  connectStatusWs: () => void
  disconnectStatusWs: () => void
}

const API = '/api/embodied'

async function api(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts)
  let j: any
  try {
    j = await r.json()
  } catch {
    throw new Error(`HTTP ${r.status}: ${r.statusText}`)
  }
  if (!r.ok || j.error) {
    throw new Error(j.detail || j.error || j.message || `HTTP ${r.status}`)
  }
  return j
}

function postJson(url: string, body?: unknown) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

let statusWs: WebSocket | null = null
let statusReconnectTimer: ReturnType<typeof setTimeout> | null = null

export const useDataCollection = create<DataCollectionStore>((set, get) => ({
  state: 'disconnected',
  loading: null,
  datasets: [],
  logs: [],
  episodePhase: '',
  savedEpisodes: 0,
  targetEpisodes: 0,
  cameraFeeds: {},

  addLog: (message, cls = 'info') => {
    const time = new Date().toLocaleTimeString()
    set((s) => ({
      logs: [...s.logs.slice(-199), { time, message, cls }],
    }))
  },

  clearLog: () => set({ logs: [] }),

  doConnect: async () => {
    set({ loading: 'connect' })
    get().addLog('Connecting robot...')
    try {
      await postJson(`${API}/connect`)
      get().addLog('Robot connected', 'ok')
    } catch (e: unknown) {
      get().addLog(`Connect failed: ${(e as Error).message}`, 'err')
    } finally {
      set({ loading: null })
    }
  },

  doDisconnect: async () => {
    get().addLog('Disconnecting robot...')
    try {
      await postJson(`${API}/disconnect`)
      get().addLog('Robot disconnected', 'info')
    } catch (e: unknown) {
      get().addLog(`Disconnect failed: ${(e as Error).message}`, 'err')
    }
  },

  doTeleopStart: async () => {
    set({ loading: 'teleop' })
    get().addLog('Starting teleoperation...')
    try {
      await postJson(`${API}/teleop/start`)
      get().addLog('Teleoperation started — hardware initializing...', 'ok')
    } catch (e: unknown) {
      get().addLog(`Teleop start failed: ${(e as Error).message}`, 'err')
    } finally {
      set({ loading: null })
    }
  },

  doTeleopStop: async () => {
    get().addLog('Stopping teleoperation...')
    try {
      await postJson(`${API}/teleop/stop`)
      get().addLog('Teleoperation stopped', 'info')
    } catch (e: unknown) {
      get().addLog(`Teleop stop failed: ${(e as Error).message}`, 'err')
    }
  },

  doRecordStart: async (params) => {
    set({ loading: 'record', savedEpisodes: 0, targetEpisodes: params.num_episodes })
    get().addLog(
      `Starting recording: ${params.dataset_name} (${params.num_episodes} episodes @ ${params.fps} fps)`,
    )
    try {
      await postJson(`${API}/record/start`, params)
      get().addLog('Recording started', 'ok')
    } catch (e: unknown) {
      get().addLog(`Record start failed: ${(e as Error).message}`, 'err')
    } finally {
      set({ loading: null })
    }
  },

  doRecordStop: async () => {
    get().addLog('Stopping recording...')
    try {
      await postJson(`${API}/record/stop`)
      get().addLog('Recording stopped', 'info')
      get().loadDatasets()
    } catch (e: unknown) {
      get().addLog(`Record stop failed: ${(e as Error).message}`, 'err')
    }
  },

  doSaveEpisode: async () => {
    get().addLog('Saving episode...')
    try {
      await postJson(`${API}/record/save-episode`)
      get().addLog('Save signal sent', 'ok')
    } catch (e: unknown) {
      get().addLog(`Save episode failed: ${(e as Error).message}`, 'err')
    }
  },

  doDiscardEpisode: async () => {
    get().addLog('Discarding episode...')
    try {
      await postJson(`${API}/record/discard-episode`)
      get().addLog('Discard signal sent', 'info')
    } catch (e: unknown) {
      get().addLog(`Discard episode failed: ${(e as Error).message}`, 'err')
    }
  },

  doSkipReset: async () => {
    get().addLog('Skipping reset wait...')
    try {
      await postJson(`${API}/record/skip-reset`)
      get().addLog('Skip signal sent', 'ok')
    } catch (e: unknown) {
      get().addLog(`Skip reset failed: ${(e as Error).message}`, 'err')
    }
  },

  loadDatasets: async () => {
    try {
      const r = await api(`${API}/datasets`)
      const datasets = Array.isArray(r) ? r : r.datasets || []
      set({ datasets })
    } catch (e: unknown) {
      get().addLog(`Load datasets failed: ${(e as Error).message}`, 'err')
    }
  },

  deleteDataset: async (name) => {
    try {
      await api(`${API}/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      get().addLog(`Dataset deleted: ${name}`, 'info')
      get().loadDatasets()
    } catch (e: unknown) {
      get().addLog(`Delete failed: ${(e as Error).message}`, 'err')
    }
  },

  connectStatusWs: () => {
    if (statusWs && statusWs.readyState <= WebSocket.OPEN) return
    if (statusReconnectTimer) {
      clearTimeout(statusReconnectTimer)
      statusReconnectTimer = null
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    statusWs = new WebSocket(`${proto}//${location.host}/api/embodied/ws/status`)

    statusWs.onopen = () => get().addLog('Status WebSocket connected', 'ok')

    statusWs.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        const stateMap: Record<string, RobotState> = {
          disconnected: 'disconnected',
          connected: 'connected',
          preparing: 'preparing',
          teleoperating: 'teleoperating',
          recording: 'recording',
        }
        const newState = stateMap[data.state] || 'disconnected'

        set({
          state: newState,
          episodePhase: data.episode_phase || '',
          savedEpisodes: data.saved_episodes ?? 0,
          targetEpisodes: data.target_episodes ?? 0,
        })
      } catch {
        /* ignore parse errors */
      }
    }

    statusWs.onclose = () => {
      get().addLog('Status WebSocket disconnected, reconnecting...', 'err')
      statusReconnectTimer = setTimeout(() => get().connectStatusWs(), 2000)
    }

    statusWs.onerror = () => statusWs?.close()
  },

  disconnectStatusWs: () => {
    if (statusReconnectTimer) {
      clearTimeout(statusReconnectTimer)
      statusReconnectTimer = null
    }
    if (statusWs) {
      statusWs.onclose = null
      statusWs.close()
      statusWs = null
    }
  },
}))
