import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, baseEnv, questionServer } from './helpers.mjs';

function runWithClosedReader(args, stream) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      if (name === stream) child[name].destroy();
      else child[name].on('data', (chunk) => { output[name] += chunk; });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, ...output });
    });
  });
}

test('closed readers never turn denied, expired or cancelled gates into success', async () => {
  for (const command of ['ask', 'approval']) {
    for (const state of ['answered', 'expired', 'cancelled']) {
      const { server, baseUrl, received } = await questionServer({
        'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_gate', state: 'pending' } }),
        'GET /api/agent/questions/q_gate/wait': () => ({ status: 200, body: {
          id: 'q_gate', state, resolution_policy: 'first',
          options: [{ value: 'approve' }, { value: 'deny' }],
          answer: state === 'answered' ? { value: 'deny' } : null,
        } }),
      });
      try {
        const result = await runWithClosedReader([
          command, '--wait', '-p', 'Deploy?', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
        ], state === 'answered' ? 'stdout' : 'stderr');
        assert.equal(result.timedOut, false);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0, `${command} ${state} must fail closed`);
        assert.doesNotMatch(result.stderr, /EPIPE|Error:|node:events/);
        assert.equal(received.filter((request) => request.method === 'POST').length, 1);
      } finally {
        server.close();
      }
    }
  }
});

test('a closed stderr reader cannot make bad usage succeed', async () => {
  const result = await runWithClosedReader(['ask', '--bogus'], 'stderr');
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
});

test('help readers may still close early without an error or stack trace', async () => {
  for (const args of [['--help'], ['help', 'all'], ['help', 'ask'], ['ask', '--help']]) {
    const result = await runWithClosedReader(args, 'stdout');
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '');
  }
});
