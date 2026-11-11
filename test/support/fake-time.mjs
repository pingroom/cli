// Preloaded into a spawned CLI (`node --import`) so a test can assert how long
// the CLI chose to wait without waiting it out, or racing a loaded machine.
//
// Time is virtual. Date.now() starts at the real clock and then moves only when
// the CLI sleeps, so the delay a pacing rule asks for is exact: an assertion on
// a wall clock has to leave room for process start-up and the first fetch, and
// that room is what ran out when the suite shared a machine with others.
// Each sleep() in lib/util.js is appended to the file named by
// PINGROOM_TEST_SLEEP_LOG, one millisecond count per line, and then returns on
// the next tick. Every other timer keeps running on the real clock: undici's
// connect and keep-alive timers go through the same global setTimeout and
// would expire the moment they were armed.
//
// AbortSignal.timeout() is the CLI's other clock: every request deadline is
// built from Date.now() and handed to it. On the real clock a request given
// the 100 ms that a test's deadline has left would abort after 100 real ms,
// and a loaded machine needs longer than that to answer a localhost request, so
// the run would end "while PingRoom was unavailable" instead of at its
// deadline. So a signal made here is virtual too: it aborts, with the same
// TimeoutError, only once the CLI has slept past its deadline.

import { appendFileSync } from 'node:fs';

const log = process.env.PINGROOM_TEST_SLEEP_LOG;
const realSetTimeout = globalThis.setTimeout;
const start = Date.now();
let slept = 0;
const timeouts = new Set();

Date.now = () => start + slept;

AbortSignal.timeout = (delay) => {
  if (!Number.isInteger(delay) || delay < 0 || delay > 0xffffffff) {
    throw new RangeError(`AbortSignal.timeout needs an integer from 0 to 4294967295, got ${delay}`);
  }
  const controller = new AbortController();
  timeouts.add({ at: start + slept + delay, controller });
  return controller.signal;
};

function abortTimedOutSignals() {
  for (const timeout of timeouts) {
    if (timeout.at > start + slept) continue;
    timeouts.delete(timeout);
    timeout.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }
}

globalThis.setTimeout = (callback, delay, ...args) => {
  // Stack line 0 is "Error", 1 is this function, 2 is whoever armed the timer.
  const caller = new Error().stack.split('\n')[2] ?? '';
  if (!caller.includes('/lib/util.js:')) return realSetTimeout(callback, delay, ...args);
  slept += delay;
  if (log) appendFileSync(log, `${delay}\n`);
  abortTimedOutSignals();
  return realSetTimeout(callback, 0, ...args);
};
