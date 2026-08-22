import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// api/mail.js sends real mail for real people, and it leans on a very small
// slice of nodemailer: createTransport, sendMail, verify. Version 6 carried
// four advisories -- one high -- so this moved to 9. Major bumps are where a
// quietly-changed API turns into mail that silently stops sending, and there is
// no test that would have caught that, so this pins the contract we depend on.
//
// Deliberately exercised through jsonTransport rather than mocked: a mock of
// nodemailer would keep passing after nodemailer itself changed, which is the
// exact failure this is meant to prevent.
const nodemailer = require('nodemailer');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const MAIL_SRC = readFileSync(new URL('../api/mail.js', import.meta.url), 'utf8');

test('the patched nodemailer major is the one pinned and installed', () => {
  const declared = pkg.dependencies.nodemailer;
  assert.match(declared, /^\^?9\./, `package.json still asks for ${declared}`);
  const installed = require('nodemailer/package.json').version;
  assert.match(installed, /^9\./, `node_modules has ${installed}`);
  // 6.x is what carried GHSA-r7g4-qg5f-qqm2 (OAuth2 TLS), the two
  // disableFileAccess/disableUrlAccess bypasses, and the addressparser DoS.
  assert.ok(!installed.startsWith('6.'), 'must not fall back to the advisory-affected major');
});

test('the three APIs api/mail.js calls all still exist', () => {
  for (const call of ['nodemailer.createTransport(', 'transport.sendMail(', 'transport.verify()']) {
    assert.ok(MAIL_SRC.includes(call), `${call} should still be how mail.js talks to nodemailer`);
  }
  const transport = nodemailer.createTransport({
    host: 'smtp.example.test', port: 587, secure: false, auth: { user: 'u', pass: 'p' },
  });
  assert.equal(typeof transport.sendMail, 'function');
  assert.equal(typeof transport.verify, 'function');
});

// smtpAuth() switches to OAuth2 whenever a Google account supplies an access
// token, so this path is live in production, not hypothetical.
test('an OAuth2 transport still builds from a supplied access token', () => {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.test', port: 465, secure: true,
    auth: { type: 'OAuth2', user: 'u@example.test', accessToken: 'tok' },
  });
  assert.equal(typeof transport.sendMail, 'function');
});

test('a message keeps the shape sendMail() builds', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const info = await transport.sendMail({
    from: { name: 'GH Co.', address: 'office@example.test' },
    to: ['client@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'],
    subject: 'Your visit is confirmed',
    html: '<b>See you Tuesday</b>',
    attachments: [{ filename: 'invoice.pdf', content: Buffer.from('hello'), contentType: 'text/plain' }],
  });
  const msg = JSON.parse(info.message);

  assert.equal(msg.from.address, 'office@example.test');
  assert.equal(msg.from.name, 'GH Co.');
  assert.deepEqual(msg.to.map((a) => a.address), ['client@example.test']);
  assert.deepEqual(msg.cc.map((a) => a.address), ['cc@example.test']);
  assert.deepEqual(msg.bcc.map((a) => a.address), ['bcc@example.test']);
  assert.equal(msg.subject, 'Your visit is confirmed');
  assert.equal(msg.html, '<b>See you Tuesday</b>');

  const att = msg.attachments[0];
  assert.equal(att.filename, 'invoice.pdf');
  // round-trips rather than just being present: base64 in, same bytes out
  assert.equal(Buffer.from(att.content, att.encoding || 'base64').toString(), 'hello');
});

// mail.js builds each attachment as {filename, content, contentType} and drops
// any without content, so a request body cannot smuggle in `path:` or `href:`.
// That is what keeps the two file-access/SSRF advisories out of reach here --
// worth pinning, because relaxing it would reopen them on any nodemailer.
test('attachments are built from content only, never a path or URL', () => {
  const build = MAIL_SRC.slice(MAIL_SRC.indexOf('mail.attachments = message.attachments.map'));
  const body = build.slice(0, build.indexOf('.filter('));
  assert.ok(body.includes('content:'), 'attachment bytes come from the request body');
  assert.ok(!body.includes('path:'), 'a caller-supplied path would read files off the server');
  assert.ok(!body.includes('href:'), 'a caller-supplied href would fetch a URL server-side');
  assert.ok(build.includes('.filter((a) => a.content)') || build.includes('.filter(a => a.content)'),
    'attachments without content are dropped rather than passed through');
});
