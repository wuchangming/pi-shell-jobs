"""Render the recorded ANSI terminal stream, without replacing its contents."""
import argparse
import json
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--font", required=True, help="Path to a monospace TTF/TTC font")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
lines = (root / "assets/demo.cast").read_text().splitlines()
header, *events = [json.loads(line) for line in lines]
screen = pyte.Screen(header["width"], header["height"])
stream = pyte.Stream(screen)
font = ImageFont.truetype(args.font, 16)
cw, ch, pad, top = round(font.getlength("M")), 22, 22, 64
width, height = header["width"] * cw + pad * 2, header["height"] * ch + top + pad
palette = dict(black="#151922", red="#ef767a", green="#a1d594", brown="#e4c07a",
               blue="#80a9ef", magenta="#cf9ee4", cyan="#7bcac9", white="#dce2ed",
               brightblack="#707b90", brightred="#ff8c90", brightgreen="#b6e7a8",
               brightbrown="#f4d791", brightblue="#9bbdff", brightmagenta="#e6b3f7",
               brightcyan="#94dedc", brightwhite="#ffffff")

def color(value, default):
    if value == "default":
        return default
    return palette.get(value, "#" + value if len(value) == 6 else default)

frames = []
event_index = 0
duration = events[-1][0]
for tick in range(int(duration * 5) + 1):
    while event_index < len(events) and events[event_index][0] <= tick / 5:
        _, kind, data = events[event_index]
        if kind == "o":
            stream.feed(data)
        event_index += 1
    frame = Image.new("RGB", (width, height), "#151922")
    draw = ImageDraw.Draw(frame)
    draw.text((pad, 12), "pi-shell-jobs  /  interactive terminal", font=font, fill="#dce2ed")
    draw.text((pad, 34), "Real Pi + real Node REPL  |  Scripted model decisions", font=font, fill="#7bcac9")
    for y in range(screen.lines):
        for x in range(screen.columns):
            cell = screen.buffer[y][x]
            fg, bg = color(cell.fg, "#dce2ed"), color(cell.bg, "#151922")
            if cell.reverse:
                fg, bg = bg, fg
            px, py = pad + x * cw, top + y * ch
            if bg != "#151922":
                draw.rectangle((px, py, px + cw - 1, py + ch - 1), fill=bg)
            if cell.data.strip():
                draw.text((px, py), cell.data, font=font, fill=fg)
    frames.append(frame)
frames[-1].save(root / "assets/demo.png")
frames[0].save(root / "assets/demo.gif", save_all=True, append_images=frames[1:],
               duration=200, loop=0, optimize=True)
print(f"Rendered {len(frames)} frames, {duration:.1f}s, {width}x{height}")
