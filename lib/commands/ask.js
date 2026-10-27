// The Question protocol: `ask` (create, optionally block), `watch` (block on an
// existing one), `cancel`, and `list`.

import { EXIT } from '../constants.js';
import { stripControlChars, applyIdempotencyKey, fail, parseDataObject, requireCreatedId, requireMaxLength, resolveWaitHold } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { agentContext } from '../config.js';
import { buildOptions, formatPollProgress } from '../render.js';
import { waitForResolution } from '../question-wait.js';
import { writeGitHubQuestionOutputs } from '../github-output.js';

export async function ask(args) {
  if (args.help) { process.stdout.write(`${commandHelp('ask')}\n`); return EXIT.OK; }

  const prompt = args.prompt;
  if (!prompt) fail('a --prompt is required', EXIT.USAGE);
  requireMaxLength(prompt, 500, '--prompt');
  requireMaxLength(args.context, 40, '--context');

  const { token, apiBase, room } = agentContext(args, { needRoom: true });

  const body = { prompt };
  const options = buildOptions(args.option);
  if (options) body.options = options;
  if (args.context) body.context = args.context;
  if (args.scope !== undefined) {
    if (args.scope !== 'direct' && args.scope !== 'room') fail("--scope must be 'direct' or 'room'", EXIT.USAGE);
    body.responder_scope = args.scope;
  }
  if (args.target !== undefined) body.target_user_id = args.target;
  if (args.ttl !== undefined) {
    if (!/^\d+$/.test(String(args.ttl))) fail('--ttl must be an integer number of seconds', EXIT.USAGE);
    body.ttl = Number(args.ttl);
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.text_input !== undefined || args.text_max !== undefined) {
    const textInput = {};
    if (args.text_input) textInput.placeholder = String(args.text_input).slice(0, 60);
    if (args.text_max !== undefined) {
      const n = Number(args.text_max);
      if (!/^\d+$/.test(String(args.text_max)) || n < 1 || n > 60) {
        fail('--text-max must be an integer between 1 and 60', EXIT.USAGE);
      }
      textInput.max_length = n;
    }
    body.text_input = textInput;
  }
  if (args.poll) {
    // A poll asks the whole room and counts option votes. The server refuses
    // these combinations with a 422, so fail before anything is created.
    if (args.scope === 'direct' || args.target !== undefined) {
      fail('--poll asks the whole room; it cannot be combined with --scope direct or --target', EXIT.USAGE);
    }
    if (args.text_input !== undefined || args.text_max !== undefined) {
      fail('--poll counts option votes; it cannot be combined with --text-input or --text-max', EXIT.USAGE);
    }
    body.resolution_policy = 'all';
  }
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const headers = applyIdempotencyKey(args, { Authorization: `Bearer ${token}` });

  // Pre-flight: reject a bad --timeout before the question exists.
  if (args.wait) resolveWaitHold(args, { def: 25, cap: 30 });

  const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`;
  const { res, text, json } = await httpJson('POST', url, { body, headers });
  if (!res.ok) {
    const detail = apiDetail(res, json);
    fail(`ask failed: ${detail}`);
  }
  const id = requireCreatedId(json, 'ask');

  // The server answered a --poll with a non-poll policy; the only server path
  // that does this is a room with nobody else in it to poll. Say so, or a
  // script would read one person's answer as the room's vote.
  if (args.poll && json && json.resolution_policy && json.resolution_policy !== 'all') {
    process.stderr.write('pingroom: the server asked this as a direct, first-answer question (nobody else in the room to poll)\n');
  }

  if (!args.wait) {
    // The question is live but nobody has answered yet, so the only honest
    // state for a workflow to read is `pending`.
    if (args.github_output !== undefined) {
      writeGitHubQuestionOutputs(args.github_output, { id, state: 'pending' });
    }
    if (args.json) process.stdout.write(`${text}\n`);
    else process.stdout.write(`${stripControlChars(id)}\n`);
    return EXIT.OK;
  }

  return waitForResolution(id, args, { token, apiBase });
}

export async function watch(args) {
  if (args.help) { process.stdout.write(`${commandHelp('watch')}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom watch <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  return waitForResolution(id, args, { token, apiBase });
}

export async function cancel(args) {
  if (args.help) { process.stdout.write(`${commandHelp('cancel')}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom cancel <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/cancel`;
  const { res, text, json } = await httpJson('POST', url, { body: {}, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = apiDetail(res, json);
    fail(`cancel failed: ${detail}`);
  }
  if (args.json) process.stdout.write(`${text}\n`);
  else process.stdout.write(`cancelled (${stripControlChars(json && json.state)})\n`);
  return EXIT.OK;
}

export async function list(args) {
  if (args.help) { process.stdout.write(`${commandHelp('list')}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const qs = args.state ? `?state=${encodeURIComponent(args.state)}` : '';
  const url = `${apiBase}/api/agent/questions${qs}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = apiDetail(res, json);
    fail(`list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const questions = (json && json.questions) || [];
  if (questions.length === 0) { process.stdout.write('no questions\n'); return EXIT.OK; }
  for (const q of questions) {
    const answer = q.answer && q.answer.value ? ` → ${q.answer.value}` : '';
    process.stdout.write(`${stripControlChars(q.id)}  ${stripControlChars(q.state).padEnd(9)}  ${stripControlChars(q.prompt)}${stripControlChars(answer)}${formatPollProgress(q)}\n`);
  }
  return EXIT.OK;
}
