// api/_lib/reina-conversation-core.js
//
// PURE, transport-neutral conversation core for Reina's first conversational
// slice — the mainline successor to the PR #53 behavior, rebuilt so it does NOT
// depend on the PR #51 preview stack.
//
// What it does: it lets Reina understand natural phrasing, follow-ups,
// corrections, challenges, narrow clarifications, unknowns, refusals, prompt
// injection, and recovery — WITHOUT being limited to fixed buttons and WITHOUT
// inventing any business fact, freshness, threshold, or policy.
//
// What it deliberately is NOT:
//   - It never imports business data. All synthetic knowledge arrives through a
//     single, bounded, DATA-ONLY injected dependency (`input.knowledge`). This
//     file has ZERO imports.
//   - It never calls a model, route, database, tool, Automation, or any
//     execution/callable — including callables handed in via the dependency.
//     The dependency is read as inert data; functions on it are never invoked.
//   - It never authorizes anything. Its output is a descriptive intent/state
//     envelope for a server composition layer (Codex 1) to consume safely.
//     Nothing in the output grants permission; `executed` is always false.
//
// Trust model:
//   - The utterance is untrusted text. Instructions inside it ("ignore all
//     rules", "as admin…", "<system>…", "tool_call:…") are classified, never
//     obeyed.
//   - Injected knowledge is synthetic and inert. Instructions embedded in its
//     fields are DATA, never commands, and never change control flow.
//   - Prior conversation state is inert context only. It resolves follow-ups;
//     it NEVER grants authority and NEVER bypasses a refusal guard.
//   - Unknown or malformed dependencies FAIL CLOSED: the core refuses to answer
//     rather than guess.
//
// `converse({ utterance, state, knowledge }) -> { response, state }` is pure:
// it never mutates its inputs and returns the next state explicitly.

// ---------------------------------------------------------------------------
// Bounds (a "bounded" dependency + hostile-input hardening)
// ---------------------------------------------------------------------------
const MAX_UTTERANCE = 4000;   // longer input is truncated before classification
const MAX_PROMPTS = 200;      // upper bound on injected prompt records scanned
const MAX_OPTIONS = 5;        // clarification examples listed
const MAX_FIELD = 4000;       // upper bound on any single business text field

// The 8 transparency dimensions Reina's every answer must carry, plus the
// bookkeeping fields the server seam consumes.
function baseEnvelope() {
  return {
    kind: 'unknown',        // answer | followup | refusal | clarify | unknown | fail_closed
    matchedPromptId: null,
    directAnswer: '',
    factVsInference: '',
    evidence: '',
    freshness: '',
    missingOrConflicting: '',
    safeRecommendation: '',
    draftNotSent: null,
    whatReinaDidNotDo: '',
    executed: false,        // ALWAYS false — this core never executes anything
  };
}

const DID_NOT_DO_DEFAULT =
  'Did not run tools, call a model, change records, send messages, move money, schedule anything, or read production/customer data.';

// ---------------------------------------------------------------------------
// Safe reads — defend against prototype pollution and accessor/getter traps.
// We only ever read OWN DATA properties; inherited props and accessors (which
// could throw or have side effects) are ignored.
// ---------------------------------------------------------------------------
function safeReadOwn(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, key);
  } catch (_e) {
    return undefined;
  }
  if (!desc) return undefined;                                   // not own -> ignore prototype
  if (typeof desc.get === 'function' || typeof desc.set === 'function') return undefined; // ignore accessors
  return desc.value;
}

function ownString(obj, key) {
  const v = safeReadOwn(obj, key);
  return typeof v === 'string' ? v : undefined;
}

function ownNumber(obj, key) {
  const v = safeReadOwn(obj, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function ownArray(obj, key) {
  const v = safeReadOwn(obj, key);
  return Array.isArray(v) ? v : undefined;
}

// A business text field: must be a non-empty string within bounds. Returns the
// trimmed value or undefined. We never fabricate one — a missing field makes the
// whole record fail validation (fail closed), so we cannot emit invented text.
function businessField(rec, key) {
  const v = ownString(rec, key);
  if (v === undefined) return undefined;
  if (v.length === 0 || v.length > MAX_FIELD) return undefined;
  return v;
}

// ---------------------------------------------------------------------------
// Text normalization + small, deterministic matchers (no model, no randomness)
// ---------------------------------------------------------------------------
function norm(s) {
  let raw = typeof s === 'string' ? s : (s == null ? '' : String(s));
  if (raw.length > MAX_UTTERANCE) raw = raw.slice(0, MAX_UTTERANCE);
  return raw.toLowerCase()
    .replace(/['‘’]/g, '')   // strip apostrophes so "that's" -> "thats"
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text, words) {
  for (let i = 0; i < words.length; i++) if (text.indexOf(words[i]) !== -1) return true;
  return false;
}

function jobRefs(text) {
  const raw = typeof text === 'string' ? text.slice(0, MAX_UTTERANCE) : '';
  const out = [];
  const m = raw.toUpperCase().match(/DEMO-\d+/g);
  if (m) for (let i = 0; i < m.length; i++) if (out.indexOf(m[i]) === -1) out.push(m[i]);
  const d = norm(raw).match(/\b(\d{3})\b/g);
  if (d) for (let j = 0; j < d.length; j++) { const r = 'DEMO-' + d[j]; if (out.indexOf(r) === -1) out.push(r); }
  return out;
}

// Refusal categories — checked against the UTTERANCE ONLY. Job/knowledge data is
// never a command. These cover money, banking, payroll, credentials,
// communications, scheduling mutations, execution, and other business actions.
const MUTATION_WORDS = [
  // record mutations
  'mark ', 'complete', 'close ', 'update', 'change', 'set ', 'delete', 'remove',
  'assign', 'approve', 'reject', 'edit ', 'write off', 'cancel', 'void', 'move ',
  'create', 'order ',
  // communications
  'send', 'email', 'text ', 'message', 'notify', 'call ', 'post ', 'publish', 'reply',
  // scheduling mutations
  'schedule ', 'reschedule', 'book ', 'cancel ',
  // money
  'pay ', 'charge', 'refund', 'transfer', 'wire ', 'deposit', 'withdraw', 'invoice ',
  // execution / actions
  'run ', 'execute', 'deploy', 'trigger', 'invoke', 'submit', 'commit', 'apply ',
  'process ', 'automate', 'activate', 'enable ', 'disable ',
];
const PRIVATE_WORDS = [
  'bank', 'banking', 'account number', 'routing', 'iban', 'balance', 'ssn',
  'social security', 'password', 'credential', 'api key', 'apikey', 'token',
  'secret', 'card number', 'cvv', 'payroll', 'salary', 'wage', 'paycheck',
  'direct deposit', 'phone number', 'email address', 'home address', 'gate code',
  'access code', 'medical', 'invoice amount', 'how much', 'dollar', 'price',
  'cost', 'margin', 'revenue', 'profit',
];

// Natural-variation patterns for the 8 answerable prompts (1-8). 9 & 10 are
// refusals handled by the guards but also reachable by exact fixture text.
const PROMPT_PATTERNS = {
  1: (t) => hasAny(t, ['needs attention', 'need attention', 'needs me', 'what should i look at', 'what is urgent', 'whats urgent', 'anything urgent', 'what needs doing', 'priorities', 'attention']),
  2: (t) => hasAny(t, ['blocking', 'blocker', 'holding up', 'stuck', 'why is', 'why delayed', 'what is wrong with']),
  3: (t) => hasAny(t, ['stale', 'outdated', 'out of date', 'old data', 'not fresh', 'how fresh']),
  4: (t) => hasAny(t, ['disagree', 'sources conflict', 'conflicting sources', 'which sources', 'sources differ', 'sources dont match', 'mismatch']),
  5: (t) => hasAny(t, ['missing', 'what do we not have', 'what are we lacking', 'incomplete info']),
  6: (t) => hasAny(t, ['assumption', 'assuming', 'what are you assuming', 'how did you decide', 'what rules']),
  7: (t) => hasAny(t, ['evidence', 'prove it', 'proof', 'source data', 'citations', 'back it up']),
  8: (t) => (hasAny(t, ['draft', 'write up', 'compose']) && hasAny(t, ['follow up', 'follow-up', 'followup', 'note', 'message', 'email', 'do not send', 'dont send'])),
};

// ---------------------------------------------------------------------------
// Bounded, data-only knowledge dependency.
//   knowledge = {
//     prompts: [ { promptId:number, prompt?:string, answer, factOrInference,
//                  evidence, freshness, missingOrConflicting, safeRecommendation,
//                  draftNotSent?, whatReinaDidNotDo } ],
//     attentionJobRefs?: string[],   // used only to list clarification examples
//     now?: string                   // inert freshness anchor (never composed)
//   }
// Everything is inert data. No property of `knowledge` is ever invoked.
// ---------------------------------------------------------------------------
function readKnowledge(knowledge) {
  if (knowledge == null || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
    return { ok: false };
  }
  const prompts = ownArray(knowledge, 'prompts');
  if (!prompts) return { ok: false };
  return { ok: true, knowledge, prompts };
}

// Validate + copy one prompt record into a clean, inert object. A record missing
// any required business field fails validation — so we NEVER emit invented or
// empty business text. Returns null on any problem.
function readPromptRecord(rec) {
  if (rec == null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const promptId = ownNumber(rec, 'promptId');
  if (promptId === undefined) return null;

  const required = ['answer', 'factOrInference', 'evidence', 'freshness', 'missingOrConflicting', 'safeRecommendation', 'whatReinaDidNotDo'];
  const clean = { promptId };
  for (const key of required) {
    const v = businessField(rec, key);
    if (v === undefined) return null;   // missing evidence/freshness/etc. -> fail closed
    clean[key] = v;
  }
  const draft = ownString(rec, 'draftNotSent');
  clean.draftNotSent = (draft !== undefined && draft.length > 0 && draft.length <= MAX_FIELD) ? draft : null;
  const promptText = ownString(rec, 'prompt');
  clean.prompt = (promptText !== undefined && promptText.length <= MAX_FIELD) ? promptText : null;
  return clean;
}

// Find a validated prompt record by id within the bounded array.
function findPromptById(prompts, id) {
  const n = Math.min(prompts.length, MAX_PROMPTS);
  for (let i = 0; i < n; i++) {
    const raw = prompts[i];
    if (raw && typeof raw === 'object' && ownNumber(raw, 'promptId') === id) {
      return readPromptRecord(raw);
    }
  }
  return null;
}

// Match exact/normalized button text against a record's `prompt` field.
function findPromptByText(prompts, normalizedUtterance) {
  const n = Math.min(prompts.length, MAX_PROMPTS);
  for (let i = 0; i < n; i++) {
    const raw = prompts[i];
    const pt = ownString(raw, 'prompt');
    if (pt !== undefined && norm(pt) === normalizedUtterance && normalizedUtterance !== '') {
      return readPromptRecord(raw);
    }
  }
  return null;
}

// Map a validated prompt record -> the transparency envelope (verbatim text).
function fromPrompt(p, kind) {
  const e = baseEnvelope();
  e.kind = kind || 'answer';
  e.matchedPromptId = p.promptId;
  e.directAnswer = p.answer;
  e.factVsInference = p.factOrInference;
  e.evidence = p.evidence;
  e.freshness = p.freshness;
  e.missingOrConflicting = p.missingOrConflicting;
  e.safeRecommendation = p.safeRecommendation;
  e.draftNotSent = p.draftNotSent || null;
  e.whatReinaDidNotDo = p.whatReinaDidNotDo;
  return e;
}

// ---------------------------------------------------------------------------
// Conversation state — consumed only as inert context, granting no authority.
// We copy exactly four whitelisted own-data fields; any forged authority field
// (role, authorized, company, tools, …) present on the incoming state is simply
// never read, so it can never influence behavior.
// ---------------------------------------------------------------------------
function readState(prev) {
  const s = { turnCount: 0, lastMatchedPromptId: null, lastReferencedJobRef: null, lastKind: null };
  const tc = ownNumber(prev, 'turnCount');
  if (tc !== undefined && tc >= 0) s.turnCount = tc;
  const lp = ownNumber(prev, 'lastMatchedPromptId');
  if (lp !== undefined) s.lastMatchedPromptId = lp;
  const lr = ownString(prev, 'lastReferencedJobRef');
  if (lr !== undefined) s.lastReferencedJobRef = lr;
  const lk = ownString(prev, 'lastKind');
  if (lk !== undefined) s.lastKind = lk;
  return s;
}

function nextState(prevClean, patch) {
  const s = {
    turnCount: prevClean.turnCount + 1,
    lastMatchedPromptId: prevClean.lastMatchedPromptId,
    lastReferencedJobRef: prevClean.lastReferencedJobRef,
    lastKind: prevClean.lastKind,
  };
  if (patch) {
    if ('lastMatchedPromptId' in patch) s.lastMatchedPromptId = patch.lastMatchedPromptId;
    if ('lastReferencedJobRef' in patch) s.lastReferencedJobRef = patch.lastReferencedJobRef;
    if ('lastKind' in patch) s.lastKind = patch.lastKind;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Canned, non-business-policy envelopes. These describe the CORE's own behavior
// (read-only, nothing executed) — they invent no business fact, no freshness
// value, and no confidence. Refusal *business* text is used verbatim from
// knowledge when a valid prompt 9/10 record exists; otherwise safe scaffolding.
// ---------------------------------------------------------------------------
function refusalPrivate(kw) {
  const p = kw.ok ? findPromptById(kw.prompts, 9) : null;
  if (p) return fromPrompt(p, 'refusal');
  const e = baseEnvelope(); e.kind = 'refusal';
  e.directAnswer = 'Refused. Private, financial, banking, payroll, or credential information is not available here, and I will not guess it.';
  e.factVsInference = 'Fact: this is a read-only advisory core; it discloses no private data.';
  e.evidence = 'None disclosed.'; e.freshness = 'N/A';
  e.missingOrConflicting = 'N/A — private/financial data is out of scope, not merely missing.';
  e.safeRecommendation = 'A person can look this up through the proper HiveLogic access controls.';
  e.whatReinaDidNotDo = 'Did not show private, financial, banking, payroll, or credential data, guess values, or query any system.';
  return e;
}
function refusalMutation(kw) {
  const p = kw.ok ? findPromptById(kw.prompts, 10) : null;
  if (p) return fromPrompt(p, 'refusal');
  const e = baseEnvelope(); e.kind = 'refusal';
  e.directAnswer = 'Refused. I am read-only: I do not change records, send messages, move money, run payroll, schedule, or execute anything. Nothing was done.';
  e.factVsInference = 'Fact: this core performs no actions.';
  e.evidence = 'N/A for an action request.'; e.freshness = 'N/A';
  e.missingOrConflicting = 'N/A';
  e.safeRecommendation = 'If a change is truly needed, a person performs it with the normal HiveLogic tools.';
  e.whatReinaDidNotDo = DID_NOT_DO_DEFAULT;
  return e;
}
function unknownAnswer() {
  const e = baseEnvelope(); e.kind = 'unknown';
  e.directAnswer = "I don't have that in my synthetic knowledge, and I will not guess.";
  e.factVsInference = 'N/A — no synthetic fact covers this request.';
  e.evidence = 'None available in the provided knowledge.';
  e.freshness = 'N/A';
  e.missingOrConflicting = 'The information needed to answer is not present.';
  e.safeRecommendation = 'A person can check this in HiveLogic; I will not invent an answer.';
  e.whatReinaDidNotDo = DID_NOT_DO_DEFAULT;
  return e;
}
function clarify(question, opts) {
  const e = baseEnvelope(); e.kind = 'clarify';
  const list = Array.isArray(opts) ? opts.filter((o) => typeof o === 'string' && o.length).slice(0, MAX_OPTIONS) : [];
  e.directAnswer = question + (list.length ? ' For example: ' + list.join(', ') + '.' : '');
  e.factVsInference = 'N/A — clarification, not an answer.';
  e.evidence = 'None yet.'; e.freshness = 'N/A';
  e.missingOrConflicting = 'Your intent is ambiguous; I need one detail before answering.';
  e.safeRecommendation = 'Reply with the specific job or question and I will answer from the synthetic knowledge only.';
  e.whatReinaDidNotDo = DID_NOT_DO_DEFAULT;
  return e;
}
// Fail-closed: the knowledge dependency is missing or malformed. We refuse to
// answer and invent nothing. Distinct kind so the server seam can tell this from
// an ordinary refusal.
function failClosed() {
  const e = baseEnvelope(); e.kind = 'fail_closed';
  e.directAnswer = "I can't answer that safely: my synthetic knowledge source is unavailable or malformed, and I will not guess.";
  e.factVsInference = 'Fact: no valid knowledge dependency was provided; I invent nothing.';
  e.evidence = 'None — no knowledge source available.';
  e.freshness = 'N/A';
  e.missingOrConflicting = 'A valid synthetic knowledge dependency is required and was missing or malformed.';
  e.safeRecommendation = 'Provide a valid synthetic knowledge dependency; a person can answer in HiveLogic meanwhile.';
  e.whatReinaDidNotDo = DID_NOT_DO_DEFAULT;
  return e;
}

// ---------------------------------------------------------------------------
// The pure conversation core.
//   input: { utterance:string, state?:object, knowledge?:{...} }  (alias: deps)
//   returns: { response:<envelope>, state:<next inert state> }
// ---------------------------------------------------------------------------
export function converse(input) {
  const safeInput = (input && typeof input === 'object') ? input : {};
  const prevClean = readState(safeReadOwn(safeInput, 'state'));

  // Knowledge is DATA ONLY and never invoked. Accept `knowledge` (preferred) or
  // the `deps` alias, both read as inert own-data.
  const kwRaw = safeReadOwn(safeInput, 'knowledge');
  const kw = readKnowledge(kwRaw !== undefined ? kwRaw : safeReadOwn(safeInput, 'deps'));

  const rawUtter = ownString(safeInput, 'utterance');
  const raw = typeof rawUtter === 'string' ? rawUtter : '';
  const t = norm(raw);
  const refs = jobRefs(raw);
  const refPatch = refs.length ? { lastReferencedJobRef: refs[refs.length - 1] } : {};

  // Empty input -> a narrow clarification (safe scaffolding; never improvise).
  if (!t) {
    return { response: clarify('What would you like to ask about the synthetic jobs?'), state: nextState(prevClean, { lastKind: 'clarify' }) };
  }

  // 1) REFUSALS FIRST — always, regardless of state or knowledge. Guards read
  //    the UTTERANCE only; embedded instructions in data are never commands.
  //    Prior state can never unlock a guarded action.
  const wantsMutation = hasAny(t, MUTATION_WORDS);
  const wantsPrivate = hasAny(t, PRIVATE_WORDS);
  const isDraftPrompt = PROMPT_PATTERNS[8](t); // allowed draft-not-sent (prompt 8)
  if (wantsMutation && !isDraftPrompt) {
    return { response: refusalMutation(kw), state: nextState(prevClean, { lastKind: 'refusal', lastMatchedPromptId: 10 }) };
  }
  if (wantsPrivate) {
    return { response: refusalPrivate(kw), state: nextState(prevClean, { lastKind: 'refusal', lastMatchedPromptId: 9 }) };
  }

  // From here we need valid knowledge to say anything factual. Fail closed if it
  // is missing or malformed — never guess.
  if (!kw.ok) {
    return { response: failClosed(), state: nextState(prevClean, { lastKind: 'fail_closed' }) };
  }

  // 2) DIRECT prompt match — natural variations of prompts 1..8 — before
  //    follow-ups, so a full question ("why is 231 stuck?") is answered as P2
  //    rather than mis-read as a bare "why?" follow-up.
  for (let id = 1; id <= 8; id++) {
    if (PROMPT_PATTERNS[id](t)) {
      const pm = findPromptById(kw.prompts, id);
      if (pm) {
        return { response: fromPrompt(pm, 'answer'), state: nextState(prevClean, Object.assign({ lastKind: 'answer', lastMatchedPromptId: id }, refPatch)) };
      }
      // Pattern matched but the record is missing/malformed -> fail closed.
      return { response: failClosed(), state: nextState(prevClean, { lastKind: 'fail_closed' }) };
    }
  }
  // Exact fixture button text (including 9 & 10) via the record `prompt` field.
  const exact = findPromptByText(kw.prompts, t);
  if (exact) {
    const kind = (exact.promptId === 9 || exact.promptId === 10) ? 'refusal' : 'answer';
    return { response: fromPrompt(exact, kind), state: nextState(prevClean, { lastKind: kind, lastMatchedPromptId: exact.promptId }) };
  }

  // 3) FOLLOW-UPS (bare, context-dependent). Corrections work with or without
  //    prior context; why/which need a prior answered prompt. State here is
  //    inert context only.
  const priorId = typeof prevClean.lastMatchedPromptId === 'number' ? prevClean.lastMatchedPromptId : null;
  const isWhy = hasAny(t, ['why', 'how come', 'explain', 'reason']);
  const isWhich = hasAny(t, ['which one', 'which job', 'which', 'what one']);
  const isCorrection = hasAny(t, ['thats wrong', 'that is wrong', 'not right', 'incorrect', 'you are wrong', 'youre wrong', 'i disagree', 'thats not', 'no it', 'actually it', 'thats false']);

  if (isCorrection) {
    const e = baseEnvelope(); e.kind = 'followup'; e.matchedPromptId = priorId;
    e.directAnswer = 'Noted. I cannot verify a correction against production here, so I have not changed anything and I am not overriding the synthetic facts.';
    e.factVsInference = 'Fact: this is a read-only core. Inference: your correction may be right, but I cannot confirm it here.';
    e.evidence = priorId ? "See the previous answer's evidence; no new evidence exists here." : 'None.';
    e.freshness = 'N/A';
    e.missingOrConflicting = 'Possible disagreement between you and the synthetic facts; left visible, not merged.';
    e.safeRecommendation = 'A person reconciles this in HiveLogic; I will not guess or rewrite the record.';
    e.whatReinaDidNotDo = DID_NOT_DO_DEFAULT;
    return { response: e, state: nextState(prevClean, { lastKind: 'followup' }) };
  }
  if (isWhy && priorId) {
    const pr = findPromptById(kw.prompts, priorId);
    if (pr) {
      const w = baseEnvelope(); w.kind = 'followup'; w.matchedPromptId = priorId;
      w.directAnswer = 'Here is the reasoning behind that answer.';
      w.factVsInference = pr.factOrInference; // reuse existing; no new facts
      w.evidence = pr.evidence; w.freshness = pr.freshness;
      w.missingOrConflicting = pr.missingOrConflicting;
      w.safeRecommendation = pr.safeRecommendation;
      w.draftNotSent = pr.draftNotSent || null;
      w.whatReinaDidNotDo = pr.whatReinaDidNotDo;
      return { response: w, state: nextState(prevClean, Object.assign({ lastKind: 'followup' }, refPatch)) };
    }
  }
  if (isWhich) {
    const att = ownArray(kw.knowledge, 'attentionJobRefs') || [];
    const opts = [];
    for (let i = 0; i < att.length && opts.length < MAX_OPTIONS; i++) {
      if (typeof att[i] === 'string' && att[i].length) opts.push(att[i]);
    }
    return { response: clarify('Which job do you mean?', opts), state: nextState(prevClean, Object.assign({ lastKind: 'clarify' }, refPatch)) };
  }

  // 4) UNKNOWN / ambiguous. A bare job reference with no clear intent -> a narrow
  //    clarification; otherwise honest missing-information.
  if (refs.length) {
    return { response: clarify('What would you like to know about ' + refs[0] + '?', ['its status', 'what is blocking it', 'its evidence']), state: nextState(prevClean, Object.assign({ lastKind: 'clarify' }, refPatch)) };
  }
  return { response: unknownAnswer(), state: nextState(prevClean, { lastKind: 'unknown' }) };
}

// Exposed for unit testing of the deterministic classifier pieces.
export const _internals = { norm, jobRefs, PROMPT_PATTERNS, MUTATION_WORDS, PRIVATE_WORDS, safeReadOwn, readState, readPromptRecord };
