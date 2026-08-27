"""Pure animation state model for the BigFish native helper.

The model intentionally has no Qt dependency. It keeps durable DSH state
separate from temporary visual overlays so a click, idle micro-animation, or
success pulse always returns to the newest Agent state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


STATES = {"IDLE", "THINKING", "WORKING", "WAITING", "SUCCESS", "ERROR", "DISCONNECTED"}
NON_CROSSFADE_CLIPS = {
    "blink",
    "glance",
    "dragging",
    "dragging_release",
    "dragging_dizzy",
    "dragging_protest",
}


def crossfade_duration(previous_clip: str, current_clip: str) -> float | None:
    """Return a safe fade duration for an already-observed frame transition.

    Expression frames stay crisp, while dragging must switch atomically. A
    delayed drag fade can reintroduce the old pose after the new pose has
    already been painted by a mouse event, which appears as layered-window
    flicker on Windows.
    """
    if previous_clip in NON_CROSSFADE_CLIPS or current_clip in NON_CROSSFADE_CLIPS:
        return None
    return 0.10 if previous_clip != current_clip else 0.045


@dataclass(frozen=True)
class Clip:
    name: str
    frames: tuple[str, ...]
    frame_ms: int
    loop: bool
    motion: str | None = None


class AnimationModel:
    def __init__(self, manifest: dict[str, Any]) -> None:
        self.clips = {
            name: Clip(
                name=name,
                frames=tuple(value["frames"]),
                frame_ms=int(value["frameMs"]),
                loop=bool(value["loop"]),
                motion=value.get("motion"),
            )
            for name, value in manifest["clips"].items()
        }
        self.state_map = dict(manifest["stateMap"])
        self.working_activity_map = dict(manifest.get("workingActivityMap", {}))
        self.idle_micro_clips = tuple(manifest.get("idleMicroClips", ()))
        self.base_state = "IDLE"
        self.base_activity: str | None = None
        self.base_clip_name = self.state_map["IDLE"]
        self.overlay_clip_name: str | None = None
        self.pulse_state: str | None = None
        self.pulse_deadline_ms: int | None = None
        self.pulse_clip_name: str | None = None
        self.active_clip_name = self.base_clip_name
        self.frame_index = 0
        self.frame_elapsed_ms = 0

    @property
    def active_clip(self) -> Clip:
        return self.clips[self.active_clip_name]

    @property
    def frame(self) -> str:
        return self.active_clip.frames[self.frame_index]

    def apply_state(self, state: str, activity: str | None = None) -> None:
        if state not in STATES:
            return
        self.base_state = state
        self.base_activity = activity
        self.base_clip_name = self._clip_for(state, activity)
        self.pulse_state = None
        self.pulse_deadline_ms = None
        self.pulse_clip_name = None
        if self.overlay_clip_name is None:
            self._activate(self.base_clip_name)

    def apply_pulse(
        self,
        state: str,
        ttl_ms: int,
        now_ms: int,
        resume_state: str | None = None,
        resume_activity: str | None = None,
    ) -> None:
        if state not in STATES or ttl_ms <= 0:
            return
        if resume_state in STATES:
            self.base_state = resume_state
            self.base_activity = resume_activity
            self.base_clip_name = self._clip_for(resume_state, resume_activity)
        self.pulse_state = state
        self.pulse_deadline_ms = now_ms + ttl_ms
        self.pulse_clip_name = self._clip_for(state, None)
        if self.overlay_clip_name is None:
            self._activate(self.pulse_clip_name)

    def play_overlay(self, clip_name: str) -> bool:
        if clip_name not in self.clips:
            return False
        self.overlay_clip_name = clip_name
        self._activate(clip_name)
        return True

    def clear_overlay(self) -> None:
        self.overlay_clip_name = None
        self._activate(self._underlay_clip_name())

    def play_idle_micro(self, index: int = 0) -> bool:
        if self.base_state != "IDLE" or self.overlay_clip_name is not None or self.pulse_state is not None:
            return False
        if not self.idle_micro_clips:
            return False
        return self.play_overlay(self.idle_micro_clips[index % len(self.idle_micro_clips)])

    def advance(self, elapsed_ms: int, now_ms: int) -> None:
        if elapsed_ms < 0:
            return
        if self.pulse_deadline_ms is not None and now_ms >= self.pulse_deadline_ms:
            self.pulse_state = None
            self.pulse_deadline_ms = None
            self.pulse_clip_name = None
            if self.overlay_clip_name is None:
                self._activate(self.base_clip_name)

        clip = self.active_clip
        if len(clip.frames) <= 1:
            return
        self.frame_elapsed_ms += elapsed_ms
        while self.frame_elapsed_ms >= clip.frame_ms:
            self.frame_elapsed_ms -= clip.frame_ms
            if self.frame_index + 1 < len(clip.frames):
                self.frame_index += 1
                continue
            if clip.loop:
                self.frame_index = 0
                continue
            if self.overlay_clip_name is not None:
                self.overlay_clip_name = None
                self._activate(self._underlay_clip_name())
            else:
                self.frame_index = len(clip.frames) - 1
            break

    def _clip_for(self, state: str, activity: str | None) -> str:
        if state == "WORKING" and activity in self.working_activity_map:
            return self.working_activity_map[activity]
        return self.state_map.get(state, self.state_map["IDLE"])

    def _underlay_clip_name(self) -> str:
        return self.pulse_clip_name or self.base_clip_name

    def _activate(self, clip_name: str) -> None:
        if self.active_clip_name == clip_name:
            return
        self.active_clip_name = clip_name
        self.frame_index = 0
        self.frame_elapsed_ms = 0
