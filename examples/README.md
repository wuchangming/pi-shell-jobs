# Runnable examples

[Back to README](../README.md) · [More recipes](../docs/recipes.md)

From a checkout, run `npm ci`, then `pi -e .`. The commands below assume Pi's
working directory is the checkout root. Both scripts use only Node's standard
library and are also included in the installable package.

## A job that returns control before finishing

Ask Pi:

> Run `node examples/progress.mjs` using exec_command with a 500 ms yield and
> a 20-second hard timeout and on_exit wake. Keep the returned session ID.
> Inspect current progress once with write_stdin and yield_time_ms: 0, then
> list this directory while the job runs. When notified, collect its final
> output and report the result. Do not start the command again.

The script prints six progress updates over three seconds, followed by
`progress: done`. Expect a running `session_id` first and `exit_code: 0` after
completion. Depending on when you collect, updates can appear in either result.

## Interactive terminal

Ask Pi:

> Start `node examples/interactive.mjs` with tty enabled and a 60-second hard
> timeout. Send `hello` followed by the terminal Enter key, resize the terminal
> to 100 columns and 35 rows, then send `quit` followed by Enter. Report the echo
> and final exit code.

Expected output contains `echo: hello`, then `interactive: done`, with exit code
0. In tool arguments, Enter is `\r`, including on Windows.

## Pipe input and EOF

Run the same interactive script with `tty: false`. Send `hello\n` with
`end_stdin: true`. It prints `echo: hello`, receives EOF, and exits 0. This is
useful for programs that keep waiting until their input stream is closed.

## Deadline and stop

Start the interactive script with `timeout_seconds: 2` and send no input. After
the deadline, collect the same session. Its `supervision.state` should be
`timed_out`; silence itself is not the reason for termination.

Alternatively, start it with a longer deadline and stop it from
`/shell-jobs-sessions`. The picker offers a single job or all jobs. This also
disarms pending completion notifications.

The [package smoke test](https://github.com/wuchangming/pi-shell-jobs/blob/main/tests/package-install.test.mjs) runs both scripts
through a real Pi host after installing the tarball, including terminal input,
resize, EOF, notifications policy and explicit stop.
