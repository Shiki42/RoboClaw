export interface ArmStatus {
  alias: string
  type: string
  connected: boolean
  calibrated: boolean
}

export interface CameraStatus {
  alias: string
  connected: boolean
  resolution: string
}

export interface DashboardStatusResponse {
  ready: boolean
  missing: string[]
  arms: ArmStatus[]
  cameras: CameraStatus[]
}

export interface RecordParams {
  task: string
  num_episodes: number
  episode_time_s?: number
  reset_time_s?: number
}

export interface RecordStatusResponse {
  active: boolean
  session_id?: string
  dataset_name?: string
  task?: string
  state: string
  current_episode?: number
  total_episodes?: number
  recent_output?: string[]
}

export async function fetchDashboardStatus(): Promise<DashboardStatusResponse> {
  const response = await fetch('/api/dashboard/status')
  if (!response.ok) throw new Error('获取硬件状态失败')
  return response.json()
}

export async function startRecord(params: RecordParams): Promise<RecordStatusResponse> {
  const response = await fetch('/api/dashboard/record/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || '启动采集失败')
  }
  return response.json()
}

export async function sendRecordAction(action: 'success' | 'failure' | 'rerecord' | 'stop'): Promise<void> {
  const response = await fetch('/api/dashboard/record/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || '操作失败')
  }
}

export async function fetchRecordStatus(): Promise<RecordStatusResponse> {
  const response = await fetch('/api/dashboard/record/status')
  if (!response.ok) throw new Error('获取采集状态失败')
  return response.json()
}
