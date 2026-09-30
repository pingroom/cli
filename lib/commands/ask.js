// The Question protocol: `ask` (create, optionally block), `watch` (block on an
// existing one), `cancel`, and `list`.

import { EXIT } from '../constants.js';
import { stripControlChars, applyIdempotencyKey, fail, parseDataObject, requireMaxLength, resolveWaitHold } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { agentContext } from '../config.js';
import { buildOptions } from '../render.js';
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

  if (!args.wait) {
    // The question is live but nobody has answered yet, so the only honest
    // state for a workflow to read is `pending`.
    if (args.github_output !== undefined) {
      writeGitHubQuestionOutputs(args.github_output, { id: json.id, state: 'pending' });
    }
    if (args.json) process.stdout.write(`${text}\n`);
    else process.stdout.write(`${json.id}\n`);
    return EXIT.OK;
  }

  return waitForResolution(json.id, args, { token, apiBase });
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
    process.stdout.write(`${stripControlChars(q.id)}  ${stripControlChars(q.state).padEnd(9)}  ${stripControlChars(q.prompt)}${stripControlChars(answer)}\n`);
  }
  return EXIT.OK;
}
