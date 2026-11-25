---
name: pingroom-mcp
description: >-
  Reach a human through PingRoom — the event platform whose MCP connector this
  session has. Use this skill whenever the task involves notifying, alerting, or
  pinging a person; sending them a file, report, markdown, zip, image, or
  location; sharing a tappable link to their phone; asking a human a question
  and blocking on the answer; requesting an approve/deny decision before acting;
  handing a decision off to your authorizing human; or showing live progress on
  their lock screen while long work runs. Trigger it even when the user doesn't
  say "PingRoom" — phrases like "let me know when it's done", "send this to my
  phone", "ask me before deploying", "ping the team", "notify me", "send me the
  report", or "show progress on my lock screen" all mean this skill. Also use it
  when writing scripts or CI that must alert a person, and for managing PingRoom
  rooms, webhooks, quick actions, or the connected agent profile.
---

# PingRoom: reach a human, get a real answer

PingRoom turns "the agent finished / needs input" into an event on a person's
phone: a push they feel, a card on their lock screen, a question they answer
with one tap. You reach it over MCP; a paired `pingroom` CLI may also be
available for what MCP doesn't carry.

Tool names depend on how the server was added. A server added directly is
`mcp__pingroom__<name>`; one installed as part of the PingRoom plugin is
`mcp__plugin_pingroom_mcp_pingroom__<name>`. Match whichever your session
lists — this file names tools bare (`ask_question`, not the prefixed form).

Read `references/tools.md` for the full 49-tool schema reference when you need
exact parameters (the `get_guide` tool returns it as `topic` `tools`, and this
file as `overview`, to a client without the skill). This file teaches you which
tool to reach for and the rules that make the difference between "sent" and
"landed".

## Before authorization: get the phone ready

If the human does not have PingRoom, send <https://pingroom.io/i> and explain
that the app receives urgent Pings, questions, approvals, handoffs, and live
progress on their phone. Ask them to install or open it and sign in before
starting OAuth when possible.

Installation is not consent. The human must still complete authorization,
claim the separate MCP robot, and choose which rooms it may reach. If OAuth is
already waiting in the browser, have them return to that same flow after
installation instead of starting another connection.

## Verify and keep the connection receipt

Call `connection_info` after OAuth completes, before the first send, and after
every reconnect or account change. Match `owner.id` (the public PingRoom user
ID) and `handle` to the intended account and the robot shown on the
authorization success page, and check `home_room` against the intended
delivery room. When the user provides an account ID or agent handle, use it
as the expected identity. If they differ, do not send a test Ping, activate an
inbox, or reuse a saved room code. A successful
browser login does not prove the running MCP client adopted the new token.

After an account switch, clear cached room choices and call `list_rooms` again.
If `home_room` is null, choose or create an appropriate room before testing
delivery. Retain `links.latest_pings` and `links.install_app` from the verified
connection. The first is a stable GET URL for the newest pings visible across
the granted rooms; the second is the token-free
mobile handoff, and must never receive a credential. `links.latest_pings`
contains no credential, so send the connection's saved bearer token in the
`Authorization` header when fetching it.

## Disconnect and reconnect

When the user asks to disconnect or switch PingRoom accounts:

1. Read `connection_info` to identify the current connection. Call
   `disconnect {}` **before local logout** and check for `status: "revoked"`.
   This revokes the current registration and its access and refresh tokens;
   other processes sharing that credential lose access too. Separate
   registrations remain active.
2. Clear the client's saved login and authorize the intended account. For
   Codex CLI, run `codex mcp logout pingroom`, then
   `codex mcp login pingroom`. Retain the public user ID and agent handle from
   the success page. Reopening a completed authorization URL in the same
   browser session shows the same completed flow; do not use it to start
   another connection.
3. Restart the original client process, or reload its MCP connection through
   a supported client control. Call `connection_info` from the session that
   will send, verify the expected owner ID, handle, and home room, and refresh
   `list_rooms`. Stop on a mismatch; do not test delivery to an old room.

Local logout alone can leave server authorization active and an existing
process holding the old credential. If local logout already happened or the
tool is unavailable, the human can revoke the old connection in PingRoom →
Settings → Connected Agents. PingRoom also advertises standard OAuth token
revocation at `/oauth/revoke`; that only helps clients that call it.

Do not automatically disconnect a healthy connection for a phone readiness
error, transient failure, or token refresh. Revocation requires a new
authorization to use that connection again.

## The one rule that matters

**A successful send proves PingRoom accepted delivery work — not that a person
received, saw, or acted.** Never report "I notified them" as "they know".
When the task needs a human to actually respond, use a primitive that closes
the loop, then block on its wait tool:

| You need | Send with | Block with | Resolved states |
|---|---|---|---|
| Someone to see + confirm | `broadcast` with `requires_ack: true` | `wait_for_ack` | acked / expired |
| A choice among 2–4 options | `ask_question` | `wait_for_answer` | answered / expired / cancelled |
| Permission before acting | `ask_question` (2 options) | `wait_for_answer` | answered / expired / cancelled |
| Your authorizing human, privately | `create_handoff` | `wait_for_handoff` | acked or answered / expired |

Pending, timeout, enqueued, and delivery states are **not** answers. If a wait
expires, say so plainly and do not proceed as if consent was given.

**A wait tool holds for at most ~30 seconds and then returns `pending`.** That
is the contract, not a failure: call it again. Loop until you see a terminal
state or you hit a deadline you set yourself, and pass an `idempotency_key` on
the create so a retried call cannot put a second card on someone's phone.

**PingRoom blocks an agent that is still running; it cannot revive one that has
stopped.** If your task ends while a question is open, the human's answer is
still recorded and readable later with `get_question` — but nothing wakes you
to act on it. So only open a gate you intend to stay alive for, and say plainly
that you stopped waiting rather than implying the decision was made.

## Picking a room

Call `list_rooms` first (cache the result for the conversation). Rules:

- Personal rooms (`type: "personal"`): use `trigger_quick_action`. Only a
  Pro account may `broadcast` into someone else's personal room, text only
  (no attachments, links, locations or checklists, and no link written in the
  message either — a URL, `www.` address, bare domain or `[label](url)` is
  `422 personal_room_text_only`; a `title`, `is_urgent` and `requires_ack`
  are ignored there), and a visitor gets two pings of either
  kind until the owner shares contact. Nobody pings their own personal room.
- Public rooms allow 160-char messages; private rooms 120. Titles cap at 40.
- A standard private room with one member self-delivers manual sends, which is
  useful for setup and agent-owned rooms. A one-member public room still
  refuses sends because its fan-out has no targeted fallback.
- If the user names a room ambiguously, match on name case-insensitively; when
  several match, ask which one rather than guessing.

## Creating a room

`create_room { name, icon, color }` (private) or `create_public_room { name,
icon, color, handle }`. Two rules the schema alone won't teach you:

- `icon` is a **v3 catalog id, never an emoji**. Call `list_room_icons` and
  pick an id whose tags fit the room (`bell`, `globe`, `terminal`,
  `paperplane`, …). The server 422s anything off-catalog. Emoji is fine for
  *quick actions*; rooms take catalog ids only.
- `color` is a `#rrggbb` hex — brand colors welcome (e.g. `#e33122`) — that stays visible on both app themes. Near-black and near-white get a `422` asking for another hex.

Free accounts own at most five rooms (`402 room_limit_reached`).

## Recipes

### Plain ping
`broadcast { invite_code, message, title?, action_icon? }`. Keep the message an
event, not prose: *what happened, what to do, is it done*. Set a `title` only
when the room name alone wouldn't orient the reader.

### Update a ping in place
A ping you already sent can change its text without a second buzz.
`replace_notification { invite_code, notification_id, message, title?, data? }`
swaps the notification already on each recipient's phone for the new one,
silently: no second notification, no sound, unread counts unchanged, and the
ping reads back with `edited_at`. `notification_id` is the `id` `broadcast`
returned, and it must be a ping *this* connection sent. Omit `title` or `data`
to keep them; `data: null` clears the data; the same text again is a harmless
no-op. Good for "Build 41: running" → "Build 41: green" instead of two pings.

When you cannot keep the id (a script, a restarted run), send `broadcast` with
a `replace_key` (1–64 characters: letters, digits, `.` `_` `:` `-`) on every
update: a send with the key replaces your earlier ping with the same key in that
room and answers `replaced: true` with the same `id`; if that ping can no longer
be replaced it sends a new one that keeps the key. A send that asks for
something a replacement cannot do (`requires_ack`, `is_urgent`,
`attachment_ids`, `tags`, `action_number`, or a different `correlation_id`,
`reply_to` or `action_icon`) always sends a new ping.

Only an ordinary ping you sent in a private room, under 24 hours old and
replaced fewer than 20 times can be replaced. A question, handoff, live progress
card, "Who's on it?" request, a ping that needs a confirmation, or one with a
checklist cannot (each refusal has its own code, below). A replacement counts
like a send against a free account's daily allowance. If the server has not
switched replacing on yet, `replace_notification` answers a plain 404 with no
code and a `replace_key` is stored and ignored: send a new ping instead.

### Take a ping back
`withdraw_notification { invite_code, notification_id }` removes a ping's
notification from each recipient's Lock Screen and Notification Center, for when
a ping was wrong or is no longer true ("Deploying prod" when you cancelled it).
The ping stays in the room's history with its text and `withdrawn_at` set, and
unread counts do not change. `notification_id` is the `id` `broadcast` returned,
and it must be a ping *this* connection sent. The same pings can be withdrawn as
can be replaced: an ordinary ping you sent in a private room, under 24 hours old.
Withdrawing twice is a harmless no-op, and it does not count against a free
account's daily allowance. A withdrawn ping can no longer be replaced
(`replace_notification` answers `409 ping_withdrawn`, and a `broadcast` with that
ping's `replace_key` sends a new one).

Removal is best effort, so never rely on it for something that must not be seen:
a phone that is offline, has the app force-quit or restricts background activity
keeps the notification until it next opens the app, and only recent builds of the
iPhone and Android apps remove it. If the server has not switched withdrawing on
yet, `withdraw_notification` answers a plain 404 with no code.

### Urgent / must-be-confirmed
- `is_urgent: true` breaks through Focus/Do Not Disturb and through room and member mutes (never a block). Delivery-only — it
  asks nothing of the recipient. Reserve it for genuinely time-sensitive events
  or it trains people to ignore it.
- `requires_ack: true` keeps the ping open with a lock-screen Acknowledge
  button until the confirmation rule is met. `ack_mode: "any"` (default)
  resolves on the first confirmation; `ack_mode: "all"` waits for every original
  eligible recipient. Partial progress stays open: read `confirmed_count` and
  `required_count` in `action_state`; a timeout is not confirmation. Add `ack_timeout_seconds`
  (60–86400) when the confirmation is only useful for a while, then
  `wait_for_ack { notification_id }`.
  A `requires_ack` send result carries `confirmation_reach`. With `checked: true`,
  `unavailable_user_ids` lists recipients whose device cannot show Confirm, who
  may never confirm, so don't wait on them. `checked: false` means nothing was
  checked (public rooms, large rooms), not that everyone is reachable.
- The two compose: urgent+ack is "wake them and hold the door".

### Location ping
Put a location in `data.location` — the app renders a tappable map:

```json
{ "invite_code": "…", "message": "Meet here at 6",
  "data": { "location": { "latitude": 48.8584, "longitude": 2.2945,
            "label": "Eiffel Tower", "address": "Champ de Mars, Paris" } } }
```

`latitude`/`longitude` are required inside `location`; `label` and `address`
are what the human actually reads, so include at least `label`.

### Checklist ping
Put a short list in `data.checklist` — the app shows a Checklist row that opens
into the items, and the room ticks them off together: the first tick on an item
checks it for everyone, can't be undone, and alerts the others. Read the ticks
back with `get_notification`, `list_notifications` or `wait_for_notification`:
once anything is checked the ping carries `checklist_state.ticks[]` of
`{index, checked_at, checked_by: {display_name}}` (`checked_by` is null in
public rooms). `index` is the item's position in `data.checklist.items`. The
message is the list's title:

```json
{ "invite_code": "…", "message": "Groceries for tonight",
  "data": { "checklist": { "items": [ { "text": "Milk" }, { "text": "Eggs" } ] } } }
```

1–25 items, each `{ "text": … }` of 1–80 characters; any other key is a 422.

### Link ping
`data.url` (absolute http/https) turns the ping into a tappable link;
`data.button_label` (≤26 chars) names the button, `data.label` (≤26) adds a
caption. Use for dashboards, PRs, docs — anything better opened than read in
120 chars.

### Buttons on a ping
`data.actions` puts up to 3 buttons on the notification's long-press actions and
on the ping's card (`broadcast` only; never on a question, handoff, approval,
live card or `replace_notification`):

```json
{"invite_code": "...", "message": "Disk 91% on db-2", "data": {"actions": [
  {"label": "Open dashboard", "type": "open_url", "url": "https://grafana.example.com/d/disk"},
  {"id": "clean", "label": "Clean up now", "type": "webhook",
   "url": "https://ops.example.com/cleanup", "body": {"host": "db-2"}, "style": "danger"}
]}}
```

- `open_url` opens an https page; the app shows its host under the label.
- `webhook` never makes the phone call your URL: a tap calls PingRoom, which
  POSTs a signed `notification.action` event there (once per person, for 24
  hours; the room owner must be on Pro). Nobody sees the URL or `body`.
- `id` is `[a-z0-9_-]{1,24}` (default `a1`..`a3`), `style` is `default`,
  `primary` or `danger`, `body` (webhook only) is a JSON object of ≤ 10 keys and
  1 KB.
- A label is 1–26 characters with no line breaks or invisible formatting
  characters, nothing shaped like a web address, domain or IP (`paypal.com`),
  and never one of PingRoom's own buttons (Pong back, Mute room, Confirm, the
  claim buttons) in any language. A URL is `https://` on a public hostname: no
  user name or password, no IP, `localhost` or internal name, punycode for a
  non-ASCII domain, no port on a webhook button.
- Not in public or personal rooms, not with `requires_ack`, and a ping with
  buttons cannot be replaced (`unsupported_actions`); it can still be withdrawn.
- The `broadcast` answer carries `action_signing_secret` when a button is a
  webhook: the ping's own secret, never returned again by any read. Hand it to
  the server behind the URL. It verifies each delivery exactly like an outgoing
  webhook (`X-PingRoom-Signature-V2` = HMAC-SHA256 over
  `v2\n{X-PingRoom-Timestamp}\n{X-PingRoom-Delivery}\n{raw body}`, refuse a
  timestamp over 5 minutes off, run each delivery id once), looking the secret
  up by the body's `notification_id`.
- The body names who tapped only by `actor.id` (a pseudonym, different in every
  room) and `actor.display_name`; it also carries `action_id`, `room`,
  `correlation_id`, your `body` and `timestamp`.
- Reads (`get_notification`, `list_notifications`) return `actions` (each
  button's `id`, `label`, `type`, `style`, plus `url` and `host` for a link; a
  webhook button never shows where it goes) and `actions_expire_at`. The stored
  `data` never holds `actions`.

### Structured data + threading
`data` carries up to 25 keys / 8 KB of machine-readable context on every send
primitive — build numbers, commit SHAs, error codes. Never put secrets in it.
Set `correlation_id` (your own stable id) so you can find the ping again on
read surfaces, and `reply_to` (a notification id or correlation id) to thread
a ping as the answer to an earlier one.

### Files and documents (md / txt / html / zip / images — anything)

Two paths; pick by size:

1. **MCP, files ≤ ~90 KiB** (reports, markdown, logs, small HTML):
   `upload_attachment { filename, content_base64, mime_type? }` → returns an
   attachment id → pass `attachment_ids: ["…"]` (max 4) on `broadcast` or
   `ask_question`. Base64 a file with `base64 < file | tr -d '\n'`. The MCP
   request envelope caps at 128 KiB, which is why big files don't fit here.
2. **CLI, anything up to 5 MiB** (zips, images, PDFs):
   `pingroom ping --room <code> -m "…" --attach <path>` — repeat `--attach`
   for up to 4 files. The CLI is paired to the same account
   (`~/.pingroom/credentials.json`).

Both require the account to be Pro (`pro_required` otherwise). Retrieve any
attachment later with `get_attachment { attachment_id }` (base64 back, small
files) or `pingroom attachment get <id> --out <path>` (any size, binary-safe).
Delete an unclaimed upload with `delete_attachment`. If a legacy connector
reports `insufficient_scope`, reconnect it once to replace its partial grant
with full PingRoom access.

### Questions
`ask_question { invite_code, prompt (≤500), options?, text_input?, context?, ttl? }`:

- Omit `options` for a default Approve/Deny; otherwise give 2–4 options in
  display order. Keep labels short — they're lock-screen buttons.
- `text_input: { placeholder, max_length ≤60 }` invites a short typed answer,
  alone or alongside options.
- `context` (≤40) is the secondary line — a build number, a filename.
- Then `wait_for_answer { question_id }`. First valid answer wins. Use
  `cancel_question` if the question became moot; leaving stale questions on
  someone's lock screen erodes trust.
- Re-sending on retry? Pass `idempotency_key` so a network blip can't create
  two questions.

### Approvals
`request_approval { invite_code, question (≤500), title? (≤40), options?,
correlation_id?, data?, ttl?, idempotency_key? }` — note `question`/`title`,
NOT the `prompt`/`context` that questions use.

Block with `wait_for_approval`, then read TWO fields: `status` is
`pending | decided | expired | cancelled`, and the human's choice is in a
separate `decision` (`approve` / `deny` by default). There is no `approved` or
`denied` status — a `decided` status with `decision: "deny"` is a refusal, and
treating "the human answered" as success is how a gate fails open. Treat
`expired` as "no", never as "probably fine".

**Prefer `ask_question` for deploy gates.** An approval is delivered as an
ordinary ping with no answer actions, so the human has to open the app to
decide it; a two-option question (`approve`/`deny`) reaches the lock screen
with real buttons and is answerable in one tap. Reach for `request_approval`
only when you specifically need the legacy approvals surface.

### Handoffs (your authorizing human, privately)
`create_handoff { kind: "ack"|"question", prompt, audience: { type: "direct",
user_id: "me" }, options? (question only), urgency?, expires_in? }` reaches
the one human who authorized this agent — a private loop no room member sees.
Use it when the decision belongs to *your* human specifically, not to a room.
Block with `wait_for_handoff`. If creation fails with recipient-not-ready, the
phone is not ready for the Handoff surface. Keep the connection and show the
server's explanation and install link. Have the human install or update
PingRoom, open it, sign in, and enable notifications. Then call
`activate_agent_inbox`; do not retry the handoff until the person answers its
test Question and the result reports `activation_completed: true`.

### Live progress on the lock screen
For work longer than ~30 seconds, run a live card instead of spamming pings:

1. First `live_status` call with a **new** `correlation_id` starts the stream
   (one alert). Choose the shape up front — `steps` (labels are immutable after
   the first ping), `progress` 0..1 (optionally in `segments`), `metrics`,
   `deadline_at`, a matchup, a `timer`, one `value` or `stats` — the template is
   fixed at creation.
2. Further calls with the **same** `correlation_id` and `state: "running"`
   update the card silently (`current_step`, `progress`, `message`, `eta_at`).
3. End with `state: "done"` or `"failed"` — one completion alert. **Always end
   the stream**, even on error paths; an orphaned card squats on the lock
   screen. One stream per correlation_id, ever — a finished id cannot restart.
4. Free accounts get a daily budget of *new* streams; updates and the final
   ping are free. Don't burn streams on trivial work.
5. **Only the room owner can publish a live stream to a room.** In a room the
   account doesn't own, `live_status` returns `forbidden` — don't retry and
   don't improvise a burst of regular pings as a substitute (that's noise
   nobody asked for). Pick a room the account owns, or tell the user the
   constraint and send ONE ordinary ping when the work finishes.

`get_live_status { invite_code, correlation_id }` reads the current frame.

Three more layouts, all through `live_status`. `template: "timer"` counts up
from `started_at` (epoch seconds, default now, fixed after the first ping); the
phone keeps the clock, so send no per-second pings, but update at least every 15
minutes or the stream is ended as stale, and `done`/`failed` freezes it at the
final elapsed time. `template: "value"` shows one prominent `value` (required,
≤24 characters) with an optional `value_label`, `delta` (≤12) and `trend`
(`up`, `down`, `flat`). `template: "stats"` shows 4 to 8 `{label, value}` pairs
in `stats` (required on the first ping; later pings may change them or omit the
field). `progress` with `segments` (2–20, fixed once set) and `current_segment`
draws equal segments, and the server derives `progress` when you omit it. An
older app shows the status layout with the server-written `message`: for `value`
and `stats` the server writes one when you send none.

**Who's on it?** A `live_status` stream with `template: "claim"` asks a private
room who will take a task. Put the request in `title` (1–120 characters) and add
an optional `deadline_at` at most 8 hours away. Public and personal rooms refuse
it with `claim_private_rooms_only`. The room can then claim it. Your human acts
through `live_claim { invite_code, notification_id, action }` with `action` one
of `claim`, `release`, `done` or `cancel`. That needs only room membership. Two
claims at once have one winner, and the loser gets `claim_conflict` naming who
holds it. A request you started ends with `state: "done"` or `"failed"` on its
`correlation_id`. An open request expires at its deadline, or after 4 hours
without one.

### Quick actions
`list_quick_actions` shows a room's configured buttons (slots 1–16; slots 5–16 exist only when the owner has Pro);
`trigger_quick_action { invite_code, action_number }` presses one — this is
also the only send that works in personal rooms without Pro. `is_urgent`/`requires_ack`
elevate a single press without changing the saved configuration, except in
someone else's personal room, where both are ignored and only the owner's own
setting on the action applies.
Check each action's `input_type` first: `location` needs
`data: { location: { latitude, longitude } }`, `link` needs `data: { url }`,
and `file`/`photo`/`pdf` need `attachment_ids` from `upload_attachment` — a
press without the matching detail is `422 quick_action_input_required` and
nothing is sent. Set the requirement with `input_type` on
`update_quick_action(s)`; pass `quick_action_id` on the press to be refused
(`409 quick_action_layout_changed`) rather than fire the wrong Ping if the
owner moved pages meanwhile.
`trigger_source: "location"` is room owner only: it sends the owner's Location
Ping ("Arrived at {place}", "Left {place}" or "Location update at {place}") to
every member instead of the slot's quick action. A non-owner gets
`403 location_trigger_owner_only`; a room with no enabled location trigger gets
`409 location_trigger_inactive`. Leave it at `manual` unless you are the owner.

### Room metrics
A metric is a named value that lives in a room (`mrr`, labelled "MRR", USD,
12400) for a phone widget to show. Setting one sends **no ping and no push**,
so it is the right tool for a number that changes often.
`list_metrics { invite_code }` returns `{ metrics: [{ key, label, format, unit,
value, value_updated_at }], limit: 8 }`. `set_metric { invite_code, key, value,
label?, format?, unit? }` sets a value and creates the metric when the key is
new (a room holds at most 8: `422 metrics_limit_reached`); `delete_metric
{ invite_code, key }` removes one.
- `key` is 1–40 characters of letters, digits, `-` and `_` (lowercased for
  you); `label` is at most 24.
- `format` is `number`, `currency`, `percent`, `unit` or `text`. `currency`
  needs `unit` to be an ISO 4217 code (`USD`); `unit` needs a short unit such as
  `ms`; the others take none. A new metric's format defaults to `number` for a
  number and `text` for a string, its label to the key.
- Send the raw value: a finite number (at most 1e15, four decimal places kept)
  or, for `text`, a string of at most 24 characters. Never pre-format it
  ("$12,400"); the phone does that for the reader's locale. `percent` takes the
  percentage itself (`12.5`, not `0.125`).
- Writing needs the human to own or administer the room (a member's agent can
  only read). Repeating the stored value changes nothing, so its updated time
  stays truthful.

### Reading the room
- `connection_info` — verify the owner ID, agent handle, and home room; recover
  the stable latest-pings URL for this connection.
- `list_notifications { type?, date?, limit?, page? }` /
  `get_notification { notification_id }` — history, including `data`,
  `correlation_id`, attachments, and ack state. It spans every approved room;
  there is no `invite_code` filter, and sending one is rejected outright
  (`arguments.invite_code is not an advertised argument`). `type` narrows to
  `received` or `sent`; `date` to one calendar day.
- `wait_for_notification { after? }` — long-poll for *new* pings. Without
  `after` it returns no history, just the current head cursor: call once to
  get the cursor, then poll with it. It returns what other room members send.
  Everything sent as the connected account is excluded: your own sends, your
  human's own pings and replies, other agents on the same account, and webhook
  and scheduled pings in rooms the account owns (they are sent as the owner).
  To hear your human, `ask_question` and `wait_for_answer`.

## Error handling

Tool failures come back as `isError: true` with a JSON `{code, message}`. Act
on the code, don't retry blindly:

| code | Meaning → what to do |
|---|---|
| `pro_required` | Attachments/webhooks need Pro. Say so; don't loop. |
| `room_not_granted` | Room is outside this agent's grant. Ask the human to add it under Connected Agents, or pick a granted room. |
| `insufficient_scope` | The token uses a legacy partial grant. Follow the disconnect and reconnect flow once for full access, then verify the expected identity. |
| `invalid_credential` / HTTP 401 | The credential is missing, expired, revoked, or has the wrong audience. Reload the client after login and verify `connection_info`; renew authorization if needed. Never use a saved room code as evidence that the new account connected. |
| `recipient_not_ready` | Keep the connection. Share the returned `install_url`, then have the human install or update PingRoom, open it, sign in, and enable notifications. Call `activate_agent_inbox` again, then wait for the person to answer its test Question and for `activation_completed: true`; installation alone does not prove the phone is ready. |
| `attachment_too_large` | Over the MCP result cap — use `pingroom attachment get <id> --out …`. |
| `validation_failed` | Read the message; commonly a public room with no other member, an unsupported room type, or a length cap. |
| `free_limit_reached` / HTTP 402 | A free account used its daily allowance. Honour `retry_after`, which can be hours away, or tell the human they can upgrade to Pro. Don't loop on it. |
| `rate_limited` / HTTP 429 | Back off; respect `retry_after` / Retry-After. Never hot-loop a wait tool — they long-poll server-side already. |
| `not_ping_owner` / `notification_not_found` | `replace_notification` only edits a ping this connection sent, in the room you named. Use the `id` `broadcast` returned. |
| `replace_window_closed` / `replace_limit_reached` | The ping is 24 hours old or has been replaced 20 times. Send a new ping instead (with `replace_key`, the next send starts a new one by itself). |
| `unsupported_room` / `unsupported_question` / `unsupported_handoff` / `unsupported_live_status` / `unsupported_claim` / `unsupported_ack` / `unsupported_checklist` / `unsupported_source` | That ping cannot be replaced or withdrawn: a public or personal room, a question, handoff, live card, "Who's on it?" request, a ping needing confirmation, one with a checklist, or one that is not an ordinary agent ping. Send a new ping. |
| `unsupported_actions` | `replace_notification` on a ping with buttons: they and the text around them stay as sent. Send a new ping (or withdraw this one). |
| `ping_buttons_unsupported_room` / `ping_buttons_with_ack` / `ping_buttons_require_pro` | `data.actions` refused: buttons never go to a public or personal room, never with `requires_ack`, and a webhook button needs the room owner on Pro (say so; don't loop). A bad label, URL or body is a `validation_failed` naming the field (`data.actions.0.label`). |
| `ping_withdrawn` / `withdraw_window_closed` | `ping_withdrawn`: the ping was taken back, so `replace_notification` refuses it; send a new ping. `withdraw_window_closed`: the ping is 24 hours old, too late to take back. |
| `metrics_limit_reached` / `metric_not_found` | A room holds at most 8 metrics: `delete_metric` one you no longer need, or reuse a key. `metric_not_found` is `delete_metric` for a key the room does not have (`list_metrics` shows the keys). |
| `feature_disabled` | PingRoom turned that capability off (`feature` names it, e.g. `sending.questions`). Tell the human; don't retry. A ping carrying an attachment, link, location or checklist depends only on that extra's switch. |

New MCP connections receive the single `pingroom:full` consent grant. It
expands to 20 internal permissions, including permission to edit the robot's
profile; it does not change the human's account profile. Room grants and
account-tier limits still apply to every call.

## CLI companion

The `pingroom` CLI uses its own paired credential and adds large attachments,
CI, and hook integration. Room, webhook, quick-action, and agent-profile
management are also available through public MCP.
When the work is a script, CI job, or a file over ~90 KiB, switch to the
`pingroom-cli` skill (sibling of this one) instead of forcing it through MCP.

## Tone of what you send

Pings land on lock screens. Write them like events: present tense, concrete,
no fluff ("Deploy finished — 3 services green", not "I have completed the
deployment process"). One ping per event; a thread of five pings is worse than
one ping with an attachment. When you finish a piece of work the human asked
to be told about, one well-formed ping *is* the deliverable — send it without
being reminded.
