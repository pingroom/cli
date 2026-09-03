// `handoff` and `handoffs` — hand a decision to a specific human (ack or
// question) and, with --wait, block until they answer.

import { EXIT } from '../constants.js';
import { fail, parseDataObject, requireMaxLength, resolveWaitHold, sleep } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { agentContext } from '../config.js';
import { buildOptions, exitForHandoffState, HANDOFF_PENDING, printHandoff } from '../render.js';
import { writeGitHubHandoffOutputs } from '../github-output.js';

export async function listHandoffs(args) {
  if (args.help) { process.stdout.write(`${commandHelp('handoffs')}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const state = args.state || 'open';
  if (state !== 'open' && state !== 'all') {
    fail("--state must be 'open' or 'all' for handoffs", EXIT.USAGE);
  }

  const url = `${apiBase}/api/agent/handoffs?state=${encodeURIComponent(state)}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = apiDetail(res, json);
    fail(`handoffs list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const handoffs = (json && json.handoffs) || [];
  if (handoffs.length === 0) { process.stdout.write('no handoffs\n'); return EXIT.OK; }
  for (const h of handoffs) {
    const answer = h.answer && (h.answer.value ?? h.answer.text);
    const outcome = answer !== undefined && answer !== null ? ` → ${answer}` : '';
    process.stdout.write(
      `${h.id}  ${String(h.kind || '').padEnd(8)}  ${String(h.state || '').padEnd(9)}  ${h.prompt || ''}${outcome}\n`,
    );
  }
  return EXIT.OK;
}

// Long-poll GET /handoffs/{id}/wait until the handoff leaves open/pending, then
// print it and return the state's exit code. Reuses the shared bounded hold.
async function waitForHandoff(id, args, { token, apiBase }, initialDeliveryState) {
  const hold = resolveWaitHold(args, { def: 20, cap: 25 });

  for (;;) {
    const started = Date.now();
    const url = `${apiBase}/api/agent/handoffs/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = apiDetail(res, json);
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && !HANDOFF_PENDING.has(json.state)) {
      // Read/wait responses intentionally carry delivery_state=null. Preserve
      // the create response's durable delivery result so --wait callers and
      // the GitHub Action do not lose it at the terminal read boundary.
      const resolved = json.delivery_state == null && initialDeliveryState != null
        ? { ...json, delivery_state: initialDeliveryState }
        : json;
      if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, resolved);
      if (args.json) process.stdout.write(`${text}\n`);
      else printHandoff(resolved);
      return exitForHandoffState(resolved.state);
    }
    // Still open/pending at the hold timeout — poll again, with the same
    // hot-loop floor as waitForResolution.
    const elapsed = Date.now() - started;
    if (elapsed < 1000) await sleep(1000 - elapsed);
  }
}

export async function handoff(args) {
  if (args.help) { process.stdout.write(`${commandHelp('handoff')}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);
  requireMaxLength(message, 500, '--message');

  const { token, apiBase } = agentContext(args);

  const options = buildOptions(args.option);
  // Any --option (or an explicit --question) makes this a question handoff.
  const isQuestion = Boolean(args.question) || Boolean(options);
  if (isQuestion && (!options || options.length < 2)) {
    fail('a question handoff needs at least 2 --option values', EXIT.USAGE);
  }
  if (isQuestion && options && options.length > 4) {
    fail('a question handoff accepts at most 4 --option values', EXIT.USAGE);
  }
  if (!isQuestion && options) {
    fail('--option requires --question', EXIT.USAGE);
  }

  const body = { kind: isQuestion ? 'question' : 'ack', prompt: message };

  const target = args.target || 'me';
  body.audience = { type: 'direct', user_id: target };

  if (options) body.options = options;

  if (args.expires_in !== undefined) {
    if (!/^\d+$/.test(String(args.expires_in))) fail('--expires-in must be an integer number of seconds', EXIT.USAGE);
    const secs = Number(args.expires_in);
    if (secs < 120 || secs > 86_400) fail('--expires-in must be between 120 and 86400 seconds', EXIT.USAGE);
    body.expires_in = secs;
  }
  if (args.urgency !== undefined) {
    if (args.urgency !== 'active' && args.urgency !== 'passive') fail("--urgency must be 'active' or 'passive'", EXIT.USAGE);
    body.urgency = args.urgency;
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const headers = { Authorization: `Bearer ${token}` };
  // A stable Idempotency-Key lets network retries collapse to one resource; the
  // server returns the same handoff for a matching key+hash (409 on conflict).
  if (args.idempotency_key !== undefined) {
    if (!args.idempotency_key) fail('--idempotency-key must be non-empty', EXIT.USAGE);
    headers['Idempotency-Key'] = args.idempotency_key;
  }

  // Pre-flight: reject a bad --timeout before the handoff exists.
  if (args.wait) resolveWaitHold(args, { def: 20, cap: 25 });

  const url = `${apiBase}/api/agent/handoffs`;
  const { res, text, json } = await httpJson('POST', url, { body, headers });
  if (!res.ok) {
    const code = json && json.code;
    const detail = apiDetail(res, json);
    // A recipient who isn't reachable yet is a distinct, retriable outcome (4),
    // not a generic error — CI may want to wait and retry rather than fail hard.
    if (res.status === 409 && code === 'recipient_not_ready') {
      if (args.json) process.stdout.write(`${text}\n`);
      else process.stderr.write(`pingroom: ${detail}\n`);
      return EXIT.CANCELLED;
    }
    fail(`handoff failed: ${detail}`);
  }

  if (!args.wait) {
    if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, json);
    if (args.json) process.stdout.write(`${text}\n`);
    else printHandoff(json);
    return EXIT.OK;
  }

  return waitForHandoff(json.id, args, { token, apiBase }, json.delivery_state);
}
