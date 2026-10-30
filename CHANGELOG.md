# Changelog

## Unreleased

- Add GitHub installation, practical recipes, runnable cross-platform examples,
  troubleshooting, contribution guidance and an explicit integration coverage map.
- Test the real Pi terminal UI over native PTYs, including completion, Esc,
  steering and normal shutdown, without requiring tmux.
- Verify a production-installed tarball through Pi's package discovery and all
  five tools, including pipe EOF and interactive terminal input/resize.

## 0.1.0 — initial repository version

Not yet published to npm.

- Supervised shell jobs with pipes and native PTYs, finite hard deadlines,
  bounded output/logging, serialized interaction and explicit stop.
- Same-process reload continuity, completion observation and opt-in wake.
- Pi 1.4 integration with native codemode structured results.
- Windows, macOS Intel/Apple Silicon and Linux CI on Node 22 and 24.
- Fix a termination escalation reporting race found by Linux CI.

Adapted from `pi-unified-exec` 0.13.1; see [third-party notices](THIRD_PARTY_NOTICES.md).
