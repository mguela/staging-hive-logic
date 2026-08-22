import { randomUUID } from 'node:crypto';

import { supabaseRequest } from '../jobber.js';

async function responseValue(response, error) {
  if (!response?.ok || typeof response.json !== 'function') throw new Error(error);
  const value = await response.json();
  return Array.isArray(value) ? value[0] : value;
}

const COUNCIL_PARTICIPANTS = Object.freeze(['claude', 'chatgpt', 'grok']);
const HISTORY_SOURCES = Object.freeze(['codex', 'chatgpt', 'claude', 'claude_code', 'grok']);

// Older production versions of reina_council_create_run require an exact
// three-provider message/audit cardinality. Resilient conversational runs can
// now complete with one healthy provider, so retry legacy databases with
// explicit unavailable placeholders. These records are audit facts, not
// fabricated model answers, and are filtered from user-facing replay output.
function legacyCompatiblePayload(result, messages, events) {
  const rounds = Number(result?.budget?.maxRounds) || 1;
  const paddedMessages = [];
  const unavailable = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const participant of COUNCIL_PARTICIPANTS) {
      const existing = messages.find((entry) => entry.participant === participant && entry.round === round);
      if (existing) {
        paddedMessages.push(existing);
        continue;
      }
      unavailable.push({ participant, round });
      paddedMessages.push({
        participant,
        round,
        message: {
          participant,
          round,
          unavailable: true,
          summary: 'Provider unavailable; no answer was generated for this round.',
        },
        usage: {},
      });
    }
  }
  const targetAuditCount = 3 + (7 * rounds);
  const paddedEvents = [...events];
  const occurredAt = events.at(-1)?.occurredAt || new Date().toISOString();
  let index = 0;
  while (paddedEvents.length < targetAuditCount) {
    const detail = unavailable[index % Math.max(unavailable.length, 1)] || { participant: null, round: null };
    paddedEvents.push({
      eventType: 'provider.unavailable_legacy_persistence',
      detail: { ...detail, generatedAnswer: false },
      occurredAt,
    });
    index += 1;
  }
  return { messages: paddedMessages, events: paddedEvents };
}

export function createCouncilStore({ request = supabaseRequest, tenantId = process.env.HIVELOGIC_TENANT_ID || 'ghgrp' } = {}) {
  async function admit({ ownerId, idempotencyKey, requestHash, maxCostCents, maxConcurrentRuns, dailyCostCents }) {
    const response = await request('rpc/reina_council_admit', {
      method: 'POST',
      body: JSON.stringify({
        p_owner_id: ownerId, p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash, p_reserved_cost_cents: maxCostCents,
        p_max_concurrent_runs: maxConcurrentRuns, p_daily_cost_cents: dailyCostCents,
      }),
    });
    return responseValue(response, 'Council admission control failed.');
  }

  async function releaseAdmission({ admissionId, ownerId }) {
    const response = await request('rpc/reina_council_release_admission', {
      method: 'POST', body: JSON.stringify({ p_admission_id: admissionId, p_owner_id: ownerId }),
    });
    return responseValue(response, 'Council admission could not be released.');
  }

  async function createRun({ ownerId, admissionId, brief, evidence, result, projectId = null }) {
    const id = randomUUID();
    const messages = result.messages.map((message) => ({
      participant: message.participant, round: message.round, message,
      usage: result.audit.find((event) => event.type === 'provider.completed' && event.data.participant === message.participant && event.data.round === message.round)?.data.usage || {},
    }));
    const events = result.audit.map((event) => ({ eventType: event.type, detail: event.data, occurredAt: event.at }));
    // project_id travels in the SAME atomic RPC call, not a follow-up PATCH.
    // The PATCH used to run after this transaction had already committed --
    // if it failed, the client was told the whole request failed (503) while
    // the run (and, for an explicit "create a project" request, a fresh
    // project row created moments earlier) already existed in the database.
    // Found during the 2026-08-18 Boardroom production incident review.
    const requestRun = (runMessages, auditEvents) => request('rpc/reina_council_create_run', {
      method: 'POST',
      body: JSON.stringify({
        p_id: id, p_owner_id: ownerId, p_admission_id: admissionId, p_state: result.state, p_brief: brief,
        p_evidence: evidence, p_budget: result.budget, p_usage: result.usage,
        p_report: result.report, p_execution_request: result.executionRequest,
        p_messages: runMessages, p_audit_events: auditEvents, p_project_id: projectId,
      }),
    });
    let created = await requestRun(messages, events);
    if (!created?.ok) {
      const legacy = legacyCompatiblePayload(result, messages, events);
      if (legacy.messages.length !== messages.length || legacy.events.length !== events.length) {
        console.warn('[reina-council] retrying legacy persistence contract', {
          actualMessages: messages.length,
          persistedMessages: legacy.messages.length,
          actualAuditEvents: events.length,
          persistedAuditEvents: legacy.events.length,
        });
        created = await requestRun(legacy.messages, legacy.events);
      }
    }
    const row = await responseValue(created, 'Could not persist complete council run and audit log.');
    if (!row?.id) throw new Error('Could not persist complete council run and audit log.');
    return row;
  }

  async function getRun(id, ownerId) {
    const response = await request('rpc/reina_council_get_run', {
      method: 'POST', body: JSON.stringify({ p_run_id: id, p_owner_id: ownerId }),
    });
    return responseValue(response, 'Council run could not be read.');
  }

  async function getRecentRuns(ownerId, limit = 25, offset = 0) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 50)) : 25;
    const boundedOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 100_000)) : 0;
    const response = await request(`reina_council_runs?owner_id=eq.${encodeURIComponent(ownerId)}&select=id,brief,state,report,usage,project_id,pinned,created_at,updated_at&order=created_at.desc&limit=${boundedLimit}&offset=${boundedOffset}`);
    if (!response?.ok || typeof response.json !== 'function') throw new Error('Boardroom history could not be read.');
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  }

  async function getImportedHistory(ownerId, limit = 300) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 300;
    const [threadsResponse, sourcesResponse] = await Promise.all([
      request(`ai_workroom_threads?owner_id=eq.${encodeURIComponent(ownerId)}&select=id&limit=1000`),
      request(`ai_workroom_sources?owner_id=eq.${encodeURIComponent(ownerId)}&source=in.(${HISTORY_SOURCES.join(',')})&select=source,status,last_synced_at,details&order=source.asc`),
    ]);
    if (!threadsResponse?.ok || typeof threadsResponse.json !== 'function'
      || !sourcesResponse?.ok || typeof sourcesResponse.json !== 'function') {
      throw new Error('Imported AI history coverage could not be read.');
    }
    const threads = await threadsResponse.json();
    const sources = await sourcesResponse.json();
    const threadIds = (Array.isArray(threads) ? threads : []).map((row) => row?.id).filter(Boolean);
    if (!threadIds.length) return { sources: Array.isArray(sources) ? sources : [], messages: [], availableSources: [] };
    const encodedIds = threadIds.map((id) => String(id).replace(/[^0-9a-f-]/gi, '')).join(',');
    const [messagesResponse, ...coverageResponses] = await Promise.all([
      request(`ai_workroom_messages?thread_id=in.(${encodeURIComponent(encodedIds)})&source=not.is.null&select=id,thread_id,author_type,author_name,body,source,source_conversation_id,source_message_id,created_at&order=created_at.desc&limit=${boundedLimit}`),
      ...HISTORY_SOURCES.map((source) => request(`ai_workroom_messages?thread_id=in.(${encodeURIComponent(encodedIds)})&source=eq.${encodeURIComponent(source)}&source_message_id=not.is.null&select=id&limit=1`)),
    ]);
    if (!messagesResponse?.ok || typeof messagesResponse.json !== 'function') throw new Error('Imported AI history messages could not be read.');
    const messages = await messagesResponse.json();
    const availableSources = [];
    for (let index = 0; index < coverageResponses.length; index += 1) {
      const response = coverageResponses[index];
      if (!response?.ok || typeof response.json !== 'function') continue;
      const rows = await response.json();
      if (Array.isArray(rows) && rows.length) availableSources.push(HISTORY_SOURCES[index]);
    }
    return { sources: Array.isArray(sources) ? sources : [], messages: Array.isArray(messages) ? messages : [], availableSources };
  }

  async function getProjects(ownerId) {
    const response = await request(`boardroom_projects?owner_id=eq.${encodeURIComponent(ownerId)}&select=id,name,repository,created_at,updated_at&order=updated_at.desc&limit=100`);
    if (!response?.ok || typeof response.json !== 'function') throw new Error('Boardroom projects could not be read.');
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  }

  async function createProject({ ownerId, name, repository = null }) {
    const response = await request('boardroom_projects', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: ownerId, name, repository }),
    });
    return responseValue(response, 'Boardroom project could not be created.');
  }

  async function getOrCreateProject({ ownerId, name, repository = null }) {
    const find = async () => {
      const response = await request(`boardroom_projects?owner_id=eq.${encodeURIComponent(ownerId)}&name=eq.${encodeURIComponent(name)}&select=id,name,repository,created_at,updated_at&limit=1`);
      if (!response?.ok || typeof response.json !== 'function') throw new Error('Boardroom project could not be read.');
      const rows = await response.json();
      return Array.isArray(rows) ? rows[0] || null : null;
    };
    const existing = await find();
    if (existing) return { project: existing, created: false };
    try {
      return { project: await createProject({ ownerId, name, repository }), created: true };
    } catch (error) {
      // The database uniqueness constraint is the concurrency fence. If two
      // identical requests race, return the winner instead of creating a
      // duplicate or failing the owner's retry.
      const raced = await find();
      if (raced) return { project: raced, created: false };
      throw error;
    }
  }

  async function updateRunMetadata({ ownerId, runId, pinned, projectId }) {
    const patch = { updated_at: new Date().toISOString() };
    if (typeof pinned === 'boolean') patch.pinned = pinned;
    if (projectId === null || typeof projectId === 'string') patch.project_id = projectId;
    const response = await request(`reina_council_runs?id=eq.${encodeURIComponent(runId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    const row = await responseValue(response, 'Boardroom decision could not be updated.');
    if (!row?.id) throw new Error('Boardroom decision could not be updated.');
    return row;
  }

  async function approveAndQueue({ run, ownerId, reason, task }) {
    const queued = await request('rpc/reina_council_approve_and_queue', {
      method: 'POST',
      body: JSON.stringify({
        p_run_id: run.id, p_owner_id: ownerId, p_reason: reason, p_tenant_id: tenantId,
        p_agent_id: task.agentId, p_task_type: task.taskType, p_path: task.path,
        p_scope_hash: task.scopeHash,
      }),
    });
    const row = await responseValue(queued, 'Approval and HiveBridge queue transaction failed; no task was queued.');
    if (!row?.id) throw new Error('Approval and HiveBridge queue transaction failed; no task was queued.');
    return row;
  }

  return Object.freeze({
    admit, releaseAdmission, createRun, getRun, getRecentRuns,
    getImportedHistory, getProjects, createProject, getOrCreateProject, updateRunMetadata, approveAndQueue,
  });
}
