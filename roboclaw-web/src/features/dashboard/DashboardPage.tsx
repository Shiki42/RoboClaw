import { useState, useEffect, useCallback } from 'react'
import {
  fetchDashboardStatus,
  startRecord,
  sendRecordAction,
  fetchRecordStatus,
  type DashboardStatusResponse,
  type RecordStatusResponse,
} from '../../shared/api/dashboard'


function ReadinessBanner({ status }: { status: DashboardStatusResponse | null }) {
  if (!status) return null
  if (status.ready) {
    return (
      <div className="rounded-lg border border-green-500/40 bg-green-500/10 p-4 text-green-200">
        所有设备就绪，可以开始数采
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200">
      <div className="font-semibold mb-2">设备未就绪</div>
      <ul className="list-disc list-inside text-sm space-y-1">
        {status.missing.map((msg, i) => (
          <li key={i}>{msg}</li>
        ))}
      </ul>
    </div>
  )
}

function HardwarePanel({ status }: { status: DashboardStatusResponse | null }) {
  if (!status) return <p className="text-gray-400">正在加载硬件状态...</p>
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {status.arms.map((arm) => (
        <div key={arm.alias} className="rounded-xl border border-gray-700 bg-gray-800/80 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${arm.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-medium">{arm.alias}</span>
          </div>
          <div className="text-sm text-gray-400">
            类型: {arm.type.includes('follower') ? '从臂' : '主臂'} | 校准: {arm.calibrated ? '已校准' : '未校准'}
          </div>
        </div>
      ))}
      {status.cameras.map((cam) => (
        <div key={cam.alias} className="rounded-xl border border-gray-700 bg-gray-800/80 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${cam.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-medium">{cam.alias}</span>
          </div>
          <div className="text-sm text-gray-400">
            摄像头{cam.resolution ? ` | ${cam.resolution}` : ''}
          </div>
        </div>
      ))}
      {status.arms.length === 0 && status.cameras.length === 0 && (
        <p className="text-gray-500 col-span-2">暂无已配置的设备</p>
      )}
    </div>
  )
}

function RecordForm({ ready, onStart }: { ready: boolean; onStart: (params: { task: string; num_episodes: number; episode_time_s?: number; reset_time_s?: number }) => void }) {
  const [task, setTask] = useState('')
  const [numEpisodes, setNumEpisodes] = useState(10)
  const [episodeTime, setEpisodeTime] = useState('60')
  const [resetTime, setResetTime] = useState('10')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!task.trim()) return
    const params: { task: string; num_episodes: number; episode_time_s?: number; reset_time_s?: number } = {
      task: task.trim(),
      num_episodes: numEpisodes,
    }
    if (episodeTime) params.episode_time_s = Number(episodeTime)
    if (resetTime) params.reset_time_s = Number(resetTime)
    onStart(params)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block space-y-2">
        <span className="text-sm text-gray-300">任务描述（必填）</span>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          className="w-full rounded-lg border border-gray-600 bg-gray-900 px-4 py-2 text-white"
          placeholder="如：把红色方块放到蓝色碗里"
          required
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm text-gray-300">采集轮数</span>
        <input
          type="number"
          min={1}
          value={numEpisodes}
          onChange={(e) => setNumEpisodes(Number(e.target.value))}
          className="w-full rounded-lg border border-gray-600 bg-gray-900 px-4 py-2 text-white"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block space-y-2">
          <span className="text-sm text-gray-300">每轮时长（秒）</span>
          <input
            type="number"
            min={1}
            value={episodeTime}
            onChange={(e) => setEpisodeTime(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-900 px-4 py-2 text-white"
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-gray-300">重置等待（秒）</span>
          <input
            type="number"
            min={0}
            value={resetTime}
            onChange={(e) => setResetTime(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-900 px-4 py-2 text-white"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={!ready || !task.trim()}
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        开始数采
      </button>
    </form>
  )
}

function RecordingControls({
  recordStatus,
  onAction,
}: {
  recordStatus: RecordStatusResponse
  onAction: (action: 'success' | 'failure' | 'rerecord' | 'stop') => void
}) {
  const actions: { key: 'success' | 'failure' | 'rerecord' | 'stop'; label: string; color: string }[] = [
    { key: 'success', label: '成功结束（本轮）', color: 'bg-green-600 hover:bg-green-700' },
    { key: 'failure', label: '失败结束（本轮）', color: 'bg-red-600 hover:bg-red-700' },
    { key: 'rerecord', label: '重录本轮', color: 'bg-yellow-600 hover:bg-yellow-700' },
    { key: 'stop', label: '终止采集', color: 'bg-gray-600 hover:bg-gray-700' },
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-700 bg-gray-800/80 p-5 space-y-3">
        <div className="flex items-center gap-3">
          <span className="inline-block w-3 h-3 rounded-full bg-green-500 animate-pulse" />
          <span className="text-lg font-semibold">采集中</span>
        </div>
        <div className="text-sm text-gray-300 space-y-1">
          <div>任务: {recordStatus.task}</div>
          <div>数据集: {recordStatus.dataset_name}</div>
          <div>
            当前轮次: {recordStatus.current_episode} / {recordStatus.total_episodes}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => onAction(a.key)}
            className={`rounded-lg px-4 py-3 text-white font-medium ${a.color}`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function CompleteSummary({
  recordStatus,
  onNewSession,
}: {
  recordStatus: RecordStatusResponse
  onNewSession: () => void
}) {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/80 p-5 space-y-4">
      <div className="text-lg font-semibold">采集完成</div>
      <div className="text-sm text-gray-300 space-y-1">
        <div>数据集: {recordStatus.dataset_name}</div>
        <div>完成轮次: {recordStatus.current_episode}</div>
      </div>
      <button
        onClick={onNewSession}
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-white hover:bg-blue-700"
      >
        开始新一轮采集
      </button>
    </div>
  )
}


export default function DashboardPage() {
  const [hwStatus, setHwStatus] = useState<DashboardStatusResponse | null>(null)
  const [recordStatus, setRecordStatus] = useState<RecordStatusResponse | null>(null)
  const [error, setError] = useState('')

  const loadHardwareStatus = useCallback(async () => {
    try {
      setHwStatus(await fetchDashboardStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取状态失败')
    }
  }, [])

  useEffect(() => {
    loadHardwareStatus()
    const interval = setInterval(loadHardwareStatus, 5000)
    return () => clearInterval(interval)
  }, [loadHardwareStatus])

  const isRecording = recordStatus?.state === 'recording' || recordStatus?.state === 'starting'

  useEffect(() => {
    if (!isRecording) return
    const interval = setInterval(async () => {
      try {
        setRecordStatus(await fetchRecordStatus())
      } catch {
        // keep last known status
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isRecording])

  async function handleStart(params: { task: string; num_episodes: number; episode_time_s?: number; reset_time_s?: number }) {
    setError('')
    try {
      setRecordStatus(await startRecord(params))
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动采集失败')
    }
  }

  async function handleAction(action: 'success' | 'failure' | 'rerecord' | 'stop') {
    setError('')
    try {
      await sendRecordAction(action)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  const isComplete = recordStatus?.state === 'complete'
  const isIdle = !recordStatus || recordStatus.state === 'idle'

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <header className="bg-gray-800 border-b border-gray-700 p-4">
        <h2 className="text-xl font-semibold">数据采集</h2>
        <p className="mt-2 text-sm text-gray-400">
          查看硬件状态、配置采集参数、控制数据采集流程
        </p>
      </header>

      <div className="flex-1 p-6 max-w-4xl space-y-6">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200">
            {error}
          </div>
        )}

        <ReadinessBanner status={hwStatus} />

        <section className="space-y-3">
          <h3 className="text-lg font-semibold">硬件状态</h3>
          <HardwarePanel status={hwStatus} />
        </section>

        <section className="space-y-3">
          <h3 className="text-lg font-semibold">采集控制</h3>
          <div className="rounded-xl border border-gray-700 bg-gray-800/80 p-5">
            {isIdle && <RecordForm ready={hwStatus?.ready ?? false} onStart={handleStart} />}
            {isRecording && recordStatus && (
              <RecordingControls recordStatus={recordStatus} onAction={handleAction} />
            )}
            {isComplete && recordStatus && (
              <CompleteSummary recordStatus={recordStatus} onNewSession={() => setRecordStatus(null)} />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
