# Changelog

## Unreleased

- Track nested completion through the enclosing tool, add automatic model-visible
  recovery receipts, and retain bounded terminal results for replay after script
  errors or omitted output. Include short-lived nested commands.
- Inject shared task workflow guidance even with lazy codemode discovery; print
  essential status alongside process output and distinguish silence from progress.
- Remove ineffective EOF/resize fields from `set_on_exit`, reject unknown tool
  arguments, and correct steering, completed-read and failed-kill instructions.
- Add real Pi failure/silent-script recovery regressions.

- Empty `write_stdin` with explicit `yield_time_ms: 0` now reads current output
  immediately (`wait_mode: immediate`, `wait_status: snapshot` while running).
  Previously zero waited at least five seconds. Omitted and positive durations
  keep their existing behavior; input-bearing calls keep their existing bounds.
- `list_sessions` and the human picker no longer remove completed records or
  suppress completion notices. Collect results with `write_stdin`; completed
  history remains bounded and can still be reclaimed for new jobs.
- Add `completed_count`, retain `just_exited_count` as its compatibility alias,
  and expose cumulative output bytes and wait mode to native codemode.
- Guide the model to use wake for finite background work needed to finish a
  request, continue independent work, and collect results before claiming success.
  API defaults remain quiet; services and start-only tasks remain quiet too.
- Exercise immediate reads, cancellation, non-consuming inventory, and actual Pi
  busy/idle completion delivery with scripted providers; document API delivery limits.

## [0.1.1] - 2026-10-31

- Add a real Pi terminal GIF to the README and package gallery preview.
  Model decisions are scripted; the extension and Node REPL run for real.
- Include a static preview and reproducible recording scripts in the repository.
  Media stays outside the npm tarball. No runtime behavior changes.

## [0.1.0] - 2026-10-31

Initial public release.

- Add GitHub installation, practical recipes, runnable cross-platform examples,
  troubleshooting, contribution guidance and an explicit integration coverage map.
- Test the real Pi terminal UI over native PTYs, including completion, Esc,
  steering and normal shutdown, without requiring tmux.
- Verify a production-installed tarball through Pi's package discovery and all
  five tools, including pipe EOF and interactive terminal input/resize.

- Supervised shell jobs with pipes and native PTYs, finite hard deadlines,
  bounded output/logging, serialized interaction and explicit stop.
- Same-process reload continuity, completion observation and opt-in wake.
- Pi 1.4 integration with native codemode structured results.
- Windows, macOS Intel/Apple Silicon and Linux CI on Node 22 and 24.
- Fix a termination escalation reporting race found by Linux CI.

Adapted from `pi-unified-exec` 0.13.1; see [third-party notices](THIRD_PARTY_NOTICES.md).
