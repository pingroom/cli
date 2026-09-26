import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCode } from '../lib/config.js';

test('room codes are normalized the way people paste them', () => {
  assert.equal(normalizeRoomCode('SEUHKD11B2KI'), 'SEUHKD11B2KI');
  assert.equal(normalizeRoomCode('  SEUHKD11B2KI '), 'SEUHKD11B2KI');
  assert.equal(normalizeRoomCode('#SEUHKD11B2KI'), 'SEUHKD11B2KI');
  assert.equal(normalizeRoomCode('https://pgr.link/j/seuhkd11b2ki?src=share'), 'seuhkd11b2ki');
  assert.equal(normalizeRoomCode('https://pingroom.io/join/SEUHKD11B2KI/'), 'SEUHKD11B2KI');
});

test('an empty or missing room stays unset', () => {
  assert.equal(normalizeRoomCode(undefined), undefined);
  assert.equal(normalizeRoomCode('   '), undefined);
  assert.equal(normalizeRoomCode('#'), undefined);
});
