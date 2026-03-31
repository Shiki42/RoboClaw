# 数采 Dashboard MVP 实现计划

> 基于 Claude Plan 分析 + 代码实测整合
> 最后更新：2026-03-31

---

## 1. IPC 方案选择：PTY 注入

### 方案对比

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **PTY 注入** | 零侵入 LeRobot 源码；headless_patch 已在读 stdin；字节级映射精确 | 需要管理 PTY 生命周期 | **✓ 选定** |
| Named pipe | 明确的 IPC 通道 | 需在 headless_patch 加 watcher 线程；两套输入源并存 | ✗ |
| Unix socket | 同上 | 同上，额外依赖 socket 协议 | ✗ |
| 信号量 | 简单 | 只有 SIGUSR1/2，不够映射 4 个动作 | ✗ |

### 选择理由

`headless_patch.py` 的 `TTYKeyboardListener` 已经从 `sys.stdin` 读取按键字节。只要把 record 子进程的 stdin 接到一个 PTY slave fd，Web Server 持有 PTY master fd 并写入对应字节，`TTYKeyboardListener` 就能原样消费这些按键——**不需要引入任何新的 IPC 通道**。

### 按钮 → 字节映射

| Dashboard 按钮 | 写入 PTY master 的字节 | TTYKeyboardListener 识别为 | events 效果 |
|---|---|---|---|
| 成功结束 | `b"s"` | `on_press("s")` | `episode_outcome="success"`, `exit_early=True` |
| 失败结束 | `b"f"` | `on_press("f")` | `episode_outcome="failure"`, `exit_early=True` |
| 重录本轮 | `b"\x1b[D"` (左箭头) | `on_press("left")` | `rerecord_episode=True`, `exit_early=True` |
| 终止采集 | `b"\x1b"` (ESC) | `on_press("esc")` | `stop_recording=True`, `exit_early=True` |

---

## 2. 必须修改的前置条件

### headless_patch.py 当前缺陷

1. **`_consume_pending()` 第 80-81 行**：所有非 ESC 开头的字符被 `pending = pending[1:]` 静默丢弃。`s` 和 `f` 字节会被吃掉，不触发 `on_press`。
2. **`events` dict 缺少 `episode_outcome` 键**（第 97-101 行）。
3. **`on_press()` 没有 `s`/`f` 分支**（第 103-116 行）。

**不修复这 3 点，"成功结束"和"失败结束"按钮无法工作。**

---

## 3. 完整数据流

```
操作员点击 "成功结束" 按钮
  ↓
React: POST /api/dashboard/record/action { action: "success" }
  ↓
FastAPI handler → 查找活跃 RecordSession → os.write(master_fd, b"s")
  ↓
PTY slave fd (record 子进程的 stdin)
  ↓
TTYKeyboardListener._consume_pending() → 匹配 "s" → on_press("s")
  ↓
on_press: events["episode_outcome"] = "success", events["exit_early"] = True
  ↓
LeRobot record_loop 检测 exit_early → 保存 episode（带 outcome 标签）→ 进入 reset_time
  ↓
后端检测子进程 stdout → WebSocket 推送 record_progress 到前端
  ↓
前端更新进度面板
```

---

## 4. 文件变更清单

### 4.1 后端新增

| 文件 | 职责 | 预估行数 |
|------|------|----------|
| `roboclaw/embodied/health.py` | 硬件连接状态检测：`check_arm_connected(port)`, `check_camera_connected(port)`, `full_health_check(setup)` | ~80 |
| `roboclaw/web/dashboard.py` | Dashboard REST API + `RecordSession`（PTY 管理 + 子进程生命周期）+ `DashboardManager`（单例，硬件轮询 + 采集管理） | ~350 |
| `roboclaw-web/src/features/dashboard/DashboardPage.tsx` | Dashboard 主页面：ReadinessBanner + HardwarePanel + RecordControlPanel + TroubleshootPanel | ~250 |
| `roboclaw-web/src/shared/api/dashboard.ts` | Dashboard REST API 客户端 | ~80 |

### 4.2 后端修改

| 文件 | 变更内容 | 影响范围 |
|------|----------|----------|
| `roboclaw/embodied/headless_patch.py` | 1. `_consume_pending()`: `s`/`f` 字符匹配分支（在第 80 行 fallthrough 之前）<br>2. `events` dict: 加入 `"episode_outcome": None`<br>3. `on_press()`: 加入 `s`→success、`f`→failure 分支 | ~15 行改动 |
| `roboclaw/web/server.py` | `create_app()` 中注册 dashboard 路由，startup/shutdown 钩子管理 DashboardManager | ~20 行改动 |

### 4.3 前端修改

| 文件 | 变更内容 |
|------|----------|
| `roboclaw-web/src/App.tsx` | 新增 `/dashboard` 路由 |
| `roboclaw-web/src/shared/components/Layout.tsx` | 侧栏加 "数据采集" 导航项 |
| `roboclaw-web/src/shared/api/websocket.ts` | `onmessage` 处理 `hardware_status`, `record_progress`, `record_complete` 事件类型 |

---

## 5. 关键模块设计

### 5.1 `RecordSession`（roboclaw/web/dashboard.py）

```python
class RecordSession:
    session_id: str
    dataset_name: str
    master_fd: int           # PTY master
    process: asyncio.subprocess.Process
    state: Literal["recording", "resetting", "complete", "error"]
    current_episode: int
    total_episodes: int

    async def start(setup, task, num_episodes, episode_time_s, reset_time_s):
        # 1. 生成 dataset_name = f"rec_{datetime.now():%Y%m%d_%H%M%S}"
        # 2. 用 SO101Controller().record() 构建 argv
        # 3. master_fd, slave_fd = pty.openpty()
        # 4. create_subprocess_exec(*argv, stdin=slave_fd, stdout=PIPE, stderr=PIPE)
        # 5. os.close(slave_fd)
        # 6. 启动 _read_output() 异步任务

    def send_action(action: str):
        # os.write(self.master_fd, ACTION_BYTES[action])

    async def _read_output():
        # 异步读 stderr，正则解析 episode/frame 进度
        # 更新 self.state, self.current_episode 等

    async def stop(force: bool):
        # force=False: send ESC (优雅停止)
        # force=True: process.terminate()
```

### 5.2 `health.py`（roboclaw/embodied/health.py）

```python
def check_arm_connected(port: str) -> bool:
    """检查 /dev/serial/by-id/... 是否存在且为有效符号链接。"""
    return os.path.exists(port)

def check_camera_connected(port: str | int) -> bool:
    """尝试 cv2.VideoCapture().isOpened()，立即释放。"""

def full_health_check(setup: dict) -> dict:
    """返回 {ready, missing, arms: [...], cameras: [...]}"""
```

### 5.3 REST API

```
GET  /api/dashboard/status          → 硬件状态 + 就绪状态
POST /api/dashboard/record/start    → {task, num_episodes, episode_time_s, reset_time_s}
POST /api/dashboard/record/action   → {action: "success"|"failure"|"rerecord"|"stop"}
GET  /api/dashboard/record/status   → 当前采集进度
```

### 5.4 WebSocket 事件（server → client）

```json
{"type": "hardware_status",  "data": {/* 同 GET /api/dashboard/status */}}
{"type": "record_progress",  "data": {"current_episode": 3, "total_episodes": 10, "state": "recording"}}
{"type": "record_complete",  "data": {"dataset_name": "rec_20260331_143022", "episodes_completed": 8}}
{"type": "fault_alert",      "data": {"fault_id": "arm_disconnected", "device": "left_follower"}}
```

---

## 6. 实现顺序

```
Phase 1: 后端基础 ───────────────────────────────────────
  ① headless_patch.py — 加 s/f 支持（前置条件，所有后续依赖）
  ② health.py — 硬件状态检测
  ③ dashboard.py — RecordSession + DashboardManager + API routes
  ④ server.py — 接入 dashboard 路由

Phase 2: 前端 ───────────────────────────────────────────
  ⑤ dashboard.ts — API 客户端
  ⑥ DashboardPage.tsx — 页面组件
  ⑦ App.tsx + Layout.tsx — 路由和导航
  ⑧ websocket.ts — 新事件类型处理

Phase 3: 集成测试（在 SSH 127 真机上）──────────────────
  ⑨ PTY 注入验证：s/f/左箭头/ESC 是否正确到达 record 子进程
  ⑩ 硬件掉线 → Dashboard 状态刷新
  ⑪ 端到端数采流程
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **PTY slave + termios.tcgetattr** 在非 TTY 环境失败 | record 子进程启动崩溃 | PTY slave **是**有效终端设备，tcgetattr 会成功。但需在 Linux 实测确认。 |
| **摄像头被 record 独占** | 录制中 health check 的摄像头探测会失败 | 录制期间跳过摄像头连接检测，状态显示"录制中使用" |
| **LeRobot stdout 无结构化进度** | 无法解析 episode/frame 数 | 降级方案：轮询 dataset 目录的 `meta/info.json`；再降级：只显示"采集中"不显示具体数字 |
| **headless_patch 的 `s`/`f` 与 LeRobot 未来版本冲突** | 升级 LeRobot 后可能失效 | headless_patch 本身就是 monkey-patch，已接受此风险；pin LeRobot 版本 |
| **Web Server 崩溃导致 record 子进程变孤儿** | 无人管理的子进程占用硬件 | DashboardManager 启动时检查残留 PID；或在 record 子进程中设 prctl(PR_SET_PDEATHSIG) |
| **单次只能一个采集会话** | 操作员误操作 | API 返回 409 Conflict + 前端 disable 按钮 |

---

## 8. MVP 不做的事

- 摄像头实时预览（录制中摄像头被独占）
- 训练/策略管理
- 数据集浏览/回放
- 排障面板完整实现（MVP 只做掉线提示 + "联系技术支持"）
- 多用户/认证
- 国际化
