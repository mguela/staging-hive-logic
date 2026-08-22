// test/reina-mail-triage.test.mjs
//
// Reina inbox triage (Chris, 2026-08-17: "Reina reading my emails and
// determining what's needing a response and what needs scheduling and what
// needs action, flagging junk and learning to get better at managing my inbox
// each day").
//
// The four things these tests exist to hold:
//
//   1. NOTHING MOVES MAIL. This route reads and labels. Archiving the wrong
//      message is the one mistake here that loses something, so the absence of
//      any Graph write is pinned, not assumed.
//   2. A MESSAGE IS CLASSIFIED ONCE. Re-deriving a verdict costs money AND
//      would silently overwrite a correction Chris made.
//   3. CORRECTIONS ACTUALLY STICK. "Learning" here means a re-label becomes a
//      standing rule that answers before the model. If that link breaks, the
//      feature quietly degrades into a classifier that repeats itself forever
//      while looking exactly the same.
//   4. GAPS ARE REPORTED. A failed batch means some mail is unlabelled; a short
//      list presented as the whole inbox is the failure that matters.
//
// Fully mocked: no network, no model, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const route = await import('../api/reina/mail-triage.js');
const lib = await import('../api/_lib/mail-triage.js');

// ---- harness ----------------------------------------------------------------
function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function sbRes(data, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data, text: async () => JSON.stringify(data) };
}
function gRes(data, status = 200) {
  return { ok: status < 300, status, json: async () => data };
}

const OWNER = 'user-1';

function makeWorld(over = {}) {
  const w = {
    authOk: true,
    mailboxes: [{ home_account_id: 'mbx-a', username: 'chris@ghgrp.net', access_token: 'tok-a', refresh_token: 'r-a', expires_at: '2099-01-01T00:00:00Z' }],
    graphMessages: {},        // home_account_id -> raw Graph messages
    graphStatus: 200,
    stored: [],               // reina_mail_triage rows
    rules: [],                // reina_mail_triage_rules rows
    inserted: [],
    patched: [],
    rulesUpserted: [],
    verdicts: null,           // what the model returns; null = derive from subject
    brief: null,              // what the full-body read returns; null = the default above
    classifyThrows: null,
    modelCalls: [],
    graphCalls: [],
    sbCalls: [],              // every Supabase request, in order
    insertFails: false,
    ruleUpsertFails: false,
    ...over,
  };

  w.supabaseRequest = async (path, opts = {}) => {
    const p = String(path);
    const method = (opts.method || 'GET').toUpperCase();
    w.sbCalls.push({ path: p, method });
    if (p.startsWith('hc_ms_tokens')) {
      if (method === 'PATCH') return sbRes([]);
      return sbRes(w.mailboxes);
    }
    if (p.startsWith('reina_mail_triage_rules')) {
      if (method === 'POST') {
        w.rulesUpserted.push(JSON.parse(opts.body));
        return sbRes(w.ruleUpsertFails ? { message: 'rules table unavailable' } : [], !w.ruleUpsertFails);
      }
      if (method === 'PATCH') return sbRes([]);
      return sbRes(w.rules);
    }
    if (p.startsWith('reina_mail_triage')) {
      if (method === 'POST') {
        const rows = JSON.parse(opts.body);
        w.inserted.push(...rows);
        if (w.insertFails) return sbRes({ message: 'duplicate key value violates unique constraint' }, false);
        // An upsert MERGES onto the existing row, and return=representation
        // hands back the whole row -- not just the columns that were sent. A
        // mock that echoes the payload hides every "this write clobbered a
        // column it never mentioned" bug.
        const out = rows.map((r) => {
          const at = w.stored.findIndex((x) => x.owner_id === r.owner_id && x.message_id === r.message_id);
          if (at === -1) { w.stored.push(r); return r; }
          w.stored[at] = Object.assign({}, w.stored[at], r);
          return w.stored[at];
        });
        return sbRes(out);
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(opts.body);
        w.patched.push({ path: p, patch });
        // PostgREST with Prefer: return=representation hands back the rows it
        // touched, and handleAct reads that to tell "updated" from "no such
        // message". Returning [] made every update look like a 404.
        const id = p.includes('message_id=eq.') ? decodeURIComponent(p.split('message_id=eq.')[1].split('&')[0]) : null;
        const hit = w.stored.filter((r) => !id || r.message_id === id).map((r) => Object.assign(r, patch));
        return sbRes(hit);
      }
      if (p.includes('corrected_at=not.is.null')) return sbRes(w.stored.filter((r) => r.corrected_at));
      if (p.includes('message_id=eq.')) {
        const id = decodeURIComponent(p.split('message_id=eq.')[1].split('&')[0]);
        return sbRes(w.stored.filter((r) => r.message_id === id));
      }
      return sbRes(w.stored);
    }
    return sbRes([]);
  };

  w.fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return gRes(w.authOk ? { id: OWNER, email: 'chris@ghgrp.net' } : { error: 'bad' }, w.authOk ? 200 : 401);
    if (u.includes('graph.microsoft.com')) {
      const token = String((opts.headers && opts.headers.Authorization) || '').replace(/^Bearer\s+/, '');
      w.graphCalls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), token });
      if (w.graphStatus !== 200) return gRes({ error: { message: 'graph down' } }, w.graphStatus);
      const box = w.mailboxes.find((m) => m.access_token === token);
      return gRes({ value: (box && w.graphMessages[box.home_account_id]) || [] });
    }
    if (u.includes('login.microsoftonline.com')) return gRes({ access_token: 'refreshed', refresh_token: 'rot', expires_in: 3600 });
    return gRes({ error: 'unexpected ' + u }, 500);
  };

  // A stand-in classifier: labels by a keyword in the subject unless the test
  // pins explicit verdicts. Keeps tests about the PIPELINE, not about prompts.
  w.anthropic = {
    messages: {
      create: async (params) => {
        w.modelCalls.push(params);
        if (w.classifyThrows) throw new Error(w.classifyThrows);
        // The full-body read of ONE message uses a different tool.
        if ((params.tools || []).some((t) => t.name === 'record_brief')) {
          return { content: [{ type: 'tool_use', name: 'record_brief', input: w.brief || {
            summary: 'Sam wants the Thursday slot confirmed for 12 Elm.',
            action: 'Tell Sam whether Thursday at 9 works for 12 Elm',
            label: 'needs_scheduling',
            reply: 'Thursday at 9 works. See you at 12 Elm.',
          } }] };
        }
        const text = params.messages[0].content;
        const refs = [...text.matchAll(/^\[(\d+)\] from:/gm)].map((m) => Number(m[1]));
        const verdicts = refs.map((ref) => {
          if (w.verdicts && w.verdicts[ref]) return { ref, ...w.verdicts[ref] };
          const block = text.split(`[${ref}] from:`)[1] || '';
          const subject = (/subject: (.*)/.exec(block) || [])[1] || '';
          let label = 'fyi';
          if (/\?|question/i.test(subject)) label = 'needs_reply';
          else if (/schedul|visit|appointment/i.test(subject)) label = 'needs_scheduling';
          else if (/invoice|pay|approve/i.test(subject)) label = 'needs_action';
          else if (/sale|webinar|offer/i.test(subject)) label = 'junk';
          return { ref, label, reason: 'test', confidence: 'high' };
        });
        return { content: [{ type: 'tool_use', name: 'record_triage', input: { verdicts } }] };
      },
    },
  };
  return w;
}

function msg(over = {}) {
  return {
    id: 'graph-' + (over.internetMessageId || over.id || '1'),
    internetMessageId: '<m1@mail>',
    subject: 'Hello',
    from: { emailAddress: { address: 'someone@example.com', name: 'Someone' } },
    receivedDateTime: '2026-08-17T12:00:00Z',
    bodyPreview: 'a preview',
    webLink: 'https://outlook.test/1',
    ...over,
  };
}

async function call(w, action, body = {}) {
  const req = { method: 'POST', query: { action }, headers: { authorization: 'Bearer t' }, body };
  const r = res();
  await route.default(req, r, { supabaseRequest: w.supabaseRequest, fetchImpl: w.fetchImpl, anthropic: w.anthropic });
  return r;
}

// ---- the hard guarantee -----------------------------------------------------

test('triage never writes to the mailbox -- every Graph call is a read', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<a@mail>', subject: 'Can you confirm the price?' }),
    msg({ internetMessageId: '<b@mail>', subject: 'Webinar: grow your business' }),
  ];
  await call(w, 'list');
  assert.ok(w.graphCalls.length > 0, 'sanity: it read the mailbox');
  for (const c of w.graphCalls) {
    assert.equal(c.method, 'GET', `triage must not ${c.method} to Graph -- moving mail is not its job`);
  }
});

test('the source carries no mail-moving verbs at all', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/reina/mail-triage.js', import.meta.url), 'utf-8'));
  for (const forbidden of ['/move', '/send', 'sendMail', 'DELETE']) {
    assert.ok(!src.includes(forbidden), `${forbidden} does not belong in a route that only labels`);
  }
});

// ---- classification ---------------------------------------------------------

test('unread mail comes back labelled, most consequential first, junk last', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<j@mail>', subject: 'Special offer for you' }),
    msg({ internetMessageId: '<r@mail>', subject: 'Quick question about the quote' }),
    msg({ internetMessageId: '<s@mail>', subject: 'Can we schedule the site visit' }),
    msg({ internetMessageId: '<a@mail>', subject: 'Invoice 4021 due' }),
  ];
  const r = await call(w, 'list');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.rows.map((x) => x.label),
    ['needs_reply', 'needs_scheduling', 'needs_action', 'junk'],
    'a list sorted by arrival time is just the inbox again');
  assert.equal(r.body.classified, 4);
});

test('all four messages ride in ONE model call, not four', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = ['a', 'b', 'c', 'd'].map((k) => msg({ internetMessageId: `<${k}@mail>`, subject: 'Note ' + k }));
  await call(w, 'list');
  assert.equal(w.modelCalls.length, 1, 'batching is the cost story -- one shared system prompt, not one per email');
});

test('a message already judged is never re-classified', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'needs_reply', received_at: '2026-08-17T12:00:00Z' }];
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'Quick question' })];
  const r = await call(w, 'list');
  assert.equal(w.modelCalls.length, 0, 'a second look at the same mail must be free');
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.classified, 0);
});

test('a stored CORRECTION survives a re-list -- it is never overwritten by a fresh verdict', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'junk', corrected_label: 'needs_reply', corrected_at: '2026-08-17T13:00:00Z', received_at: '2026-08-17T12:00:00Z' }];
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'Special offer' })];
  const r = await call(w, 'list');
  assert.equal(w.modelCalls.length, 0);
  assert.equal(r.body.rows[0].corrected_label, 'needs_reply', "Chris's call outranks the model's, permanently");
});

// ---- the learning loop ------------------------------------------------------

test('correcting a label saves it AND turns it into a standing rule for that sender', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', from_address: 'Newsletter@Vendor.COM', label: 'needs_action' }];
  const r = await call(w, 'correct', { messageId: '<a@mail>', label: 'junk' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ruleSaved, true);
  assert.equal(w.patched[0].patch.corrected_label, 'junk');
  assert.ok(w.patched[0].patch.corrected_at);
  const rule = w.rulesUpserted[0][0];
  assert.equal(rule.match_kind, 'sender');
  assert.equal(rule.match_value, 'newsletter@vendor.com', 'addresses are matched case-insensitively');
  assert.equal(rule.label, 'junk');
});

test('a corrected sender is answered by the rule next time -- the model is not asked again', async () => {
  const w = makeWorld();
  w.rules = [{ id: 'rule-1', match_kind: 'sender', match_value: 'newsletter@vendor.com', label: 'junk', hits: 3 }];
  w.graphMessages['mbx-a'] = [msg({
    internetMessageId: '<b@mail>', subject: 'Quick question about the quote',
    from: { emailAddress: { address: 'Newsletter@Vendor.com', name: 'Vendor' } },
  })];
  const r = await call(w, 'list');
  assert.equal(w.modelCalls.length, 0, 'a sender he has already judged must never cost another call');
  assert.equal(r.body.rows[0].label, 'junk', 'the standing correction wins over what the model would have said');
  assert.equal(r.body.rows[0].source, 'rule');
  assert.equal(r.body.byRule, 1);
});

test('a sender rule beats a domain rule -- one person at a vendor can still matter', () => {
  const rules = [
    { match_kind: 'domain', match_value: 'vendor.com', label: 'junk' },
    { match_kind: 'sender', match_value: 'rep@vendor.com', label: 'needs_reply' },
  ];
  assert.equal(lib.matchTriageRule({ fromAddress: 'rep@vendor.com' }, rules).label, 'needs_reply');
  assert.equal(lib.matchTriageRule({ fromAddress: 'blast@vendor.com' }, rules).label, 'junk');
});

test('one correction does NOT quietly junk a whole company', () => {
  const rule = lib.ruleFromCorrection(OWNER, { from_address: 'noreply@homedepot.com' }, 'junk');
  assert.equal(rule.match_kind, 'sender',
    'promoting one tap into a domain-wide rule is a bigger claim than he made');
});

test('recent corrections are shown to the model as worked examples', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<old@mail>', subject: 'Weekly digest', from_address: 'news@x.com', label: 'needs_action', corrected_label: 'junk', corrected_at: '2026-08-17T10:00:00Z' }];
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<new@mail>', subject: 'Something new' })];
  await call(w, 'list');
  const prompt = w.modelCalls[0].messages[0].content;
  assert.match(prompt, /corrected your labels before/);
  assert.match(prompt, /Weekly digest/);
  assert.match(prompt, /-> junk/);
  assert.match(prompt, /you had said needs_action/);
});

// ---- the brief: Reina's read of ONE email -----------------------------------
//
// Chris, 2026-08-18: "I want a standard inbox and when you click the email on
// the list, it populates the big preview screen. in the preview it shows a
// reina summary of the email and a suggested action or response."

const BRIEF_MSG = {
  messageId: '<b1@mail>', graphId: 'g1', homeAccountId: 'mbx-a',
  subject: 'Thursday?', fromAddress: 'sam@acme.com', fromName: 'Sam',
  receivedAt: '2026-08-18T09:00:00Z',
};

function graphBody(w, text) {
  const inner = w.fetchImpl;
  w.fetchImpl = async (url, opts) => {
    if (String(url).includes('graph.microsoft.com/v1.0/me/messages/')) {
      return gRes({ subject: 'Thursday?', body: { contentType: 'text', content: text } });
    }
    return inner(url, opts);
  };
}

test('opening an email reads the whole thing and stores what it learned', async () => {
  const w = makeWorld();
  graphBody(w, '<p>Can you do Thursday at 9 at 12 Elm?</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.summary, 'Sam wants the Thursday slot confirmed for 12 Elm.');
  assert.equal(r.body.action, 'Tell Sam whether Thursday at 9 works for 12 Elm');
  assert.equal(r.body.label, 'needs_scheduling');
  assert.equal(r.body.draft, 'Thursday at 9 works. See you at 12 Elm.');
  assert.equal(r.body.cached, false);

  const saved = w.inserted[0];
  assert.ok(saved, 'and it is written down');
  assert.equal(saved.summary_text, 'Sam wants the Thursday slot confirmed for 12 Elm.');
  assert.equal(saved.action_text, 'Tell Sam whether Thursday at 9 works for 12 Elm');
  assert.equal(saved.label, 'needs_scheduling');
  assert.ok(saved.brief_at);
});

test('the second open costs nothing -- no model call, no mailbox read', async () => {
  const w = makeWorld();
  graphBody(w, '<p>Can you do Thursday at 9?</p>');
  await call(w, 'brief', BRIEF_MSG);
  const modelCalls = w.modelCalls.length;
  const graphCalls = w.graphCalls.length;

  const again = await call(w, 'brief', BRIEF_MSG);
  assert.equal(again.body.cached, true);
  assert.equal(again.body.summary, 'Sam wants the Thursday slot confirmed for 12 Elm.');
  assert.equal(w.modelCalls.length, modelCalls, 'written once, never re-derived');
  assert.equal(w.graphCalls.length, graphCalls, 'and the mailbox is not re-read either');
});

test('one call produces the summary, the action, the label AND the reply', async () => {
  // Four calls would cost four times as much and could disagree with themselves.
  const w = makeWorld();
  graphBody(w, '<p>Thursday?</p>');
  await call(w, 'brief', BRIEF_MSG);
  assert.equal(w.modelCalls.length, 1);
  const tools = (w.modelCalls[0].tools || []).map((t) => t.name);
  assert.deepEqual(tools, ['record_brief']);
  assert.equal(w.modelCalls[0].tool_choice.name, 'record_brief', 'forced, so it cannot answer in prose');
});

test('a standing rule outranks a fresh read of one message', async () => {
  // He made that rule about ALL of the sender's mail. One email does not undo it.
  const w = makeWorld();
  w.rules = [{ id: 'r1', owner_id: OWNER, match_kind: 'sender', match_value: 'sam@acme.com', label: 'junk', hits: 3 }];
  graphBody(w, '<p>Thursday?</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.label, 'junk');
  assert.equal(w.inserted[0].source, 'rule');
  // ...but the summary is still Reina's, because the rule says nothing about content.
  assert.equal(r.body.summary, 'Sam wants the Thursday slot confirmed for 12 Elm.');
});

test('a correction he made survives the brief being written', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'fyi', corrected_label: 'needs_action', corrected_at: '2026-08-18T08:00:00Z',
                from_address: 'sam@acme.com', subject: 'Thursday?' }];
  graphBody(w, '<p>Thursday?</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.label, 'needs_action', "his call outranks the model's, permanently");
  assert.equal(r.body.correctedLabel, 'needs_action');
  const written = Object.keys(w.inserted[0]);
  assert.ok(!written.includes('corrected_label'), 'and the write does not even mention it');
});

test('an email the batch scan never covered can still be opened', async () => {
  // Older than the window, or in a folder the scan does not read. There is no
  // row for it; the brief creates one rather than refusing.
  const w = makeWorld();
  w.stored = [];
  graphBody(w, '<p>Thursday?</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.statusCode, 200);
  assert.equal(w.inserted[0].message_id, '<b1@mail>');
  assert.equal(w.inserted[0].subject, 'Thursday?');
});

test('a Gmail message is read from the body the browser hands in', async () => {
  const w = makeWorld();
  const r = await call(w, 'brief', {
    ...BRIEF_MSG, homeAccountId: 'imap:g@gmail.com',
    bodyText: '<p>Can you do Thursday?</p>',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(w.graphCalls.filter((c) => c.url.includes('/messages/')).length, 0,
    'the server cannot open that mailbox and must not try');
  assert.match(w.modelCalls[0].messages[0].content, /Can you do Thursday\?/);
});

test('a Gmail message with no body says so instead of guessing', async () => {
  const w = makeWorld();
  const r = await call(w, 'brief', { ...BRIEF_MSG, homeAccountId: 'imap:g@gmail.com' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /bodyText is required/);
});

test('an email that wants no reply gets no invented one', async () => {
  const w = makeWorld({ brief: {
    summary: 'Receipt for the $159.23 Intuit subscription, charged Aug 18.',
    action: 'Nothing to do — file the receipt',
    label: 'fyi',
    reply: '',
  } });
  graphBody(w, '<p>Your receipt.</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.draft, null, 'an empty reply is a real answer, not a failure');
  assert.ok(!('draft_text' in w.inserted[0]), 'and it must not wipe a draft he has already been shown');
});

test('an unfilled blank in the reply is flagged', async () => {
  const w = makeWorld({ brief: {
    summary: 'Alvaro wants the revised window proposal approved.',
    action: 'Tell Alvaro whether the revised window proposal at 164 Washington is approved',
    label: 'needs_reply',
    reply: 'Approved — go ahead. Start [CONFIRM DATE].',
  } });
  graphBody(w, '<p>Approve?</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.hasBlanks, true, 'a made-up fact is a liability; an honest gap he can see is not');
});

test('tool-call markup that leaks into a field is thrown away, not shown', async () => {
  // Seen live, 2026-08-18, in the SUGGESTED REPLY box on a cold pitch:
  //   </antml>
  //   <parameter name="reply">
  // strict:true validates the SHAPE, not the sense — a string of markup is
  // still a string. That box is one button away from a real client.
  const w = makeWorld({ brief: {
    summary: 'Cold pitch offering business funding lines.',
    action: 'Nothing to do; delete or block the sender',
    label: 'needs_reply',
    reply: '</antml>\n<parameter name="reply">',
  } });
  graphBody(w, '<p>Funding lines!</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.draft, null, 'text that could not have been written for a person never reaches the button');
});

test('junk is never handed a suggested reply', async () => {
  // The prompt says leave it empty for other labels. This makes it true.
  // "Suggested reply" on a cold pitch is an invitation to answer one.
  const w = makeWorld({ brief: {
    summary: 'Cold pitch from a throwaway domain offering funding lines.',
    action: 'Nothing to do; delete or block the sender',
    label: 'junk',
    reply: 'Thanks, please send the details.',
  } });
  graphBody(w, '<p>Funding lines!</p>');
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.label, 'junk');
  assert.equal(r.body.draft, null);
});

// Chris, 2026-08-18: "the suggested response needs a way to edit it or change
// it to create a different anwser."

test('a rewrite is given the draft it is replacing', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'needs_reply', subject: 'Quote?', from_address: 'ken@x.com',
                draft_text: 'The long original draft.' }];
  w.anthropic.messages.create = async (params) => { w.modelCalls.push(params); return { content: [{ type: 'text', text: 'Short one.' }] }; };
  graphBody(w, '<p>Any word on the quote?</p>');

  const r = await call(w, 'draft', { messageId: '<a@mail>', instruction: 'Make it shorter.', previous: 'The long original draft.' });
  assert.equal(r.statusCode, 200);
  const prompt = w.modelCalls[0].messages[0].content;
  assert.match(prompt, /Rewrite his reply/, 'not a fresh draft — this one, redone');
  assert.match(prompt, /The long original draft\./, 'the attempt being replaced is in the prompt');
  assert.match(prompt, /Make it shorter\./);
});

test('asking again with no instruction asks for something different', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'needs_reply', draft_text: 'First attempt.' }];
  w.anthropic.messages.create = async (params) => { w.modelCalls.push(params); return { content: [{ type: 'text', text: 'Second attempt.' }] }; };
  graphBody(w, '<p>hi</p>');
  await call(w, 'draft', { messageId: '<a@mail>', previous: 'First attempt.' });
  assert.match(w.modelCalls[0].messages[0].content, /Write a different reply/,
    'otherwise "try again" hands back the same words');
});

test('his edit is stored, and clearing it is a decision', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'needs_reply', draft_text: 'Reina wrote this.' }];

  const r = await call(w, 'draft_save', { messageId: '<a@mail>', draft: 'Chris wrote this instead.' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.draft, 'Chris wrote this instead.');
  assert.equal(w.patched[0].patch.draft_text, 'Chris wrote this instead.');

  const cleared = await call(w, 'draft_save', { messageId: '<a@mail>', draft: '   ' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(w.patched[1].patch.draft_text, null,
    'an empty box means he does not want one — not that the write failed');
});

test('saving a draft for a message that is not there says so', async () => {
  const w = makeWorld();
  w.stored = [];
  const r = await call(w, 'draft_save', { messageId: '<gone@mail>', draft: 'x' });
  assert.equal(r.statusCode, 404);
});

// ---- what is waiting on him -------------------------------------------------
// Chris, 2026-08-18: "Comms notifications should popup on every screen in
// hivelogic ... address it quickly with reina summary and suggested way to
// respond or act on it."

test('pending returns only what is actually waiting, and costs no model call', async () => {
  const w = makeWorld();
  const r = await call(w, 'pending', {});
  assert.equal(r.statusCode, 200);
  assert.equal(w.modelCalls.length, 0, 'it reads what triage already wrote — it can be polled for free');

  const url = w.sbCalls.map((c) => c.path).find((p) => p.includes('acted_at=is.null'));
  assert.ok(url, 'anything he has handled is gone');
  // Junk and FYI must never interrupt him: a popup that fires for a receipt is
  // one he learns to dismiss without reading.
  assert.ok(!/junk/.test(url) && !/fyi/.test(url), 'junk and fyi are not in the query at all');
  for (const label of ['needs_reply', 'needs_scheduling', 'needs_action']) {
    assert.ok(url.includes(label), label + ' is');
  }
  // A correction he made outranks the model's label here too.
  assert.match(url, /corrected_label/);
});

test('an item carries the summary and the reply, or says it has not been read yet', async () => {
  const w = makeWorld();
  w.stored = [
    { owner_id: OWNER, message_id: '<a@mail>', label: 'needs_reply', from_name: 'Ken', subject: 'Quote?',
      summary_text: 'Ken is chasing the survey quote.', action_text: 'Send Ken the price', draft_text: 'Hi Ken —' },
    { owner_id: OWNER, message_id: '<b@mail>', label: 'needs_action', from_address: 'a@x.com', subject: 'Report',
      summary_text: null, reason: 'Approve the revised service report' },
  ];
  const r = await call(w, 'pending', {});
  const [a, b] = r.body.items;
  assert.equal(a.summary, 'Ken is chasing the survey quote.');
  assert.equal(a.draft, 'Hi Ken —');
  assert.equal(a.brief, true);
  // The summary only exists once he has opened it; before that the one-line
  // reason is what there is, and saying so beats showing an empty card.
  assert.equal(b.summary, null);
  assert.equal(b.action, 'Approve the revised service report');
  assert.equal(b.brief, false);
});

test('the popup can send a reply, and it is recorded only after Graph took it', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'needs_reply', from_address: 'ken@x.com' }];
  const sent = [];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).endsWith('/reply')) { sent.push({ url: String(url), body: JSON.parse(opts.body) }); return gRes({}, 202); }
      return inner(url, opts);
    };
  })(w.fetchImpl);

  const r = await call(w, 'reply', { messageId: '<a@mail>', text: 'Thursday works.' });
  assert.equal(r.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.comment, 'Thursday works.', 'exactly the text that was on his screen');
  const acted = w.patched.find((x) => x.patch.acted_action === 'replied');
  assert.ok(acted, 'and it is marked handled');
});

test('a send that Graph refuses does NOT mark the message handled', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).endsWith('/reply')) return gRes({ error: { message: 'mailbox is over quota' } }, 507);
      return inner(url, opts);
    };
  })(w.fetchImpl);

  const r = await call(w, 'reply', { messageId: '<a@mail>', text: 'hi' });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /over quota/);
  assert.ok(!w.patched.some((x) => x.patch.acted_action), 'a failed send must never look dealt with');
});

test('a Gmail message is not sent from here, and says where to do it', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'im_1', home_account_id: 'imap:g@gmail.com', label: 'needs_reply' }];
  const r = await call(w, 'reply', { messageId: '<a@mail>', text: 'hi' });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /open it there/);
});

test('an empty reply is refused before it reaches a mailbox', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  const r = await call(w, 'reply', { messageId: '<a@mail>', text: '   ' });
  assert.equal(r.statusCode, 400);
  assert.equal(w.graphCalls.filter((c) => c.url.endsWith('/reply')).length, 0);
});

// ---- unsubscribe ------------------------------------------------------------
// Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or just
// push to junk only?"

test('one-click is recorded only when the sender promised to honour it', async () => {
  const w = makeWorld();
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).includes('graph.microsoft.com/v1.0/me/messages/')) {
        return gRes({ body: { contentType: 'text', content: 'Sale!' }, internetMessageHeaders: [
          { name: 'List-Unsubscribe', value: '<https://faire.example/u/abc>, <mailto:u@faire.example>' },
          { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
        ] });
      }
      return inner(url, opts);
    };
  })(w.fetchImpl);
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.deepEqual(r.body.unsubscribe, {
    oneClick: 'https://faire.example/u/abc',
    web: 'https://faire.example/u/abc',
    mailto: 'u@faire.example',
  });
  assert.deepEqual(w.inserted[0].unsubscribe, r.body.unsubscribe, 'and stored, so the second open needs no headers call');
});

// Chris, 2026-08-18: "unsubscribe didnt work". Six Gmail messages already
// briefed, zero carrying any unsubscribe data — read the hour before the feature
// shipped, and "written once" meant the cached path returned them untouched
// forever. The button never appeared and never would have.
test('a message briefed before unsubscribe existed gets it filled in', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'junk', summary_text: 'Marketing from Faire.', action_text: 'Nothing to do',
                brief_at: '2026-08-18T14:00:00Z', unsubscribe: null }];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).includes('$select=internetMessageHeaders')) {
        return gRes({ internetMessageHeaders: [
          { name: 'List-Unsubscribe', value: '<https://faire.example/u/abc>' },
          { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
        ] });
      }
      return inner(url, opts);
    };
  })(w.fetchImpl);

  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.cached, true, 'still cached — the expensive half stays written-once');
  assert.equal(w.modelCalls.length, 0, 'and it costs no model call');
  assert.equal(r.body.unsubscribe.oneClick, 'https://faire.example/u/abc');
  const patched = w.patched.find((x) => x.patch.unsubscribe);
  assert.ok(patched, 'and it is written down, so the next open does not look again');
});

test('a message with no unsubscribe link is asked about exactly once', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'junk', summary_text: 'Cold pitch.', brief_at: '2026-08-18T14:00:00Z', unsubscribe: null }];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).includes('$select=internetMessageHeaders')) return gRes({ internetMessageHeaders: [{ name: 'Subject', value: 'hi' }] });
      return inner(url, opts);
    };
  })(w.fetchImpl);

  const r = await call(w, 'brief', BRIEF_MSG);
  // Stored as all-nulls rather than left null: "we looked and there is nothing"
  // is a different fact from "nobody has looked", and only one is worth redoing.
  assert.deepEqual(r.body.unsubscribe, { oneClick: null, web: null, mailto: null });
  const patched = w.patched.find((x) => x.patch.unsubscribe);
  assert.ok(patched, 'the absence is recorded too');
});

test('a row that already looked is not looked at again', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
                label: 'junk', summary_text: 'Marketing.', brief_at: '2026-08-18T14:00:00Z',
                unsubscribe: { oneClick: null, web: null, mailto: null } }];
  const before = w.graphCalls.length;
  const r = await call(w, 'brief', BRIEF_MSG);
  assert.equal(r.body.cached, true);
  assert.equal(w.graphCalls.length, before, 'no mailbox read at all');
});

test('a link without the one-click promise is offered, but not fired', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', label: 'junk', from_address: 'spam@throwaway.tld',
                unsubscribe: { oneClick: null, web: 'https://throwaway.tld/u?id=1', mailto: null } }];
  const r = await call(w, 'unsubscribe', { messageId: '<b1@mail>' });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /does not support one-click/);
  assert.match(r.body.error, /move it to Junk/, 'and it says what to do instead');
});

test('the unsubscribe target comes from the stored row, never from the caller', async () => {
  // Otherwise this route is a way to make our server POST anywhere anyone likes.
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', label: 'junk',
                unsubscribe: { oneClick: 'https://faire.example/u/abc', web: null, mailto: null } }];
  const posted = [];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).startsWith('https://faire.example')) { posted.push({ url: String(url), opts }); return gRes({}, 200); }
      return inner(url, opts);
    };
  })(w.fetchImpl);

  const r = await call(w, 'unsubscribe', { messageId: '<b1@mail>', url: 'https://attacker.example/pwn' });
  assert.equal(r.statusCode, 200);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://faire.example/u/abc', 'the caller names a message, not a destination');
  assert.equal(posted[0].opts.method, 'POST');
  assert.equal(posted[0].opts.body, 'List-Unsubscribe=One-Click', 'exactly what RFC 8058 says');
});

test('an unsubscribe endpoint that fails says so instead of claiming success', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<b1@mail>', label: 'junk',
                unsubscribe: { oneClick: 'https://faire.example/u/abc', web: null, mailto: null } }];
  w.fetchImpl = (function (inner) {
    return async (url, opts) => {
      if (String(url).startsWith('https://faire.example')) return gRes({}, 500);
      return inner(url, opts);
    };
  })(w.fetchImpl);
  const r = await call(w, 'unsubscribe', { messageId: '<b1@mail>' });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /500/);
});

test('a one-click URL somewhere we should not send a request is refused', () => {
  // The URL comes out of a stranger's email. The host is the whole risk.
  for (const bad of ['http://faire.example/u', 'https://127.0.0.1/u', 'https://10.0.0.5/u',
                     'https://192.168.1.9/u', 'https://169.254.169.254/latest/meta-data',
                     'https://localhost/u', 'file:///etc/passwd', 'not a url']) {
    assert.equal(lib.safeUnsubscribeUrl(bad), null, bad + ' must be refused');
  }
  assert.equal(lib.safeUnsubscribeUrl('https://faire.example/u/abc'), 'https://faire.example/u/abc');
});

test('brief refuses a message with no id', async () => {
  const w = makeWorld();
  const r = await call(w, 'brief', {});
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /messageId is required/);
});

// ---- the live failure of 2026-08-18 -----------------------------------------
// Chris: "none of the dropdown choices worked when I tried to select them
// either." Fifty triaged messages in the table and not one stored correction --
// while `act`, which goes straight to its PATCH, had recorded his one tap. The
// only thing `correct` did that `act` did not was read the row first.

test('the correction is written before anything else is allowed to fail', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'fyi', from_address: 'sam@acme.com', subject: 'Invoice' }];
  w.sbCalls = [];
  const r = await call(w, 'correct', { messageId: '<a@mail>', label: 'needs_reply' });
  assert.equal(r.statusCode, 200);

  const onTriage = w.sbCalls.filter((c) => c.path.startsWith('reina_mail_triage?'));
  assert.equal(onTriage[0].method, 'PATCH',
    'the update goes first; a read in front of it is one more thing between him and a saved correction');
  assert.equal(w.patched[0].patch.corrected_label, 'needs_reply');
});

test('a correction still saves when the standing rule cannot be', async () => {
  const w = makeWorld({ ruleUpsertFails: true });
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'fyi', from_address: 'sam@acme.com', subject: 'Invoice' }];
  const r = await call(w, 'correct', { messageId: '<a@mail>', label: 'needs_reply' });
  // The rule is an optimization -- it saves a model call next time. The
  // correction is the thing he actually asked for. Losing the cheap half must
  // never cost the important half.
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ruleSaved, false, 'and it says the rule did not stick');
  assert.equal(w.patched[0].patch.corrected_label, 'needs_reply');
});

test('correcting a message that is not there says so, rather than reporting success', async () => {
  const w = makeWorld();
  w.stored = [];
  const r = await call(w, 'correct', { messageId: '<gone@mail>', label: 'junk' });
  assert.equal(r.statusCode, 404);
  assert.match(r.body.error, /no triage row/);
});

// Chris, 2026-08-18, reading the header this fix put there:
//   "couldn't save 6 verdicts — {"code":"21000", ... Ensure that no rows
//    proposed for insertion within the same command have duplicate ...}"
// That is a cardinality_violation, and it fails the WHOLE upsert. It is why the
// triage table held fifty Gmail rows and not a single Microsoft one.
test('mail sent to both mailboxes is upserted once, not twice in one command', async () => {
  const w = makeWorld({
    mailboxes: [
      { home_account_id: 'mbx-a', username: 'chris@ghgrp.net', access_token: 'tok-a', refresh_token: 'r-a', expires_at: '2099-01-01T00:00:00Z' },
      { home_account_id: 'mbx-b', username: 'chris@greenwichhandyman.net', access_token: 'tok-b', refresh_token: 'r-b', expires_at: '2099-01-01T00:00:00Z' },
    ],
  });
  const both = (id) => ({
    id, internetMessageId: '<same@mail>', subject: 'Quick question?',
    from: { emailAddress: { address: 'sam@acme.com', name: 'Sam' } },
    receivedDateTime: new Date().toISOString(), bodyPreview: 'hi', isRead: false,
  });
  // One email, addressed to both of his addresses: a separate copy in each
  // mailbox, ONE internetMessageId -- the key this table is unique on.
  w.graphMessages['mbx-a'] = [both('graph-a')];
  w.graphMessages['mbx-b'] = [both('graph-b')];

  const r = await call(w, 'list', {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.storeError, null, 'the write must not blow up on its own duplicate');

  const keys = w.inserted.map((row) => row.owner_id + '|' + row.message_id);
  assert.equal(new Set(keys).size, keys.length,
    'two rows with the same constrained values in one upsert is error 21000, not a merge');
  assert.equal(w.inserted.length, 1);
  assert.equal(r.body.rows.length, 1, 'and he sees one email, because it is one email');
});

test('the same email in two mailboxes is classified once, not paid for twice', async () => {
  const w = makeWorld({
    mailboxes: [
      { home_account_id: 'mbx-a', username: 'a@x', access_token: 'tok-a', refresh_token: 'r-a', expires_at: '2099-01-01T00:00:00Z' },
      { home_account_id: 'mbx-b', username: 'b@x', access_token: 'tok-b', refresh_token: 'r-b', expires_at: '2099-01-01T00:00:00Z' },
    ],
  });
  const both = (id) => ({
    id, internetMessageId: '<same@mail>', subject: 'Quick question?',
    from: { emailAddress: { address: 'sam@acme.com', name: 'Sam' } },
    receivedDateTime: new Date().toISOString(), bodyPreview: 'hi', isRead: false,
  });
  w.graphMessages['mbx-a'] = [both('graph-a')];
  w.graphMessages['mbx-b'] = [both('graph-b')];
  const r = await call(w, 'list', {});
  assert.equal(r.body.classified, 1, 'one message, one verdict');
});

test('a draft is stored once written, so the next look is free', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'im_1', home_account_id: 'imap:g@gmail.com',
                label: 'needs_reply', subject: 'Question', from_address: 'sam@acme.com' }];
  w.anthropic.messages.create = async () => ({ content: [{ type: 'text', text: 'Yes, Thursday works.' }] });
  const r = await call(w, 'draft', { messageId: '<a@mail>', bodyText: 'Does Thursday work?' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.draft, 'Yes, Thursday works.');
  const saved = w.patched.find((x) => x.patch.draft_text);
  assert.ok(saved, 'the draft is written back to the row');
  assert.equal(saved.patch.draft_text, 'Yes, Thursday works.');
  assert.equal(saved.patch.draft_error, null, 'and any earlier failure is cleared');
});

test('a verdict that could not be stored is reported, not swallowed', async () => {
  const w = makeWorld({ insertFails: true });
  w.graphMessages['mbx-a'] = [
    { id: 'g1', internetMessageId: '<q@mail>', subject: 'Quick question?', from: { emailAddress: { address: 'sam@acme.com', name: 'Sam' } }, receivedDateTime: new Date().toISOString(), bodyPreview: 'hi', isRead: false },
  ];
  const r = await call(w, 'list', {});
  assert.equal(r.statusCode, 200);
  // The labels are still usable this time round -- but they will be paid for
  // again, and any correction made against them lands on nothing. A list that
  // looks identical whether or not it saved is the failure worth naming.
  assert.ok(r.body.rows.length, 'the labels are still shown');
  assert.ok(r.body.storeError, 'and the failure to save them is stated');
  assert.match(r.body.storeError, /1 verdict/);
});

test('a normal scan reports no store error at all', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [
    { id: 'g1', internetMessageId: '<q@mail>', subject: 'Quick question?', from: { emailAddress: { address: 'sam@acme.com', name: 'Sam' } }, receivedDateTime: new Date().toISOString(), bodyPreview: 'hi', isRead: false },
  ];
  const r = await call(w, 'list', {});
  assert.equal(r.body.storeError, null, 'the warning must mean something when it does appear');
});

test('a failure names the step it happened in', async () => {
  // "could not read that message" meant the row lookup, the mailbox fetch, and
  // a client-side empty body -- three different faults, one indistinguishable
  // toast. Chris saw it and could not tell which had happened; nor could I.
  const src = readFileSync(new URL('../api/reina/mail-triage.js', import.meta.url), 'utf-8');
  const occurrences = (src.match(/could not read that message/g) || []).length;
  assert.equal(occurrences, 0, 'every failure message here must be unique to its step');
});

test('a correction to an unknown label is refused', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', from_address: 'x@y.com', label: 'fyi' }];
  const r = await call(w, 'correct', { messageId: '<a@mail>', label: 'archive_everything' });
  assert.equal(r.statusCode, 400);
  assert.equal(w.rulesUpserted.length, 0, 'a bad label must never become a standing rule');
});

// ---- honest gaps ------------------------------------------------------------

test('a failed classification leaves the count of unlabelled mail visible', async () => {
  const w = makeWorld({ classifyThrows: 'model unavailable' });
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<a@mail>', subject: 'One' }),
    msg({ internetMessageId: '<b@mail>', subject: 'Two' }),
  ];
  const r = await call(w, 'list');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rows.length, 0);
  assert.equal(r.body.unlabelled, 2, 'a short list presented as the whole inbox is the failure that matters');
  assert.match(r.body.classifyError, /model unavailable/);
});

test('with no classifier available, standing rules still work and the rest is reported unlabelled', async () => {
  const w = makeWorld();
  w.anthropic = null;
  w.rules = [{ id: 'r1', match_kind: 'sender', match_value: 'known@vendor.com', label: 'junk', hits: 0 }];
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<a@mail>', from: { emailAddress: { address: 'known@vendor.com', name: 'V' } } }),
    msg({ internetMessageId: '<b@mail>', from: { emailAddress: { address: 'stranger@x.com', name: 'S' } } }),
  ];
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].label, 'junk');
  assert.equal(r.body.unlabelled, 1);
});

test('no connected mailbox says so plainly instead of showing an empty inbox', async () => {
  const w = makeWorld({ mailboxes: [] });
  const r = await call(w, 'list');
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.rows, []);
  assert.match(r.body.note, /No mailbox connected/);
});

test('a dead mailbox is an error, not an empty list', async () => {
  const w = makeWorld({ graphStatus: 503 });
  w.graphMessages['mbx-a'] = [msg()];
  const r = await call(w, 'list');
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.ok, false);
});

test('two mailboxes are triaged together, each read with its own token', async () => {
  const w = makeWorld({
    mailboxes: [
      { home_account_id: 'mbx-a', access_token: 'tok-a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
      { home_account_id: 'mbx-b', access_token: 'tok-b', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
    ],
  });
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'Quick question' })];
  w.graphMessages['mbx-b'] = [msg({ internetMessageId: '<b@mail>', subject: 'Invoice due' })];
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.mailboxesRead, 2);
  // Filtered to the INBOX reads: drafting a reply also fetches that message's
  // body, so a bare call count would now be counting two different things.
  const inboxReads = w.graphCalls.filter((c) => c.url.includes('mailFolders/inbox'));
  assert.deepEqual(inboxReads.map((c) => c.token).sort(), ['tok-a', 'tok-b']);
});

// ---- auth -------------------------------------------------------------------

test('an unauthenticated caller reads nobody\'s mail', async () => {
  const w = makeWorld({ authOk: false });
  const req = { method: 'POST', query: { action: 'list' }, headers: {}, body: {} };
  const r = res();
  await route.default(req, r, { supabaseRequest: w.supabaseRequest, fetchImpl: w.fetchImpl, anthropic: w.anthropic });
  assert.equal(r.statusCode, 401);
  assert.equal(w.graphCalls.length, 0);
});

test('every read is scoped to the caller -- one table holds everyone\'s mail', async () => {
  const w = makeWorld();
  const paths = [];
  const inner = w.supabaseRequest;
  w.supabaseRequest = async (p, o) => { paths.push(String(p)); return inner(p, o); };
  w.graphMessages['mbx-a'] = [msg()];
  await call(w, 'list');
  for (const p of paths.filter((x) => x.startsWith('reina_mail_triage') && !x.includes('id=eq.'))) {
    assert.ok(p.includes(`owner_id=eq.${OWNER}`) || p.startsWith('reina_mail_triage?on_conflict'),
      `unscoped read of a shared table: ${p}`);
  }
});

// ---- the classifier contract ------------------------------------------------

test('the model is forced through a strict tool, so a verdict cannot be malformed', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ subject: 'Quick question' })];
  await call(w, 'list');
  const params = w.modelCalls[0];
  assert.equal(params.tool_choice.name, 'record_triage');
  assert.equal(params.tools[0].strict, true);
  assert.equal(params.tools[0].input_schema.additionalProperties, false);
  const labelProp = params.tools[0].input_schema.properties.verdicts.items.properties.label;
  assert.deepEqual(labelProp.enum, lib.MAIL_TRIAGE_LABELS);
});

test('a verdict referring to a message that was not in the batch is dropped, not misfiled', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'One' })];
  w.anthropic = {
    messages: {
      create: async () => ({ content: [{ type: 'tool_use', name: 'record_triage', input: { verdicts: [
        { ref: 0, label: 'needs_reply', reason: 'ok', confidence: 'high' },
        { ref: 7, label: 'junk', reason: 'nope', confidence: 'high' },   // no such message
      ] } }] }),
    },
  };
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 1, 'a verdict we cannot attribute to a message must never be stored');
  assert.equal(r.body.rows[0].label, 'needs_reply');
});

test('only the preview goes to the model -- never a whole mail body', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ subject: 'Hi', bodyPreview: 'x'.repeat(5000) })];
  await call(w, 'list');
  const prompt = w.modelCalls[0].messages[0].content;
  assert.ok(prompt.length < 3000, 'the preview is capped; full bodies are not this feature\'s to send');
  const graphUrl = w.graphCalls[0].url;
  assert.ok(graphUrl.includes('bodyPreview'), 'the read asks for the preview...');
  assert.ok(!/\$select=[^&]*\bbody\b(?!Preview)/.test(graphUrl), '...and never the full body');
});

test('the batch size and lookback are stated, not implicit', () => {
  assert.equal(lib.MAIL_TRIAGE_BATCH_SIZE, 25);
  assert.equal(route.MAIL_TRIAGE_LOOKBACK_DAYS, 30);
  assert.ok(lib.chunkForTriage(new Array(60).fill(0)).length === 3, '60 messages is 3 calls, not 60');
});

// ---- the Graph read shape ---------------------------------------------------
// Found live (2026-08-17): the page produced no list at all and zero rows were
// written. The read had asked Graph to filter on TWO properties while ordering
// by one of them -- `isRead eq false and receivedDateTime ge X` with
// `$orderby=receivedDateTime desc` -- which Graph rejects outright ("The
// restriction or sort order is too complex to complete"). The single-property
// filter below is the one already proven against these same mailboxes by the
// Team To-Do "emails awaiting reply" read.

test('the inbox read filters and orders on the SAME property', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg()];
  await call(w, 'list');
  const url = decodeURIComponent(w.graphCalls[0].url);
  assert.ok(/\$filter=receivedDateTime ge /.test(url), 'the window is the filter');
  assert.ok(!/isRead/.test(url.split('$select')[0]),
    'filtering on isRead while ordering by receivedDateTime is what Graph refuses');
  assert.ok(url.includes('$orderby=receivedDateTime desc'));
});

// ---- read mail counts -------------------------------------------------------
// Chris, 2026-08-17: "why not have it read all of today's emails even if
// they're shown read." Reading mail on a phone marks what his eyes have passed
// over, not what he has dealt with.

test('mail he has already READ is still triaged', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<read@mail>', subject: 'Quick question about the quote', isRead: true }),
  ];
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 1, 'a client question glanced at on a phone is exactly what this page is for');
  assert.equal(r.body.rows[0].label, 'needs_reply');
  assert.equal(r.body.rows[0].is_read, true, 'and the row says it has been read');
});

// ---- the watermark ----------------------------------------------------------
// Chris: "let's say I don't check in with reina for 3 days, she'll go back and
// check all from the last read email."

test('a first-ever scan starts at today, not at the whole lookback', () => {
  const now = Date.parse('2026-08-17T18:00:00Z');           // 2pm America/New_York
  const start = route.scanWindowStartMs(now, 0);
  assert.equal(new Date(start).toISOString(), '2026-08-17T04:00:00.000Z',
    'midnight America/New_York, not 30 days of history on first run');
});

test('after a three-day gap the window reaches back to where the last scan got to', () => {
  const now = Date.parse('2026-08-17T18:00:00Z');
  const threeDaysAgo = Date.parse('2026-08-14T15:00:00Z');
  const start = route.scanWindowStartMs(now, threeDaysAgo);
  assert.ok(start < Date.parse('2026-08-14T15:00:01Z'), 'it must reach back past the last thing it saw');
  assert.equal(new Date(start).toISOString(), '2026-08-14T14:00:00.000Z',
    'one hour of overlap, for mail that lands out of order');
});

test('checking in daily keeps the window at today -- yesterday is not re-scanned', () => {
  const now = Date.parse('2026-08-17T18:00:00Z');
  const anHourAgo = now - 3600000;
  const start = route.scanWindowStartMs(now, anHourAgo);
  assert.equal(new Date(start).toISOString(), '2026-08-17T04:00:00.000Z',
    'the window never starts later than midnight today');
});

test('the lookback is a hard floor -- a long absence does not swallow the archive', () => {
  const now = Date.parse('2026-08-17T18:00:00Z');
  const ancient = Date.parse('2020-01-01T00:00:00Z');
  const start = route.scanWindowStartMs(now, ancient);
  assert.equal(start, now - 30 * 86400000, 'a year away still means 30 days, not five years');
});

test('the watermark is per mailbox -- one falling behind does not drag the other back', () => {
  const stored = [
    { home_account_id: 'mbx-a', received_at: '2026-08-17T12:00:00Z' },
    { home_account_id: 'mbx-b', received_at: '2026-08-14T12:00:00Z' },
  ];
  assert.equal(route.scanWatermarkMs(stored, 'mbx-a'), Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(route.scanWatermarkMs(stored, 'mbx-b'), Date.parse('2026-08-14T12:00:00Z'));
});

test('the watermark comes from stored VERDICTS, so a half-finished scan re-runs', () => {
  // Derived from what actually got a verdict, not from a "last run at" column.
  // A column would record "scanned" for mail that never got labelled, and that
  // mail would then be skipped forever.
  assert.equal(route.scanWatermarkMs([], 'mbx-a'), 0, 'nothing stored means nothing was scanned');
  assert.equal(route.scanWatermarkMs([{ home_account_id: 'mbx-a', received_at: 'garbage' }], 'mbx-a'), 0);
});

test('a multi-day catch-up follows Graph pagination instead of stopping at one page', async () => {
  const w = makeWorld();
  let served = 0;
  const inner = w.fetchImpl;
  w.fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('graph.microsoft.com')) {
      w.graphCalls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), token: 'tok-a' });
      served++;
      if (served === 1) {
        return gRes({
          value: [msg({ internetMessageId: '<p1@mail>', subject: 'Page one' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
        });
      }
      return gRes({ value: [msg({ internetMessageId: '<p2@mail>', subject: 'Page two' })] });
    }
    return inner(url, opts);
  };
  const r = await call(w, 'list');
  assert.equal(served, 2, '"I did not check in all week" must not silently become "the newest page"');
  assert.equal(r.body.rows.length, 2);
});

test('the response says how far back it reached', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg()];
  const r = await call(w, 'list');
  assert.ok(r.body.scannedSince, 'a three-day catch-up should be visible as one, not look like a busy day');
  assert.ok(!isNaN(Date.parse(r.body.scannedSince)));
});

// ---- one message, two mailboxes ---------------------------------------------
// Seen live (2026-08-17): a message sent to BOTH of Chris's addresses rendered
// as two identical lines. Each mailbox holds its own copy, but it is one
// message with one internetMessageId, so there is one verdict and there must
// be one row.

test('a message sent to both mailboxes appears once, not twice', async () => {
  const w = makeWorld({
    mailboxes: [
      { home_account_id: 'mbx-a', access_token: 'tok-a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
      { home_account_id: 'mbx-b', access_token: 'tok-b', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
    ],
  });
  const both = msg({ internetMessageId: '<same@mail>', subject: 'Quick question about the pool' });
  w.graphMessages['mbx-a'] = [both];
  w.graphMessages['mbx-b'] = [{ ...both, id: 'graph-copy-b' }];
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 1, 'one message, one line');
  assert.equal(r.body.rows[0].message_id, '<same@mail>');
});

test('a copy still unread in the other mailbox keeps the message unread', async () => {
  const w = makeWorld({
    mailboxes: [
      { home_account_id: 'mbx-a', access_token: 'tok-a', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
      { home_account_id: 'mbx-b', access_token: 'tok-b', refresh_token: 'r', expires_at: '2099-01-01T00:00:00Z' },
    ],
  });
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<same@mail>', isRead: true })];
  w.graphMessages['mbx-b'] = [msg({ internetMessageId: '<same@mail>', id: 'copy-b', isRead: false })];
  const r = await call(w, 'list');
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].is_read, false, 'an unread copy elsewhere means he has not read it');
});

// ---- the one-tap actions ----------------------------------------------------
// Chris, 2026-08-17: "now do the one-tap actions."
//
// The rule they all obey: this route RECORDS, it does not PERFORM. The doing
// happens in the mail app with the mail app's own controls, so "Reina suggested
// it" and "a human did it" never blur together.

test('recording an action takes the message off the list and out of the to-do count', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'needs_reply' }];
  const r = await call(w, 'act', { messageId: '<a@mail>', action: 'replied' });
  assert.equal(r.statusCode, 200);
  assert.equal(w.patched[0].patch.acted_action, 'replied');
  assert.ok(w.patched[0].patch.acted_at);
});

test('an invented action is refused', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'junk' }];
  const r = await call(w, 'act', { messageId: '<a@mail>', action: 'send_it' });
  assert.equal(r.statusCode, 400);
  assert.equal(w.patched.length, 0);
});

test('recording against a message with no triage row is a 404, not a silent success', async () => {
  const w = makeWorld();
  w.stored = [];
  const r = await call(w, 'act', { messageId: '<nope@mail>', action: 'dismissed' });
  assert.equal(r.statusCode, 404);
});

// ---- drafting ---------------------------------------------------------------

test('drafting returns TEXT and writes nothing to the mailbox', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a',
    subject: 'Can you do Thursday?', from_address: 'client@x.com', label: 'needs_reply' }];
  w.anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Thursday works. See you at 9.' }] }) } };
  const r = await call(w, 'draft', { messageId: '<a@mail>' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.draft, 'Thursday works. See you at 9.');
  for (const c of w.graphCalls) {
    assert.equal(c.method, 'GET', 'drafting must never write to the mailbox -- the send button is his');
  }
});

test('a draft with an unfillable blank is flagged as having blanks', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  w.anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'We can start [CONFIRM DATE] once the parts land.' }] }) } };
  const r = await call(w, 'draft', { messageId: '<a@mail>' });
  assert.equal(r.body.hasBlanks, true,
    'an unnoticed blank is how [CONFIRM DATE] reaches a client');
});

test('a clean draft is not flagged', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  w.anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Yes, Thursday at 9 works.' }] }) } };
  const r = await call(w, 'draft', { messageId: '<a@mail>' });
  assert.equal(r.body.hasBlanks, false);
});

test('drafting reads the FULL body -- the preview triage uses cannot answer an email', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  let asked = null;
  w.anthropic = { messages: { create: async (p) => { asked = p; return { content: [{ type: 'text', text: 'ok' }] }; } } };
  await call(w, 'draft', { messageId: '<a@mail>' });
  const url = w.graphCalls[0].url;
  assert.ok(url.includes('/me/messages/g1'), 'it fetches that ONE message');
  assert.ok(url.includes('body'), 'and its body');
  assert.ok(asked, 'and hands it to the model');
});

test('drafting without a classifier fails loudly instead of returning an empty reply', async () => {
  const w = makeWorld();
  w.anthropic = null;
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-a', label: 'needs_reply' }];
  const r = await call(w, 'draft', { messageId: '<a@mail>' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.ok, false);
});

test('drafting a message whose mailbox is gone says so rather than guessing', async () => {
  const w = makeWorld({ mailboxes: [] });
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', graph_id: 'g1', home_account_id: 'mbx-gone', label: 'needs_reply' }];
  const r = await call(w, 'draft', { messageId: '<a@mail>' });
  assert.equal(r.statusCode, 409);
});

test('the whole route still never sends, moves or deletes mail', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/reina/mail-triage.js', import.meta.url), 'utf-8'));
  for (const verb of ['/sendMail', '/move', "method: 'DELETE'", '/createReply']) {
    assert.ok(!src.includes(verb),
      `${verb} does not belong here -- the mail app performs, this route records`);
  }
});

// ---- the IMAP path ----------------------------------------------------------
// Chris, 2026-08-17: "now do the gmail inbox." A Gmail mailbox has no Graph and
// its credentials live in the other project, so the browser -- which is already
// authenticated to /api/mail for it -- hands the envelopes in and this route
// judges them by exactly the same standard.

test('handed-in messages are judged and stored like any other', async () => {
  const w = makeWorld();
  const r = await call(w, 'classify', {
    account: 'greenwichhandyman@gmail.com',
    messages: [
      { messageId: '<g1@mail.gmail.com>', graphId: 'im_abc', subject: 'Quick question about the deck', fromAddress: 'a@b.com', receivedAt: '2026-08-17T12:00:00Z' },
      { messageId: '<g2@mail.gmail.com>', graphId: 'im_def', subject: 'Special offer inside', fromAddress: 'blast@x.com', receivedAt: '2026-08-17T11:00:00Z' },
    ],
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.rows[0].label, 'needs_reply');
  assert.equal(r.body.rows[1].label, 'junk');
});

test('an IMAP row is tagged as one, so later steps know it has no Graph', async () => {
  const w = makeWorld();
  await call(w, 'classify', {
    account: 'GreenwichHandyman@Gmail.com',
    messages: [{ messageId: '<g1@mail>', graphId: 'im_abc', subject: 'Hello', fromAddress: 'a@b.com' }],
  });
  assert.equal(w.inserted[0].home_account_id, 'imap:greenwichhandyman@gmail.com',
    'the imap: prefix is what tells archive and drafting to take a different path');
});

test("a standing rule applies across mailboxes -- a sender he junked is junk everywhere", async () => {
  const w = makeWorld();
  w.rules = [{ id: 'r1', match_kind: 'sender', match_value: 'blast@x.com', label: 'junk', hits: 0 }];
  const r = await call(w, 'classify', {
    account: 'greenwichhandyman@gmail.com',
    messages: [{ messageId: '<g1@mail>', graphId: 'im_a', subject: 'Quick question', fromAddress: 'Blast@X.com' }],
  });
  assert.equal(w.modelCalls.length, 0, 'his judgement carries over; the model is not asked again');
  assert.equal(r.body.rows[0].label, 'junk');
});

test('a message already judged is not re-judged when handed in again', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<g1@mail>', label: 'needs_action', home_account_id: 'imap:x@y.com' }];
  const r = await call(w, 'classify', {
    account: 'x@y.com',
    messages: [{ messageId: '<g1@mail>', graphId: 'im_a', subject: 'Quick question', fromAddress: 'a@b.com' }],
  });
  assert.equal(w.modelCalls.length, 0);
  assert.equal(r.body.rows[0].label, 'needs_action');
});

test('handed-in fields are length-capped -- these come from the browser', async () => {
  const w = makeWorld();
  await call(w, 'classify', {
    account: 'x@y.com',
    messages: [{ messageId: '<g1@mail>', subject: 'S'.repeat(5000), fromAddress: 'a@b.com', preview: 'P'.repeat(9000) }],
  });
  assert.ok(w.inserted[0].subject.length <= 500, 'a client-supplied subject must not be stored unbounded');
});

test('an oversized batch is refused rather than quietly truncated', async () => {
  const w = makeWorld();
  const many = new Array(200).fill(0).map((_, i) => ({ messageId: '<m' + i + '@x>', subject: 'x', fromAddress: 'a@b.com' }));
  const r = await call(w, 'classify', { account: 'x@y.com', messages: many });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /at most/);
});

test('a message with no id is dropped, not stored under an empty key', async () => {
  const w = makeWorld();
  const r = await call(w, 'classify', {
    account: 'x@y.com',
    messages: [{ subject: 'no id', fromAddress: 'a@b.com' }, { messageId: '<ok@x>', subject: 'Quick question', fromAddress: 'a@b.com' }],
  });
  assert.equal(r.body.rows.length, 1);
});

test('classify with no account is refused', async () => {
  const w = makeWorld();
  const r = await call(w, 'classify', { messages: [] });
  assert.equal(r.statusCode, 400);
});

test('drafting an IMAP reply uses the body handed in, and never touches Graph', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<g1@mail>', graph_id: 'im_a', home_account_id: 'imap:x@y.com',
    subject: 'Can you come Tuesday?', from_address: 'client@x.com', label: 'needs_reply' }];
  w.anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Tuesday works.' }] }) } };
  const r = await call(w, 'draft', { messageId: '<g1@mail>', bodyText: '<p>Can you come Tuesday?</p>' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.draft, 'Tuesday works.');
  assert.equal(w.graphCalls.length, 0, 'an IMAP mailbox is not reachable from the server at all');
});

test('drafting an IMAP reply with no body says what is missing', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<g1@mail>', graph_id: 'im_a', home_account_id: 'imap:x@y.com', label: 'needs_reply' }];
  const r = await call(w, 'draft', { messageId: '<g1@mail>' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /bodyText/);
});

// ---- replies are written in advance -----------------------------------------
// Chris, 2026-08-17: "the replies should be written already by reina for review."
//
// Drafting on tap made the list something you had to interrogate one row at a
// time. Now every needs_reply message gets a draft the first time it is
// triaged, so the list is reviewable in one pass.

test('a needs_reply message comes back with its reply already written', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'Quick question about the deck' })];
  w.anthropic = {
    messages: {
      create: async (params) => {
        // The classifier is tool-forced; the drafter is not. That is how the
        // two calls are told apart.
        if (params.tools) {
          const refs = [...params.messages[0].content.matchAll(/^\[(\d+)\] from:/gm)].map((m) => Number(m[1]));
          return { content: [{ type: 'tool_use', name: 'record_triage', input: { verdicts: refs.map((ref) => ({ ref, label: 'needs_reply', reason: 'Answer the deck question', confidence: 'high' })) } }] };
        }
        return { content: [{ type: 'text', text: 'Yes, the deck can start Monday.' }] };
      },
    },
  };
  const r = await call(w, 'list');
  assert.equal(r.body.rows[0].draft_text, 'Yes, the deck can start Monday.');
  assert.equal(r.body.drafted, 1);
});

test('only needs_reply gets a draft -- junk does not get a reply written for it', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<j@mail>', subject: 'Special offer inside' })];
  let drafts = 0;
  const inner = w.anthropic.messages.create;
  w.anthropic.messages.create = async (params) => { if (!params.tools) drafts++; return inner(params); };
  const r = await call(w, 'list');
  assert.equal(r.body.rows[0].label, 'junk');
  assert.equal(drafts, 0, 'writing a reply to junk is money spent on nothing');
});

test('a draft is written once and never re-derived', async () => {
  const w = makeWorld();
  w.stored = [{ owner_id: OWNER, message_id: '<a@mail>', label: 'needs_reply', graph_id: 'g1',
    home_account_id: 'mbx-a', draft_text: 'the one he has been editing', received_at: '2026-08-17T12:00:00Z' }];
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>' })];
  let drafts = 0;
  const inner = w.anthropic.messages.create;
  w.anthropic.messages.create = async (params) => { if (!params.tools) drafts++; return inner(params); };
  const r = await call(w, 'list');
  assert.equal(drafts, 0, 'a second look must not cost another draft -- nor overwrite one he has edited');
  assert.equal(r.body.rows[0].draft_text, 'the one he has been editing');
});

test('a draft that could not be written says why, rather than looking like silence', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [msg({ internetMessageId: '<a@mail>', subject: 'Quick question' })];
  const inner = w.anthropic.messages.create;
  w.anthropic.messages.create = async (params) => {
    if (!params.tools) throw new Error('drafting service down');
    return inner(params);
  };
  const r = await call(w, 'list');
  assert.equal(r.body.rows[0].label, 'needs_reply');
  assert.match(r.body.rows[0].draft_error, /drafting service down/);
  assert.equal(r.body.draftsFailed, 1);
});

test('one failed draft does not cost the whole triage', async () => {
  const w = makeWorld();
  w.graphMessages['mbx-a'] = [
    msg({ internetMessageId: '<a@mail>', subject: 'Quick question' }),
    msg({ internetMessageId: '<b@mail>', subject: 'Invoice 12 due' }),
  ];
  const inner = w.anthropic.messages.create;
  w.anthropic.messages.create = async (params) => { if (!params.tools) throw new Error('nope'); return inner(params); };
  const r = await call(w, 'list');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rows.length, 2, 'the labels still stand even when a draft fails');
});

test('drafting is bounded, so a long catch-up does not become 200 model calls', async () => {
  assert.equal(route.MAIL_TRIAGE_DRAFT_LIMIT, 12);
});

// ---- the action is spelled out ----------------------------------------------
// Chris: "the action needed on others should be spelled out."

test('the prompt asks for an action specific enough to hand to someone else', () => {
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /hand it to somebody else/);
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /start with the verb/);
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /up to about 20 words/);
  assert.ok(!/at most 12 words/.test(lib.MAIL_TRIAGE_SYSTEM), 'twelve words is not room for a real instruction');
});

test('the prompt shows the difference between weak and specific, not just asks for it', () => {
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /Weak:\s+"Respond about window proposal"/);
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /Right:\s+"Tell Alvaro whether/);
});

test('an unclear preview is admitted rather than turned into an invented specific', () => {
  assert.match(lib.MAIL_TRIAGE_SYSTEM, /say what is unclear rather/);
});
