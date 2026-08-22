import { createHash } from 'node:crypto';

import { requireStaff, taskScopeHash, validateTask } from './_lib/agents/security.js';
import { normalizeBudget, runCouncil } from './_lib/reina/council-core.js';
import { createCouncilProviders, configuredCouncilProviders } from './_lib/reina/council-providers.js';
import { createCouncilStore } from './_lib/reina/council-store.js';
import { getSnapshotData } from './snapshot.js';

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function enabled(env) {
  return env.REINA_COUNCIL_ENABLED === 'true';
}

function runtimeProviderEnv(env, req) {
  const header = req?.headers?.['x-vercel-oidc-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (typeof token !== 'string' || token.trim().length === 0) return env;
  // The short-lived token remains request-scoped and is never persisted or
  // included in audit output.
  return Object.freeze({ ...env, VERCEL_OIDC_TOKEN: token.trim() });
}

function bodyKeys(body, allowed) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((key) => allowed.includes(key));
}

function budgetCeiling(env) {
  const value = (key, fallback) => Number.isInteger(Number(env[key])) ? Number(env[key]) : fallback;
  return { maxRounds: value('REINA_COUNCIL_MAX_ROUNDS', 3), maxTokensPerResponse: value('REINA_COUNCIL_MAX_TOKENS_PER_RESPONSE', 4_000), maxCostCents: value('REINA_COUNCIL_MAX_COST_CENTS', 500) };
}

function operationalLimits(env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    maxConcurrentRuns: integer('REINA_COUNCIL_MAX_CONCURRENT_RUNS', 1, 1, 10),
    dailyCostCents: integer('REINA_COUNCIL_DAILY_COST_CENTS', 2_000, 1, 1_000_000),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requestHash(body) {
  const request = { brief: body.brief, evidence: body.evidence, attachments: body.attachments || [], budget: body.budget, executionRequest: body.executionRequest ?? null, projectId: body.projectId ?? null };
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

function storedInput(body) {
  if (!Array.isArray(body.attachments) || body.attachments.length === 0) return body.evidence;
  return {
    sources: body.evidence,
    attachments: body.attachments.map((item) => ({ id: item?.id, name: item?.name, kind: item?.kind, mimeType: item?.mimeType })),
  };
}

const EXTERNAL_HISTORY_SOURCES = Object.freeze(['chatgpt', 'claude', 'claude_code', 'codex', 'grok']);

function requestsExternalHistory(brief) {
  return typeof brief === 'string' && /\b(history|chats?|conversations?|threads?|past work)\b/i.test(brief);
}

function isDirectStatusCheck(brief) {
  if (typeof brief !== 'string') return false;
  const normalized = brief.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  return /^(?:are you working|are you online|is this working|is the boardroom working|does this work|does the boardroom work|boardroom status|status check)$/.test(normalized);
}

function requestedHistorySources(brief) {
  if (!requestsExternalHistory(brief)) return [];
  const requested = EXTERNAL_HISTORY_SOURCES.filter((source) => {
    if (source === 'claude_code') return /\bclaude\s+code\b/i.test(brief);
    if (source === 'claude') return /\bclaude\b(?!\s+code\b)/i.test(brief);
    if (source === 'codex') return /\bcodex\b/i.test(brief);
    return new RegExp(`\\b${source}\\b`, 'i').test(brief);
  });
  if (requested.length) return requested;
  if (/\b(?:all|every)\s+(?:of\s+)?(?:my\s+)?(?:ai\s+)?(?:platforms?|sources?|chats?|conversations?)\b/i.test(brief)) return [...EXTERNAL_HISTORY_SOURCES];
  return requested;
}

function importedHistoryEvidence(importedHistory, brief) {
  const messages = Array.isArray(importedHistory?.messages) ? importedHistory.messages : [];
  if (!messages.length) return [];
  const terms = [...new Set((String(brief).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])
    .filter((term) => !['from', 'with', 'this', 'that', 'history', 'chatgpt', 'claude', 'codex', 'grok', 'platforms'].includes(term)))];
  const scored = messages.map((message, index) => {
    const body = typeof message?.body === 'string' ? message.body : '';
    const haystack = body.toLowerCase();
    const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 3 : 0), 0);
    return { message, score: relevance + Math.max(0, 2 - Math.floor(index / 50)) };
  }).sort((a, b) => b.score - a.score || String(b.message?.created_at).localeCompare(String(a.message?.created_at)));
  const requested = requestedHistorySources(brief);
  const required = requested.map((source) => scored.find((item) => item.message?.source === source)).filter(Boolean);
  const requiredIds = new Set(required.map((item) => item.message?.id || `${item.message?.source}:${item.message?.source_message_id}`));
  const selectedItems = [...required, ...scored.filter((item) => !requiredIds.has(item.message?.id || `${item.message?.source}:${item.message?.source_message_id}`))].slice(0, 24);
  const selected = selectedItems.map(({ message }) => ({
    source: message.source,
    conversationId: message.source_conversation_id,
    author: message.author_name || message.author_type,
    createdAt: message.created_at,
    body: typeof message.body === 'string' ? message.body.slice(0, 700) : '',
  }));
  return selected;
}

function historyCoverage(importedHistory) {
  const messageCounts = new Map();
  for (const message of Array.isArray(importedHistory?.messages) ? importedHistory.messages : []) {
    if (message?.source) messageCounts.set(message.source, (messageCounts.get(message.source) || 0) + 1);
  }
  const states = new Map((Array.isArray(importedHistory?.sources) ? importedHistory.sources : []).map((item) => [item?.source, item]));
  const available = new Set(Array.isArray(importedHistory?.availableSources) ? importedHistory.availableSources : []);
  return EXTERNAL_HISTORY_SOURCES.map((source) => ({
    source,
    connected: states.get(source)?.status === 'connected' && (available.has(source) || (messageCounts.get(source) || 0) > 0),
    importedMessages: messageCounts.get(source) || 0,
    lastSyncedAt: states.get(source)?.last_synced_at || null,
  }));
}

function intelligenceEvidence(evidence, snapshot, history, importedHistory, brief) {
  const sources = Array.isArray(evidence) ? [...evidence] : [];
  const compactHistory = (Array.isArray(history) ? history : []).slice(0, 1).map((run) => ({
    id: run?.id,
    createdAt: run?.created_at || run?.createdAt,
    brief: typeof run?.brief === 'string' ? run.brief.slice(0, 300) : null,
    state: run?.state,
    consensus: (run?.report?.consensus || []).slice(0, 2).map((item) => ({
      topic: item?.topic,
      statement: typeof item?.statement === 'string' ? item.statement.slice(0, 180) : null,
    })),
    conflicts: (run?.report?.conflicts || []).slice(0, 1).map((item) => ({
      topic: item?.topic,
      statement: typeof item?.statement === 'string' ? item.statement.slice(0, 180) : null,
    })),
    completionStatus: run?.report?.completionGate?.status,
  }));
  const add = (sourceId, label, value, maxCharacters) => {
    if (sources.length >= 30 || value === null || value === undefined) return;
    const content = boundedJson(value, maxCharacters);
    if (content && content !== '{}' && content !== '[]') sources.push({ sourceId, label, content });
  };
  const explicitExternalHistory = requestedHistorySources(brief).length > 0;
  const externalHistoryRequested = requestsExternalHistory(brief);
  if (!externalHistoryRequested && !isDirectStatusCheck(brief)) {
    add('company-intelligence', 'Live HiveLogic company intelligence snapshot (read-only aggregates)', snapshot, 1_800);
    add('boardroom-history', 'Most recent Boardroom decision (historical recommendation, not a verified outcome)', compactHistory, 900);
  }
  if (externalHistoryRequested) {
    add('imported-ai-history', 'Verified imported AI conversation history requested by the user', importedHistoryEvidence(importedHistory, brief), 12_000);
  }
  return sources;
}

function boundedJson(value, maxCharacters) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) return serialized;
  if (Array.isArray(value)) {
    const bounded = [];
    for (const item of value) {
      const candidate = JSON.stringify([...bounded, item]);
      if (candidate.length > maxCharacters) break;
      bounded.push(item);
    }
    return JSON.stringify(bounded);
  }
  if (value && typeof value === 'object') {
    const bounded = {};
    for (const [key, item] of Object.entries(value)) {
      const candidate = JSON.stringify({ ...bounded, [key]: item });
      if (candidate.length > maxCharacters) continue;
      bounded[key] = item;
    }
    return JSON.stringify(bounded);
  }
  return JSON.stringify(String(value).slice(0, Math.max(0, maxCharacters - 2)));
}

function validIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// The desktop history bridge authenticates with an agent secret and stores
// imports under one configured owner. Boardroom requests authenticate as the
// signed-in admin. Those identities are intentionally different credentials,
// but they must resolve to the same history namespace or a successful import
// becomes invisible to Boardroom. Only admin/superadmin callers reach this
// handler, so the configured namespace remains access-controlled.
function importedHistoryOwnerId(staffId, env) {
  const configured = typeof env.HIVELOGIC_WORKROOM_OWNER_ID === 'string'
    ? env.HIVELOGIC_WORKROOM_OWNER_ID.trim()
    : '';
  return validUuid(configured) ? configured : staffId;
}

function cleanProjectName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 ? name : '';
}

// Detects an EXPLICIT request to create a project, covering the common ways
// people actually phrase it -- not just "create X project" (the original,
// verb-before-noun-only pattern from PR #339). Found during the 2026-08-18
// Boardroom production incident review: phrasing like "I'd like a master
// project created for this" or "I want a master project for this" matched
// nothing, so the request silently returned ok:true with project:null and
// the UI did nothing -- reproducing "reports success without executing the
// requested action" exactly.
//
// Three shapes are treated as explicit:
//   active:  a creation verb appears BEFORE "project"
//            ("create a project", "set up a master project")
//   passive: "project" appears BEFORE a creation verb, any tense
//            ("a master project created for this")
//   desire:  a want/need/please phrase with an INDEFINITE article before
//            "project" ("I want a project", "I'd like a master project").
//            The indefinite article is the disambiguator: "a project" asks
//            for a NEW one; "the project"/"this project" refers to an
//            EXISTING one and must never trigger creation.
// A brief that mentions "project" without matching any of these three is
// reported back as an ambiguous mention (mentionsProjectAmbiguously) instead
// of being silently ignored OR silently guessed into an unwanted project --
// both are real failure modes this detector has to avoid, not just the one
// that was reported.
// Base and gerund forms share one list so the negation check below can't
// drift out of sync with the active-creation check the way it did during
// review: a first draft of PROJECT_NEGATED only matched base-form verbs
// ("set up"), so "without setting up a project" -- a completely ordinary way
// to negate this -- slipped past it and auto-created a project anyway, the
// exact opposite of what "without" asked for.
const CREATE_VERBS = 'create|creating|make|making|build|building|start|starting|set\\s*up|setting\\s*up|spin\\s*up|spinning\\s*up|open|opening';
const CREATED_VERBS = 'created|made|built|started|set\\s*up|spun\\s*up|opened';
// ['’] rather than a plain "'" throughout: phones and word processors
// routinely autocorrect straight apostrophes to curly ones, and a detector
// that only matches the straight form would miss a large share of real
// typed-on-mobile phrasing.
const PROJECT_NEGATED = new RegExp(`\\b(?:do not|don['’]t|dont|without|no)\\s+(?:${CREATE_VERBS})\\b`, 'i');
// Deliberately narrower than "project" alone for the ambiguous-mention check
// below: this is a contractor app, and "the Riverside project"/"this
// project's timeline" are completely ordinary business sentences with
// nothing to do with Boardroom's project-grouping feature. "master project"
// is HiveLogic-specific branding for that feature and isn't a phrase that
// shows up by accident, so it's what actually distinguishes "ambiguously
// asking about Boardroom's project feature" from "the everyday word."
const MASTER_PROJECT_MENTIONED = /\bmaster\s+project\b/i;
const ACTIVE_PROJECT_CREATE = new RegExp(`\\b(?:${CREATE_VERBS})\\b[\\s\\S]{0,100}\\b(?:one|1|a|the)?\\s*(?:master\\s+)?project\\b`, 'i');
const PASSIVE_PROJECT_CREATE = new RegExp(`\\b(?:master\\s+)?project\\b[\\s\\S]{0,60}\\b(?:be\\s+)?(?:${CREATED_VERBS})\\b`, 'i');
const DESIRED_PROJECT_CREATE = /\b(?:want|need|would\s+like|i['’]d\s+like|please)\b[\s\S]{0,60}\b(?:a|an|one|1)\s+(?:master\s+)?project\b/i;

export function requestedProjectFromBrief(brief) {
  if (typeof brief !== 'string') return null;
  const normalized = brief.trim().replace(/\s+/g, ' ');
  if (!normalized || PROJECT_NEGATED.test(normalized)) return null;
  const explicitlyRequested = ACTIVE_PROJECT_CREATE.test(normalized)
    || PASSIVE_PROJECT_CREATE.test(normalized)
    || DESIRED_PROJECT_CREATE.test(normalized);
  if (!explicitlyRequested) return null;
  const product = /\bhive\s*logic\b/i.test(normalized) ? 'HiveLogic' : '';
  const master = /\bmaster\s+project\b/i.test(normalized);
  return { name: [product, master ? 'Master Project' : 'Boardroom Project'].filter(Boolean).join(' ') };
}

// A brief that mentions "master project" specifically (not the plain,
// ordinary word "project" -- see MASTER_PROJECT_MENTIONED above) but did not
// match any explicit-creation shape. Surfaced to the caller (and from there,
// the UI) so an unrecognized phrasing produces a visible "did you want a
// project?" signal instead of silent inaction -- the same bug class as the
// one PR #339 tried to fix, just for the phrasings that detector still
// cannot recognize.
export function mentionsProjectAmbiguously(brief) {
  if (typeof brief !== 'string') return false;
  const normalized = brief.trim().replace(/\s+/g, ' ');
  if (!normalized || PROJECT_NEGATED.test(normalized)) return false;
  return MASTER_PROJECT_MENTIONED.test(normalized) && !requestedProjectFromBrief(normalized);
}

function latestReplies(messages, audit = []) {
  const latest = new Map();
  for (const entry of Array.isArray(messages) ? messages : []) {
    const message = entry?.message || entry;
    if (!message?.participant || !Number.isInteger(message.round) || message.unavailable === true) continue;
    const current = latest.get(message.participant);
    if (!current || message.round >= current.round) {
      const usage = entry?.usage || audit.find((event) => event.type === 'provider.completed'
        && event.data?.participant === message.participant && event.data?.round === message.round)?.data?.usage || null;
      latest.set(message.participant, { ...message, usage });
    }
  }
  return ['chatgpt', 'claude', 'grok'].map((participant) => latest.get(participant)).filter(Boolean);
}

export function createCouncilHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getStaff = dependencies.requireStaff || requireStaff;
  const providers = dependencies.providers || ((providerEnv) => createCouncilProviders({ env: providerEnv }));
  const minimumParticipants = dependencies.minimumParticipants ?? 3;
  const store = dependencies.store || createCouncilStore();
  const getCompanySnapshot = dependencies.getCompanySnapshot || getSnapshotData;
  return async function handler(req, res) {
    secure(res);
    if (!enabled(env)) return res.status(404).json({ ok: false, error: 'AI Council is disabled.' });
    const staff = await getStaff(req);
    if (!staff || staff.forbidden) return res.status(staff ? 403 : 401).json({ ok: false, error: 'Admin authentication required.' });

    if (req.method === 'GET') {
      if (req.query?.status === '1') {
        const configured = configuredCouncilProviders(env);
        return res.status(200).json({
          ok: true, enabled: true, ready: configured.length === 3,
          providers: ['claude', 'chatgpt', 'grok'].map((name) => ({ name, configured: configured.includes(name) })),
          limits: { ...budgetCeiling(env), ...operationalLimits(env) },
        });
      }
      if (req.query?.workspace === '1') {
        const [projects, recent] = await Promise.all([
          store.getProjects(staff.id),
          store.getRecentRuns(staff.id, 50, 0),
        ]);
        return res.status(200).json({ ok: true, projects, recent });
      }
      if (req.query?.history === '1') {
        const requestedLimit = Number(req.query?.limit);
        const requestedOffset = Number(req.query?.offset);
        const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 50 ? requestedLimit : 25;
        const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset <= 100_000 ? requestedOffset : 0;
        const history = await store.getRecentRuns(staff.id, limit, offset);
        return res.status(200).json({ ok: true, history, hasMore: history.length === limit, nextOffset: offset + history.length });
      }
      const runId = typeof req.query?.runId === 'string' ? req.query.runId : '';
      if (!runId) return res.status(400).json({ ok: false, error: 'runId is required.' });
      const run = await store.getRun(runId, staff.id);
      return run ? res.status(200).json({ ok: true, run }) : res.status(404).json({ ok: false, error: 'Council run not found.' });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    const body = req.body || {};
    if (body.action === 'create_project') {
      if (!bodyKeys(body, ['action', 'name', 'repository'])) return res.status(400).json({ ok: false, error: 'Unsupported request fields.' });
      const name = cleanProjectName(body.name);
      const repository = typeof body.repository === 'string' ? body.repository.trim().slice(0, 500) : '';
      if (!name) return res.status(400).json({ ok: false, error: 'A project name is required.' });
      const project = await store.createProject({ ownerId: staff.id, name, repository: repository || null });
      // Supabase's `Prefer: return=representation` can come back 2xx with no
      // row (e.g. a policy that doesn't grant SELECT back to the inserting
      // role) -- store.createProject()/responseValue() then hands back
      // undefined even though nothing failed. Left unguarded, the client
      // treated that as success, unshifted `undefined` into its in-memory
      // project list, and crashed on the very next history render
      // (workspaceProjects.find(...).id) rather than at the point of the
      // actual problem. Fail loudly here instead of returning a fake success.
      if (!project) return res.status(500).json({ ok: false, error: 'Boardroom project could not be created.' });
      return res.status(201).json({ ok: true, project });
    }
    if (body.action === 'update_run_metadata') {
      if (!bodyKeys(body, ['action', 'runId', 'pinned', 'projectId'])) return res.status(400).json({ ok: false, error: 'Unsupported request fields.' });
      if (!validUuid(body.runId) || (body.pinned !== undefined && typeof body.pinned !== 'boolean')
        || (body.projectId !== undefined && body.projectId !== null && !validUuid(body.projectId))) {
        return res.status(400).json({ ok: false, error: 'Valid Boardroom metadata is required.' });
      }
      if (body.projectId) {
        const projects = await store.getProjects(staff.id);
        if (!projects.some((project) => project.id === body.projectId)) return res.status(404).json({ ok: false, error: 'Boardroom project not found.' });
      }
      const run = await store.updateRunMetadata({ ownerId: staff.id, runId: body.runId, pinned: body.pinned, projectId: body.projectId });
      return res.status(200).json({ ok: true, run });
    }
    if (body.action === 'start') {
      if (!bodyKeys(body, ['action', 'brief', 'evidence', 'attachments', 'budget', 'executionRequest', 'idempotencyKey', 'projectId'])) return res.status(400).json({ ok: false, error: 'Unsupported request fields.' });
      if (!validIdempotencyKey(body.idempotencyKey)) return res.status(400).json({ ok: false, error: 'A valid idempotencyKey is required.' });
      if (body.projectId !== undefined && body.projectId !== null && !validUuid(body.projectId)) return res.status(400).json({ ok: false, error: 'A valid Boardroom project is required.' });
      if (body.projectId) {
        const projects = await store.getProjects(staff.id);
        if (!projects.some((project) => project.id === body.projectId)) return res.status(404).json({ ok: false, error: 'Boardroom project not found.' });
      }
      if (configuredCouncilProviders(env).length !== 3) return res.status(409).json({ ok: false, error: 'All three provider keys, models, and price configuration are required.' });
      const limits = operationalLimits(env);
      const checkedBudget = normalizeBudget(body.budget, budgetCeiling(env));
      if (!checkedBudget) return res.status(400).json({ ok: false, error: 'Council budget is invalid or exceeds a server ceiling.' });
      const requestedCost = checkedBudget.maxCostCents;
      let admission;
      try {
        admission = await store.admit({
          ownerId: staff.id, idempotencyKey: body.idempotencyKey, requestHash: requestHash(body),
          maxCostCents: requestedCost, maxConcurrentRuns: limits.maxConcurrentRuns, dailyCostCents: limits.dailyCostCents,
        });
      } catch {
        return res.status(503).json({ ok: false, error: 'Council admission control is unavailable.' });
      }
      if (admission?.status === 'replay' && admission.runId) {
        const run = await store.getRun(admission.runId, staff.id);
        return run ? res.status(200).json({ ok: true, replayed: true, runId: run.id, state: run.state, report: run.report, usage: run.usage, replies: latestReplies(run.messages), executionRequest: run.execution_request })
          : res.status(503).json({ ok: false, error: 'The prior Council record could not be loaded.' });
      }
      if (admission?.status === 'in_progress') return res.status(409).json({ ok: false, error: 'This Council request is already in progress.' });
      if (admission?.status === 'conflict') return res.status(409).json({ ok: false, error: 'The idempotency key was already used for a different request.' });
      if (admission?.status === 'quota_exceeded') return res.status(429).json({ ok: false, error: admission.reason === 'daily_cost' ? 'The Boardroom\'s daily provider budget is currently exhausted.' : 'Too many Boardroom requests are active.' });
      if (admission?.status !== 'admitted' || !admission.admissionId) return res.status(503).json({ ok: false, error: 'Council admission was not granted.' });

      let result;
      try {
        const [snapshotResult, historyResult, importedResult] = await Promise.allSettled([
          getCompanySnapshot(),
          typeof store.getRecentRuns === 'function' ? store.getRecentRuns(staff.id, 6) : Promise.resolve([]),
          typeof store.getImportedHistory === 'function'
            ? store.getImportedHistory(importedHistoryOwnerId(staff.id, env), 500)
            : Promise.resolve({ sources: [], messages: [] }),
        ]);
        const importedHistory = importedResult.status === 'fulfilled' ? importedResult.value : { sources: [], messages: [] };
        const requestedSources = requestedHistorySources(body.brief);
        if (requestedSources.length) {
          const coverage = historyCoverage(importedHistory);
          const missingSources = requestedSources.filter((source) => !coverage.find((item) => item.source === source)?.connected);
          if (missingSources.length) {
            await store.releaseAdmission({ admissionId: admission.admissionId, ownerId: staff.id }).catch(() => {});
            return res.status(409).json({
              ok: false,
              code: 'HISTORY_SOURCES_NOT_IMPORTED',
              error: `Boardroom did not run because ${missingSources.join(', ')} history has not been imported. No substitute company-data answer was generated.`,
              requestedSources,
              missingSources,
              coverage,
            });
          }
        }
        const boardEvidence = intelligenceEvidence(
          body.evidence,
          snapshotResult.status === 'fulfilled' ? snapshotResult.value : null,
          historyResult.status === 'fulfilled' ? historyResult.value : [],
          importedHistory,
          body.brief,
        );
        result = await runCouncil({ brief: body.brief, evidence: boardEvidence, attachments: body.attachments, budget: body.budget, budgetCeiling: budgetCeiling(env), providers: providers(runtimeProviderEnv(env, req)), executionRequest: body.executionRequest, minimumParticipants });
        if (!result.ok) {
          console.error('[reina-council] run failed', JSON.stringify({
            error: result.error,
            diagnostics: result.diagnostics || [],
          }));
          await store.releaseAdmission({ admissionId: admission.admissionId, ownerId: staff.id }).catch(() => {});
          return res.status(400).json({ ok: false, error: result.error, diagnostics: result.diagnostics || [] });
        }
        let project = null;
        let projectCreated = false;
        let projectId = body.projectId || null;
        const projectRequest = projectId ? null : requestedProjectFromBrief(body.brief);
        if (projectRequest) {
          const ensured = await store.getOrCreateProject({ ownerId: staff.id, name: projectRequest.name });
          project = ensured.project;
          projectCreated = ensured.created;
          projectId = project.id;
        }
        const projectRequestAmbiguous = !projectId && mentionsProjectAmbiguously(body.brief);
        const run = await store.createRun({ ownerId: staff.id, admissionId: admission.admissionId, brief: body.brief, evidence: storedInput({ ...body, evidence: boardEvidence }), result, projectId });
        const independentRound = result.audit.find((event) => event.type === 'moderator.independent_round_completed');
        // The independent round is always fully fresh (3-of-3, retried once
        // if needed -- see runCouncil) by the time a run reaches here, but a
        // later debate round can still silently carry forward a provider's
        // last verified position when that provider is unavailable mid-debate
        // (council-core.js does not hard-fail on this). Surfaced here so the
        // Boardroom UI can show it instead of an indistinguishable "all 3
        // debated" report.
        const staleDebatePositions = result.audit
          .filter((event) => event.type === 'moderator.debate_round_completed' && Array.isArray(event.data?.carriedForward) && event.data.carriedForward.length > 0)
          .map((event) => ({ round: event.data.round, participants: event.data.carriedForward }));
        return res.status(201).json({ ok: true, runId: run.id, state: result.state, report: result.report, usage: result.usage, replies: latestReplies(result.messages, result.audit), degradedProviders: independentRound?.data?.unavailable || [], staleDebatePositions, executionRequest: result.executionRequest, project, projectCreated, projectRequestAmbiguous });
      } catch {
        await store.releaseAdmission({ admissionId: admission.admissionId, ownerId: staff.id }).catch(() => {});
        return res.status(503).json({ ok: false, error: 'Council completed but its audit record could not be persisted; no execution is available.' });
      }
    }
    if (body.action === 'approve_execution') {
      if (!bodyKeys(body, ['action', 'runId', 'reason'])) return res.status(400).json({ ok: false, error: 'Unsupported request fields.' });
      const run = await store.getRun(body.runId, staff.id);
      if (!run || run.state !== 'awaiting_human_approval' || !run.execution_request) return res.status(409).json({ ok: false, error: 'No pending Council execution approval exists.' });
      const checked = validateTask(run.execution_request.taskType, { path: run.execution_request.path });
      if (!checked.ok) return res.status(400).json({ ok: false, error: 'Stored execution request is not an allowed HiveBridge task.' });
      const task = { ...run.execution_request, scopeHash: taskScopeHash({ agentId: run.execution_request.agentId, taskType: run.execution_request.taskType, payload: checked.payload }) };
      try {
        const queued = await store.approveAndQueue({ run, ownerId: staff.id, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null, task });
        return res.status(202).json({ ok: true, state: 'queued_for_hivebridge', taskId: queued.id, executed: false });
      } catch {
        return res.status(409).json({ ok: false, error: 'Approval was not able to queue a permitted HiveBridge task; no command was executed.' });
      }
    }
    return res.status(400).json({ ok: false, error: 'Unsupported action.' });
  };
}

export default createCouncilHandler();
