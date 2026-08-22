// api/_lib/mail-triage.js
//
// Deciding what each unread email actually wants from you.
//
// Chris, 2026-08-17: "Reina reading my emails and determining what's needing a
// response and what needs scheduling and what needs action, flagging junk and
// learning to get better at managing my inbox each day."
//
// THE SHAPE OF "LEARNING", stated plainly so nobody reads more into it than is
// there. Nothing here trains a model. What gets better is the LOOKUP in front
// of the model: every time Chris re-labels a message, that becomes a standing
// rule for the sender (and, when he says so, the domain), plus an example in
// the next prompt. The practical effect is the one that matters -- it stops
// making the SAME mistake twice -- and it is auditable, instant, and free.
// Claiming anything more would be dressing up a cache as intelligence.
//
// Rules answer BEFORE the model, which is also the cost story: a newsletter
// sender Chris has junked once never costs another classification, forever.
//
// WHAT LEAVES THE BUILDING. Subject, sender, timestamp, and Graph's
// `bodyPreview` -- roughly the first 255 characters. Not full bodies, not
// attachments, not threads. That is enough to tell a scheduling request from an
// invoice, and it keeps the blast radius of "my mail goes to a model" small and
// describable. If a label is ever wrong because the preview was too short, the
// correction path is right there and costs one tap.
//
// This module is pure logic + one API call, with every dependency injected, so
// the tests exercise the real decision-making with no network.

export const MAIL_TRIAGE_LABELS = ['needs_reply', 'needs_scheduling', 'needs_action', 'junk', 'fyi'];

// How many messages go into one classification call. Batching is the honest
// cost lever here: one request carrying 25 messages shares a single system
// prompt instead of paying for it 25 times. Not so large that one bad message
// can blow the output cap.
export const MAIL_TRIAGE_BATCH_SIZE = 25;

// How much of the body preview to send. Graph gives ~255 chars; this is a
// second belt in case that ever changes.
export const MAIL_TRIAGE_PREVIEW_CHARS = 400;

// Corrections shown to the model as worked examples. Recent ones only -- the
// standing rules already cover the senders themselves, so this exists to teach
// the SHAPE of Chris's judgement, not to re-list his address book.
export const MAIL_TRIAGE_EXAMPLE_LIMIT = 12;

export function mailTriageModel() {
  return process.env.REINA_MAIL_TRIAGE_MODEL || 'claude-opus-5';
}

export function isMailTriageLabel(v) {
  return MAIL_TRIAGE_LABELS.indexOf(String(v || '')) !== -1;
}

export function normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase();
}

export function senderDomain(addr) {
  const at = normalizeAddress(addr).lastIndexOf('@');
  return at === -1 ? '' : normalizeAddress(addr).slice(at + 1);
}

// A standing correction that covers this message, or null. A sender rule beats
// a domain rule: one person at a supplier can matter while that supplier's
// marketing does not, and the narrower statement is the more considered one.
export function matchTriageRule(message, rules) {
  const from = normalizeAddress(message && message.fromAddress);
  if (!from) return null;
  const domain = senderDomain(from);
  const list = rules || [];
  const bySender = list.find((r) => r.match_kind === 'sender' && normalizeAddress(r.match_value) === from);
  if (bySender) return bySender;
  const byDomain = domain && list.find((r) => r.match_kind === 'domain' && normalizeAddress(r.match_value) === domain);
  return byDomain || null;
}

// ---- the prompt --------------------------------------------------------------
// Written as the operator's own standing instruction rather than a description
// of a classifier, because the judgement being asked for is "what does this
// want from ME", which is a question about consequences, not about topics.
export const MAIL_TRIAGE_SYSTEM = [
  'You triage the inbox of the owner of a home-services contracting business (handyman, remodeling, repairs).',
  'His day is: clients, subcontractors, suppliers, and the paperwork around jobs.',
  '',
  'For each message decide the ONE label that describes what it wants from him:',
  '',
  '  needs_reply       A person is waiting on a written answer from him. A question,',
  '                    a request for information, a client following up.',
  '  needs_scheduling  It wants a TIME on the calendar -- a site visit, a call, a',
  '                    delivery window, a meeting. If it wants both an answer and a',
  '                    time, this label wins: the time is the harder half.',
  '  needs_action      It needs him to DO something that is not writing back and not',
  '                    booking time. Pay this bill, approve this, sign this, order the',
  '                    material, send the document.',
  '  junk              Marketing, cold outreach, sales prospecting, newsletters he did',
  '                    not ask for, automated noise. Nothing is lost by ignoring it.',
  '  fyi               Real and legitimate, but finished. Receipts, confirmations,',
  '                    notifications, messages he is only copied on.',
  '',
  'Rules of thumb:',
  '- Judge what it wants from HIM, not what it is about. An invoice that is already',
  '  paid is fyi; the same invoice unpaid is needs_action.',
  '- An automated message from a real vendor is not junk. Junk means nobody is served',
  '  by him reading it.',
  '- When a message would be fine either way, prefer the quieter label. Over-flagging',
  '  is what makes a triage list get ignored.',
  '- You are seeing a short preview, not the whole message. If the preview genuinely',
  '  does not say, give the label you would bet on and a LOW confidence rather than',
  '  inventing a reason.',
  '',
  'For each one, write the ACTION -- what he actually has to do, stated plainly enough',
  'that he could hand it to somebody else and they would know what to do without',
  'opening the email. Name the person, the thing, and the decision where you know them.',
  '',
  '  Weak:  "Respond about window proposal"',
  '  Right: "Tell Alvaro whether the revised window proposal at 164 Washington is approved"',
  '',
  '  Weak:  "Review estimate"',
  '  Right: "Check Rich Meehan\'s Precision Stone estimate and tell him yes or no"',
  '',
  'One sentence, up to about 20 words. No preamble, no "you should" -- start with the verb.',
  'If the preview genuinely does not say what is being asked, say what is unclear rather',
  'than inventing a specific: "Open it -- the preview does not say what Harold needs."',
].join('\n');

// The classifier's output shape. `strict: true` means the model cannot hand
// back a label outside the enum or drop a message id, so the caller never has
// to defend against a malformed verdict.
export function mailTriageTool() {
  return {
    name: 'record_triage',
    description: 'Record one label for every message you were given, in the same order.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdicts'],
      properties: {
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'label', 'reason', 'confidence'],
            properties: {
              ref: { type: 'integer', description: 'The [n] reference of the message being labelled.' },
              label: { type: 'string', enum: MAIL_TRIAGE_LABELS },
              reason: { type: 'string', description: 'The action, starting with a verb, up to ~20 words. Specific enough to hand to someone else.' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
        },
      },
    },
  };
}

/* ---------------------------------------------------------------------------
   THE BRIEF -- Reina's read of ONE email, from the whole email.

   Chris, 2026-08-18: "I want a standard inbox and when you click the email on
   the list, it populates the big preview screen. in the preview it shows a
   reina summary of the email and a suggested action or response. below would be
   the actual email."

   This is a different job from triage and it needs a different prompt. The
   classifier sorts fifty messages from a 400-character preview each; this reads
   one message end to end. So it is also the better place to decide the label --
   a preview that stops mid-sentence is exactly where the classifier guesses.

   One call does all of it: summary, action, label, and the reply if one is
   wanted. Four calls would cost four times as much and could disagree with
   themselves -- a summary saying "he is asking about Thursday" next to a label
   saying fyi is worse than either one alone.
--------------------------------------------------------------------------- */
export const MAIL_BRIEF_BODY_CHARS = 12000;

export const MAIL_BRIEF_SYSTEM = [
  'You read one email for the owner of a home-services contracting business',
  '(handyman, remodeling, repairs) and tell him what is in it and what to do.',
  'His day is clients, subcontractors, suppliers, and the paperwork around jobs.',
  '',
  'He is looking at the email itself directly below what you write. So do not',
  'narrate it back to him -- tell him the part that matters and what it means.',
  '',
  'SUMMARY. ONE sentence. Two only if the second one carries a number, a date or',
  'a name the first could not. He is in the middle of something else and reads',
  'this standing up -- a paragraph is a paragraph he skips. No preamble. Lead',
  'with the thing that changes his day. Keep every number, date, name and address',
  'exact -- a summary that rounds $4,329.80 to "about $4,300" is worse than no',
  'summary, because he will act on it without checking. If the email is a long',
  'thread, summarize where it stands NOW, not the whole history.',
  '',
  'ACTION. What he actually has to do, stated plainly enough that he could hand',
  'it to somebody else and they would know what to do without opening the email.',
  'Name the person, the thing, and the decision. Start with the verb. One',
  'sentence, up to about 20 words.',
  '',
  '  Weak:  "Respond about window proposal"',
  '  Right: "Tell Alvaro whether the revised window proposal at 164 Washington is approved"',
  '',
  'If there is genuinely nothing to do, say so plainly -- "Nothing to do, it is a',
  'receipt" beats inventing a task. Over-flagging is what makes him stop reading.',
  '',
  'LABEL. The one thing it wants from him:',
  '  needs_reply       someone is waiting on a written answer',
  '  needs_scheduling  it wants a TIME on the calendar (wins over needs_reply)',
  '  needs_action      do something that is not writing back and not booking time',
  '  junk              marketing, cold outreach, automated noise; nothing is lost',
  '  fyi               real but finished -- receipts, confirmations, cc-only',
  '',
  'REPLY. Only when the label is needs_reply or needs_scheduling. Write what HE',
  'would send: plain, direct, warm but not chatty. No corporate padding, no "I',
  'hope this email finds you well", no restating their message back at them.',
  'Usually two to five sentences.',
  '',
  'If the reply depends on something you cannot know -- a price, a date, whether',
  'a part is in -- leave a marked blank like [CONFIRM DATE] rather than inventing',
  'an answer. A draft with an honest gap is useful; a draft with a made-up fact',
  'in it is a liability, because he might send it without noticing.',
  '',
  'Leave the reply empty for any other label. Do not write one just to fill it in.',
].join('\n');

// One shape, enum-constrained, so the caller never has to defend against a
// label outside the set or a missing field.
export function mailBriefTool() {
  return {
    name: 'record_brief',
    description: 'Record your read of this one email.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'action', 'label', 'reply'],
      properties: {
        summary: { type: 'string', description: 'Two or three sentences. Exact numbers, dates and names.' },
        action: { type: 'string', description: 'What he has to do, starting with a verb, up to ~20 words.' },
        label: { type: 'string', enum: MAIL_TRIAGE_LABELS },
        reply: {
          type: 'string',
          description: 'The draft reply body, or an empty string when the label does not call for one.',
        },
      },
    },
  };
}

/* ---------------------------------------------------------------------------
   UNSUBSCRIBE, read out of the message's own headers.

   Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or
   just push to junk only?"

   Two different things wear the same word, and telling them apart is the whole
   value here:

   * A MAILING LIST you are actually on (Faire, KBIS, LastPass) implements
     RFC 8058: `List-Unsubscribe` with an https URL, plus `List-Unsubscribe-Post:
     List-Unsubscribe=One-Click`. That header is a promise that a single POST
     removes you, with no login and no confirmation page. Clicking it is safe and
     it works.

   * ACTUAL SPAM -- the cold pitch from a throwaway domain -- either has no
     unsubscribe header at all, or has one that is a tracking pixel with a link
     on it. Clicking THAT tells a spammer the address is live and being read,
     which is worse than doing nothing.

   So one-click is offered only where the sender has committed to honouring it.
   Everything else goes to Junk, which teaches the provider's filter instead of
   negotiating with the sender.
--------------------------------------------------------------------------- */
export function unsubscribeFromHeaders(headers) {
  const get = (want) => {
    for (const h of headers || []) {
      if (String(h && h.name || '').toLowerCase() === want) return String(h.value || '');
    }
    return '';
  };
  // ALWAYS an object, never null. A stored value means "we looked": null in the
  // column means the message was briefed before this existed, which is a
  // different thing from a message that has no unsubscribe link, and only one
  // of the two is worth going back for.
  const raw = get('list-unsubscribe');
  // The header is a comma-separated list of <URI> entries, in any order.
  const uris = raw ? [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim()) : [];
  const web = uris.find((u) => /^https:\/\//i.test(u)) || null;
  const mailto = uris.find((u) => /^mailto:/i.test(u)) || null;

  // ONE-CLICK ONLY WHEN THEY SAID SO. Without this header a POST is not
  // something the sender agreed to honour, and firing one anyway is just an
  // unannounced request to a stranger's server on his behalf.
  const oneClickPromised = /list-unsubscribe\s*=\s*one-click/i.test(get('list-unsubscribe-post'));
  return {
    oneClick: oneClickPromised && web ? web : null,
    web,
    mailto: mailto ? mailto.replace(/^mailto:/i, '') : null,
  };
}

// A URL out of a stranger's email, about to be fetched by our server. The host
// is the whole risk: without this check the unsubscribe link is a request the
// sender gets to aim, including at things only our server can reach.
export function safeUnsubscribeUrl(value) {
  let u;
  try { u = new URL(String(value || '')); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return null;
  // Literal addresses only -- a hostname that RESOLVES to a private address is
  // not caught here, which is why this is a guard and not a guarantee.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) return null;
  }
  if (host.includes(':')) return null;   // IPv6 literal
  return u.toString();
}

/* Anything the model hands back that is not prose.

   Seen live, 2026-08-18, in the SUGGESTED REPLY box on a cold-outreach email:

     </antml>
     <parameter name="reply">

   -- fragments of the tool-call markup itself, leaked into a string field.
   `strict: true` validates the SHAPE, not the sense: a string of markup is
   still a string, so the schema had nothing to object to.

   This matters more than it looks. That box sits one button away from a real
   reply to a real client, and the button says "Use this reply". Text that could
   not possibly have been written for a person must never reach it. */
const MODEL_MARKUP = /<\/?(?:antml|parameter|function_calls|invoke)\b|antml:/i;

export function cleanModelText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (MODEL_MARKUP.test(text)) return '';
  return text;
}

// Reads one email. `message` carries from/subject/received; `bodyText` is the
// message itself, already flattened out of HTML by the caller.
export async function briefMessage(message, bodyText, deps) {
  if (!deps || !deps.anthropic) { const e = new Error('the reading service is unavailable'); e.status = 503; throw e; }
  const body = String(bodyText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAIL_BRIEF_BODY_CHARS);
  if (!body) { const e = new Error('that message came back empty'); e.status = 502; throw e; }

  const tool = mailBriefTool();
  const resp = await deps.anthropic.messages.create({
    model: mailTriageModel(),
    max_tokens: 1200,
    output_config: { effort: 'low' },
    system: MAIL_BRIEF_SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{
      role: 'user',
      content: [
        `from: ${message.fromName ? message.fromName + ' <' + (message.fromAddress || '') + '>' : (message.fromAddress || 'unknown')}`,
        `received: ${message.receivedAt || 'unknown'}`,
        `subject: ${message.subject || '(no subject)'}`,
        '',
        body,
      ].join('\n'),
    }],
  });

  const call = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!call || !call.input) { const e = new Error('the read came back empty'); e.status = 502; throw e; }
  const out = call.input;
  const label = isMailTriageLabel(out.label) ? out.label : 'fyi';

  // A reply is only ever wanted for the two labels that mean somebody is waiting
  // on him. The prompt says so; this makes it true. Junk with a suggested reply
  // is not a small cosmetic slip -- it is an invitation to answer a cold pitch.
  const wantsReply = label === 'needs_reply' || label === 'needs_scheduling';
  const reply = wantsReply ? cleanModelText(out.reply) : '';

  return {
    summary: cleanModelText(out.summary),
    action: cleanModelText(out.action),
    label,
    // An empty reply is the model saying "this one does not want one", which is
    // a real answer -- not a failure to produce text.
    draft: reply || null,
    hasBlanks: /\[[A-Z][A-Z \-]{2,}\]/.test(reply),
  };
}

function previewOf(message) {
  const raw = String((message && message.preview) || '').replace(/\s+/g, ' ').trim();
  return raw.length > MAIL_TRIAGE_PREVIEW_CHARS ? raw.slice(0, MAIL_TRIAGE_PREVIEW_CHARS) + '…' : raw;
}

// Messages are referenced by POSITION, not by their real ids. Graph message ids
// are ~150 opaque characters each; at 25 messages that is thousands of tokens
// of noise the model would have to copy back exactly. A small integer cannot be
// mistyped into a different message.
export function buildTriageUserMessage(messages, corrections) {
  const lines = [];
  const examples = (corrections || []).slice(0, MAIL_TRIAGE_EXAMPLE_LIMIT);
  if (examples.length) {
    lines.push('He has corrected your labels before. These are his calls, and they are final:');
    for (const c of examples) {
      const subject = String(c.subject || '(no subject)').slice(0, 80);
      lines.push(`- "${subject}" from ${c.from_address || 'unknown'} -> ${c.corrected_label}` +
        (c.label && c.label !== c.corrected_label ? ` (you had said ${c.label})` : ''));
    }
    lines.push('');
  }
  lines.push('Label each of these. Use record_triage, one verdict per message, and skip none:');
  lines.push('');
  messages.forEach((m, i) => {
    lines.push(`[${i}] from: ${m.fromName ? m.fromName + ' <' + (m.fromAddress || '') + '>' : (m.fromAddress || 'unknown')}`);
    lines.push(`    received: ${m.receivedAt || 'unknown'}`);
    lines.push(`    subject: ${m.subject || '(no subject)'}`);
    const p = previewOf(m);
    if (p) lines.push(`    preview: ${p}`);
    lines.push('');
  });
  return lines.join('\n');
}

// One classification call over a batch. Returns verdicts keyed by messageId.
// Throws on an API failure -- the caller decides whether a failed batch means
// an honest "couldn't triage these" row or a retry, and neither decision
// belongs here.
export async function classifyMailBatch(messages, deps = {}) {
  const { anthropic, corrections = [], model = mailTriageModel() } = deps;
  if (!messages.length) return [];
  if (!anthropic) throw new Error('classifier unavailable');

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    // Triage is a judgement call, not a hard reasoning problem, and it runs
    // over every unread message. Low effort is the right dial here; the model
    // choice is left to REINA_MAIL_TRIAGE_MODEL.
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: MAIL_TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [mailTriageTool()],
    tool_choice: { type: 'tool', name: 'record_triage' },
    messages: [{ role: 'user', content: buildTriageUserMessage(messages, corrections) }],
  });

  const call = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_triage');
  if (!call) throw new Error('classifier returned no verdicts');

  const out = [];
  const seen = new Set();
  for (const v of (call.input && call.input.verdicts) || []) {
    const msg = messages[v.ref];
    // A ref outside the batch is the model losing its place. Dropping it is
    // right: a verdict we cannot attribute to a message is worse than a gap,
    // which the caller reports honestly.
    if (!msg || seen.has(v.ref)) continue;
    if (!isMailTriageLabel(v.label)) continue;
    seen.add(v.ref);
    out.push({
      messageId: msg.messageId,
      label: v.label,
      reason: String(v.reason || '').slice(0, 300),
      confidence: v.confidence || null,
      model,
      source: 'model',
    });
  }
  return out;
}

// Split a list into batches, so one call carries many messages.
export function chunkForTriage(items, size = MAIL_TRIAGE_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// A correction becomes a standing rule for that SENDER. Not the domain --
// promoting one correction to a whole company is a bigger claim than Chris
// made by tapping a label, and getting it wrong silently mislabels everyone
// there. Domain rules exist in the schema for when he asks for one explicitly.
export function ruleFromCorrection(ownerId, message, label) {
  const from = normalizeAddress(message && message.from_address);
  if (!from || !isMailTriageLabel(label)) return null;
  return {
    owner_id: ownerId,
    match_kind: 'sender',
    match_value: from,
    label,
    updated_at: new Date().toISOString(),
  };
}

// The order the triage list is shown in: most consequential first, junk last.
// A list sorted by arrival time is just the inbox again.
export const MAIL_TRIAGE_ORDER = ['needs_reply', 'needs_scheduling', 'needs_action', 'fyi', 'junk'];

export function sortTriageRows(rows) {
  const rank = (r) => {
    const idx = MAIL_TRIAGE_ORDER.indexOf(r.corrected_label || r.label);
    return idx === -1 ? MAIL_TRIAGE_ORDER.length : idx;
  };
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    return String(b.received_at || '').localeCompare(String(a.received_at || ''));
  });
}
