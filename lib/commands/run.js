import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';

import { EXIT, PING_TITLE_MAX_LENGTH, PRIVATE_PING_MESSAGE_MAX_LENGTH } from '../constants.js';
import { agentContext } from '../config.js';
import { commandHelp } from '../help.js';
import { httpJson, requireSafeUrl } from '../http.js';
import { fail, requireMaxLength, stripControlChars, truncate } from '../util.js';

function destination(args) {
  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  if (webhook) {
    requireSafeUrl('--webhook', webhook);
    if (new URL(webhook).username || new URL(webhook).password) {
      fail('--webhook must not contain URL user credentials', EXIT.USAGE);
    }
    return { url: webhook, headers: {} };
  }
  const { token, apiBase, room } = agentContext(args, { needRoom: true });
  if (new URL(apiBase).username || new URL(apiBase).password) {
    fail('--api must not contain URL user credentials', EXIT.USAGE);
  }
  const headers = { Authorization: `Bearer ${token}` };
  try { new Headers(headers); } catch {
    fail('the agent token is not a valid HTTP credential', EXIT.USAGE);
  }
  return { url: `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`, headers };
}

function labelFor(args) {
  requireMaxLength(args.name, PING_TITLE_MAX_LENGTH, '--name');
  const label = stripControlChars(args.name ?? basename(args._[0]))
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
  if (args.name !== undefined && !label) fail('--name must contain visible text', EXIT.USAGE);
  return truncate(label || 'Command', PING_TITLE_MAX_LENGTH);
}

export async function run(args) {
  if (args.help) { process.stdout.write(`${commandHelp('run')}\n`); return EXIT.OK; }
  if (!args._?.[0]) fail('run requires -- <command> [args...]', EXIT.USAGE);
  const label = labelFor(args);
  const rawTimeout = String(args.notify_timeout ?? '10');
  if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 1 || Number(rawTimeout) > 60) {
    fail('--notify-timeout must be an integer from 1 to 60 seconds', EXIT.USAGE);
  }
  // Resolve once before launching, so a job cannot run for hours only to find
  // a missing destination, or have a changed config redirect its completion.
  const target = args.preview ? null : destination(args);
  if (args.preview) process.stderr.write('pingroom: preview EXECUTES the command; no ping will be sent.\n');

  let child;
  let notifying;
  let timer;
  const terminal = process.platform !== 'win32'
    && [process.stdin, process.stdout, process.stderr].some((stream) => stream.isTTY);
  const forward = (signal) => {
    if (child) {
      // Ctrl+C already reaches the foreground process group. Forwarding it
      // again can turn a child's graceful shutdown into a forced second one.
      // Node does not expose the signal sender; interactive PID-only SIGINT
      // callers must target the foreground group instead.
      if (signal === 'SIGINT' && terminal) return;
      try { child.kill(signal); } catch { /* child exited concurrently */ }
    } else {
      notifying?.abort();
    }
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const started = performance.now();
  try {
    const outcome = await new Promise((resolve) => {
      const launchError = (error) => resolve({ code: error?.code === 'ENOENT' ? 127 : 126, launchFailed: true });
      try {
        child = spawn(args._[0], args._.slice(1), { stdio: 'inherit', shell: false });
        child.once('error', launchError);
        // After a successful launch, an 'error' only means a forwarded kill()
        // failed (EPERM, say). The child is still running and 'exit' still
        // settles the outcome, so it must not be reported as a launch failure.
        // Keep a listener: an unhandled 'error' event would crash the wrapper.
        child.once('spawn', () => {
          child.removeListener('error', launchError);
          child.on('error', () => {});
        });
        child.once('exit', (code, signal) => resolve({
          code: code ?? 128 + (constants.signals[signal] ?? 1), signal,
        }));
      } catch (error) { launchError(error); }
    });
    child = null;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const status = outcome.launchFailed ? 'could not start'
      : outcome.signal ? `stopped by ${outcome.signal}`
        : outcome.code === 0 ? 'succeeded' : 'failed';
    const payload = {
      title: label,
      message: truncate(`${label} ${status} (exit ${outcome.code}) after ${seconds}s.`, PRIVATE_PING_MESSAGE_MAX_LENGTH),
    };
    if (outcome.launchFailed) process.stderr.write(`pingroom: command could not start (exit ${outcome.code}).\n`);
    if (args.preview) {
      process.stderr.write(`pingroom: ping preview ${JSON.stringify(payload)}\n`);
    } else {
      // soft:true avoids httpJson's process.exit path. Neither transport errors
      // nor untrusted server response text may replace or leak into job output.
      notifying = new AbortController();
      timer = setTimeout(() => notifying.abort(), Number(rawTimeout) * 1000);
      try {
        const result = await httpJson('POST', target.url, {
          body: payload, headers: target.headers, soft: true, signal: notifying.signal,
        });
        if (result.res?.ok && result.json?.success !== false) {
          process.stderr.write('pingroom: completion ping sent.\n');
        } else {
          process.stderr.write('pingroom: completion ping failed; command exit status preserved.\n');
        }
      } catch {
        process.stderr.write('pingroom: completion ping failed; command exit status preserved.\n');
      }
    }
    return outcome.code;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
