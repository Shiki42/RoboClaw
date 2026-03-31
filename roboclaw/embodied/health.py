"""Hardware connection health checks for the data collection dashboard."""

from __future__ import annotations

import os
from typing import Any


def check_arm_connected(port: str) -> bool:
    """Check whether the serial device file exists."""
    return os.path.exists(port)


def check_camera_connected(port: str | int) -> bool:
    """Try cv2.VideoCapture().isOpened(), release immediately.

    Returns False when cv2 is not installed (development machine).
    """
    try:
        import cv2
    except ImportError:
        return False
    idx = int(port) if str(port).isdigit() else port
    cap = cv2.VideoCapture(idx)
    opened = cap.isOpened()
    cap.release()
    return opened


def full_health_check(setup: dict[str, Any]) -> dict[str, Any]:
    """Run connection checks on all devices in setup.json, return full status."""
    arms_status: list[dict[str, Any]] = []
    cameras_status: list[dict[str, Any]] = []
    missing: list[str] = []

    for arm in setup.get("arms", []):
        connected = check_arm_connected(arm.get("port", ""))
        calibrated = arm.get("calibrated", False)
        arms_status.append({
            "alias": arm.get("alias", ""),
            "type": arm.get("type", ""),
            "connected": connected,
            "calibrated": calibrated,
        })
        if not connected:
            missing.append(f"机械臂 {arm.get('alias', '')} 未连接")
        if not calibrated:
            missing.append(f"机械臂 {arm.get('alias', '')} 未校准")

    for cam in setup.get("cameras", []):
        port = cam.get("port", "")
        connected = check_camera_connected(port)
        w, h = cam.get("width", 0), cam.get("height", 0)
        cameras_status.append({
            "alias": cam.get("alias", ""),
            "connected": connected,
            "resolution": f"{w}x{h}" if w and h else "",
        })
        if not connected:
            missing.append(f"摄像头 {cam.get('alias', '')} 未连接")

    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "arms": arms_status,
        "cameras": cameras_status,
    }
