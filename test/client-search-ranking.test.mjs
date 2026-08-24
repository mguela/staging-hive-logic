// Chris, 2026-08-23, typing "lori" into the New Lead client box:
// "look at the names populating when I type in lori. It did eventually find
// lori kendall but i bassically had to type her whole name first."
//
// The screenshot showed Ashley Smith, Boss Facility Services Inc. and Brenn
// Jain above her -- because those records carry lori@greenwichhandyman.net.
// Two faults in one line:
//   1. name, company and email were one flat haystack, so an address on
//      somebody else's record ranked level with the person's own name;
//   2. it stopped at the first 20 matches while walking an ALPHABETICAL list,
//      so the cap fired around the B's and Lori Kendall was never reached.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const ctx = { String, Array, console };
vm.createContext(ctx);
vm.runInContext(extractFunction(SRC, 'function hlRankClients(list, q, limit) {'), ctx);
const rank = (list, q, n) => ctx.hlRankClients(list, q, n).map((c) => c.name);

// His actual book, near enough: three records carrying Lori's email, and Lori
// herself sorting late in the alphabet.
const BOOK = [
  { name: 'Ashley Smith', companyName: '', email: 'ashley@bigappleflorist.com' },
  { name: 'Boss Facility Services Inc.', companyName: 'Boss Facility', email: 'lori@greenwichhandyman.net' },
  { name: 'Brenn Jain', companyName: '', email: 'lori@greenwichhandyman.net' },
  { name: 'Ed and Lori Blum', companyName: '', email: 'ed@blum.com' },
  { name: 'Lori Kendall', companyName: '', email: 'lori.kendall@example.com' },
  { name: 'Lorimer Holdings', companyName: 'Lorimer', email: 'x@lorimer.com' },
];

// ---- the order Chris asked for: name, address, number, email --------------
// "THE SEARCH MAYBE NEEDS PRIORITISED TO CHECK AND LIST FIRST / name /
// address / number / email / everything else." (2026-08-23)

const ORDERED = [
  { name: 'Zeta Client', companyName: '', address: '12 Ocean Drive, Rye, NY', email: 'z@x.com', phone: '+19145550100' },
  { name: 'Yankee Corp', companyName: '', address: '99 Elm St', email: 'ocean@x.com', phone: '+12035551212' },
  { name: 'Ocean Nails', companyName: '', address: '5 Main St', email: 'n@x.com', phone: '+12035559999' },
  { name: 'Xavier Ruiz', companyName: 'Ocean Drive Builders', address: '7 Pine', email: 'x@x.com', phone: '+12035558888' },
];

test('name beats company beats address beats phone beats email', () => {
  const out = rank(ORDERED, 'ocean', 20);
  assert.deepEqual(out, [
    'Ocean Nails',            // name
    'Xavier Ruiz',            // company
    'Zeta Client',            // address
    'Yankee Corp',            // email
  ], 'got: ' + out.join(', '));
});

test('a phone number finds the client', () => {
  assert.deepEqual(rank(ORDERED, '9145550100', 20), ['Zeta Client']);
  assert.deepEqual(rank(ORDERED, '914-555-0100', 20), ['Zeta Client'], 'dashes and spaces are not part of a number');
  assert.deepEqual(rank(ORDERED, '(914) 555-0100', 20), ['Zeta Client']);
});

test('a partial number works once it is long enough to mean one', () => {
  assert.deepEqual(rank(ORDERED, '5550100', 20), ['Zeta Client'], 'the last seven digits are how people say a number');
  assert.deepEqual(rank(ORDERED, '914', 20), [],
    'three digits is an area code -- matching on it would return half of Westchester');
});

test('an address finds the client', () => {
  assert.deepEqual(rank(ORDERED, '12 ocean drive', 20), ['Zeta Client']);
  assert.deepEqual(rank(ORDERED, 'rye', 20), ['Zeta Client'], 'the town counts too');
});

test('a client with no address or phone on file still searches fine', () => {
  // 2,281 of 8,690 have no address and 1,256 have no phone. A missing field
  // must not throw and must not shadow the fields that ARE there.
  const sparse = [{ name: 'Lori Kendall' }, { name: 'Nobody', address: null, phone: null, email: null }];
  assert.deepEqual(rank(sparse, 'lori', 20), ['Lori Kendall']);
  assert.deepEqual(rank(sparse, '5550100', 20), []);
});

test('the person actually called Lori comes first', () => {
  const out = rank(BOOK, 'lori', 20);
  assert.equal(out[0], 'Lori Kendall', 'got: ' + out.join(', '));
});

test('an email on someone else\'s record never outranks a real name', () => {
  const out = rank(BOOK, 'lori', 20);
  const lori = out.indexOf('Lori Kendall');
  for (const viaEmail of ['Boss Facility Services Inc.', 'Brenn Jain']) {
    assert.ok(out.indexOf(viaEmail) > lori,
      viaEmail + ' matched only on lori@... and must rank below her');
  }
});

test('a middle name still counts as a name match, above any email', () => {
  const out = rank(BOOK, 'lori', 20);
  assert.ok(out.indexOf('Ed and Lori Blum') < out.indexOf('Brenn Jain'));
});

test('starting with what you typed beats containing it', () => {
  assert.ok(rank(BOOK, 'lori', 20).indexOf('Lori Kendall') <
            rank(BOOK, 'lori', 20).indexOf('Ed and Lori Blum'));
});

test('the whole book is scanned before the list is cut', () => {
  // This is the half that made him type her full name. With an alphabetical
  // book and a cap applied DURING the walk, a common substring exhausts the
  // limit long before it reaches the L's.
  const big = [];
  for (let i = 0; i < 500; i++) big.push({ name: 'Aaa Client ' + i, companyName: '', email: 'lori@x.com' });
  big.push({ name: 'Lori Kendall', companyName: '', email: 'lk@x.com' });
  const out = rank(big, 'lori', 20);
  assert.equal(out[0], 'Lori Kendall', '500 email matches must not bury her');
  assert.equal(out.length, 20, 'and the cap still applies to what is shown');
});

test('company names still work, below people', () => {
  const out = rank(BOOK, 'lorimer', 20);
  assert.equal(out[0], 'Lorimer Holdings');
});

test('an email search still finds the person when nothing else matches', () => {
  // Email is last, not absent -- looking someone up by their address is a real
  // thing he does.
  const out = rank(BOOK, 'bigappleflorist', 20);
  assert.deepEqual(out, ['Ashley Smith']);
});

test('case and stray spaces do not change the answer', () => {
  assert.deepEqual(rank(BOOK, '  LORI  ', 20)[0], 'Lori Kendall');
});

test('an empty query returns nothing rather than the whole book', () => {
  assert.deepEqual(rank(BOOK, '', 20), []);
  assert.deepEqual(rank(BOOK, '   ', 20), []);
});

test('a record with missing fields cannot crash the picker', () => {
  const messy = [{ name: null, companyName: null, email: null }, {}, { name: 'Lori Kendall' }];
  assert.deepEqual(rank(messy, 'lori', 20), ['Lori Kendall']);
});

test('all three client pickers use the ranking, not the old flat scan', () => {
  const uses = (SRC.match(/hlRankClients\(REAL_CLIENTS/g) || []).length;
  assert.equal(uses, 3, 'New Lead, the estimate builder, and referred-by');
  assert.ok(!/out\.length ?< ?2[05];/.test(SRC),
    'the old cap-during-the-walk loop must be gone from all of them');
});
