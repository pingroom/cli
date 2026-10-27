import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { run, newHome, seedCredential } from './helpers.mjs';

test('bare pingroom prints the connected status, old-server latest-pings fallback, and help', () => {
  const home = newHome();
  seedCredential(home, {
    token: 'stored_tok',
    handle: 'agt_ab12cd34ef',
    room: { invite_code: 'ABC123', name: 'Project X' },
    api_url: 'https://api.pingroom.io',
  });
  try {
    const { status, stdout } = run([], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.match(stdout, /Robot @agt_ab12cd34ef is connected · home #Project X/);
    assert.match(stdout, /Latest pings API: https:\/\/api\.pingroom\.io\/api\/agent\/notifications\?limit=25&page=1/);
    assert.match(stdout, /Default room: ABC123/);
    assert.match(stdout, /pingroom — send a ping/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the status line reflects a grant wider than one room', () => {
  const cases = [
    {
      cred: { room_access: 'all', room: null, rooms: [] },
      expect: /Robot @agt_ab12cd34ef is connected · no home room · access all rooms/,
    },
    {
      cred: {
        room_access: 'all',
        room: { invite_code: 'ABC123', name: 'Project X' },
        rooms: [],
      },
      expect: /Robot @agt_ab12cd34ef is connected · home #Project X · access all rooms/,
    },
    {
      cred: {
        room_access: 'selected',
        room: { invite_code: 'ABC123', name: 'Project X' },
        rooms: [{ invite_code: 'ABC123', name: 'Project X' }, { invite_code: 'DEF456', name: 'Ops' }],
      },
      expect: /Robot @agt_ab12cd34ef is connected · home #Project X · access \+1 more/,
    },
  ];

  for (const { cred, expect } of cases) {
    const home = newHome();
    seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef', ...cred });
    try {
      const { status, stdout } = run([], { PINGROOM_HOME: home });
      assert.equal(status, 0);
      assert.match(stdout, expect);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('bare pingroom reports the env token instead of the stored credential', () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef' });
  try {
    const { status, stdout } = run([], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.equal(status, 0);
    assert.match(stdout, /Using the agent token from PINGROOM_TOKEN/);
    assert.match(stdout, /is ignored while it is set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-TTY: bare pingroom never prompts or draws a QR, and points at PINGROOM_TOKEN', () => {
  // spawnSync pipes both streams, so this is exactly the CI shape. It must
  // return immediately rather than block on an invisible prompt.
  const { status, stdout, stderr } = run([]);
  assert.equal(status, 0);
  assert.match(stderr, /not connected/);
  assert.match(stderr, /PINGROOM_TOKEN/);
  assert.match(stdout, /pingroom — send a ping/);
  assert.doesNotMatch(stdout, /[█▄▀]/);
  assert.doesNotMatch(stdout, /Choose \[1\]/);
});

test('non-TTY: a command needing a credential fails with the usage code, not a prompt', () => {
  for (const argv of [['ask', '--room', 'ab12cd', '-p', 'Deploy?'], ['handoff', '-m', 'Ship it']]) {
    const { status, stdout, stderr } = run(argv);
    assert.equal(status, 2, `${argv[0]} should be a usage error`);
    assert.match(stderr, /PINGROOM_TOKEN/);
    assert.doesNotMatch(stdout, /Choose \[1\]/);
  }
});
