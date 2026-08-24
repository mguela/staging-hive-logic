// test/mail-imap-search.test.mjs
// IMAP mailboxes (Gmail/iCloud/Yahoo/custom) answered every search with an
// empty list: /api/mail's Graph adapter had no $search route, and unhandled
// paths fall through to { value: [], __unsupported } -- which the UI paints as
// "No messages here." api/mail.js now answers $search with a real IMAP SEARCH.
//
// api/mail.js can't be imported here (it requires imapflow/nodemailer/
// mailparser at load, and those aren't installed for the test run), so the two
// search helpers are lifted out of the source and exercised directly. Proves:
//   1. Folder choice: an \All folder is the whole mailbox; Trash/Junk are out;
//      Inbox/Sent/Archive lead; \Noselect containers are skipped; the fan-out
//      is capped.
//   2. The SEARCH is SUBJECT/FROM/TO/BODY, never raw TEXT.
//   3. UID handling: the NEWEST matches are fetched, by UID and not by
//      sequence number -- fetching a uid list as sequence numbers would
//      silently return the wrong messages.
//   4. The mailbox lock is released on every path, including a failed SEARCH.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(nodePath.join(here, '..', 'api', 'mail.js'), 'utf8');

function slice(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `could not find "${from}" .. "${to}" in api/mail.js`);
  return SRC.slice(a, b);
}

// The real envToMessage() turns an IMAP envelope into a Graph message and is
// covered by the routes that already use it; here only the uids matter.
const mod = new Function(`
  ${slice('// ---------- IMAP search ----------', '// ---------- the Graph-shape adapter')}
  function envToMessage(p, msg) { return { id: p + ':' + msg.uid, uid: msg.uid, receivedDateTime: msg.internalDate }; }
  return { searchFolderPaths, searchFolder, SEARCH_MAX_FOLDERS };
`)();

const folder = (path, specialUse, flags) => ({
  path,
  specialUse: specialUse || '',
  flags: new Set(flags || []),
});

function fakeClient({ uids = [], searchThrows = false } = {}) {
  const calls = { locked: [], released: 0, query: null, searchOpts: null, range: null, fetchOpts: null, fetched: false };
  return {
    calls,
    async getMailboxLock(p) { calls.locked.push(p); return { release() { calls.released++; } }; },
    async search(q, o) {
      calls.query = q; calls.searchOpts = o;
      if (searchThrows) throw new Error('SELECT failed');
      return uids;
    },
    fetch(range, q, o) {
      calls.fetched = true; calls.range = range; calls.fetchOpts = o;
      const list = String(range).split(',').filter(Boolean).map(Number);
      return (async function* () {
        for (const uid of list) yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1 + (uid % 27))) };
      })();
    },
  };
}

test('a Gmail-style \\All folder is the whole mailbox in one SELECT', () => {
  const paths = mod.searchFolderPaths([
    folder('INBOX'),
    folder('[Gmail]/All Mail', '\\All'),
    folder('[Gmail]/Sent Mail', '\\Sent'),
    folder('[Gmail]/Trash', '\\Trash'),
  ]);
  assert.deepEqual(paths, ['[Gmail]/All Mail']);
});

test('Trash and Junk stay out; Inbox, Sent, Archive lead', () => {
  const paths = mod.searchFolderPaths([
    folder('Junk', '\\Junk'),
    folder('Notes'),
    folder('Sent', '\\Sent'),
    folder('Trash', '\\Trash'),
    folder('INBOX'),
    folder('Archive', '\\Archive'),
  ]);
  assert.deepEqual(paths, ['INBOX', 'Sent', 'Archive', 'Notes']);
});

test('\\Noselect containers are never opened', () => {
  const paths = mod.searchFolderPaths([
    folder('INBOX'),
    folder('[Gmail]', '', ['\\Noselect']),
    folder('Work'),
  ]);
  assert.deepEqual(paths, ['INBOX', 'Work']);
});

test('the fan-out is capped so one search cannot walk a huge mailbox', () => {
  const many = [folder('INBOX')];
  for (let i = 0; i < 40; i++) many.push(folder('Folder' + i));
  const paths = mod.searchFolderPaths(many);
  assert.equal(paths.length, mod.SEARCH_MAX_FOLDERS);
  assert.equal(paths[0], 'INBOX');
});

test('the SEARCH covers subject/from/to/body and never raw TEXT', async () => {
  const client = fakeClient({ uids: [7] });
  await mod.searchFolder(client, 'INBOX', 'roof leak', 30);
  const keys = client.calls.query.or.map(t => Object.keys(t)[0]).sort();
  assert.deepEqual(keys, ['body', 'from', 'subject', 'to']);
  // IMAP TEXT matches the raw MIME, so a base64 attachment "contains" almost
  // any word -- searching it would fill the list with false positives.
  assert.ok(!('text' in client.calls.query), 'must not fall back to IMAP TEXT');
  client.calls.query.or.forEach(t => assert.equal(Object.values(t)[0], 'roof leak'));
});

test('the newest matches are fetched, and fetched BY UID', async () => {
  const uids = Array.from({ length: 100 }, (_, i) => i + 1); // UIDs ascend with arrival
  const client = fakeClient({ uids });
  const out = await mod.searchFolder(client, 'INBOX', 'invoice', 5);
  assert.equal(client.calls.range, '96,97,98,99,100');
  // Both flags matter: {uid:true} in the query returns the uid, and the third
  // argument is what makes the RANGE a uid set instead of sequence numbers.
  assert.equal(client.calls.searchOpts.uid, true);
  assert.equal(client.calls.fetchOpts.uid, true);
  assert.deepEqual(out.map(m => m.uid), [96, 97, 98, 99, 100]);
  assert.equal(client.calls.released, 1);
});

test('no matches means no FETCH at all, and the lock still comes back', async () => {
  const client = fakeClient({ uids: [] });
  const out = await mod.searchFolder(client, 'Archive', 'nothing here', 30);
  assert.deepEqual(out, []);
  assert.equal(client.calls.fetched, false);
  assert.equal(client.calls.released, 1);
});

test('a failed SEARCH still releases the mailbox lock', async () => {
  const client = fakeClient({ searchThrows: true });
  await assert.rejects(() => mod.searchFolder(client, 'INBOX', 'x', 30), /SELECT failed/);
  assert.equal(client.calls.released, 1);
});

test('the $search route is matched before the plain listing routes', () => {
  const search = SRC.indexOf("const rawSearch = qp.get('$search')");
  const listFolder = SRC.indexOf('// GET /me/mailFolders/{id}/messages  -> newest N envelopes');
  const listOne = SRC.indexOf('// GET /me/messages/{id}  -> one full message');
  assert.ok(search > 0, '$search route missing from the adapter');
  // They share the same paths: whichever is tested first wins, and a search
  // answered by the listing route is the original bug in a new costume.
  assert.ok(search < listFolder, '$search must be tested before the folder listing');
  assert.ok(search < listOne, '$search must be tested before the single-message route');
});
