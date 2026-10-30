# pi-shell-jobs

[![CI](https://github.com/wuchangming/pi-shell-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/wuchangming/pi-shell-jobs/actions/workflows/ci.yml)

Supervised shell jobs for [Pi Coding Agent](https://github.com/earendil-works/pi).
Long-running commands return control without being restarted. The agent can
read output, send input, resize a terminal, stop a job, or request a completion
notification. Each job has an independent hard runtime deadline.

Supports native pipes and PTYs on Windows, macOS and Linux. Requires Pi 1.4.0+
(before 2.0) and Node 22.19+. This is an independent package, adapted from
`pi-unified-exec`; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Local installation

```sh
npm ci
pi -e ./src/index.ts
```

To keep the local package installed, run `pi install /absolute/path/to/pi-shell-jobs`.
Run `npm ci` in this checkout first: Pi does not install dependencies for local
packages. No npm release is required for local use.

By default, the package removes `bash` and `powershell` from the active tool
list so shell commands go through the supervised executor. Pass
`--keep-builtin-bash` to retain both native shell tools. Do not enable another
extension registering the same execution tools in the same session.

PTY support uses the optional `@homebridge/node-pty-prebuilt-multiarch`
dependency. A load failure is shown in the UI and `tty: true` fails explicitly;
ordinary pipe jobs continue to work. No tmux or WSL is required.

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

## Development

```sh
npm test
npm pack --dry-run
```

The tests include actual Pi CLI execution with an offline provider, so they
need no model credentials. CI covers Node 22/24 on Windows, macOS Intel, macOS Apple Silicon and Linux, and
requires working PTYs. `npm run test:tui` adds an optional interactive display
check when tmux is installed; tmux is only a test dependency.

See [design and reference review](docs/design.md) for implementation decisions,
ownership rules, resource limits, source references and release criteria.
