# @pingroom/cli

Send PingRoom pings — and ask a human a question and block for their answer —
from CI, scripts, and agents. Delivered as push straight to your phone.

Zero dependencies. Works anywhere Node ≥ 20 runs.

```bash
npx @pingroom/cli ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
```

Commands: `ping` (send), `ask` (ask a human), `watch` (block on an existing
question), `list`, `cancel`. Run `pingroom --help` for the full reference.

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
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)
      --api <url>        API base URL (env PINGROOM_API_URL)
      --json             Print the raw JSON response
```

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
```

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

For a fully typed client, use [`@pingroom/sdk`](https://www.npmjs.com/package/@pingroom/sdk).
See <https://pingroom.io/connect-mcp.md> to connect Cursor, Claude Desktop, or Claude Code.

## License

MIT
