#!/usr/bin/env python3
"""アプリアイコン（PNG）を標準ライブラリだけで生成する。"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (31, 78, 121)
FG = (255, 255, 255)
# チェックマークの折れ線（0〜1 の相対座標）。マスカブル用に中央 60% に収める
POINTS = [(0.30, 0.52), (0.44, 0.66), (0.71, 0.37)]
WIDTH = 0.085


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def render(size):
    rows = []
    half = WIDTH * size / 2
    pts = [(x * size, y * size) for x, y in POINTS]
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            d = min(seg_dist(x + 0.5, y + 0.5, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
            a = max(0.0, min(1.0, half - d + 0.5))
            row += bytes(round(BG[c] * (1 - a) + FG[c] * a) for c in range(3))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        (OUT / name).write_bytes(render(size))
        print("wrote", OUT / name)
