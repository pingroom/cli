# PingRoom MCP — complete tool reference

Matches the public server registry in source (81 tools). To fetch the live
catalog, POST `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` to
https://api.pingroom.io/api/agent/mcp. Every tool call is `tools/call`; in Claude Code the tools
surface as `mcp__pingroom__<name>` when the server was added directly, or as
`mcp__plugin_pingroom_mcp_pingroom__<name>` when it came from the PingRoom
plugin (load schemas with ToolSearch "select:<the name your session lists>"
before first use).

Annotations: R = read-only, D = destructive, I = idempotent.

## connection_info  [RI]

Return this connection's handle, owner, home room, room-access mode, and stable links.
`owner.id` is the human's public PingRoom user ID; `owner.name` is their display name.
After reconnecting, reload the MCP client and compare `owner.id`, `handle`, and
`home_room` with the account and agent approved by the human. Stop if they do not
match. A successful OAuth login does not prove an already-running client has
switched credentials.
`links.latest_pings` is a newest-first GET feed across the granted rooms and
requires the saved MCP bearer token in the `Authorization` header.
`links.install_app` is the token-free mobile handoff; never send credentials to
that URL.

  (no arguments)

## disconnect  [DI]

Revoke the agent connection making this call, including its access credential
and OAuth refresh tokens. Use only when the human asks to disconnect, log out,
reconnect, or switch accounts. This does not revoke another agent or delete the
human's account or rooms.

Call this **before** clearing the client's saved login. For Codex, follow with
`codex mcp logout pingroom`, then `codex mcp login pingroom` if reconnecting.
Restart or reload the original MCP client and verify `connection_info` against
the approved account and agent before sending. Local logout alone does not
revoke the server authorization.

Returns `status: "revoked"`, the disconnected `handle`, `owner.id`, `owner.name`,
and reconnect guidance in `message`. Subsequent calls with that credential are
rejected, including a repeated disconnect; refresh cannot restore it.

  (no arguments)

## get_guide  [RI]

Return this skill as Markdown, for a client that has no PingRoom skill
installed. Call it once before your first send. `topic` `overview` (the
default) is the skill itself: which tool to reach for, verifying the
connection, every kind of Ping, questions, approvals, handoffs, live progress,
errors and tone. `topic` `tools` is this reference. The result carries
`content` (the Markdown), `topics` (what you can ask for) and `source` (the
skill's repository, for clients that install skills).

  - `topic` (string) — one of: `overview`, `tools`. Defaults to `overview`.

## list_rooms  [RI]

List the rooms the authenticated account belongs to.

  (no arguments)

## list_quick_actions  [RI]

List the quick actions configured for a room. Each entry carries `action_number`, `label`, `icon`, `requires_ack` and `input_type` (`none`, `location`, `link`, `file`, `photo` or `pdf`) — read `input_type` before pressing, because a press without the matching detail is refused. A slot whose `label` and `icon` are both empty is reserved but disabled and answers `404 action_not_configured`.

  - `invite_code` (string) **(required)**. Room invite code.

## trigger_quick_action  [–]

Press a room quick action, notifying its members. Rate-limited. Read the action's `input_type` first (`list_quick_actions`): `location` needs `data.location`, `link` needs `data.url`, `file`/`photo`/`pdf` need `attachment_ids` — a press without the matching detail is `422 quick_action_input_required` and nothing is sent. In someone else's personal room `is_urgent` and `requires_ack` are ignored; only the owner's own setting on the action applies.

  - `invite_code` (string) **(required)**. Room invite code.
  - `action_number` (integer) **(required)** — 1–16. Quick-action slot number (1–16). Slots 5–16 require the room owner to have Pro (`403 pro_required` otherwise); a disabled slot is `404 action_not_configured`.
  - `data` (object). The detail this press carries; only these two keys are accepted on a trigger (no `button_label`):
    - `location` (object) — `{ latitude (−90..90), longitude (−180..180), label? (≤100), address? (≤255) }`. Satisfies `input_type: location`.
    - `url` (string) — ≤2048 chars, absolute http:// or https://. Satisfies `input_type: link`.
  - `attachment_ids` (array of uuid) — ≤4 items. Ids from `upload_attachment`. Required for `input_type` `file`, `photo` (jpg/png only) or `pdf` (pdf only); a mismatched type is `422 quick_action_input_type`.
  - `quick_action_id` (string, uuid). Optional id of the action as read from `list_quick_actions`; when that slot has since moved pages the press is refused with `409 quick_action_layout_changed` instead of firing the wrong Ping.
  - `trigger_source` (string) — one of: `manual`, `location`. Defaults to "manual". Only these two are client-settable — "webhook" and "system" are stamped server-side and are rejected here. `location` is room owner only: it sends the owner's Location Ping ("Arrived at {place}", "Left {place}" or "Location update at {place}") to every member instead of this slot's quick action. A non-owner gets `403 location_trigger_owner_only`; a room with no enabled location trigger gets `409 location_trigger_inactive`.
  - `is_urgent` (boolean). Deliver this one press time-sensitive so it breaks through Focus / Do Not Disturb and reaches members who muted the room or you (a block still wins). Send-time only — the action's saved configuration is unchanged.
  - `requires_ack` (boolean). Keep this one press open until an eligible recipient acknowledges it. Send-time only and elevating only: true adds the acknowledgement to an action that has none, false never disables the action's stored ack policy.

  - `ack_mode` (string: `any` | `all`). Confirmation rule for this press when its effective acknowledgement policy is enabled; leaves saved action configuration unchanged.

## broadcast  [–]

Send a custom ping to a room the account belongs to. Pass data.checklist.items to send a checklist the room ticks through together; read the ticks back as checklist_state. Rate-limited. In someone else's personal room only a Pro account may send it, text only (a link in the message is refused too), without title, is_urgent or requires_ack (all three are ignored there), and it counts toward the visitor's two-ping cap; otherwise use trigger_quick_action there.

  - `invite_code` (string) **(required)**. Room invite code.
  - `message` (string) **(required)** — ≤160 chars. Ping body text (max 120 characters in private rooms, 160 in public rooms).
  - `title` (string) — ≤40 chars. Optional headline. Defaults to the room name, which someone else's personal room always keeps.
  - `action_number` (integer) — 1–16. Optional quick-action slot to attribute the ping to. Slots 5–16 require the room owner to have Pro.
  - `action_icon` (string) — ≤50 chars. Optional emoji shown with the ping.
  - `data` (object). Arbitrary structured context (max 25 keys / 8KB). Read surfaces return it after connector privacy filtering; do not put secrets in data. data.location is reserved for a shareable location, data.checklist for a checklist, and data.url + data.button_label are reserved for a tappable link ping.
    - `data.location` (object). A shareable geographic location.
      - `data.location.latitude` (number). Latitude in decimal degrees.
      - `data.location.longitude` (number). Longitude in decimal degrees.
      - `data.location.label` (string). Optional place name shown to the recipient.
      - `data.location.address` (string). Optional formatted street address.
    - `data.checklist` (object). A short checklist the room can tick through, e.g. a shopping list. The room ticks it together: a checked item is checked for everyone, cannot be unchecked, and alerts the other recipients.
      - `data.checklist.items` (array) — 1–25 items. Each item is `{ "text": string }`, 1–80 chars.
    - `data.url` (string). Reserved: an absolute http:// or https:// URL. Present turns the ping into a tappable link.
    - `data.button_label` (string). Reserved: label for the link button rendered for data.url.
    - `data.label` (string). Reserved: short caption shown with the link ping.
    - `data.actions` (array) — 1–3 items. Reserved: up to 3 buttons on the notification and the ping's card. open_url opens an https link (the app shows its host); webhook makes PingRoom POST a signed notification.action event to your https URL when a recipient taps it (once per person, for 24 hours; the room owner must be Pro). Not in public or personal rooms, not with requires_ack. The answer carries `action_signing_secret` to verify deliveries with. A label may not contain a web address or domain, or copy one of PingRoom's own buttons.
      - `data.actions[].id` (string) — `[a-z0-9_-]{1,24}`. Your id for the button, unique on the ping; defaults to a1, a2, a3.
      - `data.actions[].label` (string) **(required)** — 1–26 chars. Button text.
      - `data.actions[].type` (string: `open_url` | `webhook`) **(required)**.
      - `data.actions[].url` (string) **(required)** — ≤2048 chars, `https://`. https only, a public hostname (punycode for an internationalized one), no user name or password. A webhook URL takes no port.
      - `data.actions[].style` (string: `default` | `primary` | `danger`).
      - `data.actions[].body` (object) — ≤10 keys. webhook only: a JSON object (at most 1024 bytes) echoed back to your URL as `body` on every tap. Never shown to recipients.
  - `correlation_id` (string) — ≤255 chars. Your own id, echoed back unchanged on read.
  - `tags` (array) — ≤10 items. Up to 10 labels to file this ping under, so history can later be filtered by one (list_notifications and wait_for_notification take a tag). Each is 1 to 32 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit. Trimmed, lowercased and de-duplicated for you.
  - `reply_to` (string) — ≤255 chars. Id of the ping this one answers (notification id or correlation id).
  - `is_urgent` (boolean). Deliver time-sensitive so the ping breaks through Focus / Do Not Disturb and reaches members who muted the room or you (a block still wins). Independent of requires_ack: urgent affects delivery only and asks nothing of the recipient.
  - `requires_ack` (boolean). Keep this ping open until its confirmation rule is met, and show it as a lock-screen card with an Acknowledge button. Does not raise the interruption level on its own — combine with is_urgent for an ack that also breaks through Focus.
  - `ack_mode` (string: `any` | `all`). With `requires_ack`, resolve on the first confirmation (default `any`) or wait for every original eligible recipient (`all`).
  - `ack_timeout_seconds` (integer) — 60–86400. Optional acknowledgement deadline in seconds.
  - `attachment_ids` (array) — ≤4 items. Ids of up to 4 uploaded attachments (see upload_attachment) to include. Uploading requires a Pro account.
  - `replace_key` (string) — 1–64 chars, letters, digits and `. _ : -`. Your own handle for "the ping I keep updating". A send with a replace_key replaces your earlier ping with the same key in the same room, instead of sending a new one, while that ping is under 24 hours old, replaced fewer than 20 times and replaceable (see replace_notification); the answer is then 200 with the same id and `replaced: true`. Otherwise a new ping is sent and keeps the key. A send that asks for something a replacement cannot do (requires_ack, is_urgent, attachment_ids, tags, action_number, or a different correlation_id, reply_to or action_icon) always sends a new ping.

## replace_notification  [DI]

Replace the title, message and data of a ping you already sent, in place: the notification already on each recipient's phone changes silently (no second notification, no sound, unread counts unchanged) and the ping shows `edited_at`. Only for an ordinary ping you sent in this room, in a private room, less than 24 hours old and replaced fewer than 20 times; a question, handoff, live progress card, "Who's on it?" request, acknowledgement ping or checklist cannot be replaced (each refusal has its own code, e.g. `422 unsupported_ack`, `409 replace_window_closed`). Omit `title` or `data` to keep them, send `data: null` to clear it. Counts toward the same free-plan daily ping limit as a send. To update the same ping from a script that cannot keep its id, send `broadcast` with the same `replace_key` instead.

  - `invite_code` (string) **(required)**. Room invite code.
  - `notification_id` (string, uuid) **(required)**. Id of the ping to replace (broadcast returns it as id). It must be a ping this credential sent.
  - `message` (string) **(required)** — ≤160 chars. The new ping body text (max 120 characters in private rooms).
  - `title` (string or null) — ≤40 chars. The new headline. Omit to keep the current one; an empty value clears it.
  - `data` (object or null). The new structured data, replacing the old (same rules as broadcast, minus `data.checklist` and `data.actions`: a replacement never adds, changes or removes buttons, and a ping with buttons cannot be replaced, `422 unsupported_actions`). Omit to keep the current data; null clears it.

## withdraw_notification  [DI]

Take back a ping you already sent: its notification is removed from each recipient's Lock Screen and Notification Center, and the ping stays in the room's history with its text and `withdrawn_at` set. Unread counts do not change. Only for an ordinary ping you sent in this room, in a private room, less than 24 hours old; a question, handoff, live progress card, "Who's on it?" request, acknowledgement ping or checklist cannot be withdrawn (each refusal has its own code, e.g. `422 unsupported_ack`, `409 withdraw_window_closed`). A withdrawn ping can no longer be replaced (`409 ping_withdrawn`). Taking back a ping already withdrawn is a harmless no-op. Removal is best effort: a phone that is offline, has the app force-quit or restricts background activity keeps the notification until it next opens the app. Does not count toward the free-plan daily ping limit.

  - `invite_code` (string) **(required)**. Room invite code.
  - `notification_id` (string, uuid) **(required)**. Id of the ping to take back (broadcast returns it as id). It must be a ping this credential sent.

## live_status  [DI]

Start, update, or end a live progress card on the room members' lock screen (an iOS Live Activity / Android live update). Reuse the same correlation_id for every ping of one stream: the first ping starts the card and sends one alert, further "running" pings move it silently, and the first "done"/"failed" sends one completion alert and ends it. Free accounts get a small number of NEW streams per day; updates and the final ping of an open stream are never charged; a first ping that is already "done"/"failed" counts as a new stream.

  - `invite_code` (string) **(required)**. Room invite code.
  - `correlation_id` (string) **(required)** — ≤255 chars. The stream key. Reuse it on every ping of the same stream.
  - `tags` (array) — ≤10 items. Up to 10 labels to file this ping under, so history can later be filtered by one (list_notifications and wait_for_notification take a tag). Each is 1 to 32 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit. Trimmed, lowercased and de-duplicated for you. Set by the ping that starts the stream; later pings of the same stream may repeat or omit them and never change them.
  - `live_status` (object) **(required)**. The live card's state. Only state is required.
    - `live_status.state` (string) **(required)**. running keeps the card live; done/failed end it with one completion alert.
    - `live_status.template` (string). Which layout the OS renders. Fixed at stream creation. "timer" counts up from started_at, "value" shows one prominent value and "stats" shows 4 to 8 labelled values; an app that predates them shows the plain status card (title and message). "claim" is a "Who's on it?" request one member takes on (private rooms only): its text is title (or message), up to 120 characters, an optional deadline_at is at most 8 hours away, and it then moves only through live_claim, or a done/failed ping from you that finishes or cancels it.
    - `live_status.category` (string). Legacy rendering category; prefer template. "alert" has NO template equivalent and is the only way to start a stream time-sensitive (breaks through Focus). Fixed at stream creation.
    - `live_status.message` (string). The card's live message line.
    - `live_status.progress` (number). Progress bar / Dynamic Island gauge, 0..1.
    - `live_status.steps` (array). Step labels. Required on the first ping of a steps stream. They cannot change afterwards: a later ping may resend the identical list or omit it, and a different list on a running ping is rejected with 422 steps_immutable (a done/failed ping ignores it and still ends the stream). Send current_step to advance, or start a new stream with a new correlation_id for a different list.
    - `live_status.current_step` (integer). Index into steps; the only mutable steps field.
    - `live_status.segments` (integer) — 2–20. Progress template only: draw the bar in this many equal segments. Cannot change once set (a different value on a running ping is rejected with 422 segments_immutable).
    - `live_status.current_segment` (integer) — 0–20. Progress template only: how many segments are filled, 0..segments (422 invalid_current_segment otherwise). When progress is omitted the server derives progress as current_segment / segments.
    - `live_status.started_at` (integer) — 0–4102444800. Timer template only: epoch seconds the timer counts up from. Defaults to now on the first ping and cannot change afterwards (422 started_at_immutable on a running ping). The card ticks by itself; send a message update at least every 15 minutes or the stream is ended as stale. A done/failed ping freezes the card at the final elapsed time.
    - `live_status.value` (string) — ≤24 chars. Value template only: the one prominent value, e.g. "$12.4k". Required on the first ping of a value stream (422 value_required).
    - `live_status.value_label` (string) — ≤24 chars. Value template only: what the value is, e.g. "Revenue".
    - `live_status.delta` (string) — ≤12 chars. Value template only: the change, e.g. "+3.2%".
    - `live_status.trend` (string). Value template only: the arrow drawn beside delta. Neutral colour: up is not always good.
    - `live_status.stats` (array). 4 to 8 {label,value} pairs for the stats template, drawn as two rows. Required on the first ping of a stats stream (422 stats_required). Labels and values may change on later pings; omit the field to keep the stored list. When message is omitted the server writes "Label Value · Label Value" so an older app reads it.
      - `live_status.stats.label` (string) — ≤24 chars. 
      - `live_status.stats.value` (string) — ≤24 chars. 
    - `live_status.metrics` (array). Up to 3 {label,value} counters for the metrics template.
    - `live_status.deadline_at` (integer). Epoch seconds the countdown template counts down to. A later ping may move it; duration_seconds then moves by the same amount. Send the absolute new deadline, never a delta.
    - `live_status.duration_seconds` (integer) — 1–4102444800. Countdown duration in seconds. Read from the first ping only (a later ping's own value is ignored); preserved through updates and completion. Moving deadline_at on a later ping changes the stored duration by the same amount.
    - `live_status.eta_at` (integer). Epoch seconds; renders a live ETA on status/progress.
    - `live_status.prompt` (string). The ask, for the question template.
    - `live_status.options` (array). Up to 4 {value,label} choices for the question template.
    - `live_status.left` (object). Left side {label,value} for the matchup template.
      - `live_status.left.label` (string). 
      - `live_status.left.value` (string). 
    - `live_status.right` (object). Right side {label,value} for the matchup template.
      - `live_status.right.label` (string). 
      - `live_status.right.value` (string). 
    - `live_status.center` (string). Center score/clock for the matchup template.
    - `live_status.accent_override` (string). Hex #rrggbb; a semantic accent for one frame (e.g. deadline red).
  - `title` (string) — ≤120 chars. Card title, up to 40 characters (a claim request's text, up to 120). Defaults to the selected quick action's label.
  - `action` (integer) — 1–16. Quick-action slot to attribute the stream to (supplies the icon and sound). Slots 5–16 require the room owner to have Pro.
  - `data` (object). Arbitrary structured context (max 25 keys / 8KB), returned on read surfaces after connector privacy filtering. Do not put secrets in data.
  - `requires_ack` (boolean). Add an Acknowledge button; the first eligible member to tap resolves it for everyone. Does not raise the interruption level — set category "alert" for a time-sensitive start.
  - `ack_timeout_seconds` (integer) — 1–86400. Optional acknowledgement deadline in seconds.

## get_live_status  [RI]

Read back the current state of a live stream you created, so a restarted producer can reconcile instead of starting a duplicate. Only returns streams started by this credential, within the last 24 hours. Returns notification_id and correlation_id, then the stored display state (state, progress, message, category, template, accent_override, eta_at, deadline_at, duration_seconds, metrics, prompt, options, left, right, center, steps, current_step, started_at, value, value_label, delta, trend, stats, segments, current_segment), action_state, and updated_at; a claim request also returns its title and claim (status, by, at, late). Fields you never set come back as null rather than being omitted, so a matchup/metrics/countdown/question stream can be resumed without re-sending content.

  - `invite_code` (string) **(required)**. Room invite code.
  - `correlation_id` (string) **(required)** — ≤255 chars. The stream key used when the stream was started.

## live_claim  [DI]

Act on a "Who's on it?" request (a live_status stream with template "claim") as your human: "claim" takes an open request (anyone but its asker), "release" lets go of one you hold, "done" finishes it (its claimer, or its asker at any time) and "cancel" withdraws it (its asker, or a room owner or admin). Two claims at once have one winner: the other gets 409 claim_conflict with the current claim, naming who holds it. Repeating your own last action is a no-op that returns the same claim. "release" returns the request to open only while it can still be taken: past its deadline (or 4 hours after it was made, when it has none) it ends the request as expired instead, a normal 200 whose claim.status is "expired" and whose state is "failed" (the asker hears "No one took it"), not an error.

  - `invite_code` (string) **(required)**. Room invite code.
  - `notification_id` (string) **(required)**. The request's notification id, from list_notifications or the live_status response.
  - `action` (string: `claim` | `release` | `done` | `cancel`) **(required)**. What to do with the request.

## list_room_icons  [RI]

List the room-icon catalog (icon ids, tags, and categories). Call this before create_room / create_public_room / create_webhook to pick a valid icon id, and to interpret icon values returned by reads.

  (no arguments)

## list_notifications  [RI]

List a bounded page of recent pings across approved rooms, newest first. Use page to continue while has_more is true.

  - `type` (string) — one of: `received`, `sent`. Narrow to pings you received or pings you sent. Omit for both.
  - `room_id` (string, uuid). Only pings in this room (the room's id, as list_rooms and get_room return it).
  - `tag` (string). Only pings carrying this tag (see the tags field of broadcast and live_status). Narrows only what you can already read; each returned ping carries `tags`.
  - `date` (string). Only pings created on this calendar date, e.g. "2026-08-25".
  - `limit` (integer) — 1–25. Pings per page. Defaults to 10; maximum 25.
  - `page` (integer) — 1–. Page number, newest first.

## get_notification  [RI]

Fetch one visible ping by notification id, including its current action_state and, once anything on its data.checklist is checked, checklist_state.

  - `notification_id` (string) **(required)**. Room notification id.

## wait_for_notification  [RI]

Long-poll for the next ping. Blocks until one arrives or the timeout elapses — the real-time inbound channel for an agent. Excludes everything your connected human sends (and your own sends); you receive other room members' Pings.

  - `after` (string). Cursor from the previous call; omit to get the current head.
  - `tag` (string). Only return pings carrying this tag; other pings are skipped, not returned.
  - `timeout` (integer) — 1–30. Seconds to hold the request open (server-capped).

## wait_for_ack  [RI]

Long-poll a generic acknowledgement-required ping until its confirmation rule is met (any: first confirmation; all: every original eligible recipient), it expires, or the timeout elapses. Questions use wait_for_answer instead.

  - `notification_id` (string) **(required)**. Room notification id.
  - `timeout` (integer) — 0–30. Seconds to hold the request open. Use 0 for an immediate authoritative state read.

## request_approval  [–]

Ask the human to approve or reject an action, then block on their answer (pair with wait_for_approval). Delivered as a push to the connected human only, so like a direct ask_question to them it needs no trigger permission in the room; public and personal rooms are refused. Rate-limited.

  - `invite_code` (string) **(required)**. Room invite code.
  - `question` (string) **(required)** — ≤500 chars. What you want the human to decide on.
  - `title` (string) — ≤40 chars. Optional short title for the request.
  - `options` (array) — ≤4 items. Answers to choose between. Defaults to ["approve","deny"].
  - `correlation_id` (string) — ≤255 chars. Your own id, echoed back unchanged on read.
  - `data` (object). Arbitrary structured context, returned on reads after connector privacy filtering. Do not put secrets in data.
  - `ttl` (integer) — 1–. Seconds the request stays open before it expires.
  - `idempotency_key` (string) — ≤255 chars. Stable key so a retried call cannot create a second one.

## wait_for_approval  [RI]

Long-poll an approval request until the human decides or it expires. Returns the status and, once decided, the chosen option.

  - `approval_id` (string) **(required)**. Approval request id.
  - `timeout` (integer) — 1–30. Seconds to hold the request open (server-capped).

## get_approval  [RI]

Fetch the current status of an approval request without blocking.

  - `approval_id` (string) **(required)**. Approval request id.

## ask_question  [–]

Ask a person a question with 2-4 tappable options, then block on their answer (pair with wait_for_answer). Delivered as a push they can answer from the lock screen or in-app; the first valid answer wins. Rate-limited.

  - `invite_code` (string) **(required)**. Room invite code.
  - `prompt` (string) **(required)** — ≤500 chars. The question the person reads.
  - `context` (string) — ≤40 chars. Optional secondary line, e.g. a build number.
  - `options` (array) — ≤4 items. Answer options in display order. Omit for a default Approve/Deny.
  - `text_input` (object). Invite a typed answer (on its own, or alongside options). max_length is capped at 60.
    - `text_input.placeholder` (string). Hint shown in the reply field.
    - `text_input.max_length` (integer). Max characters (default 60).
  - `correlation_id` (string) — ≤255 chars. Your own id, echoed back unchanged on read.
  - `reply_to` (string) — ≤255 chars. Optional routing pointer, echoed back unchanged.
  - `data` (object). Arbitrary structured context (max 25 keys / 8KB). Read surfaces return it after connector privacy filtering; do not put secrets in data. data.location is reserved for a shareable location, and data.checklist for a checklist.
    - `data.location` (object). A shareable geographic location.
      - `data.location.latitude` (number). Latitude in decimal degrees.
      - `data.location.longitude` (number). Longitude in decimal degrees.
      - `data.location.label` (string). Optional place name shown to the recipient.
      - `data.location.address` (string). Optional formatted street address.
    - `data.checklist` (object). A short checklist the room can tick through, e.g. a shopping list. The room ticks it together: a checked item is checked for everyone, cannot be unchecked, and alerts the other recipients.
      - `data.checklist.items` (array) — 1–25 items. Each item is `{ "text": string }`, 1–80 chars.
  - `ttl` (integer) — 1–. Seconds the question stays open before it expires.
  - `attachment_ids` (array) — ≤4 items. Ids of up to 4 uploaded attachments (see upload_attachment) to include. Uploading requires a Pro account.
  - `idempotency_key` (string) — ≤255 chars. Stable key so a retried call cannot create a second one.

## wait_for_answer  [RI]

Long-poll a question until it is answered or expires. Returns the state and, once answered, the chosen option value + label and the responder.

  - `question_id` (string) **(required)**. Question id.
  - `timeout` (integer) — 1–30. Seconds to hold the request open (server-capped).

## get_question  [RI]

Fetch the current state of a question without blocking.

  - `question_id` (string) **(required)**. Question id.

## list_questions  [RI]

List a bounded page of questions you asked, newest first. Optionally filter by state; use page while has_more is true.

  - `state` (string) — one of: `pending`, `answered`, `expired`, `cancelled`, `all`. Filter by state. Omit for all.
  - `limit` (integer) — 1–25. Questions per page. Defaults to 10; maximum 25.
  - `page` (integer) — 1–. Page number, newest first.

## cancel_question  [DI]

Withdraw a still-pending question you asked.

  - `question_id` (string) **(required)**. Question id.

## activate_agent_inbox  [–]

Start or resume the onboarding Question in the private room the human chose during authorization. If recipient_not_ready, share install_url and ask the human to install or update PingRoom, open the app, sign in, and enable notifications before retrying. Read question.id, then call wait_for_handoff only while state is pending and within a bounded local deadline. Success is answered with activation_completed true. Any other terminal result is incomplete: stop polling that attempt, then call activate_agent_inbox again for one numbered retry. The stamp requires native phone receipt before the human answer.

  (no arguments)

## create_handoff  [–]

Hand work to exactly one human as either an acknowledgement or a tappable question. The server verifies that one of the recipient's current devices supports the complete Handoff action before creating anything.

  - `kind` (string) **(required)** — one of: `ack`, `question`. ack asks the human to acknowledge; question asks them to choose an option.
  - `prompt` (string) **(required)** — ≤500 chars. The work/request shown to the human.
  - `audience` (object) **(required)**. 
    - `audience.type` (string) **(required)**. 
    - `audience.user_id` (string) **(required)**. The authorizing human, expressed as the literal value "me".
  - `expires_in` (integer). Seconds before the handoff expires; the server clamps this to its safe range.
  - `urgency` (string) — one of: `active`, `passive`. Notification interruption level. Defaults to active.
  - `options` (array) — ≤4 items. Required for question and forbidden for ack. Each item may be a label string or a structured option.
  - `data` (object). Structured context returned on read surfaces after connector privacy filtering. Do not put secrets in data.
  - `correlation_id` (string) — ≤255 chars. Your own stable correlation id.
  - `reply_to` (string) — ≤255 chars. Optional routing pointer.
  - `idempotency_key` (string) — ≤255 chars. Stable key for at-most-once creation across both Ack and Question kinds.

## wait_for_handoff  [–]

Long-poll a Handoff until the human resolves it, it expires, or the bounded timeout elapses. For the onboarding Question returned by activate_agent_inbox, success requires an answered result with activation_completed true; use a bounded local deadline and treat any terminal answer without that stamp as incomplete.

  - `handoff_id` (string) **(required)**. Handoff id.
  - `timeout` (integer) — 0–25. Seconds to hold the request open; use 0 for an immediate state read.

## get_handoff  [RI]

Fetch the authoritative current state of one Handoff without blocking.

  - `handoff_id` (string) **(required)**. Handoff id.

## list_handoffs  [RI]

List a bounded page of this agent's Handoffs, newest first. Omit state (or use open) for unresolved work; use all for history and page while has_more is true.

  - `state` (string) — one of: `open`, `all`. Filter to open Handoffs or include all states.
  - `limit` (integer) — 1–25. Handoffs per page. Defaults to 10; maximum 25.
  - `page` (integer) — 1–. Page number, newest first.

## upload_attachment  [–]

Upload a small file (max ~90 KiB over MCP; Pro account required) and get an attachment id to include in broadcast or ask_question via attachment_ids. Larger files: use the PingRoom CLI or agent REST API.

  - `filename` (string) **(required)** — ≤255 chars. File name including extension, e.g. report.md.
  - `content_base64` (string) **(required)** — ≤124000 chars. Base64-encoded file bytes (standard alphabet, padding optional).
  - `mime_type` (string) — ≤100 chars. Optional MIME type, e.g. text/markdown. Defaults from the filename extension.

## get_attachment  [RI]

Fetch an attachment visible to this agent as base64 content plus metadata. Results over the connector size limit return attachment_too_large — fetch those via the agent REST API instead.

  - `attachment_id` (string) **(required)**. Attachment id returned by upload_attachment.

## delete_attachment  [DI]

Delete an attachment this agent uploaded that is not yet claimed by a ping.

  - `attachment_id` (string) **(required)**. Attachment id returned by upload_attachment.

## get_room  [RI]

Fetch a single room by its invite code, including members and quick actions (each with `input_type`), plus `quick_action_limit` (4 or 16) and `quick_action_count`.

  - `invite_code` (string) **(required)**. Room invite code.

## create_room  [–]

Create a new room owned by the authenticated account. Free accounts may own up to five rooms.

  - `name` (string) **(required)** — ≤24 chars. Room display name.
  - `icon` (string) **(required)**. A v3 room-icon catalog id, e.g. "bell". Call list_room_icons to discover the valid ids. Emoji is rejected with a 422.
  - `color` (string) **(required)**. Hex color, e.g. "#e33122".

## create_public_room  [–]

Create a publicly discoverable room with a unique @handle. Counts toward the free-plan five-room cap.

  - `name` (string) **(required)** — ≤24 chars. Room display name.
  - `icon` (string) **(required)**. A v3 room-icon catalog id, e.g. "bell". Call list_room_icons to discover the valid ids. Emoji is rejected with a 422.
  - `color` (string) **(required)**. Hex color, e.g. "#e33122".
  - `handle` (string) **(required)**. Globally unique @handle (vanity URL): lowercase letters, digits, underscores.
  - `description` (string) — ≤120 chars. Short room description shown in public discovery.
  - `category` (string) — ≤100 chars. Discovery category.
  - `show_owner` (boolean). Whether the owner is shown publicly. Defaults to true.
  - `location_name` (string) — ≤160 chars. Place name shown in nearby discovery. Send all three location fields or none (a partial trio is a 422).
  - `location_latitude` (number) — −90..90. Latitude in decimal degrees.
  - `location_longitude` (number) — −180..180. Longitude in decimal degrees.

## join_room  [DI]

Join a room using its invite code. Include the password only if the room is protected.

  - `invite_code` (string) **(required)**. Room invite code.
  - `password` (string). Only required for password-protected rooms.

## list_room_members  [RI]

List a room's members as the account sees them in the app: members[], each with user_id (for remove_room_member, set_member_role and member mutes), name, role (owner, admin or member), emoji, colour, picture, personal-room handle and joined_at. In a public room a subscriber who is not staff sees only the staff.

  - `invite_code` (string) **(required)**. Room invite code.

## list_invitable_people  [RI]

List the people the account can invite into a room: everyone it already shares a private room with, 30 per page, sorted by name. people[] each have user_id (pass it to invite_to_room), name, picture, the room they share (shared_room) and status: member, invited (an invitation is still open) or available. When this agent was given only some rooms, only people from those rooms are listed.

  - `invite_code` (string) **(required)**. Room invite code.
  - `q` (string) — ≤100 chars. Only people whose name contains this text.
  - `page` (integer). Page number, from 1. has_more says whether another page follows.

## invite_to_room  [–]

Invite people into a room, as the account: each gets an in-app invitation and a push ("<your name> invited you"), open for 7 days. Only people from list_invitable_people can be invited (someone the account shares a private room with); any other id fails the whole call with 422. A password-protected room or the personal room takes invitations from its owner only. Inviting someone already invited, or already a member, sends nothing. Answers 201 with sent: how many invitations went out.

  - `invite_code` (string) **(required)**. Room invite code.
  - `recipient_ids` (array) **(required)** — 1–20 items. Up to 20 ids from list_invitable_people. Items: string, UUID.

## remove_room_member  [DI]

Remove a member from a room. The account must own the room, or be an admin removing someone who is not an admin (never in a personal room); the owner cannot be removed. The other members see "<your name> removed <member>" (public rooms stay silent). The person can rejoin only with a new invite.

  - `invite_code` (string) **(required)**. Room invite code.
  - `user_id` (string) **(required)** — UUID. A person's user_id, as list_room_members and list_invitable_people return it.

## set_member_role  [DI]

Make a member an admin, or an admin a plain member, in a room the account owns. Admins can edit the room and remove members who are not admins. The room is told of the change.

  - `invite_code` (string) **(required)**. Room invite code.
  - `user_id` (string) **(required)** — UUID. A person's user_id, as list_room_members and list_invitable_people return it.
  - `role` (string: `admin` | `member`) **(required)**. The member's new role.

## leave_room  [DI]

Take the ACCOUNT (the human, not only this agent) out of a room it belongs to. The room disappears from their apps and the other members see "<your name> left the room"; getting back in needs the invite code or a new invitation. An owner cannot leave their own room (422): delete it with delete_room instead.

  - `invite_code` (string) **(required)**. Room invite code.

## list_room_invitations  [RI]

List the open invitations the account has received: invitations[], each with id (for accept_room_invitation or dismiss_room_invitation), the room (name, icon, colour, description), the sender's name, the room you share with them and expires_at. Newest first, 30 per page; pass next_cursor for more. When this agent was given only some rooms, only invitations from people in those rooms are listed.

  - `cursor` (string) — ≤2048 chars. next_cursor from the previous page.

## accept_room_invitation  [DI]

Accept an invitation, joining the account to its room (the invitation stands in for a room password). The room's members are told. The same plan limits apply as to join_room. Answers with room_id and the joined room (room is null when the account was already a member).

  - `invitation_id` (string) **(required)** — UUID. Invitation id from list_room_invitations.

## dismiss_room_invitation  [DI]

Dismiss an invitation the account received. The sender is not told; their picker keeps showing "invited".

  - `invitation_id` (string) **(required)** — UUID. Invitation id from list_room_invitations.

## update_room_settings  [DI]

Change a setting of a room the account owns or administers that only a script can
change. `hide_pings: true` makes the apps show the room as its feed alone, with no
Quick Pings, no Custom Ping and no Live update button; for a room people only read,
such as a status or metrics feed. It hides the controls and refuses no send: Pings
sent through the API, webhooks and triggers arrive as before. `false` shows them
again. A change sends a background room refresh to room members' devices. Returns
`{invite_code, hide_pings}`; rooms carry `hide_pings` on `list_rooms` and `get_room`.

  - `invite_code` (string) **(required)**. Room invite code.
  - `hide_pings` (boolean) **(required)**. `true` hides the room's Quick Pings, Custom Ping and Live update controls in the apps; `false` shows them.

## update_room  [DI]

Edit a room the account owns or administers: its name, icon, colour, description, whether every member may send, and the per-member cooldown. Only the fields you send change. Members see a short system Ping for a rename, a new icon or a new description, and their devices refresh. A room's public identity (visibility, @handle, category, location, owner display) is not editable here. Answers with the updated room.

  - `invite_code` (string) **(required)**. Room invite code.
  - `name` (string) — 1–24 chars. Room display name.
  - `icon` (string). A v3 room-icon catalog id, e.g. "bell" (list_room_icons), or the room's current icon unchanged.
  - `color` (string) — `^#[0-9A-Fa-f]{6}$`. Hex color, e.g. "#e33122". Any hue that stays visible on both a white and a near-black background; the room's current colour always passes.
  - `description` (string) — ≤120 chars. Short room description. An empty string clears it.
  - `everyone_can_trigger` (boolean). Whether every member may send the room's Pings (true) or only the owner and admins (false).
  - `cooldown_seconds` (integer) — 0–5. Seconds a member waits between Pings in this room (0 to 5).

## delete_room  [DI]

Permanently delete a room the account owns. It disappears for every member, its scheduled Pings stop, its webhooks stop working and its connected agents lose it. This cannot be undone: confirm with the human first (request_approval or ask_question).

  - `invite_code` (string) **(required)**. Room invite code.

## list_time_triggers  [RI]

List a room's scheduled Pings (time triggers): triggers[], each with id, name (what it says), schedule, timezone, enabled flag and next_trigger_at, plus count.

  - `invite_code` (string) **(required)**. Room invite code.

## get_time_trigger  [RI]

Fetch one scheduled Ping by id.

  - `invite_code` (string) **(required)**. Room invite code.
  - `trigger_id` (string) **(required)** — UUID. Scheduled Ping id from list_time_triggers or create_time_trigger.

## create_time_trigger  [–]

Schedule a Ping in a room the account owns. It is sent later as the account (the room owner), not as this agent, to the room's other members, and only while the room has other members. name is what it says; with action_number it presses that Quick Ping instead. schedule_type daily, weekly or monthly repeats at trigger_time; specific sends once at trigger_at; date_based counts days, weeks or months since or until anchor_date. Always pass timezone: without it every time is UTC. It is created switched off unless enabled is true. A free account may keep one scheduled Ping switched on (402 pro_feature_required for another) and 10 per room; Pro has 100 per room.

  - `invite_code` (string) **(required)**. Room invite code.
  - `name` (string) — ≤100 chars. What the Ping says. Without it (and without action_number) it says "Scheduled Ping".
  - `enabled` (boolean). Whether it sends. A new one is OFF unless you send true.
  - `schedule_type` (string: `daily` | `weekly` | `monthly` | `specific` | `date_based`) **(required)**. daily, weekly (days_of_week), monthly (day_of_month): repeat at trigger_time. specific: once, at trigger_at. date_based: count since or until anchor_date at trigger_time.
  - `trigger_time` (string) — `^([01][0-9]|2[0-3]):[0-5][0-9]$`. Wall-clock time HH:MM (24-hour) in timezone. Required for daily, weekly, monthly and date_based.
  - `days_of_week` (array) — at least 1 item. Weekly days, 0 = Sunday to 6 = Saturday. Items: integer, 0–6.
  - `day_of_month` (integer) — 1–31. Monthly day, 1 to 31.
  - `trigger_at` (string). The one moment a specific schedule sends, in the future, e.g. "2026-12-24T18:00:00Z".
  - `date_direction` (string: `since` | `until`). date_based only: count up since anchor_date, or down until it (which must still be ahead).
  - `anchor_date` (string) — `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`. date_based only: the calendar date YYYY-MM-DD, in timezone.
  - `date_interval` (string: `day` | `week` | `month`). date_based only: send every day, week or month.
  - `timezone` (string) **(required)**. IANA timezone the times are in, e.g. "Europe/London". Without it, UTC.
  - `action_number` (integer) — 1–16. Press this Quick Ping slot instead of sending name. Slots 5 to 16 need Pro.

## update_time_trigger  [DI]

Change a scheduled Ping in a room the account owns: only the fields you send change, and the next send is recalculated. enabled: false pauses it; true switches it back on (a free account keeps one on).

  - `invite_code` (string) **(required)**. Room invite code.
  - `trigger_id` (string) **(required)** — UUID. Scheduled Ping id from list_time_triggers or create_time_trigger.
  - `name` (string) — ≤100 chars. What the Ping says. Without it (and without action_number) it says "Scheduled Ping".
  - `enabled` (boolean). Whether it sends. A new one is OFF unless you send true.
  - `schedule_type` (string: `daily` | `weekly` | `monthly` | `specific` | `date_based`). daily, weekly (days_of_week), monthly (day_of_month): repeat at trigger_time. specific: once, at trigger_at. date_based: count since or until anchor_date at trigger_time.
  - `trigger_time` (string) — `^([01][0-9]|2[0-3]):[0-5][0-9]$`. Wall-clock time HH:MM (24-hour) in timezone. Required for daily, weekly, monthly and date_based.
  - `days_of_week` (array) — at least 1 item. Weekly days, 0 = Sunday to 6 = Saturday. Items: integer, 0–6.
  - `day_of_month` (integer) — 1–31. Monthly day, 1 to 31.
  - `trigger_at` (string). The one moment a specific schedule sends, in the future, e.g. "2026-12-24T18:00:00Z".
  - `date_direction` (string: `since` | `until`). date_based only: count up since anchor_date, or down until it (which must still be ahead).
  - `anchor_date` (string) — `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`. date_based only: the calendar date YYYY-MM-DD, in timezone.
  - `date_interval` (string: `day` | `week` | `month`). date_based only: send every day, week or month.
  - `timezone` (string). IANA timezone the times are in, e.g. "Europe/London". Without it, UTC.
  - `action_number` (integer) — 1–16. Press this Quick Ping slot instead of sending name. Slots 5 to 16 need Pro.

## delete_time_trigger  [DI]

Delete a scheduled Ping from a room the account owns. It will not be sent again.

  - `invite_code` (string) **(required)**. Room invite code.
  - `trigger_id` (string) **(required)** — UUID. Scheduled Ping id from list_time_triggers or create_time_trigger.

## list_webhooks  [RI]

List the incoming webhooks (with their trigger URLs) for a room the account owns.

  - `invite_code` (string) **(required)**. Room invite code.

## create_webhook  [–]

Create an incoming webhook for a room the account owns. A free account keeps one enabled incoming webhook across the rooms it owns: creating a second enabled one is refused with pro_feature_required, and the message names the room whose webhook holds the slot (pass enabled: false to create it switched off). Pro lifts that cap. Returns the secret trigger URL — treat it as a credential.

  - `invite_code` (string) **(required)**. Room invite code.
  - `name` (string) **(required)** — ≤100 chars. Webhook name (shown to the owner).
  - `title` (string) — ≤40 chars. Optional push title used when the webhook fires.
  - `message` (string) — ≤160 chars. Optional default push body (max 120 characters in private rooms, 160 in public rooms).
  - `icon` (string). A v3 room-icon catalog id, e.g. "bell". Call list_room_icons to discover the valid ids.
  - `color` (string). Hex color, e.g. "#e33122".
  - `sound` (string). Canonical sound id, e.g. "ting". Omit for the room default.
  - `action_number` (integer or null) — 1–16. Quick-action slot whose label, sound, and acknowledgement preset fires use. Omit or pass null for an independent webhook with no Quick Ping preset. Slots 5–16 require the room owner to have Pro.
  - `enabled` (boolean). Whether the webhook is active. Defaults to true.
  - `cooldown_seconds` (integer) — 0–60. Minimum seconds between fires. Defaults to 5.

## update_webhook  [D]

Update an incoming webhook (by id) on a room the account owns — e.g. change its icon, title, message, or sound. On a free account, switching on a second enabled incoming webhook across its rooms is refused with pro_feature_required.

  - `invite_code` (string) **(required)**. Room invite code.
  - `webhook_id` (string) **(required)**. Webhook id (from list_webhooks or create_webhook).
  - `name` (string) — ≤100 chars. Webhook name (shown to the owner).
  - `title` (string) — ≤40 chars. Push title used when the webhook fires.
  - `message` (string) — ≤160 chars. Default push body (max 120 characters in private rooms, 160 in public rooms).
  - `icon` (string). A v3 room-icon catalog id, e.g. "bell". Call list_room_icons to discover the valid ids.
  - `color` (string). Hex color, e.g. "#e33122".
  - `sound` (string). Canonical sound id, e.g. "ting".
  - `action_number` (integer or null) — 1–16. Quick-action slot whose label, sound, and acknowledgement preset fires use. Pass null to clear the preset and make the webhook independent. Slots 5–16 require the room owner to have Pro.
  - `enabled` (boolean). Whether the webhook is active.
  - `cooldown_seconds` (integer) — 0–60. Minimum seconds between fires.
  - `regenerate_secret` (boolean). Rotate the secret trigger URL.

## delete_webhook  [DI]

Delete an incoming webhook (by id) from a room the account owns.

  - `invite_code` (string) **(required)**. Room invite code.
  - `webhook_id` (string) **(required)**. Webhook id (from list_webhooks or create_webhook).

## get_outgoing_webhook  [RI]

Read the outgoing webhook of a room the account owns: the URL every Ping in the room is POSTed to, whether it is on, the events it forwards, its delivery health (last_status, failure_count) and its signing_secret, which the receiver uses to check each delivery's signature. outgoing_webhook is null when the room never had one. Treat the secret as a credential.

  - `invite_code` (string) **(required)**. Room invite code.

## update_outgoing_webhook  [D]

Set up the outgoing webhook of a room the account owns: every Ping in the room is then POSTed, signed, to url. A new or changed url switches the webhook off and issues a new signing_secret: test it, then send enabled: true. A url set by this agent is switched off when the human disconnects the agent. A free account keeps one outgoing webhook on across its rooms (402 for a second). Answers with the webhook, signing_secret included.

  - `invite_code` (string) **(required)**. Room invite code.
  - `url` (string) — ≤2048 chars. Public https:// endpoint that receives the Pings. An empty string clears it.
  - `enabled` (boolean). Switch delivery on or off. On needs a url.
  - `events` (array). Forward only these events; an empty list forwards every one. Items: string: `manual` | `webhook` | `time` | `location` | `telegram` | `agent` | `agent_question` | `agent_approval` | `system` | `contact_share` | `contact_request` | `user_live` | `agent_live` | `notification.acked` | `notification.expired` | `question.answered` | `question.expired` | `question.cancelled`.
  - `regenerate_secret` (boolean). true issues a new signing_secret; the old one stops verifying at once.

## test_outgoing_webhook  [–]

Send one test delivery to the room's outgoing webhook url and wait up to 5 seconds for the answer: success, the HTTP status and any error. Works while the webhook is switched off.

  - `invite_code` (string) **(required)**. Room invite code.

## list_outgoing_webhook_deliveries  [RI]

The outgoing webhook's delivery log for a room the account owns, newest first: each attempt's status, HTTP status code, duration and time. Holds neither the url nor the secret.

  - `invite_code` (string) **(required)**. Room invite code.
  - `limit` (integer) — 1–100. Rows per page (default 20).
  - `before_id` (string) — UUID. next_before_id from the previous page.

## get_room_preferences  [RI]

Read the account's own notification settings for one room: whether it is muted, the members it muted, its custom sound, vibration and silent mode.

  - `invite_code` (string) **(required)**. Room invite code.

## update_room_preferences  [DI]

Change the account's own notification settings for one room; only the fields you send change. muted: true silences the room on the human's devices, so do it only when they asked.

  - `invite_code` (string) **(required)**. Room invite code.
  - `muted` (boolean). Mute or unmute the whole room.
  - `member_mute` (object). It takes:
    - `user_id` (string) **(required)** — UUID. A person's user_id, as list_room_members and list_invitable_people return it.
    - `muted` (boolean) **(required)**. true mutes this member's Pings in the room; false unmutes them.
  - `custom_sound` (string). Canonical sound id for this room's Pings, e.g. "ting". An empty string goes back to the room's sound.
  - `vibration_enabled` (boolean). Whether this room's Pings vibrate.
  - `silent_mode` (boolean). Deliver this room's Pings without sound.

## update_quick_action  [DI]

Configure a numbered quick-action slot for a room the account owns. Sends a background room refresh to room members' devices.

  - `invite_code` (string) **(required)**. Room invite code.
  - `action_number` (integer) **(required)** — 1–16. Quick-action slot number (1–16). Slots 5–16 require the room owner to have Pro.
  - `label` (string) **(required)** — ≤255 chars. Button label. Must be sent, but may be empty (`""`) — a Ping can be named by its emoji alone, and clients render an untitled one as just the emoji.
  - `icon` (string) **(required)**. Emoji or icon id. Sending `label` and `icon` both empty reserves the slot as disabled (kept in the layout, `404 action_not_configured` on press).
  - `sound` (string). Canonical sound id, e.g. "ting". Omit for the room default.
  - `requires_ack` (boolean). Whether pings from this action remain open until one eligible recipient acknowledges them.
  - `input_type` (string: `none` | `location` | `link` | `file` | `photo` | `pdf`). Detail every press of this action must carry (see `trigger_quick_action`). Omit to keep the stored value; defaults to `none`.

## update_quick_actions  [DI]

Configure several of a room's quick-action slots in one call. Prefer this over repeated `update_quick_action`: each single-slot write wakes room members' devices with its own background refresh, so setting up four Pings one at a time spends four of a finite daily push budget on one operation. Slots you do not list are left exactly as they are, so this is also the right tool for editing a single Ping — nothing here deletes an action. Returns the room's full ordered action set.

  - `invite_code` (string) **(required)**. Room invite code.
  - `actions` (array) **(required)** — 1–16 items. Add new pages as complete groups of four in order (5–8, 9–12, 13–16); the room owner needs Pro. The slots to write. Each `action_number` must appear at most once. Slots omitted here keep their current configuration — nothing in this tool deletes an action. Each item takes:
    - `action_number` (integer) **(required)** — 1–16. Quick-action slot number.
    - `label` (string) **(required)** — ≤255 chars. Button label. Must be sent, but may be empty (`""`) — a Ping can be named by its emoji alone.
    - `icon` (string) **(required)**. Emoji or icon id. Both `label` and `icon` empty reserves a disabled slot.
    - `sound` (string). Canonical sound id, e.g. "ting". Omit for the room default.
    - `requires_ack` (boolean). Whether pings from this action remain open until one eligible recipient acknowledges them.
    - `input_type` (string: `none` | `location` | `link` | `file` | `photo` | `pdf`). Detail every press must carry; omit to keep the stored value.

## list_metrics  [RI]

List the metrics kept in a room: named values (such as MRR or open tickets) a widget shows, each with its key, label, format, unit, current value and when the value last changed. Also returns the per-room limit. Returns `{metrics: [{key, label, format, unit, value, value_updated_at}], limit}`, oldest first.

  - `invite_code` (string) **(required)**. Room invite code.

## set_metric  [DI]

Set a room metric's value, creating the metric when the key is new (a room holds at most 8). Sends no ping and no push. Needs a room the account owns or administers. A value equal to the stored one changes nothing and keeps its updated time. A new metric's label defaults to the key and its format to number (for a number) or text (for a string); numbers keep four decimal places. Values are raw: clients format them for the reader. Returns the metric (`201` when it was created).

  - `invite_code` (string) **(required)**. Room invite code.
  - `key` (string) **(required)** — 1–40 chars, `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`. Metric key (from list_metrics): 1 to 40 characters, letters, digits, "-" and "_", starting with a letter or digit. Lowercased for you.
  - `value` (number | string) **(required)** — ≤24 chars. The value: a finite number with an absolute value of at most 1e15 for the number, currency, percent and unit formats, or a string of at most 24 characters for the text format.
  - `label` (string) — 1–24 chars. Name shown beside the value (at most 24 characters). Defaults to the key for a new metric.
  - `format` (string: `number` | `currency` | `percent` | `unit` | `text`). How clients show the value: number, currency (needs unit: an ISO 4217 code), percent, unit (needs unit: free text such as ms) or text. Defaults to number or text by the value's type for a new metric.
  - `unit` (string) — 1–8 chars. An ISO 4217 code such as USD for the currency format, short free text such as ms for the unit format. Not allowed for the other formats.

## delete_metric  [DI]

Delete a metric (by key) from a room the account owns or administers.

  - `invite_code` (string) **(required)**. Room invite code.
  - `key` (string) **(required)** — 1–40 chars, `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`. Metric key (from list_metrics): 1 to 40 characters, letters, digits, "-" and "_", starting with a letter or digit. Lowercased for you.

## set_avatar  [DI]

Set this agent's own avatar — the robot face its pings and Questions wear. Must be one of the PingRoom bot avatars. Never touches the bound human's profile picture. Returns `{ok, avatar_id, avatar_url}`.

  - `avatar_id` (string) **(required)**. Bot avatar id, e.g. "bots-3".

## rotate_handle  [D]

Rotate this agent's public handle — kill-switch for a leaked handle.

  (no arguments)

## update_agent_profile  [DI]

Rename this agent or choose its handle: the name and @handle room members see on its Pings, the ones already sent included. This changes the agent, never the human's profile (update_profile does that). Send display_name, handle, or both.

  - `display_name` (string) — 1–40 chars. The name shown on this agent's Pings.
  - `handle` (string) — 3–24 chars, `^@?[A-Za-z0-9_]+$`. Unique handle: letters, digits and underscores, lowercased for you; not starting with agt_. A leading @ is dropped.

## get_profile  [RI]

Read the human's profile: id (the public User ID connection_info names as owner.id), name, emoji, colour, timezone, avatar (avatar_source, pingroom_avatar_id, profile_image_url) and is_pro. Never their email address.

  (no arguments)

## update_profile  [DI]

Change the human's own profile: the name, emoji avatar, colour and timezone other people see. Only the fields you send change. Sending an emoji makes it their picture and deletes an uploaded photo. Their email address and sign-in methods are not editable here. Answers with the profile, as get_profile.

  - `name` (string) — 1–30 chars. Display name.
  - `emoji` (string) — ≤10 chars. One emoji to wear as the picture.
  - `color` (string) — `^#[0-9A-Fa-f]{6}$`. Hex colour behind the emoji, e.g. "#34c759".
  - `timezone` (string). IANA timezone, e.g. "Europe/London".

## list_avatars  [RI]

The PingRoom avatar catalog, by category (bots, boys, girls): each avatar's id, descriptive tags and image url. set_profile_avatar takes any id; set_avatar (this agent's own picture) takes only the "bots" category.

  (no arguments)

## set_profile_avatar  [DI]

Make a catalog avatar the human's own profile picture. An uploaded photo is deleted. Answers with the profile.

  - `avatar_id` (string) **(required)**. Avatar id from list_avatars, e.g. "girls-3".

## clear_profile_avatar  [DI]

Stop using the catalog avatar as the human's picture; their emoji avatar shows instead. Answers with the profile.

  (no arguments)

## get_contact_card  [RI]

Read the human's contact card: the links (phone, WhatsApp, Telegram, Instagram, LinkedIn, custom) they share with people through their personal room. It holds private contact details: use them only for what the human asked.

  (no arguments)

## update_contact_card  [DI]

Replace the human's contact card with these links (1 to 20). The whole card is replaced: read it with get_contact_card first and send every link that should stay. People the card is already shared with see the new links.

  - `links` (array) **(required)** — 1–20 items. Every link the card should hold. Each item takes:
    - `platform` (string: `instagram` | `phone` | `whatsapp` | `telegram` | `linkedin` | `custom`) **(required)**. Kind of link.
    - `value` (string) **(required)** — 1–500 chars. The number, username or URL.
    - `label` (string) — ≤255 chars. Optional label, e.g. "Work".
    - `sort_order` (integer). Optional position, lowest first.

## get_personal_room  [RI]

Read the human's personal room: the room behind their @handle link and QR code where people reach them, with its name, handle, bio, whether it is discoverable, its Quick Pings and scan_count. null when they have none.

  (no arguments)

## update_personal_room  [DI]

Change the human's personal room: name, @handle, bio, whether it is discoverable, and its 2 to 4 Quick Pings (sent as the full list). A new handle changes their link at once and the old link stops working, including printed QR codes, so change it only when they asked. Only the fields you send change.

  - `name` (string) — 1–30 chars. Personal room name.
  - `handle` (string) — `^[A-Za-z0-9_]{3,20}$`. The @handle in their link: 3 to 20 letters, digits or underscores, lowercased for you. Must be free.
  - `description` (string) — ≤120 chars. Bio. An empty string clears it.
  - `is_discoverable` (boolean). Whether the personal room can be found in search.
  - `quick_actions` (array) — 2–4 items. The full list of the room's Quick Pings, in order; it replaces the current ones. Each item takes:
    - `label` (string) **(required)** — ≤255 chars. Button label; may be empty when icon names the Ping.
    - `icon` (string) **(required)** — ≤255 chars. Emoji for the button.
    - `sound` (string). Canonical sound id, e.g. "ting". Omit for the default.
    - `requires_ack` (boolean). Whether the Ping stays open until acknowledged.
    - `input_type` (string: `none` | `location` | `link` | `file` | `photo` | `pdf`). Detail every press of this action must carry: none (default), location (data.location), link (data.url), file (any attachment), photo (jpg/png attachment) or pdf (pdf attachment). A press without it is a 422 quick_action_input_required.


For everyone confirmations, notification reads and `wait_for_ack` preserve
`action_state.mode`, `confirmed_count`, and `required_count`. `status` remains
`open` until every required recipient confirms, or becomes `expired` at the
deadline. `dismissed_count` counts recipients who dismissed the card without
confirming; a dismissal never counts as a confirmation. MCP omits recipient IDs.
Existing `any` responses may omit these new fields. A timeout or partial count
never proves completion.
