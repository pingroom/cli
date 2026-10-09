"""Exercise a foreground CLI job in its own controlling terminal/session."""

import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import tempfile
import termios
import time


node, cli, mode = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix="pingroom-terminal-") as directory:
    root = Path(directory)
    ready_path = root / "ready.json"
    result_path = root / "result.json"
    script = """
      const fs = require('node:fs');
      let count = 0;
      process.on('SIGINT', () => {
        count++;
        if (count === 1) setTimeout(() => {
          fs.writeFileSync(process.argv[2], JSON.stringify({ count }));
          process.exit(count);
        }, 300);
      });
      setInterval(() => {}, 1000);
      fs.writeFileSync(process.argv[1] + '.tmp', JSON.stringify({
        tty: [process.stdin, process.stdout, process.stderr].map(s => Boolean(s.isTTY)),
      }));
      fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);
    """
    try:
        pid, master = pty.fork()
    except OSError as error:
        print(f"PTY allocation unavailable: {error}", file=sys.stderr)
        sys.exit(77)
    if pid == 0:
        try:
            # Make the test's terminal Ctrl+C behavior explicit, independent of
            # the terminal settings inherited by the test runner.
            attributes = termios.tcgetattr(0)
            attributes[3] |= termios.ISIG
            attributes[6][termios.VINTR] = b"\x03"
            termios.tcsetattr(0, termios.TCSANOW, attributes)
            if mode == "redirected":
                # A launching shell normally keeps the PTY slave open. Keep
                # one extra descriptor here so fully redirected stdio does
                # not close the slave before the master sends Ctrl+C.
                terminal_keeper = os.dup(0)
                os.set_inheritable(terminal_keeper, True)
                for descriptor, path, flags in [
                    (0, os.devnull, os.O_RDONLY),
                    (1, root / "stdout", os.O_WRONLY | os.O_CREAT),
                    (2, root / "stderr", os.O_WRONLY | os.O_CREAT),
                ]:
                    opened = os.open(path, flags, 0o600)
                    os.dup2(opened, descriptor)
                    if opened != descriptor:
                        os.close(opened)
            os.environ["PINGROOM_HOME"] = str(root / "config")
            os.execv(node, [node, cli, "run", "--preview", "--", node, "-e", script,
                            str(ready_path), str(result_path)])
        except BaseException:
            os._exit(127)

    output = bytearray()
    status = None

    def interrupted(_signal, _frame):
        raise RuntimeError("PTY test interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def poll():
        global status
        if select.select([master], [], [], 0.02)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if status is None:
            waited, value = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = value
        time.sleep(0.01)

    try:
        deadline = time.monotonic() + 8
        while not ready_path.exists() and status is None and time.monotonic() < deadline:
            poll()
        if not ready_path.exists():
            raise RuntimeError("child did not become ready")
        child = json.loads(ready_path.read_text())
        foreground = os.tcgetpgrp(master) == pid
        os.write(master, b"\x03")
        while status is None and time.monotonic() < deadline:
            poll()
        if status is None:
            raise RuntimeError("job did not exit after Ctrl+C")
        poll()  # Drain the completion preview remaining on the PTY.
        if mode == "redirected":
            output.extend((root / "stdout").read_bytes())
            output.extend((root / "stderr").read_bytes())
        result = json.loads(result_path.read_text())
        print(json.dumps({
            "child_tty": child["tty"],
            "foreground_group": foreground,
            "signal_count": result["count"],
            "exit_code": os.waitstatus_to_exitcode(status),
            "output": output.decode(errors="replace"),
        }))
    finally:
        # pty.fork created a separate session/group. Kill only this fixture's
        # group on failure, then reap the wrapper without an unbounded wait.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if status is None:
            reap_deadline = time.monotonic() + 2
            while status is None and time.monotonic() < reap_deadline:
                poll()
        os.close(master)
