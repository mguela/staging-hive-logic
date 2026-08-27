// test/email-attachments.test.mjs
// jomell, 2026-08-27: invoices now attach a real PDF (see
// invoice-email-pdf-attachment.test.mjs). This pins the plumbing that
// carries an attachment through sendEmail() itself into the real Resend
// request body, and confirms every existing caller (none of which pass
// attachments) is completely unaffected.
//
// Run with: node --test test/email-attachments.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.RESEND_API_KEY = 'test-resend-key';

const { sendEmail } = await import('../api/_lib/email.js');

let lastRequest = null;

function stubFetch(responseBody = { id: 'email-1' }, ok = true) {
  global.fetch = async (url, opts) => {
    lastRequest = { url, body: JSON.parse(opts.body) };
    return { ok, json: async () => responseBody };
  };
}

test('an attachment is included in the real Resend request body', async () => {
  stubFetch();
  const r = await sendEmail({
    to: 'client@example.com', subject: 'Invoice #1', html: '<p>hi</p>',
    attachments: [{ filename: 'Invoice-1.pdf', content: 'JVBERi0xLjc=' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(lastRequest.body.attachments, [{ filename: 'Invoice-1.pdf', content: 'JVBERi0xLjc=' }]);
});

test('no attachments param means no attachments key at all in the request -- every existing caller is unaffected', async () => {
  stubFetch();
  await sendEmail({ to: 'client@example.com', subject: 'Hi', html: '<p>hi</p>' });
  assert.ok(!('attachments' in lastRequest.body));
});

test('an empty attachments array is treated the same as none', async () => {
  stubFetch();
  await sendEmail({ to: 'client@example.com', subject: 'Hi', html: '<p>hi</p>', attachments: [] });
  assert.ok(!('attachments' in lastRequest.body));
});

test('multiple attachments all pass through, in order', async () => {
  stubFetch();
  await sendEmail({
    to: 'client@example.com', subject: 'Hi', html: '<p>hi</p>',
    attachments: [{ filename: 'a.pdf', content: 'AA==' }, { filename: 'b.pdf', content: 'BB==' }],
  });
  assert.deepEqual(lastRequest.body.attachments.map((a) => a.filename), ['a.pdf', 'b.pdf']);
});
