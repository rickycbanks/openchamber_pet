#!/usr/bin/env python3
"""Verify the pet sprite sheet grid and regenerate assets/animations.json.

Grid: 1536x2288 RGBA = 8 cols x 11 rows of 192x208 frames (88 cells).
Checks that gutter lines at multiples of 192 (cols) and 208 (rows) are fully
transparent, reports per-cell alpha occupancy, diffs rows to detect
duplicates, and writes a labeled contact sheet to tools/contact-sheet.png
for human labeling of the animations.

Usage: python3 tools/slice.py [--contact-sheet PATH] [--write-json]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "assets" / "spritesheet.png"
OUT_JSON = ROOT / "assets" / "animations.json"

COLS, ROWS = 8, 11
FW, FH = 192, 208
EXPECT_W, EXPECT_H = COLS * FW, ROWS * FH  # 1536 x 2288

# Occupancy discovered per row (col -> filled). Filled in by inspecting the
# generated contact sheet; slice.py verifies the numbers match the PNG.
EXPECTED_OCCUPANCY = {
    0: 6, 1: 8, 2: 8, 3: 4, 4: 5, 5: 8, 6: 6, 7: 6, 8: 6, 9: 8, 10: 8,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--contact-sheet", default=str(ROOT / "tools" / "contact-sheet.png"))
    ap.add_argument("--write-json", action="store_true",
                    help="rewrite animations.json from the LABELS table below")
    args = ap.parse_args()

    img = Image.open(SHEET)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    if img.size != (EXPECT_W, EXPECT_H):
        print(f"FAIL: expected {EXPECT_W}x{EXPECT_H}, got {img.size[0]}x{img.size[1]}")
        return 1
    arr = np.asarray(img)
    alpha = arr[:, :, 3]

    # --- gutter checks: the 1px lines at multiples of FW / FH must be empty ---
    problems = []
    for c in range(1, COLS):
        x = c * FW - 1
        # check the gutter column across the whole sheet (both lines around the seam)
        gutter = alpha[:, x]
        if gutter.max() > 0:
            problems.append(f"col gutter at x={x} has alpha max {gutter.max()}")
        gutter2 = alpha[:, c * FW]
        if gutter2.max() > 0:
            problems.append(f"col seam at x={c * FW} has alpha max {gutter2.max()}")
    for r in range(1, ROWS):
        y = r * FH - 1
        if alpha[y, :].max() > 0:
            problems.append(f"row gutter at y={y} has alpha max {alpha[y, :].max()}")
        if alpha[r * FH, :].max() > 0:
            problems.append(f"row seam at y={r * FH} has alpha max {alpha[r * FH, :].max()}")
    # full cell borders: every cell edge line must be empty
    for c in range(COLS + 1):
        x = min(c * FW, EXPECT_W - 1)
        if alpha[:, x].max() > 0 and 0 < c < COLS:
            problems.append(f"vertical cell edge x={x} not empty")
    for r in range(ROWS + 1):
        y = min(r * FH, EXPECT_H - 1)
        if alpha[y, :].max() > 0 and 0 < r < ROWS:
            problems.append(f"horizontal cell edge y={y} not empty")

    # --- per-cell occupancy ---
    print(f"sheet {img.size[0]}x{img.size[1]} mode={img.mode} -> grid {COLS}x{ROWS} of {FW}x{FH}")
    if problems:
        for p in problems:
            print("GUTTER:", p)
    else:
        print("gutters: all cell-edge lines fully transparent (0 alpha)")

    occupancy = {}  # row -> list of occupied cols
    for r in range(ROWS):
        cols = []
        for c in range(COLS):
            cell = alpha[r * FH:(r + 1) * FH, c * FW:(c + 1) * FW]
            frac = float((cell > 8).mean())
            if frac > 0.005:  # >0.5% pixels with alpha
                cols.append((c, round(frac, 3)))
        occupancy[r] = cols
        pretty = " ".join(f"{c}:{f}" for c, f in cols)
        empty = " ".join(str(c) for c in range(COLS) if c not in dict(cols))
        print(f"row {r:2d}: {len(cols)} occupied [{pretty}]  empty: {empty}")

    total = sum(len(v) for v in occupancy.values())
    exp_total = sum(EXPECTED_OCCUPANCY.values())
    print(f"total occupied cells: {total} (expected {exp_total})")
    if total != exp_total:
        print("FAIL: occupancy total mismatch")
        return 1
    for r, exp in EXPECTED_OCCUPANCY.items():
        if len(occupancy[r]) != exp:
            print(f"FAIL: row {r} has {len(occupancy[r])} occupied, expected {exp}")
            return 1

    # --- row-vs-row diff (duplicate detection) ---
    print("\nrow diffs (mean abs RGBA diff over shared occupied cols):")
    for r in range(ROWS - 1):
        shared = [c for c, _ in occupancy[r] if any(c == c2 for c2, _ in occupancy[r + 1])]
        if not shared:
            print(f"  rows {r} vs {r+1}: no shared cols")
            continue
        diffs = []
        for c in shared:
            a = arr[r * FH:(r + 1) * FH, c * FW:(c + 1) * FW].astype(np.int16)
            b = arr[(r + 1) * FH:(r + 2) * FH, c * FW:(c + 1) * FW].astype(np.int16)
            diffs.append(float(np.abs(a - b).mean()))
        print(f"  rows {r} vs {r+1}: cols {shared} mean diffs {[round(d, 2) for d in diffs]}")

    # --- contact sheet for labeling ---
    scale = 1  # keep native res; sheet is 1536 wide already
    label_h = 28
    sheet = Image.new("RGBA", (EXPECT_W, ROWS * (FH + label_h)), (24, 24, 28, 255))
    from PIL import ImageDraw
    dr = ImageDraw.Draw(sheet)
    for r in range(ROWS):
        y = r * (FH + label_h)
        dr.rectangle([0, y, EXPECT_W, y + label_h], fill=(40, 40, 48, 255))
        dr.text((6, y + 7), f"ROW {r}  cols: " + ",".join(str(c) for c, _ in occupancy[r]), fill=(255, 220, 120, 255))
        sheet.paste(img.crop((0, r * FH, EXPECT_W, (r + 1) * FH)), (0, y + label_h))
    out = Path(args.contact_sheet)
    sheet.convert("RGB").save(out)
    print(f"\ncontact sheet written to {out} ({sheet.size[0]}x{sheet.size[1]})")

    if args.write_json:
        data = json.loads(OUT_JSON.read_text()) if OUT_JSON.exists() else {}
        # verify json against measured occupancy
        ok = True
        for name, spec in data.items():
            row = spec["row"]
            cols = [c for c, _ in occupancy[row]]
            want = list(range(spec["startCol"], spec["startCol"] + spec["frames"]))
            if cols != want:
                print(f"FAIL: animations.json '{name}' row {row} cols {want} != measured {cols}")
                ok = False
        if not ok:
            return 1
        OUT_JSON.write_text(json.dumps(data, indent=2) + "\n")
        print(f"animations.json verified against sheet ({len(data)} animations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
