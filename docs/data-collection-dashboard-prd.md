# 大规模数采 Web Dashboard 需求文档

> 目标读者：前端 + 后端开发人员
> 最后更新：2026-03-31

---

## 1. 背景与目标

### 1.1 场景

批量部署数采站：每台服务器连接 1-2 组机械臂 + 多个摄像头，运行一个 RoboClaw 实例。
数采操作人员（以下简称"操作员"）**不懂代码、不懂硬件细节**，需通过浏览器完成全部数采工作。

### 1.2 核心目标

操作员**独立**完成以下闭环，无需开发人员在场：

1. 打开网页 → 看到硬件状态（臂 + 摄像头是否正常）
2. 一键开始数采 → 实时看到采集进度（当前 episode / 总 episode）
3. 一键结束数采 / 暂停
4. 硬件故障时 → Dashboard 显示预设的排障选项 + 提示，操作员照做即可恢复

### 1.3 非目标（本期不做）

- 训练管理（train/job_status）— 操作员不涉及
- 策略部署与推理 — 操作员不涉及
- 数据集浏览/回放 — 后期迭代
- 多用户权限 — 同一台机器只有一个操作员

---

## 2. 用户角色

| 角色 | 描述 | 技术能力 |
|------|------|----------|
| 操作员 | 现场数采人员，操作遥操作手柄（leader 臂）采集数据 | 无代码能力，会用浏览器 |
| 部署人员 | 在每台服务器上安装 RoboClaw、配置硬件（set_arm / set_camera / calibrate） | 有基础运维能力 |

本需求面向**操作员**。部署人员的配置工作仍通过 CLI 或现有 Agent 对话完成。


---

## 4. 功能需求

### 4.1 Dashboard 主页 — 硬件状态总览

**进入 Dashboard 后操作员看到的第一个页面。**

#### 4.1.1 机械臂状态卡片

对 `setup.json` 中每个 arm 显示一张卡片：

| 字段 | 来源 | 显示 |
|------|------|------|
| 名称 | `arm.alias` | 如 "left_follower" |
| 类型 | `arm.type` | follower / leader，用图标区分 |
| 串口连接 | 运行时探测 `arm.port` 是否存在 | 绿色 = 已连接 / 红色 = 断开 |
| 校准状态 | `arm.calibrated` | 已校准 ✓ / 未校准 ✗ |

**实时性**：页面打开时查一次，之后每 5 秒轮询（或 WebSocket 推送）。

#### 4.1.2 摄像头状态卡片

对 `setup.json` 中每个 camera 显示一张卡片：

| 字段 | 来源 | 显示 |
|------|------|------|
| 名称 | `camera.alias` | 如 "front" |
| 连接状态 | 运行时尝试 `cv2.VideoCapture(port)` | 绿色 / 红色 |
| 预览图 | 抓取当前帧（JPEG） | 缩略图，点击放大 |
| 分辨率 | `camera.width × camera.height` | 如 640×480 |

**实时性**：预览帧每 2 秒刷新一次（仅在 Dashboard 页面可见时）。

#### 4.1.3 整体就绪指示

在页面顶部显示一个大状态：

- **就绪**（所有 follower 臂已连接 + 已校准，所有 leader 臂已连接 + 已校准，所有摄像头已连接）→ 绿色，显示"可以开始数采"
- **未就绪**（任一条件不满足）→ 红色，列出具体缺失项

---

### 4.2 数据采集控制

#### 4.2.1 开始采集

操作员点击"开始数采"按钮后，显示一个简单表单：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| 任务描述 | 本次采集的任务（如"把红色方块放到蓝色碗里"） | 必填 |
| 采集轮数 | `num_episodes` | 10 |
| 每轮时长(秒) | `episode_time_s` | 60 |
| 重置等待(秒) | `reset_time_s` | 10 |

dataset_name 自动生成（`rec_YYYYMMDD_HHMMSS`），不暴露给操作员。
fps 使用默认值 30，不暴露给操作员。

点击"确认开始"后：
1. 后端调用 `_do_record()`（对应 `embodied/ops/execute.py` 中的 record 逻辑）
2. 前端进入"采集中"状态

#### 4.2.2 采集进度面板

采集期间，Dashboard 切换到进度视图：

```
┌──────────────────────────────────────────┐
│  采集中: 把红色方块放到蓝色碗里           │
│                                          │
│  当前轮次: 3 / 10      ██████░░░░ 30%   │
│  当前轮状态: 采集中 (已录制 12.3s / 60s) │
│  已完成帧数: 2,340                       │
│                                          │
│  摄像头: front ● side ●  (实时缩略图)    │
│                                          │
│  [结束本轮] [终止采集]                   │
└──────────────────────────────────────────┘
```

**数据来源**：
- 当前 episode / 总 episodes：解析 LeRobot record 子进程的 stdout/stderr 输出
- 帧数：同上，或读取 dataset 目录的 `meta/info.json`
- 摄像头状态：与 4.1.2 相同的探测逻辑

#### 4.2.3 结束采集

- **结束本轮**：向 record 子进程发送信号，完成当前 episode 后停止
- **终止采集**：立即停止（发送 SIGINT，等同 Ctrl+C），已完成的 episode 保留

采集结束后显示摘要：
```
采集完成
- 数据集: rec_20260331_143022
- 完成轮次: 8 / 10
- 总帧数: 14,400
- 存储位置: ~/.roboclaw/workspace/embodied/datasets/local/rec_20260331_143022
```

---

### 4.3 故障处理与排障引导

**核心思路**：操作员不需要理解错误原因，只需要看到"发生了什么"+"照着做就能恢复"。

#### 4.3.1 故障检测

后端持续监控以下状态，异常时通过 WebSocket 推送事件到前端：

| 故障类型 | 检测方式 | 触发条件 |
|----------|----------|----------|
| 臂断开 | 周期性检查 `arm.port` 是否存在 | 串口设备文件消失 |
| 臂通信超时 | record 子进程 stderr | 出现 timeout / communication error |
| 摄像头断开 | `cv2.VideoCapture.isOpened()` 返回 False | 设备不可用 |
| 摄像头帧丢失 | `cv2.VideoCapture.read()` 返回空帧 | 连续 N 帧失败 |
| 采集进程异常退出 | record 子进程 exit code != 0 且非中断 | 非 130/-2 退出码 |

#### 4.3.2 排障面板 UI

故障发生时，Dashboard 弹出排障面板（非模态，不阻塞查看状态）：

```
┌──────────────────────────────────────────┐
│ ⚠ 检测到问题: 机械臂 "left_follower" 断开│
│                                          │
│ 请按以下步骤操作:                         │
│                                          │
│  1. 检查 USB 线缆是否松动，重新插紧      │
│  2. 等待 10 秒                           │
│  3. 点击下方 [重新检测]                  │
│                                          │
│  如果仍未恢复:                           │
│  4. 拔掉 USB 线，等待 5 秒，重新插入     │
│  5. 点击 [重新检测]                      │
│                                          │
│  如果多次尝试仍失败:                     │
│  → 点击 [联系技术支持] 生成故障报告      │
│                                          │
│  [重新检测]  [忽略继续]  [联系技术支持]  │
└──────────────────────────────────────────┘
```

#### 4.3.3 预设排障方案

后端维护一份**故障 → 排障步骤**的映射表（建议放 `roboclaw/embodied/troubleshoot.py`），前端不硬编码：

| 故障 ID | 故障描述 | 排障步骤 |
|---------|---------|---------|
| `arm_disconnected` | 机械臂 USB 断开 | 1. 检查 USB 线缆 → 2. 重插 → 3. 重新检测 |
| `arm_timeout` | 机械臂通信超时 | 1. 重启臂电源 → 2. 重插 USB → 3. 重新检测 |
| `arm_not_calibrated` | 机械臂未校准 | 联系部署人员执行校准 |
| `camera_disconnected` | 摄像头 USB 断开 | 1. 检查 USB 线缆 → 2. 重插 → 3. 重新检测 |
| `camera_frame_drop` | 摄像头帧丢失 | 1. 检查摄像头镜头是否被遮挡 → 2. 重插 USB → 3. 重新检测 |
| `record_crashed` | 采集进程异常退出 | 1. 点击重新开始采集 → 2. 如反复崩溃联系技术支持 |

#### 4.3.4 "联系技术支持"

点击后自动生成故障快照（JSON），包含：
- 当前 `setup.json`
- 各设备连接状态
- 最后 50 行 record 子进程日志
- 故障类型和时间戳

导出为文件或显示一个可复制的文本块，操作员发给技术人员即可。

---

### 4.4 网络访问

- Web Server 启动时 `--host 0.0.0.0`，使局域网内可访问
- 前端页面顶部或侧栏显示本机 LAN IP + 端口，方便操作员在平板/手机上访问
- 无需登录认证（内网环境，单操作员）

---

## 5. 后端 API 设计

在现有 `roboclaw/web/server.py` FastAPI 应用上扩展。

### 5.1 REST API

```
GET  /api/dashboard/status
  → 返回完整硬件状态 + 就绪状态
  Response: {
    ready: bool,
    missing: string[],          // 未就绪的原因列表
    arms: [{
      alias: string,
      type: "so101_follower" | "so101_leader",
      connected: bool,
      calibrated: bool,
    }],
    cameras: [{
      alias: string,
      connected: bool,
      resolution: string,       // "640x480"
      preview_url: string,      // "/api/dashboard/camera/{alias}/frame"
    }],
  }

GET  /api/dashboard/camera/{alias}/frame
  → 返回该摄像头当前帧 (JPEG)
  Content-Type: image/jpeg

POST /api/dashboard/record/start
  Body: {
    task: string,
    num_episodes: int,
    episode_time_s: int,
    reset_time_s: int,
  }
  → 启动采集，返回 session_id
  Response: { session_id: string, dataset_name: string }

POST /api/dashboard/record/stop
  Body: { session_id: string, force: bool }
  → 停止采集（force=true 立即终止，false 等当前 episode 结束）

GET  /api/dashboard/record/status
  → 当前采集状态
  Response: {
    active: bool,
    session_id: string | null,
    dataset_name: string | null,
    task: string | null,
    current_episode: int,
    total_episodes: int,
    current_episode_elapsed_s: float,
    episode_time_s: int,
    total_frames: int,
  }

POST /api/dashboard/troubleshoot/detect
  → 手动触发一次全量硬件检测，返回检测到的故障列表
  Response: { issues: [{ id: string, description: string, steps: string[] }] }

POST /api/dashboard/troubleshoot/report
  → 生成故障报告快照
  Response: { report: string }  // JSON 格式的完整诊断信息
```

### 5.2 WebSocket 事件

在现有 `/ws` WebSocket 上扩展，新增以下 **server → client** 事件类型：

```jsonc
// 硬件状态变化
{ "type": "hardware_status", "data": { /* 同 GET /api/dashboard/status */ } }

// 采集进度更新（每秒推送）
{ "type": "record_progress", "data": {
    "current_episode": 3,
    "total_episodes": 10,
    "current_episode_elapsed_s": 12.3,
    "episode_time_s": 60,
    "total_frames": 2340,
    "state": "recording" | "resetting" | "idle"
}}

// 故障告警
{ "type": "fault_alert", "data": {
    "fault_id": "arm_disconnected",
    "description": "机械臂 left_follower 断开",
    "affected_device": "left_follower",
    "steps": ["检查 USB 线缆是否松动...", "..."],
    "timestamp": "2026-03-31T14:30:22Z"
}}

// 采集完成
{ "type": "record_complete", "data": {
    "dataset_name": "rec_20260331_143022",
    "episodes_completed": 8,
    "total_episodes": 10,
    "total_frames": 14400
}}
```



---

## 10. 开放问题

| # | 问题 | 待确认 |
|---|------|--------|
| 1 | LeRobot record 子进程的 stdout 是否有结构化的 episode/frame 进度输出？如果没有，需要确认解析方案或改用文件系统轮询 dataset meta。 | 需实测 |
| 2 | 采集中摄像头预览是否需要？LeRobot record 会独占摄像头设备，可能无法同时抓帧。如果独占，则采集中只显示状态指示灯，不显示预览。 | 需实测 |
| 3 | 是否需要支持"续采"？即对已有 dataset 追加 episode。当前 `_do_record` 已支持，但 UI 上是否暴露给操作员？ | 需产品确认 |
| 4 | 排障步骤是否需要国际化？当前默认中文。 | 需产品确认 |
