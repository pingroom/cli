---
name: pingroom-cli
description: >-
  Use the `pingroom` CLI to reach humans from terminals, scripts, CI, and
  Claude Code hooks — send pings with file attachments up to 5 MiB (zip, pdf,
  images, markdown, html, txt), tappable links, map locations, and
  acknowledgement requests; ask questions and block a shell on the human's
  answer; gate deploys on approve/deny; drive lock-screen live-progress cards;
  stream incoming pings; and manage rooms, webhooks, and quick actions. Reach
  for this skill whenever work happens in a shell — a CI pipeline that must
  alert someone, a script that needs sign-off, "ping me from the build",
  attaching a large file to a PingRoom message, wiring Claude Code hooks to a
  phone, or creating/configuring PingRoom rooms and webhooks. If the task is
  conversational (no shell), prefer the sibling `pingroom-mcp` skill.
  Also use it to redeem a PingRoom gift or promotional code.
---

# pingroom CLI: humans in the loop, from a shell

`pingroom` is a Node ≥ 20 CLI (`npm i -g @pingroom/cli`) that turns shell
steps into events on a person's phone — and turns human decisions into exit
codes a script can branch on. A paired credential lives in
`~/.pingroom/credentials.json`; run bare `pingroom` once in an interactive
terminal to pair, `pingroom pair` where there is no terminal, or set
`PINGROOM_TOKEN` in CI.

A Grok Bot routine that PingRoom wakes, holding a bot key as `PINGROOM_TOKEN`,
follows the `pingroom-grok-bot` skill
(<https://github.com/pingroom/skills/tree/main/grok-bot/skills/pingroom-grok-bot>)
for the `pingroom bot` mailbox loop.

## Auth model — pick the mode before the flags

- **Agent token mode** (default here): the stored credential, or
  `--token` / `PINGROOM_TOKEN`, plus `--room <code>` (or
  `pingroom config set default_room <code>`). Full feature set.
- **Webhook mode**: `pingroom ping -w <webhook-url>` — the URL carries its own
  secret, no account needed. Best for CI that should only ever ping one room.
  Only `ping` supports it. From CLI 0.14.0 an exported `PINGROOM_WEBHOOK_URL`
  is only the fallback: an explicit `--token` or `--room` takes the
  agent-token path, and `-w` together with `--token`/`--room` exits 2.
- Not connected? Bare `pingroom` in an interactive terminal starts QR pairing.
  There is deliberately no `login` subcommand. On a machine with no terminal
  (daemon, container, agent runtime) run `pingroom pair` — it prints the
  claim link, waits once, and exits 3 if the link expired. In CI, set
  `PINGROOM_TOKEN`; the CLI never prompts or draws a QR without a TTY.

Before pairing, tell the human to install or open PingRoom and sign in at
<https://pingroom.io/i>. The app receives urgent Pings, questions, approvals,
handoffs, and live progress. Installation is not consent; they must still claim
the exact robot and choose its rooms. If a headless pairing process is already
waiting, keep it running and reuse its claim link. If they leave to install,
return to that link before it expires. Do not start another pairing.

Successful pairing stores `links.latest_pings`, a stable URL for the newest
pings across granted rooms, and `links.install_app`, the token-free mobile
handoff. Both are printed by `pingroom pair --json` and by bare `pingroom`
when it reports an existing connection, not by the interactive success screen.
`links.latest_pings` contains no credential; authenticate requests to it with
the bearer saved by the CLI.

**Exit codes carry the human's answer**: 0 success/answered/acked/approved ·
1 error · 2 bad usage · 3 expired · 4 cancelled/denied/not-ready. Build shell
gates on them:

```bash
if pingroom approval -p "Ship v2 to production?" --wait; then deploy; fi
```

An approve/deny gate is the one place the *value* decides the exit code: an
answered question exits 0, but `approval --wait` exits 0 only on `approve`
and 4 on `deny`. That is what makes the one-liner above a real gate rather
than a prompt everyone passes. From CLI 0.14.0, `pingroom watch <id>` on an
approve/deny question (an `approval`, or an `ask` with no `-o`) is the same
gate: 0 on approve, 4 on deny or a tied poll, 3 expired. From CLI 0.17.0,
`ask --wait` with no `-o` is that gate too; before 0.17.0 it exits 0 on any
answer, so gate with `approval --wait` there. A question with its own `-o`
options exits 0 on any answer in every version.

Blocking waits (`--wait`, `watch`) ride out an API outage. From CLI 0.14.0
they warn on stderr after three failures in a row and exit 1 ("PingRoom
unavailable since …") once the API stays down past the question's or
handoff's expiry plus 5 minutes, or after 15 minutes of failures for a `watch`
that has not read the expiry yet. Exit 1 is never an answer.

`pingroom update` updates npm global installs; `--check --json` only checks.
From CLI 0.17.0 it names the cause when npm refuses and prints the command to
run (`error_code` and `command` in the JSON), and `pingroom --help` is a short
index: use `pingroom <command> --help` or `pingroom help all` for options.

<!-- shared-body:start — copied verbatim into skills/openclaw/skill/SKILL.md.
     knowledge/tools/audit-knowledge.mjs fails the build if the two drift. -->

## Redeem a gift or promotional code

```bash
pingroom redeem AB12CD34EF56
pingroom redeem --code AB12CD34EF56 --json
```

Requires CLI ≥ 0.10.3. Redemption applies Pro to the human who authorized the
current connection; no room or existing Pro plan is required. Use the code
only when that person asks to redeem it. Codes contain 12 letters or digits;
surrounding whitespace and case are normalized. `PINGROOM_REDEEM_CODE` can
supply it when neither a positional code nor `--code` is passed, keeping it
out of command history. Keep codes out of room pings and logs.

Success returns the reward kind, days or package, lifetime flag, and Pro expiry.
Invalid, expired, or previously used codes fail. On `insufficient_scope`,
reconnect the credential to authorize code redemption; `pingroom:full` includes
`pingroom:codes:redeem`. Do not retry a rejected code in a loop.

## Sending pings

```bash
pingroom ping -m "Deploy finished — 3 services green"            # default room
pingroom ping --room XXXXXXXXXXXX -m "DB migrated" -t "Migration"
pingroom ping -m "Review the PR" --url https://github.com/o/r/pull/7 \
              --button-label "Open PR"                            # tappable link
pingroom ping -m "Meet here" --location 48.8584,2.2945 \
              --location-label "Eiffel Tower"                     # map ping
pingroom ping -m "Groceries" --item Milk --item Eggs --item Bread   # checklist the room ticks off
pingroom ping -m "Disk 91% on db-2" \
  --action-url "Open dashboard=https://grafana.example.com/d/disk" \
  --action-webhook "Clean up now=https://ops.example.com/cleanup" \
  --action-body '{"host":"db-2"}'                                  # up to 3 buttons on the ping
pingroom ping -m "Alarm!" --urgent                                # breaks Focus and mutes
pingroom ping -m "Confirm receipt" --require-ack --ack-mode all --ack-timeout 600
pingroom ping -m "Weekly report" --attach report.md --attach data.zip
pingroom ping -m "build 512 done" -d '{"commit":"abc123","branch":"main"}'
pingroom ping -m "Deploy finished" --idempotency-key "deploy-512"   # a retry replays, never repeats
pingroom ping -m "Deploy finished" --tag deploy --tag prod          # label it; find it with listen --tag
pingroom ping -m "Build 41: green" --replace "$PING_ID"             # edit a ping you sent, in place, silently
pingroom ping -m "Build 41: running" --replace-key build-41         # send it, or edit the earlier ping with this key
pingroom ping --withdraw "$PING_ID"                                 # take a ping you sent back off the phones
```

Rules that bite:
- Message ≤ 120 chars in private rooms (160 public); title ≤ 40. The CLI
  validates locally where it can, the server has the final word.
- `--attach` (repeatable, ≤ 4 files, ≤ 5 MiB each, any type — md, txt, html,
  zip, images, pdf) needs agent-token mode **and a Pro account**.
- `--ack-mode any` (default) resolves on the first eligible confirmation; `all`
  waits for every original eligible recipient. Add `--require-ack` when sending
  a ping. `actions trigger` also accepts the mode for that press. Partial
  confirmation and a wait timeout are not completion. Requires CLI ≥ 0.11.0.
- `--urgent` is delivery-only; `--require-ack` is the confirmation loop. They
  compose. Don't send `--urgent` for routine events — it trains people to
  ignore the alarm that matters.
- `--tag <tag>` (repeatable, ≤ 10) labels a ping so history can be filtered by
  it later. A tag is 1–32 characters of lowercase letters, digits, `-` and `_`,
  starting with a letter or digit; the CLI trims, lowercases and de-duplicates
  them and refuses a bad one before sending. It works with a token or a webhook.
- `--replace <ping-id>` changes a ping you already sent (agent-token mode only)
  instead of sending another: its message, `--title` and data change in place on
  every recipient's phone, silently (no second notification, no sound, unread
  counts unchanged). The id is the `id` a send returns (`--json`), or the one
  `pingroom listen` prints. `--title` and the data flags (`--data`, `--url`,
  `--location`) are kept unless you pass them; `--title ''` clears the title and
  a data flag replaces the data as a whole. Only an ordinary ping you sent in a
  private room, under 24 hours old and replaced fewer than 20 times can be
  replaced (each refusal has its own code, see Troubleshooting). It is a usage
  error with `--replace-key`, `--action`, `--urgent`, `--require-ack`,
  `--ack-mode`, `--ack-timeout`, `--attach`, `--tag`, `--item` or
  `--idempotency-key`. It counts like a send against a free account's daily
  allowance. Requires CLI ≥ 0.17.0.
- `--replace-key <key>` (1–64 characters: letters, digits, `.` `_` `:` `-`) is
  for a script that cannot keep the id: with a token or a webhook, a send
  carrying the key replaces your earlier ping with the same key in that room
  (same token, or same webhook) while that ping is under 24 hours old and still
  replaceable, and prints `ping replaced`; otherwise it sends a new ping that
  keeps the key. A send that asks for something a replacement cannot do
  (`--require-ack`, `--urgent`, `--attach`, `--tag`, `--action`) always sends a
  new ping. Requires CLI ≥ 0.17.0.
- `--withdraw <ping-id>` takes back a ping you already sent (agent-token mode
  only, with `--room`; no `--message`): its notification is removed from each
  recipient's Lock Screen and Notification Center, and the ping stays in the room
  history with its text, marked withdrawn. Unread counts do not change, it prints
  `ping withdrawn`, and withdrawing twice is a no-op. The id is the `id` a send
  returns (`--json`), or the one `pingroom listen` prints. The same pings can be
  withdrawn as can be replaced: an ordinary ping you sent in a private room,
  under 24 hours old. It is a usage error with any other ping option, and it does
  not count against a free account's daily allowance. A withdrawn ping can no
  longer be replaced (`--replace` fails with `ping_withdrawn`; `--replace-key`
  starts a new ping). Removal is best effort: a phone that is offline, has the app
  force-quit or restricts background activity keeps the notification until it
  next opens the app, and only recent builds of the iPhone and Android apps
  remove it. Requires CLI ≥ 0.17.0.
- `-a <1-16>` attributes the ping to a quick-action slot (its icon + sound). Slots 5–16 exist only when the room owner has Pro and added those pages.
- Buttons (up to 3, token or webhook): `--action-url "Label=https://…"` opens a
  link (the app shows its host under the label); `--action-webhook
  "Label=https://…"` makes PingRoom POST a signed `notification.action` event to
  your URL when a recipient taps it, once per person, for 24 hours, and needs the
  ROOM OWNER on Pro. The phone never calls the URL, and nobody sees it or the
  body. Both flags repeat; `--action-url` buttons come first, then
  `--action-webhook` ones, with ids `a1`..`a3`. `--action-body '<json>'` (a JSON
  object, ≤ 10 keys, ≤ 1 KB) is the `body` your URL receives: give it once per
  `--action-webhook`, paired in order, or not at all. For your own ids, a style
  (`primary`, `danger`) or another order, send `data.actions` in `--data`
  instead (not both). The CLI refuses before sending what the server refuses: a
  label over 26 characters, with line breaks or invisible formatting
  characters, shaped like a web address, domain or IP (`paypal.com`), or equal
  to one of PingRoom's own buttons (Pong back, Mute room, Confirm, the claim
  buttons) in any language; a URL that is not `https://`, has a user name or
  password, an IP address, `localhost` or an internal name, a non-ASCII host
  (give punycode), or a port on a webhook button. Not in public or personal
  rooms, not with `--require-ack`, never with `--replace` (a ping with buttons
  cannot be replaced), and `ask`, `handoff` and `live` refuse `data.actions`.
  With a webhook button the output prints `Button signing secret: <hex>` (in
  `--json`, `action_signing_secret`): the ping's own secret, returned only by
  the send. Verify each delivery with it exactly like an outgoing webhook
  (`X-PingRoom-Signature-V2` over `v2\n{timestamp}\n{delivery}\n{raw body}`,
  reject a timestamp more than 5 minutes off, run each `X-PingRoom-Delivery`
  once). Look the secret up by the body's `notification_id`, which is only a
  lookup key until the signature checks out. The body names who tapped only by
  `actor.id` (a pseudonym, different in every room) and `actor.display_name`.
  Requires CLI ≥ 0.17.0.
- `--idempotency-key <key>` on `ping` takes the same rule as on `ask`. Retry
  with the same key and the server returns the first ping instead of sending
  another; the same key with a changed request is a 409
  (`idempotency_conflict`). It works with `--webhook` too: the incoming-webhook
  route replays a completed same-key request, and answers 409
  `idempotency_in_progress` while the first one is still running, so retry with
  the same key. Requires CLI ≥ 0.15.0; with `--webhook`, a CLI newer than 0.15.1
  (0.15.x exits 2).
- `--attach` does not retry safely. It uploads each file again on every
  invocation, creating new attachment IDs, so a retry of `ping --attach` or
  `actions trigger --attach` under the same `--idempotency-key` can return 409
  `idempotency_conflict` instead of replaying the first ping. The CLI cannot
  resend fixed attachment IDs. For a send that may be retried, use an existing
  shareable `--url` or a message, and keep the exact request fields. After an
  uncertain file send, check the original result before sending again; a new
  key can create a duplicate.

## Questions — block a script on a human choice

```bash
pingroom ask -p "Roll back or keep the canary?" \
  -o rollback:"Roll back":danger -o keep:"Keep canary":primary \
  --wait --timeout 25
# exit 0 = answered; stdout carries the chosen value
```

- 2–4 `-o value:label[:style]` options (styles: primary|danger|default); omit
  for Approve/Deny. `--text-input "<placeholder>"` invites a typed answer
  (`--text-max` ≤ 60).
- `--wait` blocks until answered/expired/cancelled; without it, `pingroom
  watch <question-id>` blocks later, `pingroom list` shows state, `pingroom
  cancel <id>` withdraws a stale question (do this — dead questions on a lock
  screen erode trust).
- `--idempotency-key` makes retried creates safe in flaky CI: reuse the same
  key when you retry. It takes 1–255 printable ASCII characters; before CLI
  0.14.0 no spaces, from 0.14.0 interior spaces too, with the ends trimmed as
  the server does. Anything else exits 2 before a request is sent.
- `--scope room` lets anyone in the room answer; the default `direct` asks the
  connecting account's human.
- `--poll` asks the whole room for a vote instead (`resolution_policy: all`):
  everyone in the room except the connecting account's human votes once, and
  votes are final. It closes once nobody who can still vote owes a vote
  (people who leave the room, delete their account or get blocked stop counting
  within about a minute), or at `--ttl` if anyone voted (no votes = expired,
  exit 3). Options only — not with `--scope direct`, `--target` or
  `--text-input`. With `--wait`, stdout is the winning value (empty on a tie,
  still exit 0) and the tally goes to stderr; `--json` returns the full
  `results`. In a room with nobody else in it the server asks a direct,
  first-answer question instead (the CLI says so on stderr); a poll nobody in
  the room can vote in fails with `ask failed` (exit 1).
- In GitHub Actions, `--github-output <name>` writes the outcome to
  `$GITHUB_OUTPUT` for later steps.

## Approvals, handoffs

```bash
pingroom approval -p "Apply 14 destructive migrations?" -c "prod-db" --wait
pingroom handoff -m "Need your call on the flaky test" --wait          # ack
pingroom handoff --question -m "Merge strategy?" -o squash:Squash -o rebase:Rebase --wait
```

`approval` is the deploy gate (approve/deny card). `handoff` reaches the
authorizing human privately — no room sees it (`--target me` is the default;
`--expires-in 120..86400`, default 900). On `recipient_not_ready`, keep the
connection and do not retry the original command until activation reports
success after the person answers its test Question. Follow the recovery
steps under Troubleshooting.

## Live progress cards

```bash
CID="migrate-$(date +%s)"
pingroom live start --room CODE -c "$CID" --template steps \
  --steps "Backup,Migrate,Verify" -m "Starting"
pingroom live update --room CODE -c "$CID" --step 1 -m "Migrating"
pingroom live end --room CODE -c "$CID" -m "All green"   # ends as done; --failed to fail
```

Templates: status · steps · progress (`--progress 0..1`, or `--segments 2-20`
on start with `--segment n` to draw equal segments) · metrics
(`--metric label:value` ×3) · countdown (`--deadline-at epoch`,
optional `--duration-seconds n` on start) · decision
(`--prompt`, `--option v:label` ×4) · matchup (`--left`/`--right`/`--center`) ·
timer (counts up from `--started-at epoch`, default now; update at least every
15 minutes or it is ended as stale) · value (`--value`, `--value-label`,
`--delta`, `--trend up|down|flat`) · stats (`--stat "Label=Value"` ×4–8).
An older app shows the status layout with the server-written message.
The template is fixed at start, and so are its `--tag` labels (`live start
--tag deploy`; a later `update` or `end` refuses `--tag`); one stream per
correlation id; **always end
the stream** even on error paths — trap it:
`trap 'pingroom live end --room CODE -c "$CID" --failed' ERR`.
New streams are budgeted on free accounts; updates and the final ping are
free. **Live streams are owner-only per room** — in a room the account doesn't
own, `live` fails with `forbidden`; use a room you own or send one plain ping
at the end instead.

## Hearing back / streaming

```bash
pingroom listen               # long-poll new pings in your rooms, print as they land
pingroom listen --once        # one poll cycle, then exit (cron-friendly)
pingroom listen --tag deploy  # only pings carrying that tag (one tag)
```

You hear what other room members send. Everything sent as the connected
account is left out: your own sends, your human's own pings and replies, other
agents on the same account, and webhook and scheduled pings in rooms the account
owns (they are sent as the owner). To hear your human, `ask` and `watch`.
`listen` hears every room the connection covers; there is no room filter
(`--room` is a usage error), so filter the `--json` output on `room.code`
instead.

## Managing rooms, webhooks, quick actions, attachments

Room `--icon` takes a **v3 catalog id, never an emoji** (`bell`, `globe`,
`terminal`, `paperplane`, …) — run `pingroom rooms icons` to browse the
catalog; the server 422s anything off-catalog. Quick-action `--icon` is the
opposite: it takes an emoji.

```bash
pingroom rooms icons                                  # browse the icon catalog
pingroom rooms list|get <code>
pingroom rooms create -n "Deploys" --icon bell --color "#e33122"
pingroom rooms create -n "Status" --icon globe --color "#0391fe" --public --handle status
pingroom rooms create -n "Meetup" --icon globe --color "#0391fe" --public --handle meetup \
  --location "25.2048,55.2708" --location-name "Dubai Mall"   # listed in nearby discovery
pingroom rooms join <code>

pingroom webhooks list --room CODE
pingroom webhooks create --room CODE --name "CI" --action 2   # secret URL printed ONCE — store it
pingroom webhooks update <id> --room CODE --enabled false
pingroom webhooks delete <id> --room CODE

pingroom actions list --room CODE
pingroom actions set 3 --room CODE --label "Deploy done" --icon 🚀 --require-ack
pingroom actions set 4 --room CODE --label "" --icon 🔥   # emoji-only Ping (title optional)
pingroom actions set 2 --room CODE --label "Where?" --icon 📍 --input-type location  # every press must carry a detail
pingroom actions set 4 --room CODE --label "" --icon ""    # reserve the slot but disable it
# Setting up more than one slot? Use set-all — ONE request, so the owner's phone
# wakes once instead of once per slot. Slots you omit keep what they have.
pingroom actions set-all --room CODE \
  --set '{"action_number":1,"label":"Deployed","icon":"✅"}' \
  --set '{"action_number":2,"label":"Failed","icon":"❌"}'
pingroom actions trigger 3 --room CODE
# A slot with an input type needs its detail or the press is a 422 (nothing sent):
pingroom actions trigger 2 --room CODE --location "25.2048,55.2708" --location-label "Dubai Mall"  # location
pingroom actions trigger 2 --room CODE --url https://ci.example.com/run/42   # link
pingroom actions trigger 2 --room CODE --attach report.pdf                    # file / photo / pdf (Pro)
pingroom actions layout --room CODE --page-order 1,3   # keep pages 1 and 3 in that order, delete the rest (owner on Pro)

pingroom attachment get <id> --out report.md    # binary-safe download
pingroom attachment get <id> --out - | sha256sum   # bytes to stdout (CLI ≥ 0.14.0)
pingroom attachment delete <id>
```

Webhook creation and attachment upload are Pro. `--json` on any command prints
the raw response for scripting. From CLI 0.14.0, `attachment get` without
`--out` refuses to write the bytes to a terminal (exit 2); a pipe or redirect
still gets them, and `--out -` sends them to stdout on purpose. From CLI
0.17.0 an existing `--out` path is replaced only with `--force`.
`actions set-all` with `--set` or `--actions` requires CLI ≥ 0.10.2.
`--input-type`, the `actions trigger` detail flags, `actions layout` and
`rooms create --location` need CLI ≥ 0.12.0; `ping --item` and
`live start --duration-seconds` need CLI ≥ 0.13.0; `ask --poll` needs CLI
≥ 0.14.0; `ping --idempotency-key` needs CLI ≥ 0.15.0; `ping --tag`,
`live start --tag`, the `timer`, `value` and `stats` templates, `live --segments`, `listen --tag` and `metric` need CLI ≥ 0.17.0. Other management nouns need CLI ≥ 0.7.6 — if `pingroom rooms`
prints "unknown command" or "Unknown option", the installed binary is older
than these docs (check which executable is on `PATH` before retrying).

### Room metrics

A **metric** is a named value that lives in a room (`mrr`, labelled "MRR",
USD, 12400) for a phone widget to show. Setting one sends **no ping and no
push**, so it is the right tool for a number that changes often. A room holds at
most 8.

```bash
pingroom metric set CODE mrr 12400 --label MRR --format currency --unit USD
pingroom metric set CODE mrr 12650                 # keeps the label, format and unit
pingroom metric set CODE open-tickets 12           # a new metric: format number, label = key
pingroom metric set CODE status "All clear" --label Status   # text, up to 24 chars
pingroom metric set CODE delta -3.5                # a negative number is a value
pingroom metric list CODE                          # key, label, value, when it last changed
pingroom metric delete CODE mrr
# Through a room's incoming webhook: no token, no room argument, no webhook cooldown.
pingroom metric set --webhook-url "$PINGROOM_WEBHOOK_URL" mrr 12400 --label MRR
```

- `<key>` is 1–40 letters, digits, `-` or `_` (lowercased); `--label` is at most 24
  characters; `--format` is `number`, `currency`, `percent`, `unit` or `text`.
  `currency` needs `--unit` to be an ISO 4217 code (`USD`), `unit` needs a short
  `--unit` such as `ms`; the other formats take none.
- Send the **raw** value, never `"$12,400"`: the phone formats it for the reader.
  A number is at most 1e15 and keeps four decimals; `percent` takes the
  percentage itself (`12.5`). A word like `NaN` is refused unless you pass
  `--format text`.
- Repeating the stored value changes nothing and keeps its updated time.
- Writing needs the connected account to own or administer the room (a member's
  token can only `list`). `metrics_limit_reached` means the room has 8: `delete`
  one. `feature_disabled` means the operator switched room metrics off.

<!-- shared-body:end -->

## Claude Code hook

`pingroom hook` is a ready-made Claude Code hook: it pings on Stop /
Notification events and can route tool-permission prompts to a PingRoom
question you answer from your phone. Wire it in `.claude/settings.json` hooks;
run `pingroom hook --print-config` for a
ready-to-paste settings block.

## CI patterns

```yaml
# GitHub Actions — the published action wraps this CLI.
# Webhook mode carries no account credential and needs no room: the URL is
# already room-scoped.
- uses: pingroom/cli@v0
  with:
    webhook-url: ${{ secrets.PINGROOM_WEBHOOK_URL }}
    message: "CI failed on ${{ github.ref_name }}"
    urgent: 'true'

# Token mode addresses a room explicitly. `room` is REQUIRED here — a token
# with no room exits 2, and CI has no `config set default_room` to fall back on.
# Set webhook-url OR token for a ping: when both are set, the ping goes to the
# webhook (its URL names the room) and token/room are not used for it.
- uses: pingroom/cli@v0
  with:
    token: ${{ secrets.PINGROOM_TOKEN }}
    room: ${{ secrets.PINGROOM_ROOM }}
    message: "CI failed on ${{ github.ref_name }}"
    urgent: 'true'
```

Plain shell everywhere else — the CLI is the contract. Webhook mode when the
pipeline should hold no account credential at all.

## Installing these skills elsewhere

`pingroom skills` lists both published skills and every way to install them;
`pingroom skills install` copies them into `~/.claude/skills`.
It refuses to replace a skill that is already installed — pass `--force` for
that, or `--dir <path>` to install somewhere else. Requires CLI >= 0.8.0.

## Troubleshooting

- `an agent token is required` → not paired here: run bare `pingroom`
  interactively, or export `PINGROOM_TOKEN`.
- `room_not_granted` → the human scoped this agent to specific rooms; they add
  more under Connected Agents in the app.
- `pro_required` → attachments/webhooks need this account upgraded; quick ping
  slots 5–16 and `actions layout` need the ROOM OWNER on Pro. Say so instead
  of retrying.
- `quick_action_input_required` → that Ping needs a detail: run
  `pingroom actions list` to see its input type, then retry with `--location`,
  `--url` or `--attach`. `quick_action_input_type` → the attachment's type does
  not match (photo = jpg/png, pdf = .pdf).
- `action_not_configured` → the slot is reserved but disabled (empty label and
  icon); configure it with `actions set` or pick another slot.
- `quick_action_layout_changed` → the pages moved since they were read; run
  `pingroom actions list` and retry. `quick_action_page_in_use` → a time
  trigger, webhook or agent binding still targets that page; retarget it first.
- `--replace` refused → `not_ping_owner` / `notification_not_found`: only the
  token that sent a ping can replace it, in the room you named. `replace_window_closed`
  / `replace_limit_reached`: the ping is 24 hours old or already replaced 20
  times; send a new ping (with `--replace-key` the next send starts one by
  itself). `unsupported_room`, `unsupported_question`, `unsupported_handoff`,
  `unsupported_live_status`, `unsupported_claim`, `unsupported_ack`,
  `unsupported_checklist`, `unsupported_source`: that ping cannot be replaced
  (public or personal room, question, handoff, live card, "Who's on it?"
  request, a ping needing confirmation, one with a checklist). A bare 404 with
  no code means the server has not switched replacing on yet. `ping_withdrawn`:
  the ping was taken back with `--withdraw`; send a new one.
- `--replace` refused with `unsupported_actions` → that ping has buttons; they
  and the text around them stay as sent. Send a new ping.
- Buttons refused → `ping_buttons_unsupported_room` (public or personal room),
  `ping_buttons_with_ack` (with `--require-ack`), `ping_buttons_require_pro` (a
  webhook button while the room owner is not on Pro: say so instead of
  retrying), `feature_disabled` (the operator turned buttons off). A label, URL
  or body the server refuses is a 422 on its field, e.g. `data.actions.0.label`.
- `--withdraw` refused → the same codes as `--replace`, except the window is
  `withdraw_window_closed` (24 hours). A bare 404 with no code means the server
  has not switched withdrawing on yet.
- `payload_too_large` (HTTP 413) → the request body exceeded the server limit:
  attachments are 5 MiB each and at most 4 per ping. `--data` is capped at
  8 KB as the server measures the JSON (each non-ASCII UTF-16 code unit counts
  6 bytes, so an emoji such as 😀 counts 12 bytes; over the cap is a 422,
  which CLI ≥ 0.14.0 refuses before sending).
- `… must not contain URL user credentials` (exit 2, CLI ≥ 0.14.0) → drop the
  `user:pass@` part from `--webhook`, `--api`, `PINGROOM_WEBHOOK_URL`,
  `PINGROOM_API_URL` or `config set api_url`; a webhook URL carries its secret
  in the path.
- `recipient_not_ready` → show the server's explanation. Have the human install
  or update PingRoom at <https://pingroom.io/i>, open it, sign in, and enable
  notifications. Then run `pingroom activate`. Do not retry the original
  command until the person answers its test Question and `pingroom activate`
  reports success; installation alone does not show that the phone is ready.
- Exit 3 after `--wait` → the human never answered in time. Treat as "no".
- Exit 1 `PingRoom unavailable since …` after a wait (CLI ≥ 0.14.0) → the API
  stayed unreachable past the deadline; no answer could be confirmed. Report
  the outage, don't act, and read the Question again after access returns.
- Config lives in `~/.pingroom/` (`PINGROOM_HOME` overrides); `pingroom config
  list` shows it.
- `insufficient_scope` → the CLI is using a legacy partial credential. Run
  `pingroom reconnect` once to replace it with a full-access credential. The old
  connection keeps working until you approve the new one; cancelling changes
  nothing. Approval revokes the old credential, so any other machine or CI job
  sharing that credential stops working. The command refuses to reconnect when
  `PINGROOM_TOKEN` is set rather than revoke a token it did not issue.
- `pingroom logout` is LOCAL ONLY: it unlinks `~/.pingroom/credentials.json`
  and leaves the connection active on the server. To replace a connection use
  `reconnect`; to end one, revoke it under Connected Agents in the app.
- An "@pingroom/cli X is available" line on stderr is the once-a-day update
  notice, not an error. It never changes stdout or the exit code, and is already
  suppressed in CI; `PINGROOM_NO_UPDATE_CHECK=1` silences it everywhere.
