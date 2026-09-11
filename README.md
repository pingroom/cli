<p align="center">
  <img alt="PingRoom CLI — Phone notifications from your terminal" src="https://shieldcn.dev/header/gradient.svg?title=PingRoom+CLI&amp;subtitle=Phone+notifications+from+your+terminal&amp;mode=dark" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pingroom/cli"><img alt="npm version" src="https://shieldcn.dev/npm/@pingroom/cli.svg" /></a>
  <a href="https://nodejs.org/"><img alt="Required Node.js version" src="https://shieldcn.dev/npm/node/@pingroom/cli.svg" /></a>
  <a href="https://github.com/pingroom/cli"><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/pingroom/cli.svg" /></a>
</p>

# PingRoom CLI

Send push notifications from your terminal, CI, or AI agent to your phone.
Ask a question, wait for approval, or keep a live progress card on the lock screen.

```bash
pingroom ping -m "Deploy succeeded ✅"
```

**New here?** [Install and connect](#install-and-first-run).
**Using an agent?** [Add the skill](#agent-skills).

## Table of contents

- [Use cases](#use-cases)
- [Agent skills](#agent-skills)
- [Install and first run](#install-and-first-run)
- [Command guide](#command-guide)
- [Ping options, files, links, and locations](#usage)
- [Questions](#ask-a-human-questions) · [Handoffs](#handoffs-agent--human)
- [Live Activities](#live-activities-pingroom-live) · [Hearing replies](#hearing-replies)
- [Rooms, webhooks, and quick actions](#managing-rooms-webhooks-and-quick-actions)
- [GitHub Actions](#github-actions) · [GitLab CI](#gitlab-ci) · [Shell and curl](#plain-shell--curl)
- [Claude Code hooks](#claude-code-integration-get-pinged-by-your-agent) · [MCP setup](#mcp-client-setup)
- [Connecting](#connecting) · [Headless pairing](#headless-pairing-daemons-containers-openclaw) · [Local settings](#local-settings)
- [Webhook setup](#getting-a-webhook-url) · [Agent tokens](#agent-token-mode)
- [Test the round-trip](#proving-the-round-trip-optional) · [Redeem a code](#redeem-a-gift-or-promotional-code)
- [Update the CLI](#update-the-cli) · [Downloads](#downloads) · [License](#license)

## Use cases

| When you need to… | Run this after connecting |
|---|---|
| Know when a build finishes | `pingroom ping -m "Build complete"` |
| Get confirmation from everyone | `pingroom ping -m "Please confirm the release" --require-ack --ack-mode all` |
| Wait for permission to deploy | `pingroom approval -p "Deploy to production?" --wait` |
| Ask a question with choices | `pingroom ask -p "Deploy where?" -o staging:Staging -o prod:Production --wait` |
| Send a report to your phone | `pingroom ping -m "Weekly report" --attach ./report.pdf` |
| Share a build link | `pingroom ping -m "Build ready" --url https://ci.example.com/builds/512` |
| Show progress on the lock screen | `pingroom live start -c build-512 --template progress -m "Building" --progress 0` |
| Hear new pings in your terminal | `pingroom listen` |

A sent ping means the server accepted it. `--require-ack` adds confirmation
buttons and returns immediately; `--ack-mode all` keeps the ping open until
every original eligible recipient confirms. Use `approval --wait` for a shell
gate: it exits `0` only on approval. Attachments require Pro.
[End live streams](#live-activities-pingroom-live) when the work finishes.

## Agent skills

Give your agent the [PingRoom skill](https://github.com/pingroom/skills/tree/main/cli/skills/pingroom-cli)
so it knows how to send pings, ask for decisions, and wait for answers.
The CLI skill handles shell commands and CI; the
[MCP skill](https://github.com/pingroom/skills/tree/main/mcp) handles conversational tool calls.

**Claude Code plugins:** run these inside Claude Code:

```text
/plugin marketplace add pingroom/skills
/plugin install pingroom-cli
/plugin install pingroom-mcp
```

**Copy the skills:** after [installing the CLI](#install-and-first-run), run:

```bash
pingroom skills install
```

This needs Git and copies both skills into `~/.claude/skills/`. Existing skills
are preserved unless you pass `--force`; `--dir <path>` changes the destination.
The MCP plugin also configures the hosted server; authorize it through `/mcp`.
The CLI skill uses your [paired CLI connection](#connecting).

Using **Grok Build, Cursor, or OpenClaw**? Follow the
[client-specific install guide](https://github.com/pingroom/skills#install).
The OpenClaw skill includes its own reviewed, locked CLI installation.

## Install and first run

Requires **Node.js 20 or later**. [Install or open PingRoom on your phone](https://pingroom.io/i) and sign in, then run:

```bash
npm install --global @pingroom/cli
pingroom
```

Scan the QR code with PingRoom to claim the CLI's robot and choose its home
room and room access. The CLI saves that connection for later commands.

```bash
pingroom ping -m "Deploy succeeded ✅"
```

```text
ping sent ✅
View on web: https://pingroom.io/app/notifications/<ping-id>
```

Open **View on web** to see that ping. The page requires sign-in with an account
that can access it. The link appears when PingRoom returns a notification ID;
custom API servers keep their existing output. `--json` still returns only the
raw API response.

Prefer a one-off run? Use `npx --yes @pingroom/cli` to connect, then
`npx --yes @pingroom/cli ping -m "Deploy succeeded ✅"` to send.
For CI, use a [webhook](#getting-a-webhook-url) or an [agent token](#agent-token-mode).
For containers and daemons, use [headless pairing](#headless-pairing-daemons-containers-openclaw).

[Connection details](#connecting) · [All commands](#command-guide) · [Update the CLI](#update-the-cli)

## Command guide

| Task | Commands | Details |
|---|---|---|
| Send a ping, file, link, or location | `ping` | [Options and examples](#usage) |
| Ask and wait for a decision | `ask`, `approval`, `watch`, `list`, `cancel` | [Questions](#ask-a-human-questions) |
| Reach your human directly | `handoff`, `handoffs` | [Handoffs](#handoffs-agent--human) |
| Show live progress | `live start`, `update`, `end`, `get` | [Live Activities](#live-activities-pingroom-live) |
| Receive pings | `listen` | [Hearing replies](#hearing-replies) |
| Manage your setup | `rooms`, `webhooks`, `actions`, `attachment` | [Management](#managing-rooms-webhooks-and-quick-actions) |
| Connect or change settings | `pingroom`, `pair`, `reconnect`, `activate`, `config`, `logout` | [Connecting](#connecting) |
| Set up an agent | `skills`, `mcp`, `hook` | [Skills](#agent-skills) · [MCP](#mcp-client-setup) · [Hooks](#claude-code-integration-get-pinged-by-your-agent) |
| Maintain the CLI | `update`, `redeem` | [Updates](#update-the-cli) · [Gift codes](#redeem-a-gift-or-promotional-code) |

Run `pingroom --help` or `pingroom <command> --help` for the full reference.

## Usage

```
pingroom ping [options]

  -m, --message <text>   Ping body (required; <= 120 private / <= 160 public)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-16>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data, e.g. '{"commit":"abc123"}'
      --url <https-url>  Make the ping a tappable link (absolute http(s) URL)
      --button-label <t> Link button text (<= 26 chars; requires --url)
      --location <lat,lng>  Attach a map location (latitude,longitude)
      --location-label <t>  Location label (<= 100 chars; requires --location)
      --location-address <t> Address (<= 255 chars; requires --location)
      --require-ack      Keep the ping open until an eligible recipient acknowledges it
      --ack-mode <mode> any (default) or all original eligible recipients
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
      --attach <path>    Attach a file; repeat for up to 4 (requires --token)
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)
      --api <url>        API base URL (env PINGROOM_API_URL)
      --json             Print the raw JSON response
```

Ping titles are limited to 40 characters. Bodies are limited to 120 characters
in private rooms and 160 in public rooms. A room code or webhook URL does not
reveal room visibility, so the CLI rejects only bodies over 160 locally; the
server applies the tighter 120-character private-room limit.

To send a location, pass decimal latitude and longitude as one comma-separated
value. Optional map text rides inside the same reserved `data.location` object:

```bash
pingroom ping --room ab12cd -m "Meet me here" \
  --location "25.2048,55.2708" \
  --location-label "Dubai Mall" \
  --location-address "Downtown Dubai"
```

Latitude is inclusive -90..90 and longitude is inclusive -180..180. Labels are
limited to 100 Unicode characters and addresses to 255. The recipient can share
the point or open it in Waze, Google Maps, Apple Maps, or another installed map
app. These flags work with agent-token and incoming-webhook sends. When combined
with `--data`, the explicit flags replace only `data.location`; sibling keys are
preserved.

To make the ping actionable, add `--require-ack`. The first eligible recipient to
acknowledge it resolves the default `any` mode. Add `--ack-mode all` to wait
for every original eligible recipient; `--ack-timeout` expires the ping if its
confirmation rule is still unmet:

```bash
pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Production health check failed" \
  --require-ack --ack-mode all --ack-timeout 300
```

Webhook timeouts accept 1–86400 seconds. Agent-token room pings accept
60–86400 seconds.

To attach a tappable link button (a "link ping"), add `--url` and optionally
`--button-label`. They fold into the structured `data` object as
`{"url": ..., "button_label": ...}` — the same convention accepted raw via
`--data`:

```bash
pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Build 512 ready" \
  --url https://ci.example.com/builds/512 --button-label "Open build"
```

The URL must be absolute http(s) (≤ 2048 chars); the label caps at 26 chars.

To send the file itself rather than a link to it, use `--attach`. Each file is
uploaded separately and only the resulting ids ride the ping; recipients open
them from the ping, authenticated:

```bash
pingroom ping --token "$PINGROOM_TOKEN" --room AB12 -m "Nightly report" \
  --attach ./report.pdf --attach ./summary.md
```

Accepted types are `md`, `pdf`, `html`, `txt`, `jpg`, `jpeg`, `png`, `zip`, up to
5 MiB each and at most 4 per Ping. A `.zip` must be a real archive starting at
byte zero — the server rejects one with any payload prefixed to it. `--attach` needs an agent token — a webhook ping
has no uploader identity to bind private files to — and the bound account must
hold Pro (otherwise the upload fails with `pro_required`). An upload that never
reaches a ping expires by itself after 24 hours.

Exit codes: `0` success · `1` delivery failed · `2` bad usage. So CI fails loudly if a
ping doesn't land.

`--ack-mode any|all` also works on `pingroom actions trigger`; it applies to that
press only and leaves the saved action unchanged. The GitHub Action accepts
`ack-mode: all` alongside `require-ack: 'true'`. Existing calls default to `any`.

## Ask a human (Questions)

Turn a human decision into a shell gate. `ask --wait` blocks until someone taps
an answer on their phone, prints the chosen option **value** to stdout, and
encodes the outcome in the exit code — `0` answered, `3` expired, `4` cancelled.
Needs an agent token and a room.

```bash
# Gate a production deploy on a lock-screen tap (Approve/Deny is the default):
if [ "$(pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd --wait \
      -p 'Deploy 1.4.0 to production?')" = approve ]; then
  ./deploy-prod.sh
fi

# A multi-option question, answerable by anyone in the room:
pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd --scope room --wait \
  -p 'Which environment?' -o prod:Production -o staging:Staging -o cancel:Cancel

# Fire-and-forget (prints the question id), then watch it later:
ID=$(pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd -p 'Merge PR #42?' --ttl 1800)
pingroom watch --token "$PINGROOM_TOKEN" "$ID"

pingroom list   --token "$PINGROOM_TOKEN" --state pending
pingroom cancel --token "$PINGROOM_TOKEN" "$ID"
```

Options are `value:label` pairs (repeat `-o` for 2–4). Omit them for the binary
Approve/Deny default — two options is the lock-screen fast path. `--ttl` sets the
expiry in seconds (default 1h; 30–86400). `--scope room` lets any eligible member
answer (first tap wins); the default `direct` asks your bound user.
`--idempotency-key <key>` sends a printable 1–255 character `Idempotency-Key`
header. Retrying the same key with the same request returns the original
Question; reusing it with a changed request returns `409 idempotency_conflict`.

## Handoffs (agent → human)

`handoff` hands a single decision to a specific human — either a simple
**acknowledge** ("ack to proceed") or a **question** with options. It needs an
agent token whose consent grants `pingroom:handoffs:create`. Unlike `ask`, a
handoff targets a user directly (default `me`, the bound user) rather than a
room, and prints machine-readable `key=value` lines.

```bash
# Ack handoff — block until the human acknowledges (exit 0), or it expires (3):
pingroom handoff --token "$PINGROOM_TOKEN" -m "Prod deploy 1.4.0 — ack to proceed" --wait

# Question handoff, blocking, branch in CI on the exit code:
pingroom handoff --token "$PINGROOM_TOKEN" --wait \
  -m "Ship 1.4.0 to production?" --question -o deploy:Deploy -o hold:Hold
# exit 0 = answered (ANY value, incl. 'hold' — a negative human decision is not a failure)
# exit 3 = expired    exit 4 = cancelled / recipient not ready    exit 1 = error
```

Flags: `--question` (or any `-o value:label`, 2–4) makes it a question, else it's
an ack. `--target me|<uuid>` picks the recipient. `--expires-in <s>` (120–86400,
default 900). `--urgency active|passive`. `--idempotency-key <key>` is sent as
the `Idempotency-Key` header so network retries collapse to one handoff (the
server 409s on a key reused with a different payload). `--correlation-id` /
`--reply-to` / `-d '{...}'` are echoed back. Add `--wait` to long-poll to a
terminal state; without it the command prints the created handoff and returns 0.

List unresolved Handoffs or bounded recent history without changing the legacy
question-only `list` command:

```bash
pingroom handoffs --token "$PINGROOM_TOKEN"                 # open only
pingroom handoffs --token "$PINGROOM_TOKEN" --state all     # recent, up to 200 per kind
```

A negative answer (`hold`, `deny`, …) is a **successful** `answered` state and
exits `0` — branch on the printed `answer=` line, not on the exit code.

## Live Activities (`pingroom live`)

A **live-status stream** is one long-running thing shown as a self-updating card
on the Lock Screen (iOS Live Activity / Dynamic Island, Android live update, and
a full inline card in the app). `start` opens it with one alert, `update` moves
it **silently**, `end` closes it with one completion alert.

```
pingroom live <start|update|end|get> [options]

  -c, --correlation-id <id>  The stream key — reuse it for every ping (required)
      --template <name>      start only: status | steps | progress | metrics |
                             countdown | decision | matchup (fixed at creation;
                             'decision' is the app's name for the wire id
                             'question', which is still accepted)
      --steps <a,b,c>        start only: 2-8 comma-separated step labels
  -m, --message <text>       The card's live message line
      --progress <0..1>      Progress bar / Dynamic Island gauge
      --step <n>             Current step index (steps template)
      --metric <label:value> Repeatable, up to 3 (metrics template)
      --deadline-at <epoch>  Countdown target (countdown template)
      --eta-at <epoch>       Live ETA (status/progress templates)
      --prompt <text>        The ask (decision template)
      --option <value:label> Repeatable, up to 4 (decision template)
      --left <label:value>   Left side (matchup template)
      --right <label:value>  Right side (matchup template)
      --center <text>        Center score/clock, <= 40 (matchup template)
      --accent-override <#rrggbb>  Semantic accent for this frame
      --failed               end only: finish as failed instead of done
  -d, --data <json>          Structured data object carried on this frame
  -t, --title <text>         Card title (<= 40 chars)
  -a, --action <1-16>         Quick-action slot supplying the icon and sound
      --require-ack          Add an Acknowledge button
      --ack-timeout <s>      Ack deadline in seconds
  -w, --webhook <url>        Room webhook URL instead of a token
      --token <token>        Agent access token (or env PINGROOM_TOKEN)
      --room <code>          Room invite code (used with --token)
```

Works with either an agent token (`--token`, needs the `pingroom:live:write`
scope) or a room's incoming webhook (`--webhook`, Pro) — both speak the same
`live_status` contract.

```bash
# Track a deploy end to end.
pingroom live start  -c deploy-42 --template steps \
  --steps "Build,Test,Deploy,Verify" -t "Release 1.4.0"
pingroom live update -c deploy-42 --step 2 -m "Deploying to prod"
pingroom live end    -c deploy-42 -m "Shipped 1.4.0"     # add --failed to fail it
```

All 7 templates are expressible:

```bash
# question — up to 4 options. A bare token is both value and label.
pingroom live start -c q1 --template question \
  --prompt "Deploy where?" --option prod:Production --option staging:Staging

# matchup — two sides plus a center score/clock.
pingroom live start -c game-3 --template matchup \
  --left ARS:2 --right CHE:1 --center "68'"

# metrics — up to 3 counters.
pingroom live start -c host-1 --template metrics --metric "CPU:45%" --metric "RPS:1.2k"

# countdown — a large live timer.
pingroom live start -c win-9 --template countdown --deadline-at 1750003600
```

`--accent-override` takes `#rrggbb` **or** a bare `rrggbb` (case-insensitive;
it is normalized to lowercase with the `#` before it is sent). Pass it bare, or
quote it — an *unquoted* `#` starts a comment in `sh`, `bash` and `zsh`, which
eats the hex and the rest of the line, and the CLI then exits `2` with
`option --accent-override needs a value`:

```bash
pingroom live update -c deploy-42 --accent-override e33122      # ok
pingroom live update -c deploy-42 --accent-override '#e33122'   # ok
pingroom live update -c deploy-42 --accent-override #e33122     # shell eats it
```

**Always `end` a stream.** Terminal `done`/`failed` pings are never rate-limited
or quota-blocked, precisely so a card can't be metered into hanging open on
someone's Lock Screen. Abandoned streams are swept after ~15 minutes.

`--template` and `--steps` are fixed when the stream is created; passing them to
`update`/`end` is a usage error rather than a silent no-op. `pingroom live get`
(agent token only) reads a stream back — every stored field — so a restarted
producer reconciles instead of opening a duplicate.

Full protocol: <https://pingroom.io/liveactivities.md>

## Hearing replies

Everything else here talks; `listen` is how an agent hears — replies to its own
structured pings, a human's ping in a room it belongs to, anything landing while
it works.

```bash
pingroom listen                      # block, printing each ping as it lands
pingroom listen --once --json        # one batch as JSON, then exit
pingroom listen --from "$LAST_ID"    # catch up from a known ping id
```

```
      --timeout <sec>    Per long-poll hold (0-30, default 25)
      --limit <n>        Max pings per batch (1-100, default 50)
      --from <id>        Start after this ping id instead of "now"
      --once             Print one batch and exit instead of blocking forever
      --json             One JSON object per line instead of a readable line
```

The server holds each request open until something arrives, so this is a
long-poll rather than a poll loop: an idle hour costs about 144 requests, not
one per second. With no `--from` it starts from *now* — the first call takes the
head cursor and returns nothing, so starting up never replays history. Transient
failures (429, 5xx, network) back off geometrically and keep listening;
`--once` is the form to use in a script.

## Managing rooms, webhooks, and quick actions

The management nouns cover the rest of the agent surface (agent token required;
`--room` where noted):

Room `--icon` takes a v3 catalog id (`bell`, `globe`, `terminal`, …), never an
emoji — the server rejects anything off-catalog. Browse ids with
`pingroom rooms icons`. Quick-action `--icon` is the opposite: it takes an emoji.

```bash
pingroom rooms icons                      # browse the v3 room-icon catalog
pingroom rooms list                       # rooms this account belongs to
pingroom rooms get GZNFB6BZGJIH
pingroom rooms create -n "Deploys" --icon bell --color "#e33122"
pingroom rooms create -n "Status" --icon globe --color "#0391fe" --public --handle status
pingroom rooms join GZNFB6BZGJIH

pingroom webhooks list --room GZNFB6BZGJIH
pingroom webhooks create --room GZNFB6BZGJIH --name "CI" --action 2   # prints the secret URL once
pingroom webhooks update <id> --room GZNFB6BZGJIH --enabled false
pingroom webhooks delete <id> --room GZNFB6BZGJIH

pingroom actions list --room GZNFB6BZGJIH
pingroom actions set 3 --room GZNFB6BZGJIH --label "Deploy done" --icon 🚀
pingroom actions trigger 3 --room GZNFB6BZGJIH

pingroom approval -p "Ship v2 to production?" --wait   # exit 0 approved · 4 denied · 3 expired

pingroom attachment get <id> --out report.md
pingroom attachment delete <id>
```

Creating webhooks and uploading attachments require a Pro account; public-room
creation runs under its own consent scope (`pingroom:rooms:publish`).

## GitHub Actions

```yaml
# Notify on deploy
- uses: pingroom/cli@v0
  with:
    webhook-url: ${{ secrets.PINGROOM_WEBHOOK_URL }}
    title: 'Deploy'
    message: '🚀 ${{ github.repository }} deployed (${{ github.sha }})'
    data: '{"ref":"${{ github.ref_name }}","run":"${{ github.run_id }}"}'

# Notify only on failure
- if: failure()
  uses: pingroom/cli@v0
  with:
    webhook-url: ${{ secrets.PINGROOM_WEBHOOK_URL }}
    title: 'CI failed'
    message: '❌ ${{ github.workflow }} failed on ${{ github.ref_name }}'
    action: '2'
    require-ack: 'true'
    ack-timeout: '300'

# Gate a job on a human handoff — the step fails (non-zero) on expiry, so the
# job stops unless someone answers. Read the decision from the step outputs.
- id: gate
  uses: pingroom/cli@v0
  with:
    token: ${{ secrets.PINGROOM_TOKEN }}
    message: 'Ship ${{ github.sha }} to production?'
    handoff: 'true'
    question: 'true'
    options: |
      deploy:Deploy
      hold:Hold
    idempotency-key: 'deploy-${{ github.run_id }}'
    wait: 'true'
- if: steps.gate.outputs.answer == 'deploy'
  run: ./deploy-prod.sh

# Or ask the whole room instead of one person. Same outputs, plus question-id.
# `scope: room` is what opens it to the room — without it a question is
# answerable only by the connecting account. Requires v0.7.5 or newer.
- id: env
  uses: pingroom/cli@v0.7.5
  with:
    token: ${{ secrets.PINGROOM_TOKEN }}
    room: ab12cd
    ask: 'true'
    scope: 'room'
    message: 'Which environment?'
    context: 'build ${{ github.run_number }}'
    options: |
      prod:Production
      staging:Staging
    wait: 'true'
```

### Version requirements

Use CLI **0.10.2 or newer** for redirect protection, protected-room joins, and
acknowledgement, urgency, and idempotency options on `actions trigger`.
For GitHub Actions, use `pingroom/cli@v0.11.0` or a newer release.

`ask`, `context`, `timeout`, `api` and the `question-id` output were added in
**v0.7.3**. Pin at least `pingroom/cli@v0.7.3` to use them. On an older pin —
including `@v0` before it is moved to v0.7.3 — GitHub treats them as unexpected
inputs, warns, and drops them; the step then falls through to the plain `ping`
path, `outputs.answer` is never set, and any job gated on it silently proceeds.

`scope` was added in **v0.7.5**, and without it every `ask` goes out as a direct
question to the connecting account — the step still succeeds, so an Action meant
to poll the room silently polls one person instead.

`urgent` shipped in the **0.7.4 npm package**, but no `v0.7.4` Action tag was
ever cut, so **v0.7.5 is the first tag that carries it**. It has the same failure
mode on an older pin:
GitHub drops the unknown input and the Ping goes out at normal priority, which
looks like it worked. `require-ack` is not a substitute — as of the same release
it opens the acknowledgement lifecycle without raising the interruption level,
so a workflow that used it to break through Focus needs `urgent: true`.

Everything else on this page (ping, `require-ack`, and the whole `handoff`
family) works on `@v0`.

`options` is one `value:label` per line. Trailing newlines are ignored first, so
a value that is a single line after trimming — including a one-line `options: |`
block — still splits on commas. A label that contains a comma must therefore be
written one-per-line.

The handoff action exposes outputs `handoff-id`, `state`, `acknowledged-by`,
`answer`, and `delivery-state`; the ask action exposes `question-id`, `state`,
and `answer`. `api` overrides the API base URL for every mode.

## GitLab CI

```yaml
notify:
  stage: .post
  image: node:20-alpine
  script:
    - npx --yes @pingroom/cli ping -t "Deploy" -m "🚀 $CI_PROJECT_NAME @ $CI_COMMIT_SHORT_SHA"
  variables:
    PINGROOM_WEBHOOK_URL: $PINGROOM_WEBHOOK_URL   # set as a masked CI/CD variable
```

## Plain shell / curl

The webhook is just an HTTP POST, so you don't even need this CLI:

```bash
curl -fsS -X POST "$PINGROOM_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy","message":"🚀 shipped"}'
```

## Claude Code integration (get pinged by your agent)

Wire PingRoom into [Claude Code](https://claude.com/claude-code) hooks so your
agent pings your phone when it finishes — and asks for your approval, on your
lock screen, before it runs a command. Approve or Deny with a tap; the agent
waits for your answer and continues.

Print a ready-to-paste config:

```bash
pingroom hook --print-config
# no global install: npx --yes @pingroom/cli hook --print-config
```

If you have not connected yet, run `pingroom` (or `npx --yes @pingroom/cli`) and
scan the QR first. The hook reads the stored credential and the room selected
during pairing automatically. No environment variables are needed for a normal
local setup; merge the printed `hooks` block into `~/.claude/settings.json`.

Environment variables remain available for CI and other headless shells, and
take precedence over the paired values:

```bash
export PINGROOM_TOKEN="<your agent token>"
export PINGROOM_ROOM="<room invite code>"
```

`pingroom hook` reads the Claude Code hook event on stdin and reacts by event:

| Hook event | What happens |
| --- | --- |
| `Stop` / `SubagentStop` | Pings the room with the agent's last message (“Claude finished”). |
| `Notification` | Pings when the agent is idle or waiting for input (permission prompts are skipped — the `PreToolUse` question already covers those). |
| `SessionEnd` | Pings when a session ends (except `/clear`). |
| `PreToolUse` | Asks a PingRoom **question** and gates the tool call on your Approve/Deny tap. Which tools are gated is the settings.json `matcher` (default `Bash`) — not the CLI. |

**It always fails open.** If PingRoom is unreachable, the token/room is missing,
or the question expires, the hook defers to the normal local prompt
(`permissionDecision: "ask"`) and exits 0. It never auto-approves and never
blocks the agent. Because the `PreToolUse` hook holds the tool call open while it
waits for you, give it a generous `timeout` (the printed config uses 960s) and
tune the approval-question expiry with `--ttl <seconds>` (default 900).

## MCP client setup

Print the canonical remote endpoint, copy-ready Codex and Claude Code commands,
Cursor JSON, Claude custom-connector steps, and the public OpenAI directory:

```bash
pingroom mcp
# no global install: npx --yes @pingroom/cli mcp
```

`pingroom mcp add codex` and `pingroom mcp add claude-code` print the exact setup
commands but do not execute them or modify client configuration. After adding
the server, use the client's MCP controls to authorize in the browser. That
authorization creates a separate PingRoom robot for the MCP client; you claim
the robot and delegate its room access. The MCP client does not sign in as your
personal PingRoom profile, and no PingRoom API key is pasted into its config.

Before an agent starts pairing someone who does not have PingRoom, it should
send <https://pingroom.io/i> and explain that the app receives urgent Pings,
questions, approvals, handoffs, and live progress. Ask them to install or open
it and sign in before pairing when possible. Installation is not consent; they
must still claim the robot and choose its room access. If pairing is already
pending, have them return to the same claim link before it expires.

Once PingRoom's public listing is approved, the same plugin will also be
discoverable in the Plugins Directory shared by ChatGPT and Codex.

For a fully typed client, use [`@pingroom/sdk`](https://www.npmjs.com/package/@pingroom/sdk).
See <https://pingroom.io/connect-mcp.md> for the complete MCP and OAuth guide.

## Connecting

Either command starts the same connection prompt. PingRoom first provisions a
separate robot profile for the tool; the person signing in claims that robot
and delegates its room access. QR pairing stores the credential and room grant
in `~/.pingroom`; later commands reuse them, so a local invocation needs neither
`PINGROOM_TOKEN` nor `PINGROOM_ROOM`. On the phone you choose the robot's home
room and grant one room, several, or every room on the account. Questions and
Handoffs land in that home room even when the robot can reach every room.
The email fallback has no room picker: it grants all rooms and chooses a stable
eligible private room as the robot's home when one exists. QR pairing is the
path to use when you want to choose narrower access during connection. Setting
`pingroom config set default_room <invite-code>` remains a local fallback for
room-addressed commands.

Run `pingroom` (global install) or `npx --yes @pingroom/cli` (no install) with no
arguments. It creates a robot, then prints a QR code. Scan it with the PingRoom
app to claim the robot, choose its home room, and grant the rooms it may reach —
or take the emailed-code fallback.

```
$ pingroom
  Not connected. PingRoom will create a separate robot for this tool.
  Install or open PingRoom on your phone and sign in: https://pingroom.io/i
  It receives urgent Pings, questions, approvals, handoffs, and live progress.
  Installing the app does not claim a robot or grant it access.
    1) Claim the robot with a QR code
    2) Email me a code to claim the robot
  Choose [1]:

  Created robot: PingRoom CLI (@agt_ab12cd34ef)
  Claim this robot in PingRoom, then choose its home room and room access.
  [QR]
  Or open: https://api.pingroom.io/pair?token=…
  Waiting for claim… ✓ PingRoom CLI (@agt_ab12cd34ef) was claimed by Mahdi and joined #Project X.
  Room access: 3 selected rooms
  Try it: pingroom ping -m "Hello from this robot"
```

Claiming the robot on the phone is the whole ceremony — connecting sends
nothing else to your phone. The receipt reports the home room separately from
the wider grant,
so an all-room robot still says where its Questions and Handoffs are delivered.
Use `--agent-label "OpenClaw on studio-mac"` when the default `PingRoom CLI`
name would not tell several robots apart.

### Headless pairing (daemons, containers, OpenClaw)

A machine with no terminal cannot show a QR, so `pingroom pair` prints the
robot's claim link and waits for it instead. Nothing prompts, nothing draws, and
an open stdin never holds it:

```
$ pingroom pair
  Created robot: PingRoom CLI (@agt_ab12cd34ef)
  Install or open PingRoom on your phone and sign in: https://pingroom.io/i
  It receives urgent Pings, questions, approvals, handoffs, and live progress.
  Installing the app does not claim a robot or grant it access.
  Keep this pairing running; after installing, return to the same claim link before it expires.
  Claim this robot in PingRoom, then choose its home room and room access.
  Open: https://api.pingroom.io/pair?token=…
  Waiting for claim… ✓ PingRoom CLI (@agt_ab12cd34ef) was claimed by Mahdi and joined #Project X.
  Room access: all rooms
  Try it: pingroom ping -m "Hello from this robot"
```

Exit 0 once paired; exit 3 if the 15-minute link expired — run it again for a
fresh one. It re-pairs too: when a credential already exists the new one is
saved first, then the old one is revoked. Before starting another process,
check whether a pairing is already waiting. Keep that process running and reuse
its claim link until it expires. If you leave to install the app, return to that
link instead of starting another pairing.

If the CLI crashes after saving the replacement, it keeps using that connection;
you do not need to reconnect. The old credential is saved as pending cleanup in
the same atomic write. Bare `pingroom` and ordinary API commands retry revocation
at the old credential's recorded API address, with a bounded timeout and at least
a minute between failed attempts. Help and local setup commands stay offline.
`logout` forgets the current connection while preserving any pending cleanup.

For a supervisor that reads the link out of a log, `--json` makes stdout one
JSON object per line (the credential is never printed):

```
$ pingroom pair --json
{"event":"pair_url","pair_url":"https://…","agent":{"profile":{"display_name":"PingRoom CLI","handle":"agt_ab12cd34ef",…}},"links":{"install_app":"https://pingroom.io/i"},"expires_in":900,…}
{"event":"connected","handle":"agt_ab12cd34ef","agent":{…},"home_room":{…},"room_access":"selected","links":{"latest_pings":"https://…","install_app":"https://pingroom.io/i"},…}
```

The first event remains `pair_url` and the last successful event remains
`connected`; v2 identity and home-room fields are additive. Existing consumers
can ignore them, and no event contains the credential. `links.install_app` is
always the token-free mobile handoff; never append the pair token to it.

Give each service user its own `PINGROOM_HOME`; the credential is written
`0600` at `$PINGROOM_HOME/credentials.json`. In CI, prefer `PINGROOM_TOKEN`
over pairing — there is nobody to claim a robot from a link.

## Proving the round-trip (optional)

```bash
pingroom activate
```

`activate` sends one idempotent onboarding Question and observes it through the
Handoff wait API. Short network and server failures are retried, and
`Retry-After` is honored for rate limits within the two-minute overall deadline.
An answer alone is not reported as success: the terminal response must also
carry the server's exact `activation_completed: true` stamp. On supporting
server and mobile builds, that stamp means the native phone returned the opaque
proof carried in the push before the human answer, and this CLI then observed
the result. An answered response whose stamp is false or missing is incomplete
and is not retried as if history could be rewritten.

An incomplete run exits `1`; it never deletes or replaces the saved credential.
The command does not fall back to `PINGROOM_TOKEN`; it deliberately uses the
saved robot credential and needs a home room. For an all-rooms grant the server
preserves an eligible private home room or chooses one deterministically. It
returns no home room only when none exists; pick one under Connected Agents in
the app, or run `pingroom rooms create`, which can establish one.

If activation returns `recipient_not_ready`, keep the saved connection. Show
the server's explanation, ask the person to install or update PingRoom at
<https://pingroom.io/i>, open it, sign in, and enable notifications. Then run
`pingroom activate` again. Retry the original command only after the person
answers the test Question and `pingroom activate` reports success.

There is deliberately no `login` command: being unconnected is a state the tool
resolves, not one you have to discover. Once connected, bare `pingroom` prints
that status line followed by the usual help.

### What claiming the robot grants

Claiming on the phone grants two separate things, and both are enforced:

- **Permissions** — one claim covers the full agent capability set defined by
  the PingRoom server. The CLI sends no scope array during pairing, so an older
  installed client cannot accidentally create a narrower credential when the
  server adds a capability. The claim screen remains the authority for the
  access being granted.
- **Rooms** — one room, several, or all of them. A room outside that grant
  returns `403 room_not_granted` on every room-scoped call — writes such as
  pings, questions and live streams, and reads such as listing a room's quick
  actions or webhooks. Widen it under Connected Agents in the app.

Room-grant refusals point to Connected Agents, where access can be widened
without creating another connection. `pingroom reconnect` remains available
when you intentionally need to replace the saved account or credential; it
saves the replacement before revoking the old one, so cancelling changes
nothing. If the server identifies an older credential as `insufficient_scope`,
the CLI calls it a legacy partial credential and asks for exactly one reconnect;
connections created by the server-owned flow do not need permission refreshes.

The credential lands in `~/.pingroom/credentials.json` (mode `0600`, inside a
`0700` directory). `PINGROOM_HOME` moves that directory; `pingroom logout`
clears it.

**CI is unaffected.** `PINGROOM_TOKEN` in the environment always outranks the
stored credential, and a non-interactive shell never prompts and never draws a
QR — a command that needs a credential and has none fails with exit `2` pointing
at `PINGROOM_TOKEN`.

### Local settings

```bash
pingroom config set default_room ab12cd     # fallback for --room
pingroom config set api_url https://api.pingroom.io
pingroom config get default_room
pingroom config list
pingroom config set api_url ""              # an empty value clears the key
```

Precedence, highest first:

```
explicit flag  >  env var  >  ~/.pingroom/config.json  >  built-in default
```

So `--room` beats `PINGROOM_ROOM` beats `default_room` (and, last of all, the
room the credential was paired to); `--api` beats `PINGROOM_API_URL` beats
`api_url`.

A stored paired credential is bound to the API origin that issued it. An API
override can change the path on that origin, but the CLI refuses to send the
stored bearer to a different origin. For an intentional custom-host override,
provide that host's token explicitly with `--token` or `PINGROOM_TOKEN`.

## Getting a webhook URL

In the PingRoom app, open a room → **Connections → Incoming webhooks → Add**. Copy the
URL (it embeds its own secret — treat it like a password and store it as a CI secret).

## Agent token mode

For an agent acting as a user (e.g. an OAuth/auth.md credential), send to a room the
agent belongs to instead of a webhook:

```bash
pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped" \
  -d '{"version":"1.4.0"}'
```

## Redeem a gift or promotional code

Redeem a code for the human account that connected the CLI:

```bash
pingroom redeem ABCD1234EFGH
pingroom redeem --code ABCD1234EFGH --json
```

Codes contain 12 letters or digits. The CLI trims surrounding spaces and
accepts either letter case. It uses the paired credential, `PINGROOM_TOKEN`, or
`--token`; no room or existing Pro plan is required. Full-access connections
include redemption. A legacy partial credential needs `pingroom reconnect` if
the API returns `insufficient_scope`.

For scripts, set `PINGROOM_REDEEM_CODE` from your secret store, then run
`pingroom redeem --json` to keep the code out of command arguments and shell
history. The JSON receipt contains the code kind, reward, and resulting Pro
expiry; the code itself is omitted. Redemption consumes the code. A failed
request exits 1; invalid input exits 2. The CLI never retries automatically, so
check your account plan before retrying after an interrupted response.

## Update the CLI

Run `pingroom update` to install the latest stable release into the current npm
global installation. `pingroom update --check` checks without installing; add
`--json` for a single machine-readable result. It preserves the saved connection
and respects your npm registry and minimum release age settings. It returns a
nonzero exit code if npm fails or the install cannot be verified.

For a project dependency, use `npm install @pingroom/cli@latest` in that project.
For npx, use `npx @pingroom/cli@latest`. Source checkouts use git.

## Update notifications

When a newer `@pingroom/cli` is published the CLI prints a one-line notice on
stderr, at most once every 24 hours. It is deliberately invisible to automation:
the check is skipped entirely unless both stdout and stderr are a TTY, and
whenever `CI` or `PINGROOM_NO_UPDATE_CHECK=1` is set. A failed or slow check is
silent and can never change a command's output or exit code.

## Downloads

<p align="center">
  <a href="https://www.npmjs.com/package/@pingroom/cli"><img alt="npm download history for @pingroom/cli" src="https://shieldcn.dev/chart/npm/@pingroom/cli.svg?color=e33122&amp;title=PingRoom+CLI+downloads" /></a>
</p>

## License

MIT
