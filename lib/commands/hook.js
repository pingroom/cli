import { readFileSync } from 'node:fs';

import { EXIT, PRIVATE_PING_MESSAGE_MAX_LENGTH } from '../constants.js';
import { truncate } from '../util.js';
import { commandHelp } from '../help.js';
import { hookFetch, isSafeUrl } from '../http.js';
import { resolveApiBase, resolveRoom, resolveToken, storedCredentialOriginError } from '../config.js';
import { forgetContinuation, recordContinuation } from '../continuations.js';
import { VERSION } from '../version.js';

// --- hook (Claude Code integration) ----------------------------------------
//
// A single command wired into several Claude Code hook events. It reads the
// hook's JSON payload on stdin and switches on `hook_event_name`:
//   Stop / SubagentStop / SessionEnd  -> ping the room ("Claude finished")
//   Notification                      -> ping the room (idle / needs-input)
//   PreToolUse                        -> ask a PingRoom question and gate the
//                                        tool call on the phone's Approve/Deny.
//
// Safety: the hook FAILS OPEN. It never blocks the agent and never
// auto-approves. Any missing config / network error / non-answer defers to the
// normal local prompt (PreToolUse -> permissionDecision "ask") and exits 0. It
// must not call fail() (a non-zero exit — 2 especially — would break the run).

// Read all of stdin as a string. Resolves '' when nothing is piped (TTY), so a
// stray `pingroom hook` in a terminal is a silent no-op rather than a hang.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// Pull the readable text out of a Claude transcript message's content, which is
// either a plain string or an array of typed blocks.
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

// Tail a Claude Code transcript (JSONL) and return the last assistant message as
// a single truncated line. Best-effort: any read/parse failure yields ''.
function summarizeTranscript(path) {
  if (!path || typeof path !== 'string') return '';
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return ''; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry && entry.message;
    if (!msg || msg.role !== 'assistant') continue;
    const text = extractAssistantText(msg.content).replace(/\s+/g, ' ').trim();
    // The tighter PRIVATE bound, not the public one. `ping --message` may sit at
    // the public ceiling because the caller typed that text and the server is
    // entitled to reject it. Here the CLI COMPOSES the body, and a hook room is
    // private (max 120), so truncating at 160 would hand the server a body it
    // rejects — and hookPing swallows the 422, silently dropping the ping. The
    // text is already being truncated, so the tighter cut costs nothing and is
    // valid in a public room too.
    if (text) return truncate(text, PRIVATE_PING_MESSAGE_MAX_LENGTH);
  }
  return '';
}

// The widest approval prompt this hook will send, in display columns (see
// displayWidth). Approving grants EXACTLY the tool input Claude Code proposed,
// so the human must be able to read all of it on every surface that offers
// Approve: the app clamps a question prompt to eight lines
// (PING_BODY_VISUAL_LINE_LIMIT in the mobile QuestionCell and ApprovalCard,
// ~38 narrow columns a line at the default 16pt) and the Telegram mirror to 256
// characters. 160 columns leaves headroom for word-wrap and for larger
// accessibility text sizes, which shrink a line's capacity. A wider call is
// never shortened — shortening it is what let an unseen suffix ride along with
// an approval — it goes to the local prompt instead.
const APPROVAL_PROMPT_MAX_COLUMNS = 160;

// Tools whose input carries file content. A question's prompt reaches every
// room member's push, the room's outgoing webhook and its Telegram mirror, so
// content (a .env write, a key pasted into an edit) must never ride along: these
// calls are always approved locally.
const CONTENT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'new_source', 'edits']);

function carriesFileContent(toolName, input) {
  if (CONTENT_TOOLS.has(toolName)) return true;
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.keys(value).some((key) => CONTENT_KEYS.has(key) || walk(value[key]));
  };
  return walk(input);
}

// East Asian Wide/Fullwidth blocks (Hangul Jamo, CJK radicals through CJK
// Compatibility, Hangul syllables, CJK ideographs and extensions, fullwidth
// forms) plus emoji: each takes two columns.
const WIDE_CHARACTER = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}\p{Extended_Pictographic}\p{Emoji_Presentation}]/u;

// Display width in narrow columns: wide glyphs count 2, everything else 1.
// Deliberately over-counts (a combining mark counts 1), never under.
function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += WIDE_CHARACTER.test(ch) ? 2 : 1;
  return width;
}

// For a tool whose effect is one field, show just that field — but only when
// every other key present is one that cannot change what runs. Anything else
// (Bash's sandbox override, an unknown tool) shows the whole input as JSON, so nothing the approval covers is left out.
const PRIMARY_FIELDS = [
  ['command', new Set(['description', 'timeout', 'run_in_background'])], // Bash
  ['file_path', new Set(['offset', 'limit'])],                            // Read
];

// Render text so it cannot hide part of itself: line breaks, tabs, other
// control characters and invisible format characters (zero-width spaces,
// bidi overrides) become visible escapes instead of reshaping the prompt.
function visibleText(raw) {
  return String(raw).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\u{${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;
  });
}

// The complete, visible description of the tool call for the question prompt.
// Never truncated: the caller decides whether it fits. Null when there is no
// input to show, since the tool would still run with whatever it really has.
function describeToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  const keys = Object.keys(input);
  for (const [field, harmless] of PRIMARY_FIELDS) {
    if (typeof input[field] !== 'string') continue;
    if (keys.every((key) => key === field || harmless.has(key))) return visibleText(input[field]);
  }
  let raw;
  try { raw = JSON.stringify(input); } catch { return null; }
  return typeof raw === 'string' ? visibleText(raw) : null;
}

// The approval prompt as `{ prompt }`, or `{ refused }` with the reason the
// call must go to the local prompt instead of the phone.
function approvalPrompt(toolName, input) {
  if (carriesFileContent(toolName, input)) {
    return { refused: 'Tool call carries file content, which PingRoom would share with the room' };
  }
  const description = describeToolInput(input);
  if (description === null) return { refused: 'Tool call has no input PingRoom can show' };
  const prompt = `Run ${visibleText(toolName)}: ${description}?`;
  if (displayWidth(prompt) > APPROVAL_PROMPT_MAX_COLUMNS) {
    return { refused: 'Tool call too long to show in full on PingRoom' };
  }
  return { prompt };
}

function emitPreToolUseDecision(decision, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })}\n`);
}

// Long-poll the wait endpoint until the question leaves `pending`. The server
// expires it at its ttl, so this always terminates; a mid-poll throw propagates
// to the caller's fail-open handler.
async function hookWaitForAnswer(id, { token, apiBase }) {
  for (;;) {
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=25`;
    const json = await hookFetch('GET', url, { token });
    if (json && json.state && json.state !== 'pending') return json;
  }
}

async function hookPreToolUse(event, { token, room, apiBase, args }) {
  if (!token || !room) {
    emitPreToolUseDecision('ask', 'PingRoom not configured (pair by QR, or configure both a token and room)');
    return EXIT.OK;
  }

  const toolName = event.tool_name || 'a tool';
  const { prompt, refused } = approvalPrompt(toolName, event.tool_input);
  if (refused) {
    // Never ask the phone to approve text it would only see part of, or to
    // broadcast file content to the room.
    emitPreToolUseDecision('ask', `${refused} — deferring to local prompt`);
    return EXIT.OK;
  }

  let ttl = 900;
  if (args.ttl !== undefined && /^\d+$/.test(String(args.ttl))) ttl = Number(args.ttl);

  let questionId;
  let cancelled = false;
  const cancelQuestion = async () => {
    if (!questionId || cancelled) return;
    cancelled = true;
    try {
      await hookFetch('POST', `${apiBase}/api/agent/questions/${encodeURIComponent(questionId)}/cancel`, { body: {}, token });
    } catch { /* best-effort — a leftover question expires on its own ttl */ }
  };
  // If the agent aborts the tool call, withdraw the question so it doesn't linger
  // on the phone. Exit 0 so the abort itself isn't reported as a hook failure.
  const onSignal = () => { cancelQuestion().finally(() => process.exit(EXIT.OK)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // `data` is echoed into every room member's push AND into the room's
    // outgoing webhook, so it carries only what a recipient should see. The
    // working directory is a local filesystem path: it goes to
    // ~/.pingroom/continuations.json below, never on the wire.
    const data = { tool_name: String(toolName) };
    const created = await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`, {
      token,
      body: {
        prompt,
        context: 'Claude Code',
        options: [
          { value: 'allow', label: 'Approve', style: 'primary' },
          { value: 'deny', label: 'Deny', style: 'danger' },
        ],
        ttl,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    questionId = created && created.id;
    if (!questionId) {
      emitPreToolUseDecision('ask', 'PingRoom did not return a question — deferring to local prompt');
      return EXIT.OK;
    }

    // Where this session would need to resume from, kept locally. Best-effort:
    // a failure here must not change the tool decision.
    recordContinuation(questionId, {
      sessionId: event.session_id,
      cwd: event.cwd,
      transcriptPath: event.transcript_path,
    });

    const resolved = await hookWaitForAnswer(questionId, { token, apiBase });
    forgetContinuation(questionId);
    if (resolved.state === 'answered') {
      const value = resolved.answer && (resolved.answer.value || resolved.answer.text);
      if (value === 'allow') { emitPreToolUseDecision('allow', 'Approved via PingRoom'); return EXIT.OK; }
      if (value === 'deny') { emitPreToolUseDecision('deny', 'Denied via PingRoom'); return EXIT.OK; }
      emitPreToolUseDecision('ask', `PingRoom answer "${value}" — deferring to local prompt`);
      return EXIT.OK;
    }
    emitPreToolUseDecision('ask', `PingRoom question ${resolved.state} — deferring to local prompt`);
    return EXIT.OK;
  } catch (err) {
    emitPreToolUseDecision('ask', `PingRoom unavailable (${err.message}) — deferring to local prompt`);
    return EXIT.OK;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function hookNotify(event, name, { token, room, apiBase, args }) {
  if (!token || !room) {
    if (!args.quiet) process.stderr.write('pingroom: hook skipped (pair by QR, or configure both a token and room)\n');
    return EXIT.OK;
  }

  let title;
  let message;
  if (name === 'Stop' || name === 'SubagentStop') {
    title = 'Claude finished';
    message = summarizeTranscript(event.transcript_path) || 'Session finished — waiting for you.';
  } else if (name === 'Notification') {
    message = truncate(event.message || 'Claude is waiting for your input.', PRIVATE_PING_MESSAGE_MAX_LENGTH);
    // A PreToolUse hook already turns permission prompts into a question; skip
    // the duplicate "needs your permission" Notification so you aren't paged twice.
    if (/permission/i.test(message)) return EXIT.OK;
    title = 'Claude needs you';
  } else if (name === 'SessionEnd') {
    if (event.reason === 'clear') return EXIT.OK; // /clear isn't worth a ping
    title = 'Session ended';
    // `reason` is whatever the host put in the event, so bound the composed
    // line rather than trusting it to stay short.
    message = truncate(
      `Claude Code session ended (${event.reason || 'unknown'}).`,
      PRIVATE_PING_MESSAGE_MAX_LENGTH,
    );
  } else {
    return EXIT.OK; // unknown event — stay silent rather than send noise
  }

  // Same rule as the question path: nothing here is private to this machine.
  // `session_id` is already the ping's correlation_id, so it is on the wire by
  // design; `cwd` is a local path and stays local.
  const data = { event: name };
  if (event.session_id) data.session_id = String(event.session_id);

  try {
    await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`, {
      token,
      body: {
        message,
        title,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    if (!args.quiet) process.stderr.write('pingroom: pinged ✅\n');
  } catch (err) {
    // A broken ping must never break the agent — report to stderr and exit 0.
    if (!args.quiet) process.stderr.write(`pingroom: hook ping failed (${err.message})\n`);
  }
  return EXIT.OK;
}

function printHookConfig() {
  const command = `npx --yes @pingroom/cli@${VERSION} hook`;
  const config = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command }] }],
      Notification: [{ hooks: [{ type: 'command', command }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 960 }] }],
    },
  };
  process.stdout.write(
`# PingRoom × Claude Code — merge this into ~/.claude/settings.json
#
# 1. Connect once and choose a home room when you scan the QR:
#      npm install --global @pingroom/cli && pingroom
#    Or, without a global install:
#      npx --yes @pingroom/cli@${VERSION}
#    The hook reads that stored credential and paired room automatically; you do
#    not need to export PINGROOM_TOKEN or PINGROOM_ROOM for a local setup.
#
# 2. Merge the "hooks" block below into ~/.claude/settings.json.
#      Stop / Notification  -> ping your phone.
#      PreToolUse (Bash)     -> ask a question you Approve/Deny from the lock
#                               screen before the command runs. Add or change the
#                               matcher to gate other tools.
#
# If PingRoom is unreachable the hook defers to the normal local prompt — it
# never auto-approves and never blocks the agent.
# PINGROOM_TOKEN / PINGROOM_ROOM remain supported for CI and headless shells.

${JSON.stringify(config, null, 2)}
`);
}

export async function hook(args) {
  if (args.help) { process.stdout.write(`${commandHelp('hook')}\n`); return EXIT.OK; }
  if (args.print_config) { printHookConfig(); return EXIT.OK; }

  let event = {};
  const raw = await readStdin();
  if (raw) { try { event = JSON.parse(raw); } catch { event = {}; } }
  const name = event.hook_event_name || '';

  // The hook fails open, so it reads the same layered config as everything else
  // but never complains about a missing piece — it just defers.
  const token = resolveToken(args);
  const room = resolveRoom(args);
  const apiBase = resolveApiBase(args);

  const originError = storedCredentialOriginError(args, apiBase);
  if (originError) {
    if (name === 'PreToolUse') {
      emitPreToolUseDecision('ask', `${originError}; deferring to local prompt`);
    } else if (!args.quiet) {
      process.stderr.write(`pingroom: hook skipped (${originError})\n`);
    }
    return EXIT.OK;
  }

  // Every other command that attaches a bearer gates its base through
  // requireSafeUrl first; the hook was the one that didn't, so a config or env
  // pointing at plain http shipped `Authorization: Bearer …` in the clear with
  // nothing on screen. Same rule here — but enforced by deferring, not by
  // exiting: the hook's whole contract is that it never blocks the agent, so a
  // hard failure would trade a credential leak for a broken session.
  if (!isSafeUrl(apiBase)) {
    const why = `${apiBase} is not https — refusing to send credentials over cleartext`;
    if (name === 'PreToolUse') {
      emitPreToolUseDecision('ask', `PingRoom API base ${why}; deferring to local prompt`);
    } else if (!args.quiet) {
      process.stderr.write(`pingroom: hook skipped (API base ${why})\n`);
    }
    return EXIT.OK;
  }

  if (name === 'PreToolUse') {
    return hookPreToolUse(event, { token, room, apiBase, args });
  }
  return hookNotify(event, name, { token, room, apiBase, args });
}
