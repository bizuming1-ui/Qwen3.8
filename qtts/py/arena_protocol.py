"""QTTS browser wire protocol and prosody planner.

This is a Python runtime adapter for the preserved Go gateway. Client frames are
byte-compatible: type:u8, segment:u32le, payload_length:u32le, payload.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import json
import math
import os
from pathlib import Path
import random
import re
import struct
import unicodedata

from voice_binding import reference_binding

SAMPLE_RATE = 24000
C_PCM, C_SEG, C_TEXT, C_STATS, C_END, C_ERROR, C_POLICY = range(1, 8)
F_PCM, F_STATS, F_ERR, F_END = 1, 2, 3, 4
PROFILE_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def frame(kind: int, segment: int, payload: bytes = b"") -> bytes:
    return struct.pack("<BII", kind, segment, len(payload)) + payload


def json_frame(kind: int, segment: int, value) -> bytes:
    return frame(kind, segment, json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode())


def policy_for(aggregate_rtf: float, underruns: int = 0) -> dict:
    if aggregate_rtf >= 2.2:
        low, high, start = 3.5, 36.0, 1.3
    elif aggregate_rtf >= 1.5:
        low, high, start = 5.0, 42.0, 2.0
    elif aggregate_rtf >= 1.0:
        low, high, start = 7.0, 50.0, 3.5
    else:
        low, high, start = 10.0, 60.0, 6.0
    return {
        "low_s": low + min(underruns * 1.5, 6),
        "high_s": high,
        "start_s": start + min(underruns, 3),
        "agg_rtf": aggregate_rtf,
    }


def detect_lang(text: str) -> str:
    cjk = kana = hangul = latin = 0
    for char in text:
        point = ord(char)
        if 0x3040 <= point <= 0x30FF:
            kana += 1
        elif 0xAC00 <= point <= 0xD7AF:
            hangul += 1
        elif 0x3400 <= point <= 0x9FFF:
            cjk += 1
        elif "a" <= char.lower() <= "z":
            latin += 1
    if kana > 0 and kana >= cjk * 0.2:
        return "Japanese"
    if hangul > cjk and hangul > 0:
        return "Korean"
    if cjk > 0 and cjk >= latin * 0.35:
        return "Chinese"
    return "English"


def is_cjk(char: str) -> bool:
    try:
        name = unicodedata.name(char)
    except ValueError:
        return False
    return any(token in name for token in ("CJK UNIFIED", "HIRAGANA", "KATAKANA", "HANGUL"))


def is_word(char: str) -> bool:
    return char.isalnum() or char == "'"


def units(text: str) -> float:
    total = 0.0
    inside = False
    for char in text:
        if is_cjk(char):
            total += 1
            inside = False
        elif is_word(char):
            if not inside:
                total += 1.6
            inside = True
        else:
            inside = False
    return total


class Boundary(IntEnum):
    NONE = 0
    CLAUSE = 1
    SENTENCE = 2
    PARA = 3
    ELLIPSIS = 4

    @property
    def label(self) -> str:
        return ("none", "clause", "sentence", "para", "ellipsis")[int(self)]


@dataclass
class Segment:
    index: int
    text: str
    units: float
    pause_ms: int = 0
    breath: bool = False
    boundary: Boundary = Boundary.NONE
    boundary_name: str = ""

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "text": self.text,
            "units": self.units,
            "pause_ms": self.pause_ms,
            "breath": self.breath,
            "boundary": self.boundary_name,
        }


@dataclass
class SegCfg:
    immediate_first: bool = False
    preserve_text: bool = True
    first_min: float = 7
    first_max: float = 20
    minimum: float = 12
    target: float = 26
    maximum: float = 64
    pause_clause: int = 150
    pause_sentence: int = 340
    pause_para: int = 560
    pause_ellipsis: int = 460

    @classmethod
    def for_profile(cls, profile: dict | None, mode: str = "read") -> "SegCfg":
        cfg = cls()
        if profile:
            cfg.pause_clause = clamp(int(profile.get("pause_clause_ms") or cfg.pause_clause), 60, 400)
            cfg.pause_sentence = clamp(int(profile.get("pause_sentence_ms") or cfg.pause_sentence), 160, 800)
            cfg.pause_para = clamp(int(profile.get("pause_para_ms") or cfg.pause_para), 260, 1200)
            cfg.pause_ellipsis = clamp(int(cfg.pause_sentence * 1.35), 260, 900)
        if mode == "read":
            cfg.first_min, cfg.first_max = 12, 24
            cfg.minimum, cfg.target, cfg.maximum = 20, 40, 80
        else:
            cfg.immediate_first = True
        return cfg


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


CLOSERS = set("\"'”’」』）)】]》>")
PUNCT = set("。！？!?…；;，,、：:—.")
PAIRS = {"“": "”", "「": "」", "『": "』", "（": "）", "(": ")", "【": "】", "《": "》"}
SENTENCE = set("。！？!?…")
CLAUSE = set("；;，,、：:—")


def open_first_delimiter(buffer: list[str]) -> bool:
    stack: list[str] = []
    quoted = False
    for char in buffer:
        if char == '"':
            quoted = not quoted
        elif char in PAIRS:
            stack.append(PAIRS[char])
        elif stack and char == stack[-1]:
            stack.pop()
    return quoted or bool(stack)


def classify(buffer: list[str], index: int, final: bool) -> int:
    """0=none, 1=clause, 2=sentence, 3=paragraph."""
    char = buffer[index]
    if char in SENTENCE:
        return 2
    if char == "\n":
        return 3
    if char in CLAUSE:
        return 1
    if char == ".":
        if index + 1 < len(buffer):
            following = buffer[index + 1]
            if index > 0 and buffer[index - 1].isdigit() and following.isdigit():
                return 0
            return 2 if following.isspace() or is_cjk(following) or following == "." or following in CLOSERS else 0
        return 2
    return 0


class Segmenter:
    def __init__(self, cfg: SegCfg, seed: int):
        self.cfg = cfg
        self.buffer: list[str] = []
        self.index = 0
        self.last_boundary = Boundary.NONE
        self.since_breath = 0.0
        self.random = random.Random(seed)

    def limits(self) -> tuple[float, float, float]:
        if self.index == 0:
            return self.cfg.first_min, self.cfg.first_min, self.cfg.first_max
        return self.cfg.minimum, self.cfg.target, self.cfg.maximum

    def cut(self, final: bool) -> tuple[int, Boundary, bool]:
        minimum, target, maximum = self.limits()
        total = 0.0
        inside = False
        last_clause, last_clause_units = -1, 0.0
        i = 0
        while i < len(self.buffer):
            char = self.buffer[i]
            if is_cjk(char):
                total += 1
                inside = False
            elif is_word(char):
                if not inside:
                    total += 1.6
                inside = True
            else:
                inside = False
            kind = classify(self.buffer, i, final)
            if kind == 0:
                if total >= maximum:
                    if last_clause >= 0 and last_clause_units >= minimum:
                        return last_clause, Boundary.CLAUSE, True
                    if char.isspace() or is_cjk(char):
                        return i + 1, Boundary.NONE, True
                i += 1
                continue
            j = i + 1
            ellipsis = char == "…"
            dots = 1 if char == "." else 0
            while j < len(self.buffer) and (
                self.buffer[j] in PUNCT or self.buffer[j] in CLOSERS or (self.buffer[j] == "\n" and kind == 3)
            ):
                ellipsis = ellipsis or self.buffer[j] == "…"
                dots += self.buffer[j] == "."
                j += 1
            ellipsis = ellipsis or dots >= 3
            if j >= len(self.buffer) and not final:
                if self.cfg.immediate_first and self.index == 0 and char != "." and not open_first_delimiter(self.buffer[:j]):
                    if kind in (2, 3) and total >= 1:
                        boundary = Boundary.PARA if kind == 3 else Boundary.ELLIPSIS if ellipsis else Boundary.SENTENCE
                        return j, boundary, True
                    if kind == 1 and total >= minimum:
                        return j, Boundary.CLAUSE, True
                return 0, Boundary.NONE, False
            while j < len(self.buffer) and self.buffer[j] in " \t":
                j += 1
            if j >= len(self.buffer) and not final:
                if self.cfg.immediate_first and self.index == 0 and char != "." and not open_first_delimiter(self.buffer[:j]):
                    if kind in (2, 3) and total >= 1:
                        boundary = Boundary.PARA if kind == 3 else Boundary.ELLIPSIS if ellipsis else Boundary.SENTENCE
                        return j, boundary, True
                    if kind == 1 and total >= minimum:
                        return j, Boundary.CLAUSE, True
                return 0, Boundary.NONE, False
            effective = 3 if kind == 2 and j > 0 and self.buffer[j - 1] == "\n" else kind
            if effective in (2, 3):
                boundary = Boundary.PARA if effective == 3 else Boundary.ELLIPSIS if ellipsis else Boundary.SENTENCE
                if total >= minimum or (self.cfg.immediate_first and self.index == 0 and total >= 1) or (effective == 3 and total >= 3) or (final and j >= len(self.buffer)):
                    return j, boundary, True
                last_clause, last_clause_units = j, total
            elif effective == 1:
                if total >= target:
                    return j, Boundary.CLAUSE, True
                last_clause, last_clause_units = j, total
            i = j
        return 0, Boundary.NONE, False

    def pause_for(self, boundary: Boundary) -> int:
        base = {
            Boundary.CLAUSE: self.cfg.pause_clause,
            Boundary.SENTENCE: self.cfg.pause_sentence,
            Boundary.PARA: self.cfg.pause_para,
            Boundary.ELLIPSIS: self.cfg.pause_ellipsis,
        }.get(boundary)
        if base is None:
            return 60
        return int(base * (0.88 + 0.24 * self.random.random()))

    def finish(self, raw: list[str], boundary: Boundary) -> Segment | None:
        text = "".join(raw)
        if not any(is_word(char) or is_cjk(char) for char in text):
            self.last_boundary = max(self.last_boundary, boundary)
            return None
        segment = Segment(self.index, text, units(text))
        if self.index > 0:
            segment.pause_ms = self.pause_for(self.last_boundary)
            segment.boundary = self.last_boundary
            segment.boundary_name = self.last_boundary.label
            if self.last_boundary == Boundary.PARA:
                segment.breath = True
            elif self.last_boundary in (Boundary.SENTENCE, Boundary.ELLIPSIS):
                segment.breath = self.since_breath >= 16 or self.random.random() < 0.35
            elif self.last_boundary == Boundary.CLAUSE:
                segment.breath = self.since_breath >= 34 and segment.pause_ms >= 200
                if segment.breath:
                    segment.pause_ms = clamp(segment.pause_ms + 120, 200, 600)
            if segment.breath and segment.pause_ms < 280:
                segment.pause_ms = 280
        if segment.breath:
            self.since_breath = 0
        self.since_breath += segment.units
        self.last_boundary = boundary
        self.index += 1
        return segment

    def drain(self, final: bool) -> list[Segment]:
        output = []
        while self.buffer:
            end, boundary, ok = self.cut(final)
            if not ok:
                if final:
                    segment = self.finish(self.buffer, Boundary.NONE)
                    if segment:
                        output.append(segment)
                    self.buffer = []
                break
            raw = self.buffer[:end]
            self.buffer = self.buffer[end:]
            segment = self.finish(raw, boundary)
            if segment:
                output.append(segment)
        return output

    def feed(self, delta: str) -> list[Segment]:
        self.buffer.extend(delta)
        return self.drain(False)

    def flush(self) -> list[Segment]:
        return self.drain(True)


def load_profile(state: Path, profile_id: str, mock: bool) -> dict:
    if not PROFILE_ID.fullmatch(profile_id):
        raise ValueError("invalid profile id")
    path = state / "profiles" / profile_id / "profile.json"
    if not path.is_file():
        raise FileNotFoundError(f"profile {profile_id!r} not found")
    profile = json.loads(path.read_text(encoding="utf-8"))
    if profile.get("id") not in (None, "", profile_id):
        raise ValueError("profile id mismatch")
    profile["id"] = profile_id
    if mock:
        profile["voice_conditioning"] = "mock"
    elif profile.get("model_output_mode") == "sentence-buffered" or os.environ.get("QTTS_TTS_ENGINE", "faster") == "qwen-adapter-buffered":
        profile["voice_conditioning"] = "trained-speaker-vector"
    elif os.environ.get("QTTS_CLONE_MODE", "xvector").strip().lower() == "xvector":
        profile["voice_conditioning"] = "speaker-vector-only"
    else:
        profile["voice_conditioning"] = "icl-generated-only-codec"
    profile["voice_binding"] = reference_binding(path.parent, profile, allow_missing=mock) if profile.get("anchor") else ""
    return profile


def active_profile(state: Path) -> str:
    try:
        value = json.loads((state / "active.json").read_text(encoding="utf-8")).get("id", "")
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def finite_number(value, default=0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default
