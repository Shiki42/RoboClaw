"""Dashboard REST API for large-scale data collection."""

from __future__ import annotations

import asyncio
import os
import pty
import re
from datetime import datetime
from typing import Any

from fastapi import Body, HTTPException

from roboclaw.embodied.health import full_health_check
from roboclaw.embodied.ops.helpers import (
    _arm_id,
    _dataset_path,
    _group_arms,
    _validate_pairing,
)
from roboclaw.embodied.runner import _utf8_env
from roboclaw.embodied.sensor.camera import resolve_cameras
from roboclaw.embodied.setup import load_setup

# Byte sequences to send via PTY stdin for each dashboard action.
ACTION_BYTES: dict[str, bytes] = {
    "success": b"s",
    "failure": b"f",
    "rerecord": b"\x1b[D",  # left arrow
    "stop": b"\x1b",  # ESC
}

# Regex to detect episode progress from lerobot output.
_EPISODE_RE = re.compile(r"Recording episode (\d+)")


class RecordSession:
    """Manages a single lerobot record subprocess via PTY."""

    def __init__(
        self,
        session_id: str,
        dataset_name: str,
        task: str,
        total_episodes: int,
    ) -> None:
        self.session_id = session_id
        self.dataset_name = dataset_name
        self.task = task
        self.total_episodes = total_episodes
        self.current_episode = 0
        self.state = "starting"
        self.master_fd: int | None = None
        self.process: asyncio.subprocess.Process | None = None
        self._output_task: asyncio.Task | None = None
        self._output_lines: list[str] = []

    async def start(
        self,
        setup: dict[str, Any],
        num_episodes: int,
        episode_time_s: int | None,
        reset_time_s: int | None,
    ) -> None:
        """Build the record command and spawn the subprocess with a PTY stdin."""
        argv = _build_record_argv(
            setup,
            task=self.task,
            dataset_name=self.dataset_name,
            num_episodes=num_episodes,
            episode_time_s=episode_time_s,
            reset_time_s=reset_time_s,
        )
        master_fd, slave_fd = pty.openpty()
        self.master_fd = master_fd
        self.process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=slave_fd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_utf8_env(),
        )
        os.close(slave_fd)
        self.state = "recording"
        self._output_task = asyncio.create_task(self._read_output())

    def send_action(self, action: str) -> None:
        """Write the action byte sequence to the PTY master."""
        if self.master_fd is None:
            return
        data = ACTION_BYTES.get(action)
        if data is None:
            return
        os.write(self.master_fd, data)

    def is_alive(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def cleanup(self) -> None:
        """Close PTY and wait for subprocess."""
        if self.master_fd is not None:
            os.close(self.master_fd)
            self.master_fd = None
        if self._output_task is not None:
            self._output_task.cancel()
            try:
                await self._output_task
            except asyncio.CancelledError:
                pass
        if self.process is not None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            await self.process.wait()
        self.state = "complete"

    async def _read_output(self) -> None:
        """Read stdout/stderr and parse episode progress."""
        streams: list[asyncio.StreamReader] = []
        if self.process and self.process.stdout:
            streams.append(self.process.stdout)
        if self.process and self.process.stderr:
            streams.append(self.process.stderr)

        async def _read_stream(stream: asyncio.StreamReader) -> None:
            async for line_bytes in stream:
                line = line_bytes.decode("utf-8", errors="replace").rstrip()
                self._output_lines.append(line)
                if len(self._output_lines) > 200:
                    self._output_lines = self._output_lines[-100:]
                match = _EPISODE_RE.search(line)
                if match:
                    self.current_episode = int(match.group(1))

        tasks = [asyncio.create_task(_read_stream(s)) for s in streams]
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.process and self.process.returncode is not None:
            self.state = "complete"

    def to_dict(self) -> dict[str, Any]:
        """Serialize current session state for the API response."""
        return {
            "active": self.is_alive(),
            "session_id": self.session_id,
            "dataset_name": self.dataset_name,
            "task": self.task,
            "state": self.state if self.is_alive() else "complete",
            "current_episode": self.current_episode,
            "total_episodes": self.total_episodes,
            "recent_output": self._output_lines[-20:],
        }


class DashboardManager:
    """Coordinates health checks and the active record session."""

    def __init__(self) -> None:
        self.session: RecordSession | None = None

    def get_status(self) -> dict[str, Any]:
        """Run full hardware health check against current setup."""
        setup = load_setup()
        return full_health_check(setup)

    async def start_record(self, params: dict[str, Any]) -> dict[str, Any]:
        """Create and start a new RecordSession. Only one session at a time."""
        if self.session is not None and self.session.is_alive():
            raise HTTPException(status_code=409, detail="已有采集任务正在进行中")
        setup = load_setup()
        task = params.get("task", "default_task")
        num_episodes = params.get("num_episodes", 10)
        episode_time_s = params.get("episode_time_s")
        reset_time_s = params.get("reset_time_s")
        dataset_name = f"rec_{datetime.now():%Y%m%d_%H%M%S}"
        session_id = f"dash_{datetime.now():%Y%m%d_%H%M%S}"
        self.session = RecordSession(
            session_id=session_id,
            dataset_name=dataset_name,
            task=task,
            total_episodes=num_episodes,
        )
        await self.session.start(
            setup=setup,
            num_episodes=num_episodes,
            episode_time_s=episode_time_s,
            reset_time_s=reset_time_s,
        )
        return self.session.to_dict()

    def send_action(self, action: str) -> dict[str, Any]:
        """Forward a control action to the active session."""
        if self.session is None or not self.session.is_alive():
            raise HTTPException(status_code=404, detail="当前没有正在进行的采集任务")
        if action not in ACTION_BYTES:
            raise HTTPException(status_code=400, detail=f"未知操作: {action}")
        self.session.send_action(action)
        return {"status": "ok", "action": action}

    def get_record_status(self) -> dict[str, Any]:
        """Return the current recording session state."""
        if self.session is None:
            return {"active": False, "state": "idle"}
        return self.session.to_dict()

    async def shutdown(self) -> None:
        """Clean up the active session on server shutdown."""
        if self.session is not None:
            await self.session.cleanup()
            self.session = None


def register_dashboard_routes(app: Any, manager: DashboardManager) -> None:
    """Mount dashboard REST endpoints on the FastAPI app."""

    @app.get("/api/dashboard/status")
    async def dashboard_status() -> dict[str, Any]:
        return manager.get_status()

    @app.post("/api/dashboard/record/start")
    async def record_start(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return await manager.start_record(payload)

    @app.post("/api/dashboard/record/action")
    async def record_action(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        action = payload.get("action", "")
        return manager.send_action(action)

    @app.get("/api/dashboard/record/status")
    async def record_status() -> dict[str, Any]:
        return manager.get_record_status()


# ── Command builder ───────────────────────────────────────────────────


def _build_record_argv(
    setup: dict[str, Any],
    *,
    task: str,
    dataset_name: str,
    num_episodes: int,
    episode_time_s: int | None,
    reset_time_s: int | None,
) -> list[str]:
    """Build the lerobot record argv from the current setup, reusing SO101Controller."""
    from roboclaw.embodied.embodiment.arm.so101 import SO101Controller

    arms = setup.get("arms", [])
    grouped = _group_arms(arms)
    followers = grouped["followers"]
    leaders = grouped["leaders"]
    error = _validate_pairing(followers, leaders)
    if error:
        raise ValueError(error)

    cameras = resolve_cameras(setup)
    controller = SO101Controller()
    dataset_root = str(_dataset_path(setup, dataset_name))
    record_kwargs: dict[str, Any] = {
        "cameras": cameras,
        "repo_id": f"local/{dataset_name}",
        "task": task,
        "dataset_root": dataset_root,
        "push_to_hub": False,
        "fps": 30,
        "num_episodes": num_episodes,
    }
    if episode_time_s is not None:
        record_kwargs["episode_time_s"] = episode_time_s
    if reset_time_s is not None:
        record_kwargs["reset_time_s"] = reset_time_s

    if len(followers) == 1:
        return controller.record(
            robot_type=followers[0]["type"],
            robot_port=followers[0]["port"],
            robot_cal_dir=followers[0]["calibration_dir"],
            robot_id=_arm_id(followers[0]),
            teleop_type=leaders[0]["type"],
            teleop_port=leaders[0]["port"],
            teleop_cal_dir=leaders[0]["calibration_dir"],
            teleop_id=_arm_id(leaders[0]),
            **record_kwargs,
        )

    # Bimanual: SO101Controller.record_bimanual expects merged calibration dirs.
    # In agent flow this is handled by _bimanual_cal_dirs() context manager in
    # execute.py. For the dashboard MVP we pass the first follower/leader cal dirs
    # as placeholders. Full bimanual support with temp cal dirs will be added in
    # a follow-up iteration.
    return controller.record_bimanual(
        robot_id="bimanual",
        robot_cal_dir=followers[0]["calibration_dir"],
        left_robot=followers[0],
        right_robot=followers[1],
        teleop_id="bimanual",
        teleop_cal_dir=leaders[0]["calibration_dir"],
        left_teleop=leaders[0],
        right_teleop=leaders[1],
        **record_kwargs,
    )
