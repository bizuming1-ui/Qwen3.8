"""Automatic, transcript-preserving preparation for the simple real-training flow.

The UI receives one complete ASR transcript.  Internal windows are an implementation
/detail of the acoustic trainer, never a requirement for the user to split text.
No model, optimizer, or quality claim lives in this module.
"""
from __future__ import annotations

import hashlib
import io
import math
import uuid
import wave

import numpy as np

from resource_limits import UploadRejected
from training_data import transcript

SR = 24000
MAX_WINDOWS = 16
WINDOW_SECONDS = 16
MAX_FULL_TRANSCRIPT = 200_000


def join_transcript(clips) -> str:
    """Join ordered ASR clips without exposing artificial segment boundaries."""
    ordered = sorted(clips, key=lambda c: (int(c.get("f", 0)), float(c.get("start", 0)), float(c.get("end", 0))))
    result = ""
    for clip in ordered:
        value = str(clip.get("text", "")).strip()
        if not value:
            continue
        if result:
            left, right = result[-1], value[0]
            # Whisper commonly strips the leading space between Latin words.
            # CJK and punctuation should not acquire a space on every ASR segment.
            if left.isascii() and right.isascii() and (left.isalnum() and right.isalnum()):
                result += " "
        result += value
    if len(result) > MAX_FULL_TRANSCRIPT:
        raise UploadRejected("complete transcript exceeds the bounded profile text budget", 413)
    return result


def _window_text(group) -> str:
    return join_transcript([dict(c, f=0) for c in group])


def _pcm16_wav(samples: np.ndarray) -> bytes:
    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not values.size or not np.isfinite(values).all():
        raise UploadRejected("training window contains invalid audio", 400)
    pcm = (np.clip(values, -1.0, 1.0) * 32767.0).round().astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SR)
        stream.writeframes(pcm.tobytes())
    return output.getvalue()


def _evenly_cover(candidates: list[dict], maximum: int = MAX_WINDOWS) -> list[dict]:
    """Keep bounded trainer inputs while covering the beginning, middle and end.

    Existing immutable SFT/codes stores intentionally admit at most 16 rows.  A
    long recording is therefore sampled across its whole time span rather than
    silently truncating to its first 16 seconds.  The receipt reports this policy;
    it does not claim that every source second became an optimizer row.
    """
    if len(candidates) <= maximum:
        return candidates
    indices = sorted({int(round(i * (len(candidates) - 1) / (maximum - 1))) for i in range(maximum)})
    return [candidates[i] for i in indices]


def make_windows(cleaned, clips, *, maximum: int = MAX_WINDOWS) -> tuple[list[dict], dict]:
    """Build aligned canonical WAV windows from the existing timestamped ASR clips."""
    if not cleaned or not clips:
        raise UploadRejected("no speech with a usable transcript was found", 400)
    by_file = {index: (name, np.asarray(y, dtype=np.float32)) for index, (name, y) in enumerate(cleaned)}
    candidates = []
    skipped = 0
    for file_index, (filename, audio) in by_file.items():
        duration = len(audio) / SR
        ordered = sorted((c for c in clips if int(c.get("f", -1)) == file_index), key=lambda c: (float(c["start"]), float(c["end"])))
        group = []

        def flush():
            nonlocal skipped
            if not group:
                return
            start = max(0.0, float(group[0]["start"]) - 0.05)
            end = min(duration, float(group[-1]["end"]) + 0.08)
            if end - start > WINDOW_SECONDS:
                start, end = float(group[0]["start"]), float(group[-1]["end"])
            # A short trailing phrase can include its actual surrounding silence;
            # never pad a short file with fabricated samples or duplicate speech.
            if end - start < 1.5 and duration >= 1.5:
                middle = (start + end) / 2
                start = max(0.0, middle - 0.75)
                end = min(duration, start + 1.5)
                start = max(0.0, end - 1.5)
            if end - start < 1.5 or end - start > WINDOW_SECONDS + 0.02:
                skipped += 1
                return
            text = _window_text(group)
            try:
                text = transcript(text)
                wav = _pcm16_wav(audio[int(round(start * SR)):int(round(end * SR))])
            except (UploadRejected, ValueError):
                skipped += 1
                return
            candidates.append({
                "wav": wav, "text": text, "source_name": filename,
                "start": round(start, 6), "end": round(end, 6),
                "seconds": round(end - start, 6),
                "confidence": float(np.mean([float(c.get("logprob", -0.5)) for c in group])),
            })

        for clip in ordered:
            start, end = float(clip["start"]), float(clip["end"])
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + 0.02):
                skipped += 1
                continue
            if end - start > WINDOW_SECONDS + 0.02:
                # prepare_segments() normally prevents this.  Refuse a guessed
                # text/audio cut if an alternate ASR backend violates that contract.
                raise UploadRejected("an ASR segment exceeds the safe aligned training window", 409)
            if group:
                gap = start - float(group[-1]["end"])
                span = end - float(group[0]["start"])
                if gap > 1.0 or span > WINDOW_SECONDS:
                    flush()
                    group = []
            group.append(clip)
        flush()
    if not candidates:
        raise UploadRejected("no non-silent aligned training window of at least 1.5 seconds could be made", 400)
    selected = _evenly_cover(candidates, maximum)
    # LibraryStore deliberately deduplicates identical audio.  Remove duplicate
    # candidates here so the text-to-sample mapping remains unambiguous.
    unique = []
    seen = set()
    for candidate in selected:
        digest = hashlib.sha256(candidate["wav"]).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        unique.append(candidate)
    selected = unique
    total_seconds = sum(len(audio) / SR for _, audio in cleaned)
    selected_seconds = sum(c["seconds"] for c in selected)
    all_windows_selected = len(selected) == len(candidates)
    # This flag is intentionally conservative: silence/gaps and skipped clips are
    # not optimizer rows, even when every candidate window was selected.
    all_source_rows = bool(not skipped and all_windows_selected and abs(selected_seconds - total_seconds) < 0.05)
    report = {
        "candidate_window_count": len(candidates),
        "selected_window_count": len(selected),
        "skipped_window_count": skipped,
        "source_seconds": round(total_seconds, 6),
        "selected_audio_seconds": round(selected_seconds, 6),
        "source_coverage_ratio": round(selected_seconds / max(total_seconds, 1e-9), 6),
        "selection_policy": "even-time-coverage" if len(candidates) > len(selected) else "all-aligned-windows",
        "all_candidate_windows_selected": all_windows_selected,
        "all_source_seconds_used_as_optimizer_rows": all_source_rows,
        "internal_window_seconds_max": WINDOW_SECONDS,
        "transcript_is_asr_not_human_verified": True,
    }
    return selected, report


def prepare_snapshot(libraries, training_data, *, name: str, language: str, cleaned, clips) -> dict:
    """Publish an ordinary immutable TrainingDataStore snapshot automatically."""
    full_text = join_transcript(clips)
    if not full_text:
        raise UploadRejected("ASR returned no complete reference text", 400)
    selected, window_report = make_windows(cleaned, clips)
    library_name = (name.strip()[:40] or "voice") + " · train-" + uuid.uuid4().hex[:8]
    library = libraries.create(library_name, language or "auto")
    try:
        added = libraries.add(library["id"], library["revision"], [
            ("simple-window-%03d.wav" % index, candidate["wav"])
            for index, candidate in enumerate(selected)
        ])
        by_hash = {sample["sha256"]: sample for sample in added["samples"]}
        rows = []
        ids = []
        for candidate in selected:
            digest = hashlib.sha256(candidate["wav"]).hexdigest()
            sample = by_hash.get(digest)
            if sample is None:
                raise UploadRejected("automatic training window was not persisted exactly once", 409)
            ids.append(sample["id"])
            rows.append({"id": sample["id"], "text": candidate["text"]})
        if len(set(ids)) != len(ids) or not rows:
            raise UploadRejected("automatic training sample mapping is ambiguous", 409)
        # Prefer a normal 5–16 s reference when available; otherwise use the
        # actual aligned window, never a truncated long reference.
        reference_index = next((i for i, c in enumerate(selected) if 5 <= c["seconds"] <= 16), 0)
        dataset = training_data.prepare(libraries, {
            "library_id": library["id"],
            "revision": added["revision"],
            "samples": rows,
            "reference_sample_id": ids[reference_index],
            "voice_rights_confirmed": True,
            "single_speaker_confirmed": True,
        })
        return {
            "dataset": dataset,
            "library_id": library["id"],
            "full_ref_text": full_text,
            "allow_single_sample": len(rows) == 1,
            "reference_sample_index": reference_index,
            "windows": window_report,
            "transcript_source": "automatic_asr",
            "transcript_verified": False,
            "operation": "automatic_input_preparation_not_training",
        }
    except Exception:
        # Keep the private library for diagnosis/recovery; do not delete a
        # snapshot which may already have been committed by TrainingDataStore.
        raise
