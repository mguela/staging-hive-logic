import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// GHSA-ggr8-5vv4-36mx: deepmerge-ts below 8.0.0 exhausts the stack on recursive
// object graphs. It reaches us three levels down -- mailparser -> html-to-text
// -> deepmerge-ts -- and there is no upstream fix to wait for: mailparser pins
// html-to-text to exactly 10.0.0, and html-to-text 10.0.0 pins deepmerge-ts
// ^7.1.5. `npm audit fix` advertises a fix for this and then changes nothing.
//
// So package.json overrides deepmerge-ts to ^8.0.1, forcing a version outside
// the range html-to-text asked for. That is the kind of change that works on
// the day it is made and quietly breaks email parsing three months later, so
// these tests run the REAL libraries -- no stubs -- over the exact call shapes
// api/mail.js depends on.
const require = createRequire(import.meta.url);
const { htmlToText } = require('html-to-text');
const { simpleParser } = require('mailparser');

// Resolve deepmerge-ts the way html-to-text does, not the way the top level
// does. npm hoists it when the override applies and nests it under
// node_modules/html-to-text when it doesn't, so a fixed path would report on a
// copy nobody loads -- or throw ENOENT and mask the real answer. Whatever
// html-to-text resolves is the code that actually runs on inbound mail.
const htmlToTextRequire = createRequire(require.resolve('html-to-text'));
const { deepmerge } = htmlToTextRequire('deepmerge-ts');

function resolvedVersion(dep, asSeenBy = htmlToTextRequire) {
  let dir = path.dirname(asSeenBy.resolve(dep));
  // deepmerge-ts blocks ./package.json in its exports map, so walk up to it
  while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const major = (v) => Number(v.split('.')[0]);

test('the override is declared and actually took effect', () => {
  assert.equal(pkg.overrides?.['deepmerge-ts'], '^8.0.1',
    'the override is the only thing standing between us and the advisory');
  const seen = resolvedVersion('deepmerge-ts');
  assert.ok(major(seen) >= 8,
    `html-to-text resolves deepmerge-ts ${seen} -- the override did not take, and the advisory is back`);
  assert.ok(pkg.overridesRationale?.['deepmerge-ts'],
    'an override that outlives the memory of why it exists is how dependencies rot');
});

// The advisory itself, not a proxy for it. If this ever passes on a version
// below 8 the pin can go; if it starts failing, the override was lost.
test('a recursive object graph merges instead of blowing the stack', () => {
  const a = { name: 'a' }; a.self = a;
  const b = { name: 'b' }; b.self = b;
  const merged = deepmerge(a, b);
  assert.equal(merged.name, 'b');

  // deep-but-acyclic is the same failure mode reached a different way
  const deep = {};
  let cur = deep;
  for (let i = 0; i < 50000; i++) { cur.n = {}; cur = cur.n; }
  cur.leaf = 1;
  assert.doesNotThrow(() => deepmerge(deep, deep));
});

// mailparser calls htmlToText(node.textContent) with ONE argument -- no user
// options -- so this is the path every inbound HTML email takes.
test('the bare one-argument call mailparser makes still renders HTML to text', () => {
  const out = htmlToText(
    '<h1>Invoice 4821</h1><p>Due <b>Friday</b>.</p><a href="https://x.test/pay">Pay now</a>'
  );
  assert.match(out, /INVOICE 4821/, 'headings are still uppercased');
  assert.match(out, /Due Friday\./, 'inline markup is still stripped, not dropped');
  assert.match(out, /Pay now \[https:\/\/x\.test\/pay\]/, 'link hrefs are still surfaced');
  assert.doesNotMatch(out, /<[a-z]/i, 'no raw markup may survive into the text body');
});

// The options merge is the code path that actually runs through deepmergeCustom
// -- filterValues, mergeArrays and metaDataUpdater all at once. Root `selectors`
// must COMPOSE with the defaults; every other array must overwrite. Getting this
// backwards would silently discard html-to-text's built-in handling.
test('user selectors compose with the defaults rather than replacing them', () => {
  const html = '<a href="https://x.test/pay">Pay now</a><img src="logo.png" alt="ACME">';
  const out = htmlToText(html, { selectors: [{ selector: 'a', options: { ignoreHref: true } }] });

  assert.match(out, /Pay now/);
  assert.doesNotMatch(out, /x\.test/, 'the caller-supplied anchor rule must be honoured');
  assert.match(out, /ACME \[logo\.png\]/,
    'and the default img rule must survive the merge -- if selectors overwrote, this is gone');
});

test('an HTML-only message still yields the text and textAsHtml api/mail.js falls back to', async () => {
  const mime = [
    'From: Dispatch <dispatch@gh.test>',
    'To: Chris <chris@ghgrp.net>',
    'Subject: Job 4821',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<h1>Job 4821</h1><p>Crew arrives <b>08:00</b>.</p><a href="https://x.test/p">Portal</a>',
    '',
  ].join('\r\n');

  const parsed = await simpleParser(mime);
  assert.match(parsed.text, /JOB 4821/, 'text is derived from the HTML through html-to-text');
  assert.match(parsed.text, /Crew arrives 08:00\./);
  assert.match(parsed.textAsHtml, /<p>JOB 4821<\/p>/);
});

// Everything api/mail.js reads off a parsed message, in one pass. This is the
// blast radius of the override: if the pin broke mailparser, it breaks here.
test('a multipart message exposes every field the Graph shim reads', async () => {
  const mime = [
    'From: Dispatch <dispatch@gh.test>',
    'To: Chris <chris@ghgrp.net>',
    'Cc: Ops <ops@gh.test>',
    'Subject: Job 4821 - site photos',
    'Date: Mon, 17 Aug 2026 09:12:00 -0400',
    'Message-ID: <job4821@gh.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B1"',
    '',
    '--B1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Crew arrives <b>08:00</b>.</p>',
    '--B1',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('gate code 4417').toString('base64'),
    '--B1--',
    '',
  ].join('\r\n');

  const p = await simpleParser(mime);

  assert.equal(p.subject, 'Job 4821 - site photos');
  assert.equal(p.from.value[0].address, 'dispatch@gh.test');
  assert.equal(p.from.value[0].name, 'Dispatch');
  assert.equal(p.to.value[0].address, 'chris@ghgrp.net');
  assert.equal(p.cc.value[0].address, 'ops@gh.test');
  assert.equal(p.messageId, '<job4821@gh.test>');
  assert.ok(p.date instanceof Date && !Number.isNaN(p.date.getTime()));
  assert.match(p.html, /Crew arrives/);

  assert.equal(p.attachments.length, 1);
  const [a] = p.attachments;
  assert.equal(a.filename, 'notes.txt');
  assert.equal(a.contentType, 'text/plain');
  assert.ok(Buffer.isBuffer(a.content), 'api/mail.js calls .toString("base64") on this');
  assert.equal(a.content.toString(), 'gate code 4417');
  assert.equal(a.content.toString('base64'), Buffer.from('gate code 4417').toString('base64'));
});

// simpleParser(Buffer.from('')) is a real call site in api/mail.js -- the
// attachments route hits it whenever a fetch comes back without a source.
test('an empty source parses to an empty message rather than throwing', async () => {
  const p = await simpleParser(Buffer.from(''));
  assert.deepEqual(p.attachments, []);
});
