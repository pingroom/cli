import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  run, runAsync, startServer, questionServer, newHome, seedCredential, transportServer,
} from './helpers.mjs';

test('exit 0: ping -h prints the ping-focused help, not the full reference', () => {
  // `ping -h` routes through parseArgs -> args.help -> ping() returns 0, and
  // prints only the ping section plus the shared flags footer.
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  assert.match(stdout, /^ping options:/);
  assert.match(stdout, /-m, --message <text>/);
  assert.match(stdout, /--location <lat,lng>/);
  assert.match(stdout, /--item <text>/);
  assert.match(stdout, /Shared:/);
  assert.doesNotMatch(stdout, /pingroom — send a ping/);
  assert.doesNotMatch(stdout, /ask options/);
  assert.doesNotMatch(stdout, /Exit codes: 0 on success/);
});

test('exit 2: missing --message', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook']);
  assert.equal(status, 2);
  assert.match(stderr, /--message is required/);
});

test('exit 2: bad --action (out of range)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', '17']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: bad --action (non-numeric)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', 'foo']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: invalid --data JSON', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '{not json}']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be valid JSON/);
});

test('exit 2: --data is valid JSON but not an object', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '[1,2,3]']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be a JSON object/);
});

test('exit 2: --ack-timeout requires --require-ack', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--ack-timeout', '120']);
  assert.equal(status, 2);
  assert.match(stderr, /--ack-timeout requires --require-ack/);
});

test('exit 2: --ack-timeout needs a value', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /option --ack-timeout needs a value/);
});

test('exit 2: webhook --ack-timeout must be within 1–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout', '0',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 1 and 86400/);
});

test('exit 2: agent room --ack-timeout must be within 60–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '--token', 'tok', '--room', 'ab12cd', '--api', 'http://127.0.0.1:1',
    '-m', 'hi', '--require-ack', '--ack-timeout', '30',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 60 and 86400/);
});

test('exit 2: --button-label requires --url', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--button-label', 'Open']);
  assert.equal(status, 2);
  assert.match(stderr, /--button-label requires --url/);
});

test('exit 2: --url must be a valid absolute URL', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--url', '/relative/path']);
  assert.equal(status, 2);
  assert.match(stderr, /--url is not a valid URL/);
});

test('exit 2: --url must be http(s)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--url', 'ftp://example.com/x']);
  assert.equal(status, 2);
  assert.match(stderr, /--url must be an absolute http\(s\) URL/);
});

test('exit 2: --button-label over 26 chars', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi',
    '--url', 'https://example.com', '--button-label', 'x'.repeat(27),
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--button-label must be at most 26 characters/);
});

test('exit 2: location metadata flags require --location', () => {
  for (const [flag, value] of [
    ['--location-label', 'Office'],
    ['--location-address', '1 Main Street'],
  ]) {
    const { status, stderr } = run([
      'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', flag, value,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, new RegExp(`${flag} requires --location`));
  }
});

test('exit 2: --location requires exactly two finite numeric coordinates', () => {
  for (const value of ['25.2', '25.2,55.3,7', 'NaN,55.3', '25.2,Infinity', 'north,west']) {
    const { status, stderr } = run([
      'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--location', value,
    ]);
    assert.equal(status, 2, value);
    assert.match(stderr, /--location.*(?:exactly two|finite numbers)/, value);
  }
});

test('exit 2: --location enforces latitude and longitude ranges', () => {
  for (const [value, coordinate] of [['90.1,0', 'latitude'], ['0,-180.1', 'longitude']]) {
    const { status, stderr } = run([
      'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--location', value,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, new RegExp(`${coordinate} must be between`));
  }
});

test('exit 2: location display caps count Unicode characters', () => {
  const tooLong = [
    ['--location-label', '📍'.repeat(101), /at most 100 characters/],
    ['--location-address', '📍'.repeat(256), /at most 255 characters/],
  ];
  for (const [flag, value, expected] of tooLong) {
    const { status, stderr } = run([
      'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi',
      '--location', '0,0', flag, value,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, expected);
  }
});

test('exit 2: --token without --room', () => {
  const { status, stderr } = run(['ping', '--token', 'tok_abc', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /--room is required/);
});

test('exit 2: no credential (no webhook, no token)', () => {
  const { status, stderr } = run(['ping', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /provide a webhook .* or an agent token/);
});

// ---------------------------------------------------------------------------
// Exit 0 — successful delivery (stubbed server)
// ---------------------------------------------------------------------------

test('exit 0: successful webhook delivery', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'hello', '--require-ack', '--ack-timeout', '45',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'hello', requires_ack: true, ack_timeout_seconds: 45,
    });
  } finally {
    server.close();
  }
});

test('ping --json flushes a response larger than the pipe buffer before exiting', async () => {
  const receipt = JSON.stringify({ success: true, data: 'x'.repeat(256 * 1024) });
  const { server, baseUrl } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(receipt);
    });
  });
  try {
    const { status, stdout, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hello', '--json']);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, `${receipt}\n`);
  } finally {
    server.close();
  }
});

// Urgency and acknowledgement are independent flags. They used to be one, so
// `--urgent` must never smuggle `requires_ack` into the body, and
// `--require-ack` must never smuggle `is_urgent`.
test('ping --urgent sends is_urgent alone', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'prod is down', '--urgent']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0]), { message: 'prod is down', is_urgent: true });
  } finally {
    server.close();
  }
});

test('ping --require-ack does not imply is_urgent', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'confirm', '--require-ack']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0]), { message: 'confirm', requires_ack: true });
  } finally {
    server.close();
  }
});

test('ping sends both flags when both are asked for', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'ack me now', '--urgent', '--require-ack',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0]), {
      message: 'ack me now', requires_ack: true, is_urgent: true,
    });
  } finally {
    server.close();
  }
});

test('ping accepts the 160-character public-room ceiling and a 40-character title', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
  });
  try {
    const message = '🚀'.repeat(160);
    const title = 't'.repeat(40);
    const { status, stderr } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', message, '-t', title,
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(received, [{ message, title }]);
  } finally {
    server.close();
  }
});

test('exit 0: link ping folds --url/--button-label into data', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'build ready',
      '-d', '{"commit":"abc123"}',
      '--url', 'https://ci.example.com/b/512', '--button-label', 'Open build',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'build ready',
      data: { commit: 'abc123', url: 'https://ci.example.com/b/512', button_label: 'Open build' },
    });
  } finally {
    server.close();
  }
});

test('exit 0: webhook location flags replace raw data.location and preserve siblings', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status, stderr } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'meet here',
      '-d', '{"event":"lunch","location":{"latitude":1,"longitude":2,"stale":true}}',
      '--location', ' 25.2048, 55.2708 ',
      '--location-label', '📍'.repeat(100),
      '--location-address', '📍'.repeat(255),
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(received, [{
      message: 'meet here',
      data: {
        event: 'lunch',
        location: {
          latitude: 25.2048,
          longitude: 55.2708,
          label: '📍'.repeat(100),
          address: '📍'.repeat(255),
        },
      },
    }]);
  } finally {
    server.close();
  }
});

test('exit 0: --item builds data.checklist in order and replaces a raw data.checklist', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status, stderr } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'Groceries',
      '-d', '{"event":"shop","checklist":{"items":[{"text":"stale"}]}}',
      '--item', ' Milk ', '--item', '🥚'.repeat(80),
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(received, [{
      message: 'Groceries',
      data: {
        event: 'shop',
        checklist: { items: [{ text: 'Milk' }, { text: '🥚'.repeat(80) }] },
      },
    }]);
  } finally {
    server.close();
  }
});

test('exit 2: --item rejects blank, overlong, and more than 25 items', () => {
  const cases = [
    [['--item', '   '], /--item must not be empty/],
    [['--item', '🥚'.repeat(81)], /--item must be at most 80 characters/],
    [Array.from({ length: 26 }, (_, i) => ['--item', `x${i}`]).flat(), /at most 25 times/],
    // 25 x 80 non-Latin characters is ~4 KB of UTF-8 but ~12 KB under PHP's
    // escaped json_encode, which is what the server's 8 KB cap measures.
    [Array.from({ length: 25 }, () => ['--item', 'ش'.repeat(80)]).flat(), /at most 8 KB/],
  ];
  for (const [flags, pattern] of cases) {
    const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', ...flags]);
    assert.equal(status, 2, stderr);
    assert.match(stderr, pattern);
  }
});

test('an unknown room says so instead of a bare "Resource not found"', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    received.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Resource not found.' }));
    });
  });
  try {
    const { status, stderr } = await runAsync([
      'ping', '--token', 'tok_abc', '--room', ' #https://pgr.link/j/ab12cd ', '--api', baseUrl, '-m', 'hi',
    ]);
    assert.notEqual(status, 0);
    assert.equal(received[0], '/api/agent/rooms/ab12cd/notifications');
    assert.match(stderr, /No room with code ab12cd/);
    assert.match(stderr, /pingroom rooms list/);
  } finally {
    server.close();
  }
});

test('exit 0: successful agent-token delivery via --api override', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers['authorization'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'n1' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'ping', '--token', 'tok_abc', '--room', 'ab12cd', '--api', baseUrl,
      '-m', 'shipped', '-t', 'CI', '-a', '2', '-d', '{"version":"1.4.0"}',
      '--location', '-90,180',
      '--require-ack', '--ack-timeout', '300',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/notifications');
    assert.equal(received[0].auth, 'Bearer tok_abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'shipped', title: 'CI', action_number: 2,
      data: { version: '1.4.0', location: { latitude: -90, longitude: 180 } },
      requires_ack: true, ack_timeout_seconds: 300,
    });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Exit 1 — delivery failure
// ---------------------------------------------------------------------------

test('exit 1: HTTP error response from server', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'boom' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: boom/);
  } finally {
    server.close();
  }
});

test('exit 1: 200 OK but success:false in body', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'rejected' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: rejected/);
  } finally {
    server.close();
  }
});

test('exit 1: network error (connection refused)', () => {
  // Port 1 is privileged/unused -> fetch throws -> fail() defaults to code 1.
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi']);
  assert.equal(status, 1);
  assert.match(stderr, /network error/);
});

// ---------------------------------------------------------------------------
// ping --attach
// ---------------------------------------------------------------------------

test('help advertises the attachment type, size, and count contract', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /md\/pdf\/html\/txt\/jpg\/jpeg\/png\/zip, <= 5 MiB/);
  assert.match(stdout, /repeat for up to 4/);
});

test('file delivery uses the same room for an explicit code, pasted link, and paired default', async () => {
  const home = newHome();
  const file = join(home, 'report.txt');
  writeFileSync(file, 'room resolution regression');
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/attachments': () => ({ status: 201, body: { attachment: { id: 'att-1' } } }),
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'ping-1' } }),
  });
  seedCredential(home, { token: 'paired-token', api_url: baseUrl, room: { invite_code: 'ABC123' } });
  try {
    for (const roomArgs of [[], ['--room', 'ABC123'], ['--room', ' #ABC123 '], ['--room', 'https://pgr.link/j/ABC123']]) {
      const result = await runAsync(['ping', '-m', 'File ready', '--attach', file, ...roomArgs], { PINGROOM_HOME: home, PINGROOM_API_URL: undefined });
      assert.equal(result.status, 0, result.stderr);
    }
    const deliveries = received.filter((request) => request.path.endsWith('/notifications'));
    assert.equal(deliveries.length, 4);
    for (const request of deliveries) {
      assert.equal(request.path, '/api/agent/rooms/ABC123/notifications');
      assert.deepEqual(JSON.parse(request.body), { message: 'File ready', attachment_ids: ['att-1'] });
    }
    assert.equal(received.filter((request) => request.path.endsWith('/attachments')).length, 4);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--attach uploads each file as multipart and sends only the ids', async () => {
  const uploads = [];
  let pingBody = null;

  const { server, baseUrl } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    if (req.url === '/api/agent/attachments') {
      uploads.push({
        contentType: req.headers['content-type'],
        raw: raw.toString('latin1'),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ attachment: { id: `att_${uploads.length}` } }));
      return;
    }

    pingBody = JSON.parse(raw.toString('utf8'));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'n1' }));
  });

  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const notes = join(dir, 'notes.txt');
  const brief = join(dir, 'brief.md');
  const page = join(dir, 'page.html');
  const maxSize = join(dir, 'max-size.txt');
  writeFileSync(notes, 'private notes');
  writeFileSync(brief, '# brief');
  writeFileSync(page, '<p>status</p>');
  writeFileSync(maxSize, Buffer.alloc(5 * 1024 * 1024, 65));

  try {
    const { status } = await runAsync([
      'ping', '-m', 'report attached',
      '--attach', notes,
      '--attach', brief,
      '--attach', page,
      '--attach', maxSize,
      '--token', 'tok_abc', '--room', 'AB12', '--api', baseUrl,
    ]);

    assert.equal(status, 0);
    assert.equal(uploads.length, 4);
    // The runtime must own the boundary — a hand-set Content-Type breaks it.
    assert.match(uploads[0].contentType, /^multipart\/form-data; boundary=/);
    assert.match(uploads[0].raw, /filename="notes\.txt"/);
    assert.match(uploads[0].raw, /private notes/);
    assert.match(uploads[1].raw, /filename="brief\.md"/);
    assert.match(uploads[2].raw, /filename="page\.html"/);
    assert.match(uploads[3].raw, /filename="max-size\.txt"/);

    // Flag order is claim order, and no bytes ride the JSON ping body.
    assert.deepEqual(pingBody.attachment_ids, ['att_1', 'att_2', 'att_3', 'att_4']);
    assert.equal(pingBody.message, 'report attached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('--attach enforces the four-file and 5 MiB limits before uploading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-limits-'));
  const notes = join(dir, 'notes.txt');
  const oversized = join(dir, 'oversized.txt');
  writeFileSync(notes, 'private notes');
  writeFileSync(oversized, Buffer.alloc(5 * 1024 * 1024 + 1, 65));

  try {
    const tooManyArgs = ['ping', '-m', 'hi'];
    for (let i = 0; i < 5; i++) tooManyArgs.push('--attach', notes);
    tooManyArgs.push('--token', 'tok_abc', '--room', 'AB12', '--api', 'http://127.0.0.1:1');

    const tooMany = run(tooManyArgs);
    assert.equal(tooMany.status, 2);
    assert.match(tooMany.stderr, /--attach accepts at most 4 files/);

    const tooLarge = run([
      'ping', '-m', 'hi', '--attach', oversized,
      '--token', 'tok_abc', '--room', 'AB12', '--api', 'http://127.0.0.1:1',
    ]);
    assert.equal(tooLarge.status, 2);
    assert.match(tooLarge.stderr, /file exceeds the 5 MiB limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--attach rejects a webhook ping, an unsupported type, and a missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const binary = join(dir, 'payload.exe');
  const notes = join(dir, 'notes.txt');
  writeFileSync(binary, 'MZ');
  writeFileSync(notes, 'private notes');

  try {
    const webhook = run(
      ['ping', '-m', 'hi', '--attach', notes, '-w', 'https://api.pingroom.io/api/webhook/abc'],
    );
    assert.equal(webhook.status, 2);
    assert.match(webhook.stderr, /--attach requires an agent token/);

    const badType = run(
      ['ping', '-m', 'hi', '--attach', binary, '--token', 'tok_abc', '--room', 'AB12'],
    );
    assert.equal(badType.status, 2);
    assert.match(badType.stderr, /only md, pdf, html, txt, jpg, jpeg, png, zip/);

    const missing = run(
      ['ping', '-m', 'hi', '--attach', join(dir, 'nope.txt'), '--token', 'tok_abc', '--room', 'AB12'],
    );
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--attach surfaces the Pro gate instead of a bare HTTP error', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'pro_required', message: 'Ping attachments are a Pro feature.' }));
  });

  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'private notes');

  try {
    const { status, stderr } = await runAsync([
      'ping', '-m', 'hi', '--attach', notes,
      '--token', 'tok_abc', '--room', 'AB12', '--api', baseUrl,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /Pro feature/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('--data larger than 8 KB never leaves the machine', () => {
  const big = JSON.stringify({ blob: 'x'.repeat(9 * 1024) });
  const { status, stderr } = run(['ping', '-m', 'hi', '--token', 'x'.repeat(40), '--room', 'ab12cd', '--data', big]);
  assert.equal(status, 2);
  assert.match(stderr, /--data must serialize to at most 8 KB/);
});

// --- explicit transport flags beat PINGROOM_WEBHOOK_URL ----------------------

test('an explicit --token/--room beats a PINGROOM_WEBHOOK_URL in the environment', async () => {
  const { server, baseUrl, received } = await transportServer();
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-transport-'));
  const file = join(dir, 'report.txt');
  writeFileSync(file, 'build log');
  const env = { PINGROOM_WEBHOOK_URL: `${baseUrl}/webhooks/room/HOOKSECRET` };
  try {
    for (const argv of [
      ['ping', '-m', 'hi', '--token', 'tok', '--room', 'ab12cd'],
      // --room alone picks the token path too; the token comes from the env.
      ['ping', '-m', 'hi', '--room', 'ab12cd'],
      // --attach used to fail with "requires an agent token" despite --token.
      ['ping', '-m', 'hi', '--token', 'tok', '--room', 'ab12cd', '--attach', file],
      ['live', 'start', '-c', 'deploy-1', '--token', 'tok', '--room', 'ab12cd'],
    ]) {
      received.length = 0;
      const extra = argv.includes('--token') ? {} : { PINGROOM_TOKEN: 'tok' };
      const { status, stderr } = await runAsync([...argv, '--api', baseUrl], { ...env, ...extra });
      assert.equal(status, 0, `${argv.join(' ')}: ${stderr}`);
      assert.ok(received.length > 0);
      assert.ok(received.every((r) => r.path.startsWith('/api/agent/')), `${argv.join(' ')} reached ${received.map((r) => r.path)}`);
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run sends its completion ping on the explicit token path, not the env webhook', async () => {
  const { server, baseUrl, received } = await transportServer();
  try {
    const { status, stderr } = await runAsync(
      ['run', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--', process.execPath, '-e', ''],
      { PINGROOM_WEBHOOK_URL: `${baseUrl}/webhooks/room/HOOKSECRET` },
    );
    assert.equal(status, 0, stderr);
    assert.deepEqual(received.map((r) => r.path), ['/api/agent/rooms/ab12cd/notifications']);
  } finally {
    server.close();
  }
});

test('PINGROOM_WEBHOOK_URL is still the transport when no flag names one', async () => {
  const { server, baseUrl, received } = await transportServer();
  try {
    const { status, stderr } = await runAsync(['ping', '-m', 'hi'], {
      PINGROOM_WEBHOOK_URL: `${baseUrl}/webhooks/room/HOOKSECRET`, PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd',
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(received.map((r) => r.path), ['/webhooks/room/HOOKSECRET']);
  } finally {
    server.close();
  }
});

test('naming both transports is a usage error, and --room without a token says why', () => {
  for (const argv of [
    ['ping', '-m', 'hi', '--webhook', 'https://hooks.example/w', '--token', 'tok'],
    ['ping', '-m', 'hi', '--webhook', 'https://hooks.example/w', '--room', 'ab12cd'],
    ['live', 'start', '-c', 'deploy-1', '--webhook', 'https://hooks.example/w', '--token', 'tok'],
    ['run', '--webhook', 'https://hooks.example/w', '--token', 'tok', '--', process.execPath, '-e', ''],
  ]) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.match(stderr, /--webhook cannot be combined with --token or --room/);
  }
  const { status, stderr } = run(['ping', '-m', 'hi', '--room', 'ab12cd'], { PINGROOM_WEBHOOK_URL: 'https://hooks.example/w' });
  assert.equal(status, 2);
  assert.match(stderr, /--room selects the agent-token path.*PINGROOM_WEBHOOK_URL is ignored/);
});
