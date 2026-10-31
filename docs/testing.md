# Testing and Pi integration

[Back to README](../README.md) · [Contributing](../CONTRIBUTING.md)

The extension is tested **inside the real Pi 1.4.0 host**, in addition to tests
that call the extension factory directly. The model provider is scripted
locally using Pi's faux-provider API. Pi's loader, event loop, tools, RPC,
codemode, terminal UI and child processes are real. No provider credentials or
paid model calls are needed.

## Run checks

```sh
npm ci
npm test
npm run test:package
```

For a focused host-integration run, use `npm run test:integration`. It is a
subset of `npm test`, so there is no need to run both when validating the whole
suite. Set `EXPECT_PTY=1` to require a working native PTY module; CI always does.

Package verification needs registry access to install the tarball's production
dependencies. It uses temporary directories and an isolated Pi settings
directory; it does not install the extension into your personal Pi setup.

| Layer | What is exercised | Evidence |
| --- | --- | --- |
| Core / tool pipeline | Deadlines, ignored termination, quotas, EOF, input, output bounds, notification deduplication, cleanup and ownership | `supervision`, `e2e`, `wake-e2e`, `reload`, `held-open` tests |
| Real Pi JSON CLI | Long attached waits and host cache-warming decisions | `tests/cli-wait.test.ts` |
| Real Pi RPC | Human steering interrupts waits; reload uses a fresh loader/factory and retains a live job | `tests/cli-steer.test.ts`, `tests/cli-reload.test.ts` |
| Real Pi progress / completion | Start a job, do independent work, immediately read progress, receive a queued/idle completion, list then collect results | `tests/cli-progress.test.ts` |
| Native codemode | Structured sample/store parity, actual shell results, silent-script and failed-script recovery in `on` and `only` modes | `tests/codemode-cli.test.ts`, `tests/cli-agent-contract.test.ts` |
| Real Pi terminal UI | Launch Pi inside a native PTY; assert rendered wait/completion text, send Esc and typed steering, and verify normal quit cleans up the job | `tests/cli-tui.test.ts` |
| Installed artifact | `npm pack`, production-only install outside the checkout, `pi install`, manifest discovery without a direct source flag, five tools, EOF, PTY input/resize and uninstall | `tests/package-install.test.mjs` |

The installed-artifact test also executes the shipped example scripts and
checks that the tarball includes documentation and attribution, excludes tests,
and does not install a second Pi host. Its temporary installation path includes
spaces to exercise quoting and path resolution.

## CI

[GitHub Actions](https://github.com/wuchangming/pi-shell-jobs/actions/workflows/ci.yml)
runs Node 22 and 24 on Windows x64, macOS Intel, macOS Apple Silicon and Linux
x64. Runner OS and architecture are asserted before installation. Each job
runs type checking, the full test suite, package installation verification and
dependency auditing. Test logs are retained for seven days, including failures.

The matrix runs for pushes to `main`, pull requests targeting `main`, and manual
dispatch. PTY load failures are failures, not silent skips. Tests specific to
another OS can still be skipped intentionally.

## What remains a manual check

- **Live model behavior:** scripted responses prove host integration, not whether
  every model independently chooses good arguments or explains failures well.
  Use the natural-language prompts in [examples](../examples/README.md) with
  your configured provider before a release. Verify that finite dependent jobs
  use wake, services stay quiet, progress questions use an immediate read, and
  abandoning a task disarms its wake. Check that the model reports results
  rather than just saying the command started.
- **Visual layout:** the native terminal checks verify output and interaction,
  not pixel-perfect rendering in every terminal emulator, theme or font.
- **Git hosting / registry conditions:** the artifact test uses Pi's local
  installation path. Git clone authentication, remote updates and npm registry
  publication are separate concerns. Release verification additionally installs
  the published npm version in an isolated Pi configuration and runs the examples.
- **Detached descendants / crash recovery:** the package does not promise
  process-tree proof or reattachment after a Pi crash. Tests cannot turn these
  documented limitations into guarantees.

The older `npm run test:tui` tests use tmux screen capture on POSIX and are
optional. They skip if tmux is absent; native terminal tests in `npm test` do
not depend on tmux and also run on Windows.
