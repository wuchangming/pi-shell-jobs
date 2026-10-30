# Tool and lifecycle reference

[Back to README](../README.md) · [Recipes](recipes.md) · [Troubleshooting](troubleshooting.md)

The JSON below is passed to Pi tools; it is not a shell command.

## Tools

| Tool | Purpose |
| --- | --- |
| `exec_command` | Start once; return an exit result or a live `session_id`. |
| `write_stdin` | Send text/binary input, wait for output/exit, close pipe input, or resize a PTY. |
| `list_sessions` | Inspect running jobs and consume terminal status records. |
| `set_on_exit` | Arm or disarm a completion notification without killing the job. |
| `kill_session` | Terminate explicitly; retain ownership if exit cannot be confirmed. |

The `/shell-jobs-sessions` command lets the user inspect and stop jobs directly.

Start a command with separate attachment and lifetime limits:

```json
{
  "cmd": "npm run build",
  "yield_time_ms": 1000,
  "timeout_seconds": 600,
  "on_exit": "wake"
}
```

`yield_time_ms` controls when the tool returns. `timeout_seconds` controls when
the process must stop, even if no tool is currently waiting. The default hard
lifetime is 30 minutes; an explicit positive override may be at most 24 hours.
Set a suitable finite lifetime for servers and watchers too.

When the result contains a `session_id`, poll the same job:

```json
{"session_id": 1, "yield_time_ms": 10000}
```

Use the ID actually returned by the tool. Empty polls default to five seconds
and return early on exit, cancellation or user steering. Cancelling a wait
leaves the job alive. Use `kill_session` to stop it. Long explicit waits may use
an absolute UTC `yield_until`; it is mutually exclusive with `yield_time_ms`
and input. `PI_SHELL_JOBS_MAX_EMPTY_POLL_MS` can impose an operator limit.

For interactive programs, start with `tty: true`. Submit terminal lines with
`\r` for Windows-compatible Enter handling. `chars` accepts C-style escapes;
`chars_b64` accepts raw bytes and is mutually exclusive with `chars`. Use
`{"session_id": 1, "cols": 120, "rows": 40}` to resize a PTY. For pipes,
`end_stdin: true` closes stdin after any supplied bytes; it is not valid for a PTY.

`on_exit` defaults to `none`. Use `wake` when automatic continuation is desired.
A finalized tool result that observes completion consumes the pending wake.
An unobserved completion produces one follow-up notification, batched with
nearby completions; explicit stop suppresses it. Notifications contain bounded
metadata, not raw command output. Failed delivery stays eligible for retry at
the next tool boundary or `agent_settled` event.

## Status and logs

Each process result includes `supervision` in both text and structured output:

```json
{
  "state": "timed_out",
  "stop_reason": "timed_out",
  "deadline_utc": "2026-10-31T12:00:00.000Z",
  "quiet_ms": 1500,
  "log_bytes": 128,
  "log_truncated": false,
  "cleanup": "unconfirmed"
}
```

`state` distinguishes running, stopping, completion, failure and stop reasons.
`quiet_ms` is observation only: a quiet build is not automatically considered
stuck. Output is bounded in memory and model responses. `log_path` points to a
temporary combined stdout/stderr log; use Pi's `read` tool to inspect it
without consuming the job's pending output.

Limits are 64 registered jobs, 16 MiB per log, 256 MiB cumulative logs per
session runtime, and a 1 MiB outstanding write queue per job. Quota or storage
failure stops the affected job and reports a partial log. Completed jobs can
leave the registry after observation; their log files remain available until
temporary-file cleanup. A full registry never evicts a running process.

On POSIX, stop targets the process group and escalates after two seconds.
Windows uses native `taskkill /T /F`. Observing transport exit does not prove
all descendants were terminated: detached descendants and a vanished Windows
root are limitations. Therefore `cleanup` stays `unconfirmed` after a stop,
or `pending` while waiting for exit. This package is not a sandbox.

## Lifecycle

`/reload` preserves jobs, buffered output, deadlines and pending notifications
within the same Pi process. A new extension factory takes over the runtime.
If it does not return within ten seconds, cleanup starts. New/resumed/forked
sessions and normal quit clean up owned jobs; `/tree` keeps them and displays
the live-job status. Reload does not extend deadlines or reset log budgets.

Pi process crashes, forced termination and machine restarts do not support
reattachment. Logs are temporary evidence, not a durable job database.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `--keep-builtin-bash` | Off | Keep Pi's `bash` and `powershell` tools active alongside these tools. |
| `PI_SHELL_JOBS_BASH` | Unset | Windows Bash executable override; use an existing file's full path. |
| `PI_SHELL_JOBS_MAX_EMPTY_POLL_MS` | Unset | Maximum relative empty poll; does not change job lifetime or absolute waits. Values below 5000 become 5000; invalid explicit values fail the poll. |
| `PI_SHELL_JOBS_STEER_INTERRUPT` | Enabled | Set to `0` to disable early return on human steering. |

Set environment variables before starting Pi. They are optional, not settings
keys. On Windows, the default resolver searches for Git Bash, then falls back
to PowerShell; `shell` can explicitly select `pwsh`, `powershell` or `cmd`.
Shell syntax still depends on the chosen shell. This package does not translate
POSIX commands into PowerShell.

## Common parameters and results

| Operation | Key parameters / defaults |
| --- | --- |
| `exec_command` | `cmd` required; `workdir` defaults to Pi's cwd; `tty: false`; initial `yield_time_ms: 10000`; `timeout_seconds: 1800`; `on_exit: "none"`. |
| `write_stdin` | Returned `session_id` required; `chars` or `chars_b64` for input; with input, default yield 250 ms; empty poll default/minimum 5000 ms. |
| `kill_session` | `session_id`; optional `signal`, default `SIGTERM`. Any signal on Windows uses forceful tree termination. |
| `set_on_exit` | `session_id` and `on_exit: "none"` or `"wake"`. |
| `list_sessions` | No parameters. Observing finished jobs consumes their completion status. |

Initial execution and input-bearing waits are clamped to 250–30000 ms. Empty
polls have separate rules described above. PTY resize requires both `cols`
(20–500) and `rows` (5–300).

Process results contain `operation`, `status`, `running`, `output`, `log_path`
and `supervision`. A running result provides `session_id`; a completed result
provides exit information (`exit_code`, `signal`, and any `failure`).
`wait_status` explains whether an empty poll completed, reached its deadline,
was cancelled, or was interrupted by steering. A tool wait deadline is not a
process timeout: check `running` and `supervision.state`.

Kill results include `killed` and `escalated`. If `killed` is false, the job
remains owned and available for inspection; do not treat it as successfully
stopped. Successful termination still does not prove that every detached
descendant has exited.

Pi's native codemode receives typed `structuredContent` with an `outputSchema`.
The package does not replace codemode or its renderer. In codemode, inspect
`result.output`, `result.session_id` and `result.exit_code` rather than printing
the whole result object.
