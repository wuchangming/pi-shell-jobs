# Troubleshooting

[Back to README](../README.md) · [Reference](reference.md)

| Symptom | Check / next step |
| --- | --- |
| `/shell-jobs-sessions` is unavailable | Run `pi list`, check the install scope, then start a new Pi session or `/reload`. For a local checkout, run `npm ci` and try `pi -e .` from its root. |
| Duplicate tool / extension conflict | Disable another extension that registers `exec_command`, `write_stdin`, `list_sessions`, `set_on_exit` or `kill_session`. Do not load the checkout and a Git-installed copy together. |
| `tty: true` reports a load failure | Read the native-module error. Install with optional dependencies enabled (`npm ci --include=optional` for a checkout); do not omit install scripts needed by the PTY dependency. Check supported Node and OS architecture. Pipe jobs still work. |
| Windows command syntax fails | Check the selected shell. Git Bash uses POSIX syntax; fallback PowerShell does not. Choose `shell: "powershell"`, `"pwsh"`, or `"cmd"` explicitly when needed, or set `PI_SHELL_JOBS_BASH` to Git Bash's executable path. WSL is not required. |
| Terminal echoes input but does not execute it | Submit with `\r`, not just `\n`, for Windows-compatible Enter. |
| Program waits forever after consuming input | If it expects EOF, use `end_stdin: true` with a pipe job. A PTY needs its program's normal exit command. |
| Esc or a steering message did not kill the process | Expected: these interrupt the attached wait. Use explicit stop or the sessions picker. |
| No completion notification | `on_exit` defaults to `none`. An observed exit consumes an armed wake; explicit stop suppresses it. Check `wake_armed` in `list_sessions`. |
| Output stops before the command finishes | Inspect `supervision.state`, `log_truncated` and the retained log. A log quota or storage failure stops the job; a normal tool yield does not. |
| `unknown session_id` | Use the actual returned ID. Completed/collected jobs may have left the registry. New sessions or Pi restarts cannot reattach to an old ID. |
| `already has an attached reader/writer` | Wait for the current input/poll call to return. Only one reader/writer can attach to a job; explicit stop remains available. |
| Job has no output | Check `quiet_ms` and the deadline. Silence is telemetry, not a hang detector. |
| `cleanup: "unconfirmed"` after stop | Exit was observed, but the transport cannot prove every detached descendant exited. Inspect the OS process tree if a descendant is still serving a port. |

## Report a reproducible issue

Use [GitHub issues](https://github.com/wuchangming/pi-shell-jobs/issues) and include:

- OS and CPU architecture (`node -p "process.platform + ' ' + process.arch"`).
- `node --version`, `pi --version`, package commit/version and install method.
- The shell, `tty` setting, exact tool arguments, and expected versus actual result.
- Whether the [bundled examples](../examples/README.md) reproduce it.
- The relevant result metadata and a small log excerpt. Remove credentials and
  private output before sharing; logs contain the command's raw output.

For contributors, `npm run test:integration` exercises the real Pi host;
`npm run test:package` checks the installable artifact. See [testing](testing.md).
