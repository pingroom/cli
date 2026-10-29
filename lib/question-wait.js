// The one long-poll loop behind every command that blocks on a human: `ask`,
// `watch`, and `approval`. It lives here rather than in ask.js so the hot-loop
// floor and the terminal-state handling cannot drift apart — `approval` shipped
// its own copy of this loop once, and that copy read a field the server never
// sends, so it spun forever after the human had already decided.

import { fail, resolveWaitHold, stripControlChars, waitOutPollFloor } from './util.js';
import { apiDetail, pollDecision } from './http.js';
import { exitForState, formatPollTally, isPoll, printResolution } from './render.js';
import { writeGitHubQuestionOutputs } from './github-output.js';

/**
 * How long past a question's or handoff's expires_at an unreachable API is
 * retried. The server reports `expired` once expires_at passes, so after this
 * the only outcome left is one we cannot read. Covers clock skew.
 */
export const EXPIRY_GRACE_MS = 5 * 60 * 1000;

/**
 * The bound on an unbroken outage while the expiry is unknown: `watch` starts
 * with only an id, until a read returns the question's expires_at.
 */
export const UNKNOWN_EXPIRY_OUTAGE_MS = 15 * 60 * 1000;

/** pollDecision's bound for a decision expiring at `expiresAt` (an ISO time). */
export function waitBound(expiresAt) {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(at)
    ? { deadline: at + EXPIRY_GRACE_MS }
    : { maxOutageMs: UNKNOWN_EXPIRY_OUTAGE_MS };
}

/**
 * The wait endpoints always name a `state`. Fail the blocking wait, exit 1, on a
 * 2xx body that does not: the SDK rejects the same response as
 * `invalid_response`, and a loop that can never terminate must not be silent.
 */
export function requireWaitState(json, what) {
  if (typeof json?.state !== 'string' || json.state === '') {
    fail(`invalid response while waiting for ${what}: the API answered without a state`);
  }
}

/**
 * Long-poll until the question leaves `pending`, then print and return its exit
 * code. The server expires it at its ttl, so this terminates while the server
 * answers; when it stops answering, pollDecision gives up at the expiry plus
 * EXPIRY_GRACE_MS (`opts.expiresAt` from the create, or the expires_at of any
 * read) and exits 1.
 *
 * `exitFor` and `print` take the whole resolved question, not just its state:
 * a deploy gate has to read the chosen *value* to tell approve from deny, which
 * the state alone ("answered") cannot express.
 */
export async function waitForResolution(id, args, { token, apiBase }, opts = {}) {
  const exitFor = opts.exitFor ?? ((q) => exitForState(q.state));
  const print = opts.print ?? printResolution;
  const hold = resolveWaitHold(args, { def: 25, cap: 30 });
  let bound = waitBound(opts.expiresAt);
  const what = `question ${stripControlChars(id)}`;
  // A poll stays `pending` while votes arrive; report each change in the vote
  // count on stderr so a waiting shell isn't silent for the whole TTL.
  let lastVoteCount = 0;

  for (;;) {
    const started = Date.now();
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await pollDecision(url, token, { ...bound, what });
    if (!res.ok) {
      const detail = apiDetail(res, json);
      fail(`wait failed: ${detail}`);
    }
    // A 2xx that names no state (a gateway or mock answering `{}`) is not
    // `pending` and not a verdict: nothing it says can ever end this loop, so it
    // used to re-poll once a second, silently, until the CI job timed out.
    requireWaitState(json, what);
    // `watch` starts without the expiry and learns it from its first read.
    const learned = waitBound(json?.expires_at);
    if (learned.deadline !== undefined) bound = learned;
    if (json.state !== 'pending') {
      if (args.github_output !== undefined) writeGitHubQuestionOutputs(args.github_output, json);
      if (args.json) process.stdout.write(`${text}\n`);
      else print(json);
      return exitFor(json);
    }
    if (!args.json && isPoll(json) && json.results) {
      const votes = Number(json.results.response_count) || 0;
      if (votes !== lastVoteCount) {
        lastVoteCount = votes;
        process.stderr.write(`pingroom: poll: ${formatPollTally(json.results)}\n`);
      }
    }
    // Still pending at the hold timeout — poll again, but never hot-loop: a
    // misbehaving server that answers `pending` instantly (ignoring the hold)
    // would otherwise be hammered at full speed.
    await waitOutPollFloor(started);
  }
}
