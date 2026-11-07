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

import { appendFileSync } from 'node:fs';

const log = process.env.PINGROOM_TEST_SLEEP_LOG;
const realSetTimeout = globalThis.setTimeout;
const start = Date.now();
let slept = 0;

Date.now = () => start + slept;

globalThis.setTimeout = (callback, delay, ...args) => {
  // Stack line 0 is "Error", 1 is this function, 2 is whoever armed the timer.
  const caller = new Error().stack.split('\n')[2] ?? '';
  if (!caller.includes('/lib/util.js:')) return realSetTimeout(callback, delay, ...args);
  slept += delay;
  if (log) appendFileSync(log, `${delay}\n`);
  return realSetTimeout(callback, 0, ...args);
};
