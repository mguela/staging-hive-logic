// Whether a piece of mail is worth interrupting Chris for when HiveLogic is
// closed -- and how Reina learns the answer.
//
// Chris, 2026-08-19, asked for two things in one breath: notifications while
// the app is shut, and "Reina needs to have an option to mark it with some
// indicator that would allow her to learn over time whats worth sending and
// what can wait, also the junk/spam filter is important."
//
// The second half is the harder one, and it is a DIFFERENT QUESTION from the
// one the triage pass already answers. Triage decides WHAT a message is.
// This decides WHETHER IT IS WORTH HIS EVENING. Those come apart constantly:
// a password-reset notice is honestly needs_action and honestly not worth a
// ping; a supplier chasing a number is honestly needs_reply and worth one.
//
// So the rule is a lookup, not a model call -- same boring shape that made the
// label rules work. A sender he silenced once is silenced by a table read: no
// token spend, no chance of the same mistake twice, and he can see the list.
//
// THE ONE THING THIS MUST NEVER DO is go quiet on its own. Every notify rule
// here comes from something he pressed. Reina guessing "he probably does not
// care about this one" and being wrong costs him a job; being noisy costs him
// a click. Those are not symmetric, so nothing infers silence.

// Mail that is not about him doing something is never worth a desktop
// notification, whatever the sender history says. junk and fyi never reach
// this module, and this list is what remains.
export const NOTIFY_LABELS = ['needs_reply', 'needs_scheduling', 'needs_action'];

// A brand-new sender he has never ruled on. Silent by default would mean the
// first email from a new customer never reaches him, which is the exact
// failure this feature exists to prevent -- so unknown senders DO notify, and
// one press teaches her otherwise.
export const DEFAULT_NOTIFY = true;

// WHERE the notification is allowed to appear.
//
// Chris, 2026-08-23: "just notifications on the bottom of hivelogic not
// windows." He wants the in-app nudge and not the desktop toast.
//
// The obvious way to get that -- press "Turn off" in the settings -- is a
// trap, and it is worth writing down why. Turning off DELETES the push
// subscription row, and mail-sweep picks the owners it scans FROM that table.
// No row means no sweep, no sweep means no mailbox read, and no mailbox read
// means the in-app nudge quietly stops finding new mail too. He would have
// switched off the thing he wanted to keep by switching off the thing he
// wanted rid of.
//
// So the channel is a preference, not the absence of a subscription. The
// browser stays subscribed and the sweep keeps running; the desktop toast is
// simply not sent.
//
// Stored as a reserved row in reina_notify_rules -- the table already has
// (owner_id, match_kind, match_value) unique and a notify boolean, and
// matchNotifyRule only ever looks at 'sender' and 'domain', so a 'channel' row
// is inert to sender matching. No migration, no second settings table.
export const DESKTOP_CHANNEL = Object.freeze({ kind: 'channel', value: 'desktop' });

/**
 * Desktop toasts are ON unless he has said otherwise.
 *
 * Same asymmetry the rest of this module runs on: being noisy costs him a
 * click, going quiet on its own costs him a job. Nothing here infers silence
 * -- only an explicit notify:false turns it off.
 */
export function desktopPushEnabled(rules) {
  for (const rule of rules || []) {
    if (rule && rule.match_kind === DESKTOP_CHANNEL.kind
      && String(rule.match_value || '').toLowerCase() === DESKTOP_CHANNEL.value) {
      return rule.notify !== false;
    }
  }
  return true;
}

/** The row that records the choice, either way. */
export function desktopChannelRule(ownerId, enabled) {
  return {
    owner_id: ownerId,
    match_kind: DESKTOP_CHANNEL.kind,
    match_value: DESKTOP_CHANNEL.value,
    notify: enabled !== false,
    source: 'button',
    updated_at: new Date().toISOString(),
  };
}

export function domainOf(address) {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return '';
  return String(address).slice(at + 1).trim().toLowerCase();
}

export function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

/**
 * The sender rule wins over the domain rule. One person at a vendor can matter
 * while the vendor's marketing does not, and the narrower statement is always
 * the more specific thing he said.
 */
export function matchNotifyRule(rules, fromAddress) {
  const addr = normalizeAddress(fromAddress);
  if (!addr) return null;
  const dom = domainOf(addr);
  let domainHit = null;
  for (const rule of rules || []) {
    const value = normalizeAddress(rule && rule.match_value);
    if (!value) continue;
    if (rule.match_kind === 'sender' && value === addr) return rule;
    if (rule.match_kind === 'domain' && dom && value === dom) domainHit = rule;
  }
  return domainHit;
}

/**
 * Should this row interrupt him right now?
 *
 * Returns a REASON as well as a verdict, because "why did Reina not tell me"
 * is a question he will ask, and "she did not" with no answer is how a feature
 * like this loses trust.
 */
export function shouldNotify(row, rules, opts) {
  const options = opts || {};
  const label = (row && (row.corrected_label || row.label)) || '';

  if (row && row.notified_at) return { notify: false, reason: 'already sent' };
  if (row && row.acted_at) return { notify: false, reason: 'already dealt with' };
  if (NOTIFY_LABELS.indexOf(label) === -1) {
    // The junk/spam half he called important: junk and fyi cannot reach him
    // here at all, and no sender rule can override that. A rule that could
    // turn junk back on is a rule he would eventually set by accident.
    return { notify: false, reason: label === 'junk' ? 'junk' : 'nothing to do' };
  }

  const rule = matchNotifyRule(rules, row && row.from_address);
  if (rule && rule.notify === false) {
    return { notify: false, reason: 'you silenced ' + rule.match_value, rule };
  }
  // An explicit yes beats quiet hours -- that is what marking a sender
  // always-notify is FOR.
  if (rule && rule.notify === true) return { notify: true, reason: 'you marked ' + rule.match_value + ' worth it', rule };

  if (options.quiet === true) return { notify: false, reason: 'quiet hours' };
  return { notify: DEFAULT_NOTIFY, reason: 'new sender' };
}

/**
 * Quiet hours, in HIS timezone, not the server's. A Vercel function runs in
 * UTC; 9pm in Connecticut is 1am or 2am UTC depending on the month, so reading
 * the raw UTC hour would silence him mid-afternoon half the year.
 *
 * Quiet is a delay, never a drop: the sweep leaves notified_at null, so the
 * first sweep after the quiet window sends it.
 */
export function isQuietHour(now, timeZone, startHour, endHour) {
  const tz = timeZone || 'America/New_York';
  const from = Number.isFinite(startHour) ? startHour : 21;
  const to = Number.isFinite(endHour) ? endHour : 7;
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(now));
  } catch (_) {
    return false;   // an unknown zone must not silence him
  }
  if (!Number.isFinite(hour)) return false;
  // 21..07 wraps midnight, so it is two ranges, not one comparison.
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

// One email, one toast -- even when it lands in more than one mailbox.
//
// Chris got the same Gusto payroll reminder twice on 2026-08-23. Both rows
// were real and both were correctly judged worth telling him about; they were
// simply the same message delivered to two of his Outlook mailboxes, so they
// carried different Graph ids. The push tag is built from message_id, which
// means Chrome could not collapse them either -- the ids genuinely differ.
// The same message also gets stored a second time under its RFC822
// Message-ID by the other ingest path, which is a third copy of one email.
//
// So identity here is what a person would use: who sent it and what it says
// in the subject line. Reply and forward prefixes are stripped because
// "Re: Time to run payroll" is the same conversation, not a new interruption.
export function mailIdentity(row) {
  const from = String((row && row.from_address) || '').trim().toLowerCase();
  const subject = String((row && row.subject) || '')
    .replace(/^\s*(?:re|fw|fwd|aw|sv)\s*:\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  // No sender AND no subject is not an identity -- collapsing every such row
  // into one would silence unrelated mail. Fall back to the message id, which
  // is unique, so those rows each stand alone.
  if (!from && !subject) return 'id:' + String((row && row.message_id) || JSON.stringify(row || null));
  return from + '\u0000' + subject;
}

/**
 * Collapse rows that are the same email to a person.
 *
 * Returns one entry per distinct email, in the order given: the first row is
 * the one that gets the toast, and `duplicates` are the other copies. Those
 * still need stamping as notified, or the next sweep would pick a copy up and
 * raise the toast this one just suppressed.
 */
export function collapseDuplicates(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = mailIdentity(row);
    const existing = groups.get(key);
    if (existing) existing.duplicates.push(row);
    else groups.set(key, { row, duplicates: [] });
  }
  return [...groups.values()];
}

/**
 * What the notification actually says.
 *
 * It has to be readable in a Windows toast, which is roughly one line of title
 * and two of body before it truncates. Reina's ACTION is the body when she has
 * one -- that is the sentence that tells him whether to put the drill down --
 * and the subject is the fallback when the message has not been read yet.
 */
export function notificationFor(row, extraCount) {
  const who = (row && (row.from_name || row.from_address)) || 'Someone';
  const label = (row && (row.corrected_label || row.label)) || '';
  const tag = label === 'needs_reply' ? 'needs a reply'
    : label === 'needs_scheduling' ? 'needs a time'
      : 'needs you';
  // action_text is written when Reina has actually READ it. Before that the
  // batch pass leaves a one-line `reason`, which beats echoing the subject he
  // can already see in the title.
  const body = (row && (row.action_text || row.summary_text || row.reason || row.subject)) || '';
  const more = Number(extraCount) > 0 ? `  ·  +${Number(extraCount)} more waiting` : '';
  return {
    title: `${who} — ${tag}`,
    body: String(body).slice(0, 220) + more,
    tag: 'reina-mail-' + String((row && row.message_id) || ''),
    data: {
      messageId: (row && row.message_id) || null,
      graphId: (row && row.graph_id) || null,
      homeAccountId: (row && row.home_account_id) || null,
      fromAddress: (row && row.from_address) || null,
      url: '/?reina=mail',
    },
    // The mute is the learning signal, and it is on the notification itself
    // because that is the moment he knows the answer -- asking him to open the
    // app to say "that was not worth it" is asking him to do the thing that
    // was not worth doing.
    //
    // Labelled "Mute sender" rather than "Not this sender" because Chris asked
    // what the old label did. A button whose effect has to be explained is a
    // button nobody presses, and this one is only useful if it is pressed in
    // the half-second he is annoyed.
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'mute', title: 'Mute sender' },
    ],
  };
}

/**
 * The rule a press produces. 'button' is him saying so outright and outranks
 * anything inferred, which is why the source is stored rather than assumed.
 */
export function muteRuleFor(ownerId, fromAddress, kind) {
  const addr = normalizeAddress(fromAddress);
  if (!addr) return null;
  const matchKind = kind === 'domain' ? 'domain' : 'sender';
  const value = matchKind === 'domain' ? domainOf(addr) : addr;
  if (!value) return null;
  return {
    owner_id: ownerId,
    match_kind: matchKind,
    match_value: value,
    notify: false,
    source: 'button',
    updated_at: new Date().toISOString(),
  };
}
