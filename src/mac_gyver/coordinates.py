"""Coordinate conversion shared by preview input and region selection."""

from math import isfinite


def fit_rect(width, height, image_width, image_height):
    values = (width, height, image_width, image_height)
    if not all(isfinite(v) and v > 0 for v in values):
        raise ValueError("화면 크기는 양수여야 합니다.")
    scale = min(width / image_width, height / image_height)
    w, h = image_width * scale, image_height * scale
    return (width - w) / 2, (height - h) / 2, w, h


def normalized_point(x, y, rect):
    left, top, width, height = rect
    if not all(isfinite(v) for v in (x, y, left, top, width, height)):
        return None
    if width <= 0 or height <= 0 or not (left <= x <= left + width and top <= y <= top + height):
        return None
    return {"x": min(1.0, max(0.0, (x - left) / width)),
            "y": min(1.0, max(0.0, (y - top) / height))}


def selection_region(first, second):
    x, y = min(first["x"], second["x"]), min(first["y"], second["y"])
    width, height = abs(first["x"] - second["x"]), abs(first["y"] - second["y"])
    if width < .005 or height < .005:
        raise ValueError("검사할 영역을 조금 더 크게 선택해 주세요.")
    return {"x": x, "y": y, "width": width, "height": height}
