# Design and reference review

## Maintainer decisions

The package owns shell process lifetime and integrates through Pi's public
extension APIs. It has no service-specific integration or external daemon.
Pipes and interactive PTYs are both supported. The implementation uses the
existing `exec_command` / `write_stdin` interaction model, with explicit
supervision metadata added to the results.

The supported host baseline is Pi 1.4.0 and Node 22.19 or newer. The Pi 1.4
extension types and lifecycle were checked against the published package and
the upstream source. Tests run against the published package rather than a
moving development checkout.

| Concern | Contract |
| --- | --- |
| Yield | Returns control without terminating or restarting the job. |
| Lifetime | Every job has a finite hard deadline, independent of tool waits. |
| Silence | `quiet_ms` measures time since output; silence alone never kills. |
| Cancellation | Cancelling an attached wait leaves the job controllable. |
| Explicit stop | Suppresses completion wake, requests termination, waits for exit, and escalates on POSIX. |
| Capacity | Refuse before spawn when all 64 slots are live; only completed history is evictable. |
| Output | Bound in-memory retention, collection, model output, disk writes and outstanding write buffers separately. |
| Input | One attached reader/writer per job; competing interactions fail clearly. Stop remains available. |
| Reload | Preserve the actual runtime, PID, buffers, deadline and pending notifications in the same Pi process. |
| Session change | `new`, `resume`, `fork` and `quit` request cleanup; no notification crosses that boundary. |
| Branch navigation | `/tree` keeps jobs in the same session and surfaces live jobs in the UI. |
| Completion | Observe completion at finalized `tool_execution_end`, not when an execute handler merely returns. |

## Structure

- `session.ts`, `supervision.ts`: job lifecycle, deadlines, quotas, interaction
  exclusion and snapshots.
- `pty.ts`, `shell.ts`: native process transports and shell command construction.
- `session-store.ts`: bounded admission and completed-history reclamation.
- `collect.ts`, `head-tail-buffer.ts`, `notify.ts`, `long-wait.ts`: bounded
  collection and interruptible waits, with cancellable subscriptions.
- `completion.ts`: observation leases, batched completion delivery, failed-send
  recovery and suppression during explicit cancellation.
- `index.ts`: Pi tools, lifecycle, ownership handoff and UI integration.
- `tool-result.ts`, `script-result.ts`, `render.ts`: model text, typed codemode
  results and terminal-safe rendering. Native Pi codemode is not replaced.

Extension activation registers tools and callbacks; it does not start jobs,
create log files or start periodic timers. Shell execution starts only when a
tool is invoked. Tools return both bounded text and `structuredContent` with an
`outputSchema`, so native codemode can inspect fields directly.

## Reload ownership

A process-local, versioned global WeakMap is keyed by Pi's stable
`SessionManager` object. Separate SDK sessions cannot claim each other's jobs,
even if they use the same session file. Shutdown with reason `reload` detaches
message delivery and parks the runtime. The next factory adopts it and rebinds
delivery to the new Pi API. Deadlines continue to run during this interval.

If adoption does not happen within ten seconds, the old runtime terminates its
jobs. This handles a removed extension and reload failure. This is deliberately
same-process continuity: a restarted or crashed Pi process cannot reattach to
these transports. It is not a persistent job service.

Completion while detached is recorded and delivered after adoption. Old Pi API
objects are never used for a new notification. Explicit shutdown drops pending
wakes before signalling children. Failed cleanup remains owned and blocks new
commands until those old children settle.

## Termination evidence

POSIX pipes use a separate process group; termination addresses the group.
PTY termination also attempts the process group. Windows uses the absolute
system path to `taskkill.exe /T /F`, and PTYs use ConPTY through the optional
native module. Shell names are resolved before spawning on Windows to avoid
accidental executable lookup in the command's working directory.

`hasExited` means the transport observed exit/closure. It is not proof that
every descendant is gone. A process may detach from its group; on Windows,
`taskkill /T` cannot reliably recover a tree after its root has disappeared.
Consequently, a stopped job reports `cleanup: unconfirmed` after exit rather
than claiming tree-wide cleanup. `cleanup: pending` means even transport exit
has not been observed. The package is process supervision, not a sandbox.

## Resource policy

- Hard runtime: default 1,800 seconds; positive caller override up to 86,400.
- Registry: 64 jobs, including unconsumed terminal records.
- Session retention: 1 MiB head/tail; streaming preview: 32 KiB.
- Attached collection: bounded head/tail, with explicit omission markers.
- Model response: 50 KiB / 2,000 lines, using Pi's truncation helpers.
- Disk log: 16 MiB per job; 256 MiB cumulative per Pi session runtime.
- Pending log writes: at most 1 MiB per job before truncation and stop.
- Logs are exclusively created with POSIX mode `0600` in the OS temp directory.

Reaching a disk/write-queue quota stops the noisy job and marks the retained log
as partial. Storage errors stop the job while preserving real process state.
Limits do not reset on reload. A new Pi session gets a new cumulative budget.
Logs survive registry removal for inspection using Pi's `read` tool; they are
temporary files, not durable history. The package does not promise a global
quota across independent Pi processes or delete previous sessions' logs.

## References and what was adopted

The runtime foundation is adapted from the MIT-licensed
[pi-unified-exec 0.13.1](https://github.com/iamwrm/pi-unified-exec/tree/1baa4161f3d556af9f3eb9ae26219983b5cfe96d).
Its native transports, shell handling, output safety, completion observation,
steering behavior and baseline regression tests are retained. Attribution is
in `THIRD_PARTY_NOTICES.md` and `LICENSE`. Live-job LRU eviction, unbounded
disk logging, reload termination and the native-codemode renderer override
were not retained.

Other reviewed primary sources:

- [Pi v1.4.0](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent):
  public tool schema, `structuredContent`, lifecycle reasons, `agent_settled`,
  `tool_execution_end` and follow-up message delivery. Local shell operations
  lack the persistent stdin/PTY handle needed here, so this package owns its
  transport instead of pretending a synchronous shell operation is a job.
- [DSH jobs](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447):
  separation of jobs from host integration, admission before side effects,
  ownership fencing, and cancellation distinct from settlement.
- [Codex unified execution](https://github.com/openai/codex/tree/a4b4082b5f14a8a037386d823ddb96a85fd25975/codex-rs/core/src/unified_exec):
  one persistent execution identity, separate yield and process lifetime,
  bounded output, and serialized interaction.
- [pi-bg](https://github.com/iefnaf/pi-bg/tree/0a764531c1647823fa0e66e386e3436a828b5bce):
  distinction between interactive-prompt detection and ordinary quiet output.
  This package does not infer a dead loop from output silence.
- [pi-background-task](https://github.com/ZKiteLM/pi-background-task/tree/c67ac177edc6bef82ee2d73e9392279c2bdae15d):
  reload continuity and lifecycle ownership. Native transports were chosen
  instead of requiring tmux, so Windows remains a first-class target.
- `pi-background-jobs` 0.1.3 (published npm source): separate task outcome and
  cleanup evidence, storage limits and native Windows considerations.

## Release verification

`npm test` includes unit tests, actual child processes, PTYs and offline real
Pi CLI sessions. Regression cases include CPU loops, ignored termination,
output floods, shared disk budgets, concurrent input, trailing output,
failed sends, steering and fresh-factory reload adoption.

The CI matrix requires Node 22 and 24 on native Windows x64, macOS Intel,
macOS Apple Silicon and Linux x64. Runner platform/architecture are asserted
before dependency installation. Pushes, pull requests and manual dispatch
run the same eight-job matrix; test output is retained for seven days.
`EXPECT_PTY=1` makes a missing native PTY module fail CI instead of silently
skipping PTY coverage. Local macOS results are not evidence of Windows/Linux
execution; those platforms require their own successful CI run before a
cross-platform release claim.

Local verification on 2026-10-31 (macOS, Node 24.11.1):

| Check | Result |
| --- | --- |
| `EXPECT_PTY=1 npm test` | 356 tests: 351 passed, 5 Windows-only cases skipped; no failures. |
| Actual Pi CLI | Execution, native codemode, steering and fresh-factory reload tests passed offline. |
| `npm audit --audit-level=high` | Zero reported vulnerabilities in the locked development/install tree. |
| `npm pack --dry-run` | Package manifest, sources, license, notices and design documentation included. |
| Optional tmux display tests | 3 skipped: tmux is not installed on the local machine. |
| Windows / Linux | Native CI matrix configured; not executed locally. |

The repository overrides the development host's transitive `undici` dependency
to the patched 8.12.2-compatible line. Package overrides do not modify an
already installed Pi host; host dependency updates remain with Pi.
