import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.mjs';

test('mcp prints the canonical endpoint and copy-ready client setup', () => {
  const { status, stdout, stderr } = run(['mcp']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /claude mcp add --transport http pingroom https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /codex mcp add pingroom --url https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /codex mcp login pingroom/);
  assert.match(stdout, /OpenAI Plugins Directory \(ChatGPT and Codex\)/);
  assert.doesNotMatch(stdout, /ChatGPT desktop app:/);
  assert.match(stdout, /"mcpServers"/);
  assert.match(stdout, /"pingroom": \{/);
  assert.match(stdout, /"url": "https:\/\/api\.pingroom\.io\/api\/agent\/mcp"/);
  assert.match(stdout, /Claude Desktop:/);
  assert.match(stdout, /Add custom connector/);
  assert.match(stdout, /Install or open PingRoom and sign in: https:\/\/pingroom\.io\/i/);
  assert.match(stdout, /urgent Pings, questions, approvals, handoffs, and live progress/);
  assert.match(stdout, /does not authorize or claim an MCP robot/);
  assert.match(stdout, /creates a separate robot for that MCP client/);
  assert.match(stdout, /does not sign in as or impersonate your personal PingRoom profile/);
  assert.match(stdout, /does not modify client config/);
});

test('mcp add codex remains safe and output-only', () => {
  const { status, stdout, stderr } = run(['mcp', 'add', 'codex']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /No client configuration was changed/);
  assert.match(stdout, /codex mcp add pingroom --url https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /codex mcp login pingroom/);
});

test('mcp add claude-code remains safe and output-only', () => {
  const { status, stdout, stderr } = run(['mcp', 'add', 'claude-code']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /No client configuration was changed/);
  assert.match(stdout, /claude mcp add --transport http pingroom https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
});
