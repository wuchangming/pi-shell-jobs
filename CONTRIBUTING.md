# Contributing

Use Node 22.19+ and Git. The development tree pins Pi 1.4.0 for reproducible
host tests. Install dependencies with `npm ci`; start a local Pi session with
`pi -e .` from the repository root.

## Before submitting a change

```sh
npm test
npm run test:package
npm audit --audit-level=high
```

For focused work, `npm run test:integration` runs only the actual Pi host
tests. The full suite already includes those tests. Package verification needs
registry access but no model credentials. [Testing](docs/testing.md) describes
the layers and the checks that remain manual.

Add a regression test for a behavior change, especially around asynchronous
completion, reload, termination and output limits. Use actual child processes
when testing lifecycle behavior; mock boundaries only when the failure cannot
be reproduced reliably with a real process. Use Node-based fixtures for shared
cross-platform cases, and keep OS-specific skips explicit.

Keep these contracts intact:

- A yield or cancelled wait does not terminate a job.
- Live jobs keep an owner until exit is confirmed; admission never evicts one.
- Completion notifications are consumed at Pi's finalized tool-result boundary.
- Reload preserves the original deadline and log budget.
- Logs, buffers and model output have independent bounds.
- The extension uses Pi's public APIs and has no company-specific integration.

Update the relevant recipe/reference when changing user-visible behavior and
add a note under `Unreleased` in [CHANGELOG.md](CHANGELOG.md). Keep examples
runnable with the dependencies already required by the package.

Pull requests should explain the observable problem, the resulting behavior
and relevant verification. Native CI must pass on all eight platform/Node
combinations before treating a change as cross-platform verified. Do not commit
generated logs, tarballs, credentials or personal Pi settings.

This project includes MIT-licensed upstream work. Preserve [LICENSE](LICENSE)
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when adapting that code.
