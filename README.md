# pi-shell-jobs

[![CI](https://github.com/wuchangming/pi-shell-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/wuchangming/pi-shell-jobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run long commands and interactive terminals inside [Pi](https://github.com/earendil-works/pi),
then keep working. Pi can return to the same process to read output, send input,
or stop it. Jobs have finite lifetimes and bounded output, and survive `/reload`
within the same Pi process.

**Windows · macOS Intel / Apple Silicon · Linux** — Node 22.19+ and Pi 1.4+ (before 2.0).
No tmux, WSL or external daemon is required. This is an independent package
adapted from `pi-unified-exec`; see [attribution](THIRD_PARTY_NOTICES.md).

## Install

With Pi already installed:

```sh
pi install git:github.com/wuchangming/pi-shell-jobs
```

Start a new Pi session, or run `/reload` in the current one. This installs from
GitHub; the package is not yet published to npm. Add `--local` for a project-only
install. For reproducible installs, append `@<full-commit-sha>` to the Git source.

```sh
pi list
pi update git:github.com/wuchangming/pi-shell-jobs
pi remove git:github.com/wuchangming/pi-shell-jobs
```

The extension replaces the active `bash` and `powershell` tools by default.
Use `pi --keep-builtin-bash` to retain them. Disable other extensions registering
`exec_command` / `write_stdin` before enabling this one.

## Try it in Pi

Ask Pi:

> Run this project's build in the background with a 10-minute hard timeout.
> Keep the session ID and tell me when it finishes.

Pi uses `exec_command` with a short yield and `on_exit: "wake"`. The job keeps
running after the tool returns. Completion can resume Pi once; if Pi already
observed the exit, it does not send a second notification.

For an interactive task:

> Open a Node REPL in a terminal, calculate 6 × 7, then exit the REPL.

Use `/shell-jobs-sessions` to inspect live jobs and stop one or all of them.
**Esc cancels waiting; it does not kill the job.** Explicit stop and normal Pi
shutdown request cleanup. Without opting into wake, completion stays quiet.

For a reproducible walkthrough without project-specific build tools, use the
[bundled examples](examples/README.md). They include a finite progress job and
an interactive line reader, both written in plain Node for all supported OSes.

## What it provides

| Tool | Purpose |
| --- | --- |
| `exec_command` | Start a command; get an exit result or a live `session_id`. |
| `write_stdin` | Read output, send input, close pipe stdin, or resize a terminal. |
| `list_sessions` | Inspect jobs and collect terminal status. |
| `set_on_exit` | Enable or disable automatic completion notification. |
| `kill_session` | Stop a job and report whether its exit was confirmed. |

The attachment window (`yield_time_ms`) and job lifetime (`timeout_seconds`)
are independent. Jobs default to a 30-minute hard deadline, with a maximum
explicit lifetime of 24 hours. Quiet output is never treated as a hang.

Logs retain up to 16 MiB per job and 256 MiB per session runtime; results and
memory are bounded separately. A full registry refuses new jobs instead of
evicting live ones. Logs are temporary files and may contain command output.

Reload continuity is within one running Pi process. It does not restore jobs
after a crash or machine restart. Termination is best effort for process trees;
`cleanup: "unconfirmed"` explains that limitation. This is not a sandbox.

## Documentation

- [Recipes](docs/recipes.md): background builds, interactive input, EOF, timeouts and reload.
- [Reference](docs/reference.md): parameters, results, configuration, limits and lifecycle.
- [Troubleshooting](docs/troubleshooting.md): installation, PTY loading, Windows shells and missing notifications.
- [Testing](docs/testing.md): real Pi integration, terminal interaction, package installation and CI coverage.
- [Design](docs/design.md): ownership rules and upstream references.
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Develop locally

```sh
git clone https://github.com/wuchangming/pi-shell-jobs.git
cd pi-shell-jobs
npm ci
pi -e .
```

`pi -e .` loads the package for one invocation. To keep the checkout installed,
use `pi install /absolute/path/to/pi-shell-jobs`. Run `npm ci` first: Pi does not
install dependencies for local packages.

```sh
npm test
npm run test:integration
npm run test:package
```

`npm test` includes real Pi CLI and native terminal tests. Package verification
builds a tarball, installs it outside the checkout, registers it with Pi, and
executes the examples through the installed extension. CI runs these checks on
four native platforms with Node 22 and 24. Model responses are scripted locally;
no model credentials or paid requests are needed. See [testing](docs/testing.md)
for what this proves and the remaining manual checks.
