// The one long-poll loop behind every command that blocks on a human: `ask`,
// `watch`, and `approval`. It lives here rather than in ask.js so the hot-loop
// floor and the terminal-state handling cannot drift apart — `approval` shipped
// its own copy of this loop once, and that copy read a field the server never
// sends, so it spun forever after the human had already decided.

import { fail, resolveWaitHold, sleep } from './util.js';
import { apiDetail, httpJson, pollDecision } from './http.js';
import { exitForState, printResolution } from './render.js';
import { writeGitHubQuestionOutputs } from './github-output.js';

/**
 * Long-poll until the question leaves `pending`, then print and return its exit
 * code. The server expires it at its ttl, so this always terminates.
 *
 * `exitFor` and `print` take the whole resolved question, not just its state:
 * a deploy gate has to read the chosen *value* to tell approve from deny, which
 * the state alone ("answered") cannot express.
 */
export async function waitForResolution(id, args, { token, apiBase }, opts = {}) {
  const exitFor = opts.exitFor ?? ((q) => exitForState(q.state));
  const print = opts.print ?? printResolution;
  const hold = resolveWaitHold(args, { def: 25, cap: 30 });

  for (;;) {
    const started = Date.now();
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await pollDecision(url, token);
    if (!res.ok) {
      const detail = apiDetail(res, json);
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && json.state !== 'pending') {
      if (args.github_output !== undefined) writeGitHubQuestionOutputs(args.github_output, json);
      if (args.json) process.stdout.write(`${text}\n`);
      else print(json);
      return exitFor(json);
    }
    // Still pending at the hold timeout — poll again, but never hot-loop: a
    // misbehaving server that answers `pending` instantly (ignoring the hold)
    // would otherwise be hammered at full speed.
    const elapsed = Date.now() - started;
    if (elapsed < 1000) await sleep(1000 - elapsed);
  }
}
