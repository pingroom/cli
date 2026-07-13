# @pingroom/cli

Send PingRoom pings — and ask a human a question and block for their answer —
from CI, scripts, and agents. Delivered as push straight to your phone.

Zero dependencies. Works anywhere Node ≥ 20 runs.

```bash
npx @pingroom/cli ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
```

Commands: `ping` (send), `ask` (ask a human), `watch` (block on an existing
question), `list`, `cancel`, `handoff` (hand a decision to a specific human),
and `handoffs` (list open or recent Handoffs).
Run `pingroom --help` for the full reference.

## Getting a webhook URL

In the PingRoom app, open a room → **Connections → Incoming webhooks → Add**. Copy the
URL (it embeds its own secret — treat it like a password and store it as a CI secret).

## Usage

```
pingroom ping [options]

  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data, e.g. '{"commit":"abc123"}'
      --require-ack      Keep the ping open until an eligible recipient acknowledges it
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)
      --api <url>        API base URL (env PINGROOM_API_URL)
      --json             Print the raw JSON response
```

To make the ping actionable, add `--require-ack`. The first eligible recipient to
acknowledge it wins; `--ack-timeout` optionally expires it if nobody responds:

```bash
pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Production health check failed" \
  --require-ack --ack-timeout 300
```

Webhook timeouts accept 1–86400 seconds. Agent-token room pings accept
60–86400 seconds.

Exit codes: `0` success · `1` delivery failed · `2` bad usage. So CI fails loudly if a
ping doesn't land.

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
    options: 'deploy:Deploy,hold:Hold'
    idempotency-key: 'deploy-${{ github.run_id }}'
    wait: 'true'
- if: steps.gate.outputs.answer == 'deploy'
  run: ./deploy-prod.sh
```

The handoff action exposes outputs `handoff-id`, `state`, `acknowledged-by`,
`answer`, and `delivery-state`.

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

## Agent token mode

For an agent acting as a user (e.g. an OAuth/auth.md credential), send to a room the
agent belongs to instead of a webhook:

```bash
pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped" \
  -d '{"version":"1.4.0"}'
```

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

For a fully typed client, use [`@pingroom/sdk`](https://www.npmjs.com/package/@pingroom/sdk).
See <https://pingroom.io/connect-mcp.md> to connect Cursor, Claude Desktop, or Claude Code.

## License

MIT
