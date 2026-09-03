// All --help output. One section per command plus intro/shared/tail, so
// `pingroom <command> --help` can print a focused excerpt (see commandHelp) and
// `pingroom --help` still prints the historical single blob.
//
// Nothing here is decorative: the subprocess tests assert this text verbatim.

import { BUILTIN_API, DEFAULT_API } from './constants.js';

// The help text lives as one section per command plus intro/shared/tail, so
// `pingroom <command> --help` can print a focused excerpt (see commandHelp).
// The full HELP below joins them in the historical order — `pingroom --help`
// output is byte-identical to the pre-split single blob.
export const HELP_INTRO = `pingroom — send a ping, or ask a human a question, from CI/scripts/agents

Usage:
  pingroom <command> [options]

Commands:
  ping     Send a ping to a room (webhook URL, or agent token + room)
  ask      Ask a human a question; with --wait, block until they answer
  watch    Block until a question resolves and print the outcome (alias: await)
  list     List the agent's questions by state
  cancel   Withdraw a pending question
  handoff  Hand a decision (ack or question) to a specific human; with --wait,
           block until they acknowledge or answer
  handoffs List the agent's open handoffs or bounded recent history
  listen   Block on pings arriving in your rooms and print them as they land
  live     Drive a live progress card on the lock screen (Live Activity)
  hook     Claude Code hook: ping on Stop/Notification, and route tool
           permission prompts to a PingRoom question you answer from your phone
  mcp      Print the remote MCP endpoint and setup for Claude Code, Codex,
           Cursor, and Claude Desktop
  skills   List the PingRoom agent skills, or install them for Claude Code
  activate Retry Agent Inbox activation with the saved robot credential
  rooms    List, inspect, create, or join rooms; browse the icon catalog
           (rooms list|get|create|join|icons)
  webhooks Manage a room's incoming webhooks (webhooks list|create|update|delete)
  actions  List, configure, or trigger a room's quick actions (actions list|set|set-all|trigger)
  approval Send an approve/deny request; with --wait, block on the decision
  attachment Download or delete an attachment by id (attachment get|delete)
  config   Read/write local settings (config list | get <key> | set <key> <val>)
  reconnect Create and claim a replacement robot, then revoke the old credential
  pair     Pair without a terminal: create a robot, print its claim link, wait
  logout   Forget the stored credential`;

export const HELP_PING = `ping options:
  -m, --message <text>   Ping body (required; <= 120 private / <= 160 public)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data object, e.g. '{"commit":"abc123"}'
      --url <https-url>  Make the ping a tappable link (absolute http(s) URL)
      --button-label <t> Link button text (<= 26 chars; requires --url)
      --location <lat,lng>  Attach a map location (latitude,longitude)
      --location-label <t>  Location label (<= 100 chars; requires --location)
      --location-address <t> Address (<= 255 chars; requires --location)
      --urgent           Deliver time-sensitive so it breaks through Focus / Do Not
                         Disturb. Delivery only - asks nothing of the recipient
      --require-ack      Keep the ping open until an eligible recipient acknowledges it,
                         showing a lock-screen card with an Acknowledge button. Does
                         not raise the interruption level; combine with --urgent
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
      --attach <path>    Attach a file (md/pdf/html/txt/jpg/jpeg/png/zip, <= 5 MiB);
                         repeat for up to 4. Requires --token and a Pro account
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)`;

export const HELP_ASK = `ask options (agent token required):
  -p, --prompt <text>    The question a human reads (required)
  -o, --option <v:label[:style]>
                         An answer option (style: primary|danger|default);
                         repeat for 2–4. Omit for Approve/Deny
  -c, --context <text>   Secondary line, e.g. a build number (<= 40 chars)
      --scope <s>        Who answers: 'direct' (default) or 'room'
      --target <uuid>    For --scope direct: a specific room member
      --ttl <seconds>    Expiry; omit for the server default (1h; 30..86400)
      --idempotency-key <key>  Dedupe this exact create request across retries
      --text-input <ph>  Invite a short typed answer; <ph> is the placeholder
      --text-max <n>     Max typed-answer length (1..60)
      --wait             Block until answered/expired/cancelled
      --timeout <sec>    Per long-poll hold with --wait/watch (0–30, default 25)
  -d, --data <json>      Structured data object echoed back on the answer
      --correlation-id <id>  Opaque id echoed on every read of this question
      --reply-to <id>    Id of the ping this question replies to
      --room <code>      Room invite code (required for ask)
      --expected-room-sha256 <hex>
                         Fail unless the resolved room matches this SHA-256
      --github-output <path>  Safely append question outputs for GitHub Actions`;

export const HELP_LIST = `list options:
      --state <s>        pending | answered | expired | cancelled | all`;

export const HELP_HANDOFF = `handoff options (agent token required; consent scope pingroom:handoffs:create):
  -m, --message <text>   The prompt a human reads (required)
      --question         Make it a question (else a simple acknowledge). Also
                         implied whenever one or more --option is given.
  -o, --option <v:label> A question option; repeat for 2–4. Requires --question.
      --target <id>      Recipient: 'me' (default) or a specific user uuid
      --expires-in <s>   Expiry in seconds (120..86400, default 900)
      --urgency <u>      'active' (default) or 'passive'
      --idempotency-key <key>  Dedupe key; retries reuse it (Idempotency-Key)
      --correlation-id <id>    Opaque id echoed on every read of this handoff
      --reply-to <id>    Opaque reply-to id echoed back
  -d, --data <json>      Structured data object echoed on the handoff
      --wait             Block until acked / answered / expired / cancelled
      --timeout <sec>    Per long-poll hold with --wait (0–20, server caps 25)
      --github-output <path>  Safely append handoff outputs for GitHub Actions`;

export const HELP_HANDOFFS = `handoffs options (agent token required; consent scope pingroom:handoffs:create):
      --state <s>        open | all (default open)`;

export const HELP_LISTEN = `listen options (agent token required; consent scope pingroom:notifications:read):
      --timeout <sec>    Per long-poll hold (0-30, default 25)
      --limit <n>        Max pings per batch (1-100, default 50)
      --from <id>        Start after this ping id instead of "now"
      --once             Print one batch and exit instead of blocking forever
      --json             One JSON object per line instead of a readable line`;

export const HELP_LIVE = `live <start|update|end|get> options (agent token, or a room webhook):
  -c, --correlation-id <id>  The stream key — reuse it for every ping (required)
      --template <name>      start only: status | steps | progress | metrics |
                             countdown | decision | matchup (fixed at creation;
                             'decision' is the app's name for the wire id
                             'question', which is still accepted)
      --category <name>      start only: status | steps | alert. Legacy, but
                             'alert' has no template equivalent and is the only
                             way to start a stream time-sensitive
      --steps <a,b,c>        start only: 2-8 comma-separated step labels
  -m, --message <text>       The card's live message line
      --progress <0..1>      Progress bar / Dynamic Island gauge
      --step <n>             Current step index (steps template)
      --metric <label:value> Repeatable, up to 3 (metrics template)
      --deadline-at <epoch>  Countdown target (countdown template)
      --eta-at <epoch>       Live ETA (status/progress templates)
      --prompt <text>        The ask (decision template)
      --option <value:label> Repeatable, up to 4 (decision template). A bare
                             token is both value and label
      --left <label:value>   Left side (matchup template)
      --right <label:value>  Right side (matchup template)
      --center <text>        Center score/clock, <= 40 (matchup template)
      --accent-override <#rrggbb>  Semantic accent for this frame
      --failed               end only: finish as failed instead of done
  -d, --data <json>          Structured data object carried on this frame
  -t, --title <text>         Card title (<= 40 chars)
  -a, --action <1-4>         Quick-action slot supplying the icon and sound
      --require-ack          Add an Acknowledge button (does not raise the
                             interruption level; see --category alert)
      --ack-timeout <s>      Ack deadline in seconds
      --room <code>          Room invite code (used with --token)
  -w, --webhook <url>        Room webhook URL instead of a token`;

export const HELP_HOOK = `hook options (reads a Claude Code event; defaults to stored credentials/config):
      --room <code>      Room invite code (or env/config/paired room)
      --ttl <seconds>    Approval-question expiry for PreToolUse (default 900)
      --quiet            Suppress the informational stderr lines
      --print-config     Print a ready-to-paste ~/.claude/settings.json block`;

export const HELP_MCP = `mcp:
  pingroom mcp                     Print the endpoint and client setup snippets
  pingroom mcp add claude-code     Print the Claude Code setup command
                                   (output-only; does not change client config)
  pingroom mcp add codex           Print the Codex setup and login commands
                                   (output-only; does not change client config)

  Browser authorization creates a separate PingRoom robot for the MCP client.
  You claim that robot and delegate room access; it never signs in as your
  personal PingRoom profile.`;

export const HELP_SKILLS = `skills:
  pingroom skills                  List the published agent skills and every
                                   install route (output-only)
  pingroom skills install          Copy them into ~/.claude/skills (needs git)
      --dir <path>       Install somewhere other than ~/.claude/skills
      --force            Replace skills that are already installed`;

export const HELP_ACTIVATE = `activate:
  pingroom activate                Send one test Question to your phone to prove the
                                   saved robot credential works (optional —
                                   connecting no longer does this for you)`;

export const HELP_CONFIG = `config options:
  pingroom config list              Print the stored settings
  pingroom config get <key>         Print one setting
  pingroom config set <key> <val>   Store a setting (an empty value clears it)
  Keys: default_room, api_url`;

export const HELP_SHARED = `Shared:
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --api <url>        API base URL (default ${DEFAULT_API}; env PINGROOM_API_URL)
      --json             Print the raw JSON response
  -h, --help             Show this help
  -v, --version          Show the CLI version`;

export const HELP_TAIL = `Connecting:
  Install globally, then run with no arguments:
    npm install --global @pingroom/cli
    pingroom

  Or connect without installing globally:
    npx --yes @pingroom/cli

  It first creates a separate robot profile, then prints a QR code you scan with
  the PingRoom app. You claim that robot, choose its home room, and grant the
  rooms it may reach (one, several, or all of them). Once paired, it saves the
  credential and you are done; connecting sends nothing to your phone.
  Run "pingroom activate" if you want to prove the round-trip with one test
  Question. The emailed-code fallback grants all rooms and uses an eligible
  private room as the robot's home when one exists; QR lets you choose access.
  "config set default_room" enables room-addressed commands, but private
  Inbox/Handoff delivery requires QR pairing.
  There is no "login" command: being unconnected is a state the tool resolves,
  not one you have to discover.

  The credential is written to ~/.pingroom/credentials.json (mode 0600, in a
  0700 directory). PINGROOM_HOME overrides that directory. PINGROOM_TOKEN in the
  environment ALWAYS wins over the stored credential, so CI is unaffected.
  "pingroom logout" forgets it.

  Settings precedence, highest first:
    explicit flag  >  env var  >  ~/.pingroom/config.json  >  the paired
    credential  >  built-in default
  So --room beats PINGROOM_ROOM beats "config set default_room", and --api beats
  PINGROOM_API_URL beats "config set api_url" beats the host you paired against,
  beats ${BUILTIN_API}. A stored credential is bound to the origin it was paired
  against: an API override may change the path on that origin, but a different
  origin is refused before the token is sent. To target another origin
  intentionally, provide that host's token with --token or PINGROOM_TOKEN.

  Non-interactive shells (CI, pipes) never prompt and never draw a QR: set
  PINGROOM_TOKEN there, or run "pingroom pair" to pair a machine that has no
  terminal (it prints the robot's claim link and waits).

Examples:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
  pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped"

  # Link ping — a tappable button that opens a URL:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Build 512 ready" \\
    --url https://ci.example.com/builds/512 --button-label "Open build"

  # Location ping — recipients can share it or open it in a maps app:
  pingroom ping --room ab12cd -m "Meet me here" \\
    --location "25.2048,55.2708" --location-label "Dubai Mall"

  # Gate a deploy on a human tap — the chosen value prints to stdout:
  if [ "$(pingroom ask --token "$T" --room ab12cd --wait \\
        -p 'Deploy 1.4.0 to production?')" = approve ]; then ./deploy.sh; fi

  # Multi-option question, blocking:
  pingroom ask --token "$T" --room ab12cd --scope room --wait \\
    -p 'Which environment?' -o prod:Production -o staging:Staging

  pingroom list --token "$T" --state pending
  pingroom watch --token "$T" q_01H...   # block on an existing question
  pingroom cancel --token "$T" q_01H...

  # Hand a deploy decision to yourself and block on the acknowledgement:
  pingroom handoff --token "$T" -m "Prod deploy 1.4.0 — ack to proceed" --wait

  # A blocking question handed to a specific human; branch in CI on exit code:
  pingroom handoff --token "$T" -m "Ship 1.4.0?" --question \\
    -o deploy:Deploy -o hold:Hold --wait
  # -> exit 0 (answered, any value incl. 'hold'); 3 expired; 4 recipient-not-ready

  pingroom handoffs --token "$T" --state all   # recent history (up to 200/kind)

  # A live deploy card on everyone's lock screen — one stream, three calls:
  pingroom live start --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    --template steps --steps "Build,Test,Stage,Ship" -t "Deploy 2.1.0"
  pingroom live update --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    --step 2 -m "Smoke tests green"
  pingroom live end --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    -m "Live on production"
  # ...or end it as a failure, which still delivers one completion alert:
  #   pingroom live end ... --failed -m "Rollback triggered"

  # Connect Claude Code hooks to your paired credential (no env vars needed):
  pingroom hook --print-config

  # Connect an MCP client through browser OAuth (no API key needed):
  pingroom mcp

Security:
  Prefer the env vars (PINGROOM_WEBHOOK_URL / PINGROOM_TOKEN) over passing
  secrets as --webhook / --token flags: argv is visible to other users via the
  process table (ps) and may be captured in shell history. URLs must use https
  (loopback http is allowed for local dev).

  A paired credential is only sent to its recorded API origin. --api,
  PINGROOM_API_URL and config.api_url cannot redirect that stored bearer to a
  different origin; provide an explicit --token or PINGROOM_TOKEN to override.

Exit codes: 0 on success (answered / acked), 1 on error (network/auth/5xx),
2 on bad usage, 3 when a handoff or question expired, 4 when it was cancelled
or the recipient was not ready (409 recipient_not_ready). A question answered
with ANY value — including a negative one like 'hold' or 'deny' — exits 0: a
human decision is not an infrastructure failure.`;

export const HELP = [
  HELP_INTRO, HELP_PING, HELP_ASK, HELP_LIST, HELP_HANDOFF, HELP_HANDOFFS,
  HELP_LISTEN, HELP_LIVE, HELP_HOOK, HELP_MCP, HELP_SKILLS, HELP_ACTIVATE, HELP_CONFIG,
  HELP_SHARED, HELP_TAIL,
].join('\n\n');

// Sections for `pingroom <command> --help`. watch/cancel/logout have no block
// of their own in the full help, so they get a minimal one here.
export const COMMAND_HELP_SECTIONS = {
  ping: HELP_PING,
  ask: HELP_ASK,
  watch: `watch:
  pingroom watch <question-id>      Block until the question resolves and
                                    print the outcome
      --timeout <sec>    Per long-poll hold (0–30, default 25)`,
  cancel: `cancel:
  pingroom cancel <question-id>     Withdraw a pending question`,
  list: HELP_LIST,
  handoff: HELP_HANDOFF,
  handoffs: HELP_HANDOFFS,
  listen: HELP_LISTEN,
  live: HELP_LIVE,
  hook: HELP_HOOK,
  skills: HELP_SKILLS,
  activate: HELP_ACTIVATE,
  rooms: `rooms (agent token required):
  pingroom rooms list               List the rooms this account belongs to
  pingroom rooms get <code>         Show one room
  pingroom rooms icons              Browse the v3 room-icon catalog
  pingroom rooms create -n <name> --icon <id> --color <hex>
                                    Create a minimal private room.
                                    --icon is a v3 catalog id from "rooms icons"
                                    (e.g. bell), NOT an emoji;
                                    --public --handle <handle> creates a public
                                    room under its own consent scope, and is
                                    the only create that takes --description
  pingroom rooms join <code>        Join a room by invite code`,
  webhooks: `webhooks (agent token + --room required):
  pingroom webhooks list --room <code>
  pingroom webhooks create --room <code> --name <n>
                                    Optional: --title --message --icon --color
                                    --sound --action <1-4> --cooldown <sec>
                                    Prints the secret trigger URL once
  pingroom webhooks update <id> --room <code> [same fields, plus --enabled true|false]
  pingroom webhooks delete <id> --room <code>`,
  actions: `actions (agent token + --room required):
  pingroom actions list --room <code>
  pingroom actions set <1-4> --room <code> --label <text> --icon <emoji>
                                          (--label "" makes an emoji-only Ping)
                                    Optional: --sound, --require-ack
  pingroom actions set-all --room <code> --set <json> [--set <json> ...]
  pingroom actions set-all --room <code> --actions <json array>
  pingroom actions set-all --room <code> --actions -        (array on stdin)
                                    Writes up to 4 slots in ONE request, which
                                    wakes the room owner's device once instead
                                    of once per slot. Slots you leave out keep
                                    their current configuration - set-all never
                                    clears a Ping. Each object takes the same
                                    fields as "actions set" plus action_number:
                                      {"action_number":1,"label":"Deployed",
                                       "icon":"check","sound":"ting"}
  pingroom actions trigger <1-4> --room <code>`,
  approval: `approval (agent token + --room required):
  pingroom approval -p <prompt>     Send an approve/deny request
                                    Prints the id; --wait prints the decision
      -c, --context <text>   Secondary line (<= 40 chars)
      --ttl <seconds>        Expiry; omit for the server default
      --idempotency-key <k>  Safe replay of the create after a network failure
      --wait                 Block until the human decides
                             (exit 0 approve · 4 deny/cancelled · 3 expired)
      --timeout <0-30>       Seconds per long-poll while waiting (default 25)`,
  attachment: `attachment (agent token required):
  pingroom attachment get <id> [--out <path>]
                                    Download; bytes go to --out or stdout
  pingroom attachment delete <id>   Delete an unclaimed upload`,
  config: HELP_CONFIG,
  pair: `pair (no terminal required):
  pingroom pair                     Create a robot, print its PingRoom claim link,
                                    wait for a human to claim it on their phone,
                                    and save the credential. For daemons,
                                    containers, and agent runtimes with no TTY.
                                    Re-pairs when a credential already exists:
                                    the new one is saved first, then the old one
                                    is revoked.
                                    Exits 0 once paired, 3 if the link expired
                                    (run it again for a fresh one).
      --api <url>            API base URL (default https://api.pingroom.io)
      --agent-label <name>   Robot name shown before and during claim
      --json                 One JSON object per line on stdout:
                             {"event":"pair_url","pair_url":…,"agent":…}
                             first, then {"event":"connected","handle":…,
                             "links":{"latest_pings":…}}.
                             The credential is never printed.`,
  reconnect: `reconnect:
  pingroom reconnect                Create and claim a replacement robot, save
                                    its credential, then revoke the old robot's
                                    credential. Your existing connection keeps
                                    working until you claim the replacement,
                                    and cancelling changes nothing.
                                    Any other machine or CI job sharing the same
                                    credential will stop working once it is revoked.
      --api <url>            API base URL (default https://api.pingroom.io)
      --agent-label <name>   Name for the replacement robot`,
  logout: `logout:
  pingroom logout                   Forget the stored credential (PINGROOM_TOKEN
                                    in the environment is unaffected).
                                    This is LOCAL ONLY — the connection stays
                                    active on the server. To replace it, use
                                    "pingroom reconnect"; to end it, revoke it in
                                    PingRoom -> Settings -> Connected Agents.`,
};

// config and logout are local-only commands that reject --token/--api (and,
// for logout, --json), so their help gets a footer that only lists what they
// actually accept instead of the full shared block.
export const COMMAND_HELP_FOOTERS = {
  config: `Shared:
      --json             Print the raw JSON response
  -h, --help             Show this help`,
  logout: `Shared:
  -h, --help             Show this help`,
  // reconnect drives the QR pairing flow; a --token would have nothing to do
  // with the credential it is about to replace.
  reconnect: `Shared:
  -h, --help             Show this help`,
  // pair writes the stored credential, so --token is meaningless here too.
  pair: `Shared:
  -h, --help             Show this help`,
  // `skills` reaches GitHub, never the PingRoom API, so the shared credential
  // and --json flags would all be lies here.
  skills: `Shared:
  -h, --help             Show this help`,
};

// `<command> --help`: that command's section plus the shared flags, instead of
// the full reference `pingroom --help` / `pingroom help` still print.
export function commandHelp(name) {
  const section = COMMAND_HELP_SECTIONS[name];
  return section ? `${section}\n\n${COMMAND_HELP_FOOTERS[name] ?? HELP_SHARED}` : HELP;
}
