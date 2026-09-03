// `mcp` — print the remote MCP endpoint and client setup. Output only: it never
// edits a client's configuration.

import { EXIT, INSTALL_APP_URL, MCP_ENDPOINT } from '../constants.js';
import { fail } from '../util.js';

export function mcp(rest) {
  const claudeCommand = `claude mcp add --transport http pingroom ${MCP_ENDPOINT}`;
  const codexAddCommand = `codex mcp add pingroom --url ${MCP_ENDPOINT}`;
  const codexLoginCommand = 'codex mcp login pingroom';

  if (rest.length === 0 || (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help'))) {
    const config = {
      mcpServers: {
        pingroom: { url: MCP_ENDPOINT },
      },
    };
    process.stdout.write(
`PingRoom MCP endpoint:
  ${MCP_ENDPOINT}

Claude Code:
  ${claudeCommand}

Codex CLI:
  ${codexAddCommand}
  ${codexLoginCommand}

OpenAI Plugins Directory (ChatGPT and Codex):
  Search for PingRoom after its public listing is approved.

Cursor JSON (~/.cursor/mcp.json):
${JSON.stringify(config, null, 2)}

Claude Desktop:
  Customize > Connectors > Add custom connector
  Name: PingRoom
  URL:  ${MCP_ENDPOINT}

Mobile app:
  Install or open PingRoom and sign in: ${INSTALL_APP_URL}
  It receives urgent Pings, questions, approvals, handoffs, and live progress.
  Installing the app does not authorize or claim an MCP robot.

After adding the server, use your client's MCP controls to authorize in the
browser. PingRoom creates a separate robot for that MCP client; you claim the
robot and choose the rooms it may reach. It acts with delegated room access —
it does not sign in as or impersonate your personal PingRoom profile. No API
key is needed.
This command only prints setup instructions and does not modify client config.
`);
    return EXIT.OK;
  }

  if (rest.length === 2 && rest[0] === 'add' && rest[1] === 'claude-code') {
    process.stdout.write(
`No client configuration was changed. Copy and run:
  ${claudeCommand}
`);
    return EXIT.OK;
  }

  if (rest.length === 2 && rest[0] === 'add' && rest[1] === 'codex') {
    process.stdout.write(
`No client configuration was changed. Copy and run:
  ${codexAddCommand}
  ${codexLoginCommand}
`);
    return EXIT.OK;
  }

  fail('usage: pingroom mcp [add claude-code|codex]', EXIT.USAGE);
}
