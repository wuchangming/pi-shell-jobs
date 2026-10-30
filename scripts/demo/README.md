# Reproduce the GIF

The demo runs the real Pi terminal UI, this extension, and a real Node REPL.
Only the model's tool selection is scripted. No model credentials or network
requests are needed. It shows a process yielding, receiving input through the
same session ID, returning `42`, and exiting.

From the repository root after `npm ci`:

```sh
npx tsx scripts/demo/record.ts
python3 -m venv /tmp/pi-shell-jobs-demo-tools
/tmp/pi-shell-jobs-demo-tools/bin/pip install Pillow==13.0.0 pyte==0.8.2
/tmp/pi-shell-jobs-demo-tools/bin/python scripts/demo/render.py --font /path/to/monospace.ttf
```

On macOS, `--font /System/Library/Fonts/Menlo.ttc` works. Choose an installed
monospace font on other systems. Python and these rendering packages are only
used to build documentation; they are not extension dependencies.

`assets/demo.cast` is the original asciicast v2 terminal output. The renderer
replays it at five frames per second without changing the terminal contents.
The persistent caption discloses the scripted model. The GIF loops, while the
PNG provides a static alternative. Assets and recording scripts are excluded
from the npm package by its `files` allowlist.
