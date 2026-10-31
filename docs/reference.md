# Tool and lifecycle reference

[Back to README](../README.md) · [Recipes](recipes.md) · [Troubleshooting](troubleshooting.md)

The JSON below is passed to Pi tools; it is not a shell command.

## Tools

| Tool | Purpose |
| --- | --- |
| `exec_command` | Start once; return an exit result or a live `session_id`. |
| `write_stdin` | Send text/binary input, wait for output/exit, close pipe input, or resize a PTY. |
| `list_sessions` | Inspect running and retained completed jobs without consuming results. |
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

When the result contains a `session_id`, read current output immediately:

```json
{"session_id": 1, "yield_time_ms": 0}
```

Use the ID actually returned by the tool. Only an empty read with explicit
`yield_time_ms: 0` is immediate: it returns unread output, or empty output if
nothing new has arrived. It does not wait for future output or exit. A call
already cancelled before the read is rejected without consuming output, even
after exit.
Do not repeatedly request empty snapshots.

Omitting the duration still defaults to five seconds. Positive durations have a
five-second minimum; positive fractions do not become immediate reads. Use a
finite wait when the next step depends on completion. These waits return early
on exit, cancellation or user steering. Cancelling a wait
leaves the job alive. Use `kill_session` to stop it. Long explicit waits may use
an absolute UTC `yield_until`; it is mutually exclusive with `yield_time_ms`
and input. `PI_SHELL_JOBS_MAX_EMPTY_POLL_MS` can impose an operator limit.

For interactive programs, start with `tty: true`. Submit terminal lines with
`\r` for Windows-compatible Enter handling. `chars` accepts C-style escapes;
`chars_b64` accepts raw bytes and is mutually exclusive with `chars`. Use
`{"session_id": 1, "cols": 120, "rows": 40}` to resize a PTY. For pipes,
`end_stdin: true` closes stdin after any supplied bytes; it is not valid for a PTY.

`on_exit` defaults to `none`. For finite background work whose result is needed
to finish the request, the model is guided to explicitly select `wake` and keep
working on independent steps. This does not require the user to separately ask
for notification. Services, REPLs and start-only requests keep `none`.
A successful direct output-collection result reporting completion consumes a
pending wake; listing sessions does not. Inside codemode, observation is held
until the outermost tool finalizes successfully with its shell-jobs receipt.
A script failure or cancellation keeps the completion eligible for notification.
An unobserved completion produces one follow-up notification, batched with
nearby completions; explicit stop suppresses it. Notifications contain bounded
metadata, not raw command output. Pi queues it as `followUp` while busy and
starts a run while idle; it does not steer the current run. Collect the final
output, then continue only if the task is still relevant. Disarming cannot
recall a message already handed to Pi.

The coordinator retries submission errors it can observe at the next tool
boundary or `agent_settled`. Pi's ordinary `pi.sendMessage()` API returns void
and reports asynchronous failures through the host, so this is not an
end-to-end delivery guarantee. The extension does not resend on an assumed
acknowledgement timeout.

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
leave the registry after output collection, explicit stop, or completed-history
eviction; their log files remain available until
temporary-file cleanup. A full registry never evicts a running process.

On POSIX, stop targets the process group and escalates after two seconds.
Windows uses native `taskkill /T /F`. Observing transport exit does not prove
all descendants were terminated: detached descendants and a vanished Windows
root are limitations. Therefore `cleanup` stays `unconfirmed` after a stop,
or `pending` while waiting for exit. This package is not a sandbox.

`list_sessions` and the human sessions picker do not consume output or suppress
completion notifications. List results expose `active_count`, `completed_count`,
and `just_exited_count` (a compatibility alias for `completed_count`, not a count
of new exits). Each entry includes cumulative `output_bytes_total`, elapsed
time and supervision metadata in both details and codemode structured results.
Read a completed session with `write_stdin` to collect its final output. If
capacity reclamation has evicted it, use the retained `log_path` instead.

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
| `write_stdin` | Returned `session_id` required; `chars` or `chars_b64` for input; with input, default yield 250 ms; empty read: explicit 0 is immediate, omitted/positive minimum 5000 ms. |
| `kill_session` | `session_id`; optional `signal`, default `SIGTERM`. Any signal on Windows uses forceful tree termination. |
| `set_on_exit` | `session_id` and `on_exit: "none"` or `"wake"`. |
| `list_sessions` | No parameters. Read-only inventory; completed results remain collectable. |

Initial execution and input-bearing waits are clamped to 250–30000 ms. Empty
polls have separate rules described above. PTY resize requires both `cols`
(20–500) and `rows` (5–300).

Process results contain `operation`, `status`, `running`, `output`, `log_path`
and `supervision`. A running result provides `session_id`; a completed result
provides exit information (`exit_code`, `signal`, and any `failure`).
`wait_mode` is `immediate`, `relative`, or `absolute`. An immediate running read
returns `wait_status: "snapshot"`; an exited read returns `"completed"`.
Otherwise `wait_status` explains whether a wait completed, reached its deadline,
was cancelled, or was interrupted by steering. A tool wait deadline is not a
process timeout: check `running` and `supervision.state`.

Kill results include `killed` and `escalated`. If `killed` is false, the job
remains owned and available for inspection; do not treat it as successfully
stopped. Successful termination still does not prove that every detached
descendant has exited.

Pi's native codemode receives typed `structuredContent` with an `outputSchema`.
The package does not replace codemode or its renderer. Print concise status as
well as needed output, for example:

```js
const r = await tools.exec_command({cmd: "node verify.cjs", yield_time_ms: 500, on_exit: "wake"});
text({session_id: r.session_id, status: r.status, exit_code: r.exit_code});
text(r.output);
```

Every enclosing tool that runs shell jobs gets a bounded, metadata-only
`[shell-jobs results]` receipt, including recovery session IDs, exit status and
log paths. It survives a script error or omission of `text()`. It does not
claim that the script printed the process output or that the model understood it.
The workflow guidance is also injected into the system prompt, so codemode's
lazy tool discovery cannot hide task responsibility.

Final output collected inside a script is retained in the existing bounded
session registry. This includes commands that finish in the initial exec call.
Read it again with `write_stdin({session_id, yield_time_ms: 0})` using the receipt
ID. Such reads return `output_replayed: true`; the output is the saved terminal
read, not a new delta or the entire historical log. A direct read consumes the
record; nested reads preserve it. Explicit stop, capacity eviction and session
shutdown can remove it. Same-process reload retains it. After eviction use
`log_path`, respecting `supervision.log_truncated`. Successful receipt delivery
consumes wake without discarding the recoverable output.

Unknown tool input fields are rejected. EOF and resize belong to `write_stdin`;
`set_on_exit` accepts only `session_id` and `on_exit`.
