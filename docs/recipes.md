# Recipes

[Back to README](../README.md) · [Reference](reference.md)

Usually you can describe the task to Pi. The JSON here shows the exact **tool
arguments**, not text to paste into a shell. Replace `1` with the session ID
returned by the preceding call. These examples assume the checkout root as cwd;
set `workdir` when running a command elsewhere.

## Run a build and resume when it finishes

Ask: “Run the build in the background; tell me when it finishes. Stop it after
ten minutes if it has not completed.” Pi calls `exec_command`:

```json
{"cmd":"npm run build","yield_time_ms":1000,"timeout_seconds":600,"on_exit":"wake"}
```

Use your project's actual build command. A live result contains `session_id` and
`log_path`. Pi can do other work. If completion is not observed by a tool first,
one follow-up notification resumes the agent. Disarm with `set_on_exit` when the
task is no longer relevant:

```json
{"session_id":1,"on_exit":"none"}
```

This does not stop the job. `kill_session` stops it and disarms wake together.

## Collect output without restarting

Call `write_stdin` with the same ID:

```json
{"session_id":1,"yield_time_ms":10000}
```

It returns early when the job exits. If still running, retain the same ID and
continue later. Read the returned `log_path` with Pi's file reader for retained
history; polling consumes pending output, while reading the log does not.
Logs can be truncated by quotas, so check `supervision.log_truncated`.

## Drive an interactive program

Start with `exec_command`:

```json
{"cmd":"node examples/interactive.mjs","tty":true,"yield_time_ms":500,"timeout_seconds":60}
```

Then send input and resize through `write_stdin`:

```json
{"session_id":1,"chars":"hello\r","cols":100,"rows":35,"yield_time_ms":1000}
```

Expect `echo: hello`. Finish by sending `quit\r` to the same session. Prefer a
program's own exit command when available; use `kill_session` if it cannot exit.

`chars` decodes C-style escapes. Use `chars_b64` for exact binary data, or to
avoid accidental escape decoding in text containing literal backslashes. Never
send both. `end_stdin` works only with pipes, not terminals.

## Finish a program waiting for EOF

Start `node examples/interactive.mjs` with `tty: false`, then use `write_stdin`:

```json
{"session_id":1,"chars":"hello\n","end_stdin":true,"yield_time_ms":5000}
```

Expected output includes `echo: hello` and `interactive: done`, with exit code 0.
After EOF, stdin cannot be reopened for that job.

## Keep a server while you work

Choose a finite lifetime, for example `timeout_seconds: 3600`, and keep the
default `on_exit: "none"`. Start the server once, read its readiness output, then
continue other work. A yield is not a server restart or a process timeout.
Stop it explicitly when finished. Avoid an absolute `yield_until` for a server
or watcher that is not expected to exit on its own.

## Reload the extension

Start `examples/interactive.mjs` with a 120-second lifetime and record the
session ID. Run `/reload`, then ask Pi to list jobs and send `hello\n` to that
same session. The job, buffered output, log path and original deadline remain.

This applies to `/reload` inside the same Pi process. `/new`, resume, fork and
normal quit request cleanup; `/tree` retains live jobs. Restarting Pi is not a
reattachment mechanism.

## Interrupt a wait

Press Esc during an attached wait, or send Pi a steering message. The wait
returns and the job keeps running. Pi should handle the new message before
polling again. To stop the process itself, use `kill_session` or the
`/shell-jobs-sessions` picker.
