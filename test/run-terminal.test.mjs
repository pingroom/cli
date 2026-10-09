import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/pingroom.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/run-terminal.py', import.meta.url));
// Python supplies a real controlling terminal for these tests only. The CLI
// itself uses Node built-ins and does not depend on Python or a PTY package.
const python = process.platform === 'win32' ? null
  : spawnSync('python3', ['-c', 'import pty, termios'], { timeout: 5000, encoding: 'utf8' });
const skip = process.platform === 'win32' ? 'POSIX controlling terminals are unavailable on Windows'
  : python.error || python.status !== 0 ? 'Python 3 with stdlib pty/termios is unavailable' : false;

for (const mode of ['attached', 'redirected']) {
  test(`one terminal Ctrl+C reaches the child once with ${mode} standard streams`, { skip }, (t) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PINGROOM_')) delete env[key];
    delete env.NODE_OPTIONS;
    const result = spawnSync('python3', [FIXTURE, process.execPath, CLI, mode], {
      env, encoding: 'utf8', timeout: 15000,
    });
    if (result.status === 77) { t.skip(result.stderr.trim()); return; }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.child_tty, Array(3).fill(mode === 'attached'));
    assert.equal(observed.foreground_group, true);
    assert.equal(observed.signal_count, 1, observed.output);
    assert.equal(observed.exit_code, 1, observed.output);
    assert.match(observed.output, /failed \(exit 1\)/);
  });
}

test('controlling-terminal probing closes its descriptor and tolerates unavailable terminals', { skip: process.platform === 'win32' }, () => {
  const runUrl = new URL('../lib/commands/run.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import tty from 'node:tty';
    import { syncBuiltinESMExports } from 'node:module';
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let descriptor;
    let closed = 0;
    let scenario;
    fs.openSync = function (path, ...args) {
      if (path !== '/dev/tty') return originalOpen(path, ...args);
      if (scenario === 'unavailable') throw Object.assign(new Error('no terminal'), { code: 'ENXIO' });
      descriptor = originalOpen('/dev/null', 'r');
      return descriptor;
    };
    fs.closeSync = function (fd) {
      if (fd === descriptor) closed++;
      return originalClose(fd);
    };
    tty.isatty = function (fd) {
      if (fd !== descriptor) return false;
      if (scenario === 'inspection-fails') throw new Error('inspection failed');
      return false;
    };
    syncBuiltinESMExports();
    const { run } = await import(${JSON.stringify(runUrl)});
    const outcomes = [];
    for (scenario of ['not-a-terminal', 'inspection-fails', 'unavailable']) {
      descriptor = undefined;
      const code = await run({ preview: true, _: [process.execPath, '-e', 'process.exit(6)'] });
      let descriptorClosed = true;
      if (descriptor !== undefined) {
        try { fs.fstatSync(descriptor); descriptorClosed = false; } catch (error) {
          if (error.code !== 'EBADF') throw error;
        }
      }
      outcomes.push({ code, descriptorClosed });
    }
    process.stdout.write(JSON.stringify({ outcomes, closed }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, detached: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    outcomes: Array(3).fill({ code: 6, descriptorClosed: true }), closed: 2,
  });
});
