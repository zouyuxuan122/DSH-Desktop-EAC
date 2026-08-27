"""Phase 0 native BigFish helper.

The DSH plugin owns this process and sends newline-delimited JSON over stdin.
Closing stdin is a lifecycle signal: the helper exits instead of becoming an
independent desktop application.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import threading
import time
from pathlib import Path
from typing import Any, TextIO

try:
    from .animation_model import AnimationModel, crossfade_duration
    from .layout_store import default_layout_path, load_layout, save_layout
except ImportError:
    from animation_model import AnimationModel, crossfade_duration
    from layout_store import default_layout_path, load_layout, save_layout


PROTOCOL_VERSION = 1
STATES = {"IDLE", "THINKING", "WORKING", "WAITING", "SUCCESS", "ERROR", "DISCONNECTED"}
DRAG_RELEASE_MS = 300
DRAG_DIZZY_MS = 840
DRAG_PROTEST_MS = 300
DRAG_RELEASE_STAGES = (
    ("dragging_release", DRAG_RELEASE_MS),
    ("dragging_dizzy", DRAG_DIZZY_MS),
    ("dragging_protest", DRAG_PROTEST_MS),
)


def bundle_root() -> Path:
    """Locate packaged assets both from source and a PyInstaller one-file build."""
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root is not None:
        return Path(frozen_root)
    return Path(__file__).resolve().parent.parent


def configure_qt_platform() -> None:
    """Prefer XWayland when available so desktop-window controls keep working."""
    if sys.platform != "linux" or os.environ.get("QT_QPA_PLATFORM"):
        return
    platforms: list[str] = []
    if os.environ.get("DISPLAY"):
        platforms.append("xcb")
    if os.environ.get("WAYLAND_DISPLAY"):
        platforms.append("wayland")
    if platforms:
        os.environ["QT_QPA_PLATFORM"] = ";".join(platforms)


def configure_stdio() -> None:
    """Make the JSONL pipe UTF-8 regardless of the Windows console code page."""
    for stream, errors in ((sys.stdin, "strict"), (sys.stdout, "backslashreplace"), (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors=errors)


def parse_message(line: str) -> dict[str, Any]:
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("message must be an object")
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    kind = message.get("kind")
    if kind in {"state", "pulse"} and message.get("state") not in STATES:
        raise ValueError("unsupported companion state")
    return message


def emit_reply(kind: str, **payload: Any) -> None:
    print(
        json.dumps(
            {"protocolVersion": PROTOCOL_VERSION, "kind": kind, "timestamp": int(time.time() * 1000), **payload},
            ensure_ascii=False,
        ),
        flush=True,
    )


class EventRecorder:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._stream: TextIO | None = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._stream = path.open("a", encoding="utf-8")

    def record(self, message: dict[str, Any]) -> None:
        if self._stream is None:
            return
        self._stream.write(json.dumps(message, ensure_ascii=False) + "\n")
        self._stream.flush()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.close()


def run_headless(recorder: EventRecorder) -> int:
    try:
        emit_reply("ready")
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = parse_message(line)
            except (ValueError, json.JSONDecodeError) as error:
                print(json.dumps({"kind": "error", "message": str(error)}), flush=True)
                continue
            recorder.record(message)
            if message.get("kind") == "ping":
                emit_reply("pong")
                continue
            if message.get("kind") == "shutdown":
                break
    finally:
        recorder.close()
    return 0


def run_visual(recorder: EventRecorder, snapshot_path: Path | None = None) -> int:
    configure_qt_platform()
    try:
        from PySide6.QtCore import QObject, QPoint, QRectF, Qt, QTimer, QUrl, Signal
        from PySide6.QtGui import QColor, QDesktopServices, QFont, QFontMetrics, QMouseEvent, QPainter, QPen, QPixmap
        from PySide6.QtWidgets import QApplication, QMenu, QWidget
    except ImportError:
        print(
            "PySide6 is required for visual mode. Run with --headless for protocol tests.",
            file=sys.stderr,
        )
        recorder.close()
        return 2

    class Inbox(QObject):
        message = Signal(dict)
        closed = Signal()

    manifest_path = bundle_root() / "assets" / "pet-manifest.json"
    asset_root = manifest_path.parent / "pet"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"Unable to load BigFish asset manifest: {error}", file=sys.stderr)
        recorder.close()
        return 2

    class CompanionWindow(QWidget):
        LABELS = {
            "IDLE": "休息中",
            "THINKING": "思考中",
            "WORKING": "干活中",
            "WAITING": "等你呢",
            "SUCCESS": "完成啦",
            "ERROR": "出问题了",
            "DISCONNECTED": "已断开",
        }

        def __init__(self) -> None:
            super().__init__()
            self.layout_path = default_layout_path()
            self.layout = load_layout(self.layout_path)
            configured_scale = os.environ.get("DSH_DAFEIYU_SCALE")
            try:
                self.scale = min(1.4, max(0.55, float(configured_scale))) if configured_scale else self.layout["scale"]
            except ValueError:
                self.scale = self.layout["scale"]
            configured_bubble_scale = os.environ.get("DSH_DAFEIYU_BUBBLE_SCALE")
            try:
                self.bubble_scale = (
                    min(1.2, max(0.8, float(configured_bubble_scale)))
                    if configured_bubble_scale
                    else self.layout["bubbleScale"]
                )
            except ValueError:
                self.bubble_scale = self.layout["bubbleScale"]
            configured_reduced_motion = os.environ.get("DSH_DAFEIYU_REDUCED_MOTION")
            self.reduced_motion = (
                configured_reduced_motion == "1"
                if configured_reduced_motion is not None
                else self.layout["reducedMotion"]
            )
            configured_sound_enabled = os.environ.get("DSH_DAFEIYU_SOUND_ENABLED")
            self.sound_enabled = configured_sound_enabled != "0"
            self.activity_level = os.environ.get("DSH_DAFEIYU_ACTIVITY_LEVEL", "normal")
            configured_bubble_mode = os.environ.get("DSH_DAFEIYU_BUBBLE_MODE")
            self.bubble_mode = (
                configured_bubble_mode
                if configured_bubble_mode in {"always", "hidden", "custom"}
                else self.layout.get("bubbleMode", "always")
            )
            configured_bubble_states = os.environ.get("DSH_DAFEIYU_BUBBLE_STATES")
            if configured_bubble_states is not None:
                self.bubble_states = [part.strip() for part in configured_bubble_states.split(",") if part.strip()]
            else:
                self.bubble_states = list(self.layout.get("bubbleStates", ["SUCCESS", "ERROR", "WAITING"]))
            self.model = AnimationModel(manifest)
            self.pixmaps: dict[str, QPixmap] = {}
            for clip in self.model.clips.values():
                for frame in clip.frames:
                    if frame in self.pixmaps:
                        continue
                    pixmap = QPixmap(str(asset_root / frame))
                    if pixmap.isNull():
                        raise RuntimeError(f"Unable to load BigFish frame: {frame}")
                    self.pixmaps[frame] = pixmap

            self.display_state = "IDLE"
            self.status_state = "IDLE"
            self.status_message = "我在这儿等新任务哦"
            self.status_detail = "DSH · 等待下一次任务"
            self.status_deadline_ms: int | None = self._now_ms() + 4200
            self.overlay_state: str | None = None
            self.overlay_message = ""
            self.overlay_detail = ""
            self.overlay_deadline_ms: int | None = None
            self.task = ""
            self.tasks: list[dict[str, Any]] = []
            self.webui_url = os.environ.get("DSH_DAFEIYU_WEBUI_URL", "http://127.0.0.1:3080/")
            self.shake_timer: QTimer | None = None
            self.shake_origin: QPoint | None = None
            self.shake_count = 0
            self.drag_origin: QPoint | None = None
            self.pet_origin: QPoint | None = None
            self.pet_x = 0
            self.pet_y = 0
            self.dragging = False
            self.drag_chain_id = 0
            self.last_tick_ms = self._now_ms()
            self.fade_from_pixmap: QPixmap | None = None
            self.fade_started = 0.0
            self.fade_duration = 0.15
            self.animation_timer = QTimer(self)
            self.animation_timer.timeout.connect(self._tick)
            self.animation_timer.start(40 if self.reduced_motion else 20)
            self.micro_timer = QTimer(self)
            self.micro_timer.setSingleShot(True)
            self.micro_timer.timeout.connect(self._play_idle_micro)
            if not self.reduced_motion:
                self._schedule_micro()
            self.snapshot_saved = False
            self.setWindowTitle("DSH 大肥鱼")
            self.setWindowFlags(
                Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.WindowStaysOnTopHint
                | Qt.WindowType.Tool
            )
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            self._apply_window_size()
            QTimer.singleShot(0, self._restore_visible_position)

        def apply_message(self, message: dict[str, Any]) -> None:
            recorder.record(message)
            kind = message.get("kind")
            if kind == "shutdown":
                QApplication.quit()
                return
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            if kind == "task":
                self.task = str(message.get("task", ""))
                self._show_status(
                    str(message.get("message", self.task)),
                    str(message.get("detail", "")),
                    self.model.base_state,
                    None if self.model.base_state in {"THINKING", "WORKING", "WAITING", "ERROR"} else 6000,
                )
            elif kind == "tasks":
                raw_tasks = message.get("tasks")
                self.tasks = raw_tasks if isinstance(raw_tasks, list) else []
                self._sync_bubble_size()
            elif kind == "config":
                self._apply_config(message)
            elif kind in {"state", "pulse"}:
                state = str(message.get("state", "IDLE"))
                self.display_state = state
                if kind == "pulse":
                    ttl_ms = max(250, int(message.get("ttlMs", 1800)))
                    resume_state = str(message.get("resumeState", self.model.base_state))
                    self.model.apply_pulse(
                        state,
                        ttl_ms,
                        self._now_ms(),
                        resume_state,
                        message.get("resumeActivity"),
                    )
                    self._show_status(
                        str(message.get("resumeMessage", self.LABELS.get(resume_state, resume_state))),
                        str(message.get("resumeDetail", "")),
                        resume_state,
                        None if resume_state in {"THINKING", "WORKING", "WAITING", "ERROR"} else ttl_ms + 2200,
                    )
                    self._show_overlay(
                        str(message.get("message", self.LABELS.get(state, state))),
                        str(message.get("detail", "")),
                        state,
                        ttl_ms,
                    )
                    if state in {"SUCCESS", "ERROR"}:
                        self._notify_alert(state)
                else:
                    activity = None if self.reduced_motion else message.get("activity")
                    self.model.apply_state(state, activity)
                    self._clear_overlay()
                    persistent = state in {"THINKING", "WORKING", "WAITING", "ERROR"}
                    self._show_status(
                        str(message.get("message", self.LABELS.get(state, state))),
                        str(message.get("detail", "")),
                        state,
                        None if persistent else 4200,
                    )
            self._sync_frame_transition(previous_frame, previous_clip)
            self._sync_bubble_size()
            self.update()
            if snapshot_path is not None and not self.snapshot_saved:
                QTimer.singleShot(180, self._save_snapshot)

        def _apply_config(self, message: dict[str, Any]) -> None:
            """Apply a live CONFIG message without restarting the window."""
            scale = message.get("scale")
            if isinstance(scale, (int, float)) and not isinstance(scale, bool):
                self.scale = min(1.4, max(0.55, float(scale)))
            bubble_scale = message.get("bubbleScale")
            if isinstance(bubble_scale, (int, float)) and not isinstance(bubble_scale, bool):
                self.bubble_scale = min(1.2, max(0.8, float(bubble_scale)))
            reduced_motion = message.get("reducedMotion")
            if isinstance(reduced_motion, bool) and reduced_motion != self.reduced_motion:
                self.reduced_motion = reduced_motion
                self.animation_timer.setInterval(40 if self.reduced_motion else 20)
                if self.reduced_motion:
                    self.micro_timer.stop()
                    self._cancel_drag_release_chain()
                else:
                    self._schedule_micro()
            sound_enabled = message.get("soundEnabled")
            if isinstance(sound_enabled, bool):
                self.sound_enabled = sound_enabled
            activity_level = message.get("activityLevel")
            if activity_level in {"quiet", "normal", "lively"}:
                self.activity_level = activity_level
                if not self.reduced_motion:
                    self._schedule_micro()
            bubble_mode = message.get("bubbleMode")
            if bubble_mode in {"always", "hidden", "custom"}:
                self.bubble_mode = bubble_mode
            bubble_states = message.get("bubbleStates")
            if isinstance(bubble_states, list):
                self.bubble_states = [str(state) for state in bubble_states if isinstance(state, str)]
            self._sync_bubble_size()
            self._save_layout()

        def _tick(self) -> None:
            now_ms = self._now_ms()
            elapsed_ms = max(0, now_ms - self.last_tick_ms)
            self.last_tick_ms = now_ms
            had_pulse = self.model.pulse_state is not None
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            model_elapsed = 0 if self.reduced_motion and self.model.active_clip.loop else elapsed_ms
            self.model.advance(model_elapsed, now_ms)
            self._sync_frame_transition(previous_frame, previous_clip)
            if had_pulse and self.model.pulse_state is None:
                self.display_state = self.model.base_state
            if self.overlay_deadline_ms is not None and now_ms >= self.overlay_deadline_ms:
                self._clear_overlay()
            self.update()

        def _play_idle_micro(self) -> None:
            if self.reduced_motion:
                return
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            self.model.play_idle_micro(random.randrange(max(1, len(self.model.idle_micro_clips))))
            self._sync_frame_transition(previous_frame, previous_clip)
            self.update()
            self._schedule_micro()

        def _sync_frame_transition(
            self,
            previous_frame: str,
            previous_clip: str,
            *,
            allow_fade: bool = True,
        ) -> None:
            current_frame = self.model.frame
            if current_frame == previous_frame:
                return
            duration = crossfade_duration(previous_clip, self.model.active_clip_name) if allow_fade else None
            if duration is None:
                self.fade_from_pixmap = None
                return
            self.fade_from_pixmap = self.pixmaps.get(previous_frame)
            self.fade_started = time.monotonic()
            self.fade_duration = duration

        def _play_model_overlay(
            self,
            clip_name: str,
            *,
            allow_fade: bool = True,
            repaint: bool = True,
        ) -> bool:
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            if not self.model.play_overlay(clip_name):
                return False
            self._sync_frame_transition(previous_frame, previous_clip, allow_fade=allow_fade)
            if repaint:
                self.update()
            return True

        def _begin_drag(self) -> None:
            if self.dragging:
                return
            self.dragging = True
            self.drag_chain_id += 1
            self.animation_timer.stop()
            self.micro_timer.stop()
            self._play_model_overlay("dragging", allow_fade=False, repaint=False)

        def _finish_drag(self) -> None:
            if not self.dragging:
                return
            now_ms = self._now_ms()
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            # Expire an underlying pulse before revealing it after a long drag.
            self.model.advance(0, now_ms)
            self.model.clear_overlay()
            self._sync_frame_transition(previous_frame, previous_clip, allow_fade=False)
            self.dragging = False
            self.last_tick_ms = now_ms
            self.animation_timer.start(40 if self.reduced_motion else 20)
            if not self.reduced_motion:
                self._schedule_micro()
                self._run_drag_release_chain()

        def _run_drag_release_chain(self) -> None:
            """Play release -> dizzy -> protest, then hand back to the base state.

            Every stage is a single-frame clip, so the chain is driven by timers;
            any new grab (or a manifest without the stage clips) aborts quietly.
            """
            self.drag_chain_id += 1
            token = self.drag_chain_id

            def play(index: int) -> None:
                if token != self.drag_chain_id or self.dragging:
                    return
                if self.reduced_motion or index >= len(DRAG_RELEASE_STAGES):
                    self._clear_drag_overlay()
                    return
                clip_name, hold_ms = DRAG_RELEASE_STAGES[index]
                if not self._play_model_overlay(clip_name, allow_fade=False):
                    self._clear_drag_overlay()
                    return
                QTimer.singleShot(hold_ms, lambda: play(index + 1))

            QTimer.singleShot(0, lambda: play(0))

        def _clear_drag_overlay(self) -> None:
            if self.dragging:
                return
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            self.model.clear_overlay()
            self._sync_frame_transition(previous_frame, previous_clip)
            self.update()

        def _cancel_drag_release_chain(self) -> None:
            self.drag_chain_id += 1
            if not self.dragging and self.model.active_clip_name in {
                name for name, _ in DRAG_RELEASE_STAGES
            }:
                self._clear_drag_overlay()

        def _schedule_micro(self) -> None:
            if self.reduced_motion:
                self.micro_timer.stop()
                return
            intervals = {
                "quiet": (12000, 24000),
                "normal": (6500, 12500),
                "lively": (3500, 8000),
            }
            lower, upper = intervals.get(self.activity_level, intervals["normal"])
            self.micro_timer.start(random.randint(lower, upper))

        def _bubble_visible(self) -> bool:
            if self.bubble_mode == "hidden":
                return False
            if self.bubble_mode == "always":
                return True
            if len(self.tasks) >= 2:
                return any(task.get("state") in self.bubble_states for task in self.tasks)
            state = self.overlay_state or self.status_state or self.model.base_state or "IDLE"
            return state in self.bubble_states

        def _sync_bubble_size(self) -> None:
            old_size = (self.width(), self.height())
            self._apply_window_size()
            if (self.width(), self.height()) != old_size:
                self._move_to_pet(self.pet_x, self.pet_y)

        def _apply_window_size(self) -> None:
            pet_width = round(int(manifest["maxFrameWidth"]) * self.scale)
            pet_height = round(int(manifest["maxFrameHeight"]) * self.scale)
            if self._bubble_visible():
                bubble_width = round(420 * self.bubble_scale)
                bubble_height = self._card_height()
                self.setFixedSize(max(pet_width + 50, bubble_width + 28), pet_height + bubble_height + 34)
            else:
                self.setFixedSize(pet_width + 50, pet_height + 26)

        def _screen_geometry_at(self, x: int, y: int):
            screen = QApplication.screenAt(QPoint(x, y)) or QApplication.primaryScreen()
            if screen is None:
                return None
            return screen.availableGeometry()

        def _pet_size(self) -> tuple[int, int]:
            return (
                round(int(manifest["maxFrameWidth"]) * self.scale),
                round(int(manifest["maxFrameHeight"]) * self.scale),
            )

        def _move_to_pet(self, pet_x: int, pet_y: int) -> None:
            """Move the window so the pet stands at (pet_x, pet_y).

            The pet position is the source of truth; the window is just the
            container that keeps the status bubble on screen.  While the window
            fits on screen the pet stays centered under it.  When the window
            would have to leave the screen, it is clamped and the pet shifts
            inside the window instead, so the pet can stand at any screen
            position while the bubble stays fully visible.
            """
            pet_width, pet_height = self._pet_size()
            geometry = self._screen_geometry_at(pet_x, pet_y)
            if geometry is None:
                self.pet_x = pet_x
                self.pet_y = pet_y
                self.move(
                    pet_x - (self.width() - pet_width) // 2,
                    pet_y - (self.height() - pet_height - 8),
                )
                self.update()
                return

            min_x = geometry.left()
            max_x = max(min_x, geometry.right() - self.width() + 1)
            min_y = geometry.top()
            max_y = max(min_y, geometry.bottom() - self.height() + 1)

            center_offset_x = (self.width() - pet_width) // 2
            window_x = min(max(pet_x - center_offset_x, min_x), max_x)
            offset_x = min(max(pet_x - window_x, 0), self.width() - pet_width)
            self.pet_x = window_x + offset_x

            top_offset_y = self.height() - pet_height - 8
            window_y = min(max(pet_y - top_offset_y, min_y), max_y)
            self.pet_y = window_y + top_offset_y

            self.move(window_x, window_y)
            self.update()

        def _pet_offset_x(self, pet_width: int) -> int:
            return min(max(self.pet_x - self.x(), 0), self.width() - pet_width)

        def _pet_rect(self) -> tuple[int, int, int, int]:
            pet_width, pet_height = self._pet_size()
            return self._pet_offset_x(pet_width), self.height() - pet_height - 8, pet_width, pet_height

        def _bubble_rect(self) -> tuple[int, int, int, int]:
            card_width = round(420 * self.bubble_scale)
            card_height = self._card_height()
            pet_width, _ = self._pet_size()
            pet_center_x = self._pet_offset_x(pet_width) + pet_width // 2
            margin = 14
            card_x = pet_center_x - card_width // 2
            min_x = margin
            max_x = self.width() - card_width - margin
            if max_x < min_x:
                max_x = min_x
            card_x = min(max(card_x, min_x), max_x)
            return card_x, 7, card_width, card_height

        def _restore_visible_position(self) -> None:
            pet_width, pet_height = self._pet_size()
            top_offset = self.height() - pet_height - 8
            center_offset = (self.width() - pet_width) // 2
            saved_pet_x = self.layout.get("petX")
            saved_pet_y = self.layout.get("petY")
            if isinstance(saved_pet_x, int) and isinstance(saved_pet_y, int):
                pet_x, pet_y = saved_pet_x, saved_pet_y
            else:
                saved_x = self.layout.get("x")
                saved_y = self.layout.get("y")
                if isinstance(saved_x, int) and isinstance(saved_y, int):
                    # Legacy layouts stored the window position.  Recreate the
                    # pet position that the old centered layout would have had.
                    pet_x = saved_x + center_offset
                    pet_y = saved_y + top_offset
                else:
                    geometry = self._screen_geometry_at(self.x() + self.width() // 2, self.y() + self.height() // 2)
                    if geometry is None:
                        return
                    pet_x = geometry.right() - pet_width - 24
                    pet_y = geometry.bottom() - pet_height - 24
            self._move_to_pet(pet_x, pet_y)

        def _save_layout(self) -> None:
            self.layout = {
                "version": 1,
                "x": self.x(),
                "y": self.y(),
                "petX": self.pet_x,
                "petY": self.pet_y,
                "scale": self.scale,
                "bubbleScale": self.bubble_scale,
                "reducedMotion": self.reduced_motion,
                "bubbleMode": self.bubble_mode,
                "bubbleStates": self.bubble_states,
            }
            try:
                save_layout(self.layout_path, self.layout)
            except OSError as error:
                print(f"Unable to save BigFish layout: {error}", file=sys.stderr)

        def _save_snapshot(self) -> None:
            if snapshot_path is None or self.snapshot_saved:
                return
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            self.snapshot_saved = self.grab().save(str(snapshot_path), "PNG")

        def _show_status(self, message: str, detail: str, state: str, ttl_ms: int | None) -> None:
            self.status_message = message
            self.status_detail = detail
            self.status_state = state
            self.status_deadline_ms = None if ttl_ms is None else self._now_ms() + ttl_ms

        def _show_overlay(self, message: str, detail: str, state: str, ttl_ms: int) -> None:
            self.overlay_message = message
            self.overlay_detail = detail or self.status_detail
            self.overlay_state = state
            self.overlay_deadline_ms = self._now_ms() + ttl_ms

        def _clear_overlay(self) -> None:
            self.overlay_message = ""
            self.overlay_detail = ""
            self.overlay_state = None
            self.overlay_deadline_ms = None

        @staticmethod
        def _now_ms() -> int:
            return int(time.monotonic() * 1000)

        def _current_card(self) -> tuple[str, str, str] | None:
            now_ms = self._now_ms()
            if self.overlay_message and (
                self.overlay_deadline_ms is None or now_ms < self.overlay_deadline_ms
            ):
                return self.overlay_message, self.overlay_detail, self.overlay_state or self.status_state
            if self.status_message and (
                self.status_deadline_ms is None or now_ms < self.status_deadline_ms
            ):
                return self.status_message, self.status_detail, self.status_state
            return None

        @staticmethod
        def _status_colors(state: str) -> tuple[QColor, QColor]:
            return {
                "SUCCESS": (QColor("#D9F7E4"), QColor("#12B85A")),
                "ERROR": (QColor("#FDE3E3"), QColor("#E5484D")),
                "WAITING": (QColor("#FFF0CE"), QColor("#D88A00")),
                "THINKING": (QColor("#E2ECFF"), QColor("#4C78E8")),
                "WORKING": (QColor("#DDEBFF"), QColor("#3478F6")),
                "DISCONNECTED": (QColor("#ECEEF1"), QColor("#7B818A")),
            }.get(state, (QColor("#ECEEF1"), QColor("#747A84")))

        def _draw_status_icon(self, painter: QPainter, state: str, center_x: int, center_y: int) -> None:
            background, foreground = self._status_colors(state)
            radius = 23
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(background)
            painter.drawEllipse(center_x - radius, center_y - radius, radius * 2, radius * 2)
            pen = QPen(foreground, 3)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            if state == "SUCCESS":
                painter.drawLine(center_x - 10, center_y, center_x - 3, center_y + 8)
                painter.drawLine(center_x - 3, center_y + 8, center_x + 12, center_y - 10)
            elif state == "ERROR":
                painter.drawLine(center_x - 8, center_y - 8, center_x + 8, center_y + 8)
                painter.drawLine(center_x + 8, center_y - 8, center_x - 8, center_y + 8)
            elif state == "WAITING":
                painter.drawLine(center_x, center_y - 10, center_x, center_y + 3)
                painter.setBrush(foreground)
                painter.drawEllipse(center_x - 2, center_y + 9, 4, 4)
            elif state in {"THINKING", "WORKING"}:
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(foreground)
                for offset in (-9, 0, 9):
                    painter.drawEllipse(center_x + offset - 3, center_y - 3, 6, 6)
            else:
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(foreground)
                painter.drawEllipse(center_x - 5, center_y - 5, 10, 10)

        def _card_height(self) -> int:
            if len(self.tasks) >= 2:
                rows = min(len(self.tasks), 3)
                return round((58 + rows * 26) * self.bubble_scale)
            return round(84 * self.bubble_scale)

        def _draw_card_background(
            self,
            painter: QPainter,
            card_x: int,
            card_y: int,
            card_width: int,
            card_height: int,
            corner_radius: int,
            s: float,
        ) -> None:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(17, 24, 39, 13))
            painter.drawRoundedRect(
                card_x + 1, card_y + round(13 * s), card_width - 2, card_height,
                corner_radius, corner_radius,
            )
            painter.setBrush(QColor(17, 24, 39, 18))
            painter.drawRoundedRect(
                card_x, card_y + round(7 * s), card_width, card_height,
                corner_radius, corner_radius,
            )
            painter.setPen(QPen(QColor(218, 221, 226, 205), 1))
            painter.setBrush(QColor(252, 252, 253, 248))
            painter.drawRoundedRect(
                card_x, card_y, card_width, card_height,
                corner_radius, corner_radius,
            )

        def _draw_multi_task_card(
            self,
            painter: QPainter,
            card_x: int,
            card_y: int,
            card_width: int,
            card_height: int,
            s: float,
        ) -> None:
            title_font = QFont("Microsoft YaHei UI")
            title_font.setPointSizeF(max(8.0, 11.0 * s))
            title_font.setWeight(QFont.Weight.DemiBold)
            detail_font = QFont("Microsoft YaHei UI")
            detail_font.setPointSizeF(max(7.0, 9.0 * s))
            text_x = card_x + round(16 * s)
            text_width = max(40, card_width - round(32 * s))
            painter.setFont(title_font)
            painter.setPen(QColor("#25282D"))
            title = f"{len(self.tasks)} 个任务进行中"
            painter.drawText(
                text_x,
                card_y + round(10 * s),
                text_width,
                max(12, round(22 * s)),
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                QFontMetrics(title_font).elidedText(title, Qt.TextElideMode.ElideRight, text_width),
            )
            painter.setFont(detail_font)
            for index, task in enumerate(self.tasks[:3]):
                row_y = card_y + round((36 + index * 24) * s)
                state = str(task.get("state", "IDLE"))
                state_label = self.LABELS.get(state, state)
                label = task.get("project") or task.get("task") or task.get("message") or state_label
                line = f"{state_label} · {label}"
                _, foreground = self._status_colors(state)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(foreground)
                painter.drawEllipse(text_x, row_y + round(4 * s), round(8 * s), round(8 * s))
                painter.setPen(QColor("#747981"))
                painter.drawText(
                    text_x + round(14 * s),
                    row_y,
                    text_width - round(14 * s),
                    max(12, round(20 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    QFontMetrics(detail_font).elidedText(line, Qt.TextElideMode.ElideRight, text_width - round(14 * s)),
                )
            if len(self.tasks) > 3:
                more = f"还有 {len(self.tasks) - 3} 个任务…"
                painter.setPen(QColor("#9AA0A6"))
                painter.drawText(
                    text_x + round(14 * s),
                    card_y + round((36 + 3 * 24) * s),
                    text_width,
                    max(12, round(20 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    more,
                )

        def _notify_alert(self, state: str) -> None:
            if self.sound_enabled:
                played = False
                if sys.platform == "win32":
                    try:
                        import winsound

                        sound_name = "success.wav" if state == "SUCCESS" else "error.wav"
                        sound_path = bundle_root() / "assets" / "sounds" / sound_name
                        winsound.PlaySound(
                            str(sound_path),
                            winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
                        )
                        played = True
                    except (ImportError, OSError, RuntimeError):
                        pass
                if not played:
                    try:
                        QApplication.beep()
                    except Exception:
                        pass
            self._shake_window()

        def _shake_window(self) -> None:
            if self.shake_timer is None:
                self.shake_timer = QTimer(self)
                self.shake_timer.timeout.connect(self._shake_tick)
            self.shake_origin = self.pos()
            self.shake_count = 0
            self.shake_timer.start(30)

        def _shake_tick(self) -> None:
            offsets = [(6, 0), (-6, 0), (4, 0), (-4, 0), (2, 0), (-2, 0), (0, 0)]
            if self.shake_origin is None:
                self.shake_timer.stop()
                return
            if self.shake_count < len(offsets):
                dx, dy = offsets[self.shake_count]
                self.move(self.shake_origin.x() + dx, self.shake_origin.y() + dy)
                self.shake_count += 1
            else:
                self.shake_timer.stop()
                self.move(self.shake_origin)

        def paintEvent(self, _event: Any) -> None:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            # 平滑缩放：放大/缩小时插值，避免锯齿和模糊
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            card = self._current_card() if self._bubble_visible() else None
            bubble_height = 12
            card_x, card_y, card_width, card_height = self._bubble_rect()
            s = self.bubble_scale
            corner_radius = round(30 * s)

            if len(self.tasks) >= 2 and self._bubble_visible():
                bubble_height = card_y + card_height + 19
                self._draw_card_background(painter, card_x, card_y, card_width, card_height, corner_radius, s)
                self._draw_multi_task_card(painter, card_x, card_y, card_width, card_height, s)
            elif card:
                title, detail, card_state = card
                bubble_height = card_y + card_height + 19
                self._draw_card_background(painter, card_x, card_y, card_width, card_height, corner_radius, s)
                icon_center_x = card_x + card_width - round(39 * s)
                icon_center_y = card_y + card_height // 2
                painter.save()
                painter.translate(icon_center_x, icon_center_y)
                painter.scale(s, s)
                painter.translate(-icon_center_x, -icon_center_y)
                self._draw_status_icon(painter, card_state, icon_center_x, icon_center_y)
                painter.restore()

                text_x = card_x + round(24 * s)
                text_width = max(40, card_width - round(102 * s))
                title_font = QFont("Microsoft YaHei UI")
                title_font.setPointSizeF(max(8.0, 11.0 * s))
                title_font.setWeight(QFont.Weight.DemiBold)
                detail_font = QFont("Microsoft YaHei UI")
                detail_font.setPointSizeF(max(7.0, 9.0 * s))
                painter.setFont(title_font)
                painter.setPen(QColor("#25282D"))
                title_text = QFontMetrics(title_font).elidedText(
                    title,
                    Qt.TextElideMode.ElideRight,
                    text_width,
                )
                painter.drawText(
                    text_x,
                    card_y + round(15 * s),
                    text_width,
                    max(12, round(27 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    title_text,
                )
                painter.setFont(detail_font)
                painter.setPen(QColor("#747981"))
                detail_text = QFontMetrics(detail_font).elidedText(
                    detail,
                    Qt.TextElideMode.ElideRight,
                    text_width,
                )
                painter.drawText(
                    text_x,
                    card_y + round(43 * s),
                    text_width,
                    max(12, round(24 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    detail_text,
                )

            pixmap = self.pixmaps[self.model.frame]
            phase = time.monotonic()
            motion = self.model.active_clip.motion
            if self.reduced_motion:
                motion = None
            scale_extra = 1.0
            angle = 0.0
            offset_x = 0
            offset_y = 0
            clip_name = self.model.active_clip_name
            if motion == "breathe":
                # 独立版同款：缩放呼吸 + 轻摇摆（无位移）
                scale_extra = 1.0 + 0.02 * math.sin(phase * 2.5)
                angle = math.sin(phase * 2.5) * 1.5
            elif motion == "think":
                offset_y = math.sin(phase * 2.8) * 3
                angle = math.sin(phase * 1.3) * 0.8
            elif motion == "work":
                offset_x = math.sin(phase * 5.4) * 3
                angle = math.sin(phase * 3.1) * 1.0
            elif motion == "wait":
                offset_y = math.sin(phase * 1.8) * 1
                angle = math.sin(phase * 1.2) * 0.8
            elif motion == "bounce":
                offset_y = -abs(math.sin(phase * 5.2)) * 8
                scale_extra = 1.0 + 0.02 * math.sin(phase * 5.2)
            elif motion in {"shake", "dizzy"}:
                offset_x = math.sin(phase * 11.0) * 4
                angle = math.sin(phase * 11.0) * 1.5
            elif motion == "float":
                offset_y = math.sin(phase * 3.0) * 4
                angle = math.sin(phase * 1.6) * 1.0
            # Give walking clips a light bob and quick sway without changing frame timing.
            if clip_name in ("working_search", "working_command"):
                offset_y = -abs(math.sin(phase * 4.5)) * 5
                angle = math.sin(phase * 9.0) * 2.5

            # Scale procedural offsets with the character while retaining subpixel motion.
            offset_x = offset_x * self.scale
            offset_y = offset_y * self.scale

            fade_alpha = 1.0
            if self.fade_from_pixmap is not None and not self.fade_from_pixmap.isNull():
                fade_elapsed = time.monotonic() - self.fade_started
                if fade_elapsed < self.fade_duration:
                    fade_alpha = min(1.0, (fade_elapsed / self.fade_duration) ** 0.7)
                else:
                    self.fade_from_pixmap = None

            def draw_pet(pix: QPixmap, alpha: float) -> None:
                base_width = pix.width() * self.scale
                base_height = pix.height() * self.scale
                pw = base_width * scale_extra
                ph = base_height * scale_extra
                x = self._pet_offset_x(base_width) + (base_width - pw) / 2 + offset_x
                y = self.height() - ph - 8 + offset_y
                if bubble_height > y:
                    y = bubble_height
                cx = x + pw / 2
                cy = y + ph / 2
                painter.save()
                painter.setOpacity(alpha)
                painter.translate(cx, cy)
                painter.rotate(angle)
                painter.translate(-cx, -cy)
                painter.drawPixmap(QRectF(x, y, pw, ph), pix, QRectF(0, 0, pix.width(), pix.height()))
                painter.restore()

            if fade_alpha < 1.0 and self.fade_from_pixmap is not None:
                # Keep the old frame opaque underneath so the pet never flashes transparent.
                draw_pet(self.fade_from_pixmap, 1.0)
            draw_pet(pixmap, fade_alpha)

        def mousePressEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                self.drag_origin = event.globalPosition().toPoint()
                self.pet_origin = QPoint(self.pet_x, self.pet_y)
                self.dragging = False

        def mouseMoveEvent(self, event: QMouseEvent) -> None:
            if self.drag_origin is not None and self.pet_origin is not None:
                if not self.dragging and (event.globalPosition().toPoint() - self.drag_origin).manhattanLength() > 5:
                    self._begin_drag()
                delta = event.globalPosition().toPoint() - self.drag_origin
                self._move_to_pet(self.pet_origin.x() + delta.x(), self.pet_origin.y() + delta.y())

        def mouseReleaseEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                if self.dragging:
                    self._finish_drag()
                    self._move_to_pet(self.pet_x, self.pet_y)
                    self._save_layout()
                else:
                    self._play_click_interaction(event.position().x(), event.position().y())
            self.drag_origin = None
            self.pet_origin = None
            self.dragging = False

        def _play_click_interaction(self, x: float, y: float) -> None:
            pet_x, pet_y, pet_width, pet_height = self._pet_rect()
            relative_x = max(0.0, x - pet_x)
            relative_y = max(0.0, y - pet_y)
            if relative_y < pet_height * 0.45:
                self._play_model_overlay("head_pat")
                self._show_overlay("摸摸也不能让我少干活哦~", self.status_detail, self.status_state, 1800)
            elif relative_x > pet_width * 0.72:
                self._play_model_overlay("tail")
                self._show_overlay("尾巴不是进度条啦！", self.status_detail, self.status_state, 1500)
            else:
                self._play_model_overlay("poke")
                self._show_overlay("戳我干嘛，任务还在跑呢", self.status_detail, self.status_state, 1500)

        def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                self._play_model_overlay("head_pat")
                self._show_overlay("好啦好啦，知道你喜欢我~", self.status_detail, self.status_state, 1800)

        def contextMenuEvent(self, event: Any) -> None:
            menu = QMenu(self)
            size_menu = menu.addMenu("大小")
            size_actions = {}
            for label, scale in (("迷你", 0.6), ("小", 0.8), ("标准", 1.0), ("大", 1.25)):
                action = size_menu.addAction(label)
                action.setCheckable(True)
                action.setChecked(abs(self.scale - scale) < 0.05)
                size_actions[action] = scale
            bubble_size_menu = menu.addMenu("气泡大小")
            bubble_size_actions = {}
            for label, bubble_scale in (("小", 0.8), ("标准", 1.0), ("大", 1.2)):
                action = bubble_size_menu.addAction(label)
                action.setCheckable(True)
                action.setChecked(abs(self.bubble_scale - bubble_scale) < 0.05)
                bubble_size_actions[action] = bubble_scale
            reduced_action = menu.addAction("减少动态")
            reduced_action.setCheckable(True)
            reduced_action.setChecked(self.reduced_motion)
            open_webui_action = menu.addAction("打开 WebUI")
            menu.addSeparator()
            hide_action = menu.addAction("本次隐藏")
            exit_action = menu.addAction("本次关闭")
            selected = menu.exec(event.globalPos())
            if selected in size_actions:
                self.scale = size_actions[selected]
                self._apply_window_size()
                self._move_to_pet(self.pet_x, self.pet_y)
                self._save_layout()
                emit_reply("settings", scale=self.scale)
            elif selected in bubble_size_actions:
                self.bubble_scale = bubble_size_actions[selected]
                self._apply_window_size()
                self._move_to_pet(self.pet_x, self.pet_y)
                self._save_layout()
                emit_reply("settings", bubbleScale=self.bubble_scale)
            elif selected == reduced_action:
                self.reduced_motion = reduced_action.isChecked()
                self.animation_timer.setInterval(40 if self.reduced_motion else 20)
                if self.reduced_motion:
                    self.micro_timer.stop()
                    self._cancel_drag_release_chain()
                else:
                    self._schedule_micro()
                self._save_layout()
                emit_reply("settings", reducedMotion=self.reduced_motion)
                self.update()
            elif selected == open_webui_action:
                QDesktopServices.openUrl(QUrl(self.webui_url))
            elif selected == hide_action:
                self.hide()
            elif selected == exit_action:
                self._save_layout()
                emit_reply("closed", reason="user")
                QApplication.quit()

    application = QApplication(sys.argv[:1])
    application.setQuitOnLastWindowClosed(False)
    inbox = Inbox()
    window = CompanionWindow()
    inbox.message.connect(window.apply_message)
    inbox.closed.connect(application.quit)

    def read_stdin() -> None:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = parse_message(line)
                if message.get("kind") == "ping":
                    emit_reply("pong")
                inbox.message.emit(message)
            except (ValueError, json.JSONDecodeError) as error:
                print(json.dumps({"kind": "error", "message": str(error)}), flush=True)
        inbox.closed.emit()

    reader = threading.Thread(target=read_stdin, name="dsh-bigfish-stdin", daemon=True)
    reader.start()
    window.show()
    emit_reply("ready")
    code = application.exec()
    recorder.close()
    return code


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="DSH BigFish native helper")
    parser.add_argument("--headless", action="store_true", help="validate the protocol without opening a window")
    parser.add_argument("--event-log", type=Path, help="append received protocol messages to a JSONL file")
    parser.add_argument("--snapshot", type=Path, help="save one diagnostic visual frame after the first message")
    args = parser.parse_args()
    recorder = EventRecorder(args.event_log)
    return run_headless(recorder) if args.headless else run_visual(recorder, args.snapshot)


if __name__ == "__main__":
    raise SystemExit(main())
