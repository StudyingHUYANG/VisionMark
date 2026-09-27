import json
import math
import sys
import traceback
from pathlib import Path

import numpy as np
from PIL import Image


DEFAULT_OPTIONS = {
    "histBins": 16,
    "baseThreshold": 0.55,
    "maxDynamicThreshold": 0.92,
    "peakStdFactor": 1.35,
    "ssimThreshold": 0.6,
    "histThreshold": 0.38,
    "phashThreshold": 0.32,
    "strongThreshold": 0.72,
    "minGapSeconds": 15.0,
    "warmupSeconds": 1.5,
    "ignoreEndSeconds": 15.0,
    "ignoreEndMinDuration": 60.0,
    "maxCuts": 80,
    "weights": {
        "ssim": 0.45,
        "histogram": 0.35,
        "phash": 0.20,
    },
}


def deep_merge(base, override):
    result = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            nested = dict(result[key])
            nested.update(value)
            result[key] = nested
        else:
            result[key] = value
    return result


def as_float(value, default=0.0):
    try:
        number = float(value)
        if math.isfinite(number):
            return number
    except (TypeError, ValueError):
        pass
    return default


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def load_image_features(frame_path, hist_bins):
    image = Image.open(frame_path).convert("RGB")

    small_rgb = image.resize((160, 90), Image.Resampling.BILINEAR)
    rgb = np.asarray(small_rgb, dtype=np.float32) / 255.0
    gray = (
        0.299 * rgb[:, :, 0]
        + 0.587 * rgb[:, :, 1]
        + 0.114 * rgb[:, :, 2]
    ).astype(np.float64)

    hist_parts = []
    for channel in range(3):
        hist, _ = np.histogram(
            rgb[:, :, channel],
            bins=hist_bins,
            range=(0.0, 1.0),
            density=False,
        )
        hist = hist.astype(np.float64)
        hist = hist / (hist.sum() + 1e-12)
        hist_parts.append(hist)

    phash_gray = image.convert("L").resize((32, 32), Image.Resampling.LANCZOS)
    phash_matrix = np.asarray(phash_gray, dtype=np.float64)

    return {
        "gray": gray,
        "hist": np.concatenate(hist_parts),
        "phash": perceptual_hash(phash_matrix),
    }


def dct_basis(size):
    basis = np.zeros((size, size), dtype=np.float64)
    factor = math.pi / (2.0 * size)
    scale0 = math.sqrt(1.0 / size)
    scale = math.sqrt(2.0 / size)
    for k in range(size):
        alpha = scale0 if k == 0 else scale
        for n in range(size):
            basis[k, n] = alpha * math.cos((2 * n + 1) * k * factor)
    return basis


DCT_32 = dct_basis(32)


def perceptual_hash(gray_32):
    dct = DCT_32 @ gray_32 @ DCT_32.T
    low = dct[:8, :8].copy()
    values = low.flatten()[1:]
    median = np.median(values)
    return (low.flatten() > median).astype(np.uint8)


def histogram_diff(left, right):
    # Three channels, each normalized to sum=1. The L1 maximum is 6.
    return clamp(float(np.abs(left - right).sum() / 6.0))


def ssim_diff(left, right):
    x = left.astype(np.float64)
    y = right.astype(np.float64)
    mean_x = x.mean()
    mean_y = y.mean()
    var_x = x.var()
    var_y = y.var()
    covariance = ((x - mean_x) * (y - mean_y)).mean()
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    numerator = (2 * mean_x * mean_y + c1) * (2 * covariance + c2)
    denominator = (mean_x * mean_x + mean_y * mean_y + c1) * (var_x + var_y + c2)
    if denominator == 0:
        return 0.0
    similarity = numerator / denominator
    return clamp(1.0 - clamp(float(similarity)))


def phash_diff(left, right):
    if left.size == 0 or right.size == 0:
        return 0.0
    distance = np.count_nonzero(left != right)
    return clamp(float(distance / max(left.size, 1)))


def build_reasons(point, options, threshold):
    reasons = ["visual_change"]

    if point["ssimDiff"] >= as_float(options.get("ssimThreshold"), 0.6):
        reasons.append("ssim_drop")
    if point["histDiff"] >= as_float(options.get("histThreshold"), 0.38):
        reasons.append("histogram_diff")
    if point["phashDiff"] >= as_float(options.get("phashThreshold"), 0.32):
        reasons.append("phash_diff")
    if point["score"] >= threshold:
        reasons.append("visual_peak")

    strong_threshold = as_float(options.get("strongThreshold"), 0.72)
    if (
        point["score"] >= strong_threshold
        or (
            point["ssimDiff"] >= as_float(options.get("ssimThreshold"), 0.6)
            and point["histDiff"] >= as_float(options.get("histThreshold"), 0.38) * 0.7
        )
    ):
        reasons.append("scene_change")

    return list(dict.fromkeys(reasons))


def dominant_method(point, weights):
    contributions = {
        "ssim": point["ssimDiff"] * as_float(weights.get("ssim"), 0.45),
        "histogram": point["histDiff"] * as_float(weights.get("histogram"), 0.35),
        "phash": point["phashDiff"] * as_float(weights.get("phash"), 0.20),
    }
    return max(contributions, key=contributions.get)


def detect_visual_cuts(frames, options):
    hist_bins = int(as_float(options.get("histBins"), 16))
    hist_bins = max(4, min(64, hist_bins))
    weights = options.get("weights") or DEFAULT_OPTIONS["weights"]

    valid_frames = []
    for frame in frames:
        frame_path = Path(str(frame.get("framePath") or frame.get("path") or ""))
        if not frame_path.exists():
            continue
        valid_frames.append(
            {
                "framePath": str(frame_path),
                "time": as_float(frame.get("time"), 0.0),
            }
        )

    valid_frames.sort(key=lambda item: item["time"])

    if len(valid_frames) < 2:
        return {
            "visualCuts": [],
            "stats": {
                "frameCount": len(valid_frames),
                "transitionCount": 0,
                "threshold": None,
                "meanScore": 0.0,
                "stdScore": 0.0,
            },
        }

    features = []
    for frame in valid_frames:
        features.append(load_image_features(frame["framePath"], hist_bins))

    transitions = []
    for index in range(1, len(valid_frames)):
        prev_features = features[index - 1]
        next_features = features[index]
        hist = histogram_diff(prev_features["hist"], next_features["hist"])
        ssim = ssim_diff(prev_features["gray"], next_features["gray"])
        phash = phash_diff(prev_features["phash"], next_features["phash"])
        score = (
            as_float(weights.get("ssim"), 0.45) * ssim
            + as_float(weights.get("histogram"), 0.35) * hist
            + as_float(weights.get("phash"), 0.20) * phash
        )
        transitions.append(
            {
                "index": index,
                "previousTime": valid_frames[index - 1]["time"],
                "time": valid_frames[index]["time"],
                "score": clamp(score),
                "ssimDiff": ssim,
                "histDiff": hist,
                "phashDiff": phash,
            }
        )

    scores = np.asarray([item["score"] for item in transitions], dtype=np.float64)
    mean_score = float(scores.mean()) if scores.size else 0.0
    std_score = float(scores.std()) if scores.size else 0.0
    base_threshold = as_float(options.get("baseThreshold"), 0.55)
    peak_std_factor = as_float(options.get("peakStdFactor"), 1.35)
    max_dynamic_threshold = as_float(options.get("maxDynamicThreshold"), 0.92)
    dynamic_threshold = mean_score + peak_std_factor * std_score
    threshold = min(max_dynamic_threshold, max(base_threshold, dynamic_threshold))

    warmup_seconds = as_float(options.get("warmupSeconds"), 1.5)
    min_gap_seconds = as_float(options.get("minGapSeconds"), 2.0)
    ignore_end_seconds = as_float(options.get("ignoreEndSeconds"), 0.0)
    ignore_end_min_duration = as_float(options.get("ignoreEndMinDuration"), 60.0)
    max_cuts = int(as_float(options.get("maxCuts"), 80))
    video_end_time = valid_frames[-1]["time"] if valid_frames else 0.0
    should_guard_video_end = video_end_time >= ignore_end_min_duration and ignore_end_seconds > 0

    peaks = []
    for index, point in enumerate(transitions):
        if point["time"] < warmup_seconds:
            continue
        if should_guard_video_end and video_end_time - point["time"] <= ignore_end_seconds:
            continue

        prev_score = transitions[index - 1]["score"] if index > 0 else -1.0
        next_score = transitions[index + 1]["score"] if index + 1 < len(transitions) else -1.0
        is_local_peak = point["score"] >= prev_score and point["score"] >= next_score
        has_metric_trigger = (
            point["ssimDiff"] >= as_float(options.get("ssimThreshold"), 0.6)
            or point["histDiff"] >= as_float(options.get("histThreshold"), 0.38)
            or point["phashDiff"] >= as_float(options.get("phashThreshold"), 0.32)
        )

        if point["score"] >= threshold and is_local_peak and has_metric_trigger:
            candidate = {
                "time": round(point["time"], 3),
                "score": round(point["score"], 4),
                "reasons": build_reasons(point, options, threshold),
                "method": dominant_method(point, weights),
                "metrics": {
                    "ssimDiff": round(point["ssimDiff"], 4),
                    "histDiff": round(point["histDiff"], 4),
                    "phashDiff": round(point["phashDiff"], 4),
                },
                "previousTime": round(point["previousTime"], 3),
            }
            peaks.append(candidate)

    selected = []
    for peak in sorted(peaks, key=lambda item: item["time"]):
        if selected and peak["time"] - selected[-1]["time"] < min_gap_seconds:
            if peak["score"] > selected[-1]["score"]:
                selected[-1] = peak
            continue
        selected.append(peak)

    if max_cuts > 0 and len(selected) > max_cuts:
        selected = sorted(selected, key=lambda item: item["score"], reverse=True)[:max_cuts]
        selected.sort(key=lambda item: item["time"])

    return {
        "visualCuts": selected,
        "stats": {
            "frameCount": len(valid_frames),
            "transitionCount": len(transitions),
            "threshold": round(threshold, 4),
            "meanScore": round(mean_score, 4),
            "stdScore": round(std_score, 4),
            "baseThreshold": base_threshold,
            "peakStdFactor": peak_std_factor,
            "minGapSeconds": min_gap_seconds,
            "warmupSeconds": warmup_seconds,
            "ignoreEndSeconds": ignore_end_seconds if should_guard_video_end else 0.0,
            "ignoreEndMinDuration": ignore_end_min_duration,
        },
        "transitions": [
            {
                "time": round(item["time"], 3),
                "score": round(item["score"], 4),
                "ssimDiff": round(item["ssimDiff"], 4),
                "histDiff": round(item["histDiff"], 4),
                "phashDiff": round(item["phashDiff"], 4),
            }
            for item in transitions
        ],
    }


def main():
    try:
        payload = json.load(sys.stdin)
        options = deep_merge(DEFAULT_OPTIONS, payload.get("options") or {})
        frames = payload.get("frames") or []
        result = detect_visual_cuts(frames, options)
        if not payload.get("includeDebug"):
            result.pop("transitions", None)
        json.dump(result, sys.stdout, ensure_ascii=False)
    except Exception as error:
        json.dump(
            {
                "error": str(error),
                "traceback": traceback.format_exc(),
            },
            sys.stdout,
            ensure_ascii=False,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
