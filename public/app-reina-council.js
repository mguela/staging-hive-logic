(function () {
  'use strict';

  var loaded = false;
  var attachments = [];
  var activeRunId = '';
  var pendingKey = '';
  var pendingFingerprint = '';
  var draftEvidence = [];
  var pendingBoardroomDraft = null;
  var timeMachineRun = null;
  var selectedFuture = 'recommended';
  var historyRows = [];
  var historyOffset = 0;
  var historyLoading = false;
  var historyDone = false;
  var workspaceProjects = [];
  var historyMode = 'recent';
  var selectedProjectId = '';
  var HISTORY_PAGE_SIZE = 25;
  var MAX_ATTACHMENTS = 30;
  var MAX_ATTACHMENT_BYTES = 2500000;

  function byId(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function title(value) { return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function number(value) { return Number(value || 0).toLocaleString(); }
  function money(value) { return '$' + (Number(value || 0) / 100).toFixed(2); }
  function dateLabel(value) {
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'rc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function readBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '').split(',').pop()); };
      reader.onerror = function () { reject(reader.error || new Error('That file could not be read.')); };
      reader.readAsDataURL(blob);
    });
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('That file could not be read.')); };
      reader.readAsText(file);
    });
  }

  async function imageAttachment(file, targetBytes) {
    if (!/^image\/(?:jpeg|png)$/.test(file.type)) throw new Error('Use a JPG or PNG photo.');
    var image = await createImageBitmap(file);
    var scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    var canvas = document.createElement('canvas');
    var quality = .78;
    var blob = null;
    for (var attempt = 0; attempt < 7; attempt += 1) {
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      var context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
      if (blob && blob.size <= targetBytes) break;
      quality = Math.max(.48, quality - .08);
      scale *= .82;
    }
    if (typeof image.close === 'function') image.close();
    if (!blob || blob.size > targetBytes) throw new Error('That photo could not be reduced enough to fit safely.');
    return { id: uuid(), name: file.name, kind: 'image', mimeType: 'image/jpeg', dataBase64: await readBase64(blob), sizeBytes: blob.size };
  }

  async function normalizeFile(file, targetBytes) {
    var name = String(file.name || 'attachment').slice(0, 240);
    if (/^image\//.test(file.type)) return imageAttachment(file, targetBytes);
    if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
      if (file.size > 1500000) throw new Error('That PDF is too large. Keep it under 1.5 MB.');
      return { id: uuid(), name: name, kind: 'pdf', mimeType: 'application/pdf', dataBase64: await readBase64(file), sizeBytes: file.size };
    }
    if (/^text\//.test(file.type) || /\.(?:txt|md|csv|json|xml|ya?ml|js|ts|css)$/i.test(name)) {
      if (file.size > 500000) throw new Error('That text file is too large. Keep it under 500 KB.');
      return { id: uuid(), name: name, kind: 'text', mimeType: 'text/plain', content: await readText(file), sizeBytes: file.size };
    }
    throw new Error('That file type is not readable yet. Use a photo, PDF, or text-based file.');
  }

  function renderAttachments() {
    var host = byId('rc-attachments');
    if (!host) return;
    host.innerHTML = attachments.map(function (item) {
      return '<div class="rc-attachment"><span><b>' + esc(item.name) + '</b><small>' + esc(item.kind === 'image' ? 'Photo' : item.kind === 'pdf' ? 'PDF' : 'File') + '</small></span><button type="button" data-attachment-id="' + esc(item.id) + '" aria-label="Remove ' + esc(item.name) + '">&times;</button></div>';
    }).join('');
  }

  async function addFiles(fileList) {
    showError('');
    try {
      var incoming = Array.prototype.slice.call(fileList || []);
      if (attachments.length + incoming.length > MAX_ATTACHMENTS) throw new Error('Add up to 30 files or photos per Boardroom request.');
      var existingBytes = attachments.reduce(function (sum, item) { return sum + item.sizeBytes; }, 0);
      var targetBytes = Math.min(180000, Math.floor((MAX_ATTACHMENT_BYTES - existingBytes) / Math.max(1, incoming.length)));
      if (targetBytes < 30000) throw new Error('These files would exceed the safe upload size. Remove a large PDF or some photos and try again.');
      var added = [];
      for (var i = 0; i < incoming.length; i += 1) added.push(await normalizeFile(incoming[i], targetBytes));
      if (attachments.concat(added).reduce(function (sum, item) { return sum + item.sizeBytes; }, 0) > MAX_ATTACHMENT_BYTES) throw new Error('Those files are too large together. Remove a large PDF or some photos and try again.');
      attachments = attachments.concat(added);
      renderAttachments();
    } catch (error) {
      showError(error.message);
    }
    if (byId('rc-files')) byId('rc-files').value = '';
  }

  async function api(url, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
    options.headers = headers;
    var response = await fetch(url, options);
    var payload = {};
    try { payload = await response.json(); } catch (ignore) {}
    if (!response.ok) {
      var error = new Error(payload.error || ('Boardroom request failed (' + response.status + ').'));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setStatus(state, label) {
    var node = byId('rc-status');
    if (!node) return;
    node.dataset.state = state;
    var text = node.querySelector('b');
    if (text) text.textContent = label;
  }

  function showError(message) {
    var node = byId('rc-error');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function clearDraftContext() {
    draftEvidence = [];
    var banner = byId('rc-handoff');
    if (banner) banner.hidden = true;
  }

  function applyBoardroomDraft(payload) {
    if (!payload || typeof payload !== 'object') return;
    var brief = typeof payload.brief === 'string' ? payload.brief.trim().slice(0, 12000) : '';
    if (!brief || !byId('rc-brief')) return;
    byId('rc-brief').value = brief;
    draftEvidence = (Array.isArray(payload.evidence) ? payload.evidence : []).slice(0, 5).map(function (source, index) {
      return {
        sourceId: String(source && source.sourceId || ('owners-brief-' + index)).slice(0, 120),
        label: String(source && source.label || "Owner's Brief").slice(0, 240),
        content: String(source && source.content || '').slice(0, 11500)
      };
    }).filter(function (source) { return source.content; });
    var banner = byId('rc-handoff');
    if (banner) banner.hidden = false;
    var label = byId('rc-handoff-label');
    if (label) label.textContent = String(payload.label || 'Decision context attached').slice(0, 160);
    byId('rc-brief').focus();
  }

  function collect() {
    var request = {
      action: 'start',
      brief: byId('rc-brief').value.trim(),
      evidence: draftEvidence.map(function (source) { return { sourceId: source.sourceId, label: source.label, content: source.content }; }),
      attachments: attachments.map(function (item) {
        return item.kind === 'text'
          ? { id: item.id, name: item.name, kind: item.kind, mimeType: item.mimeType, content: item.content }
          : { id: item.id, name: item.name, kind: item.kind, mimeType: item.mimeType, dataBase64: item.dataBase64 };
      }),
      budget: {
        maxRounds: Math.max(2, Number(byId('rc-rounds').value)),
        maxTokensPerResponse: Number(byId('rc-tokens').value),
        maxCostCents: Number(byId('rc-cost').value)
      }
    };
    if (selectedProjectId) request.projectId = selectedProjectId;
    if (!request.brief) throw new Error('Type a question first.');
    if (byId('rc-execution').open) {
      var execution = {
        agentId: byId('rc-agent').value.trim(),
        taskType: byId('rc-task').value,
        path: byId('rc-path').value.trim()
      };
      if (!execution.agentId || !execution.path) throw new Error('The optional HiveBridge request needs an agent ID and exact repository path.');
      request.executionRequest = execution;
    }
    return request;
  }

  function citations(claims) {
    var seen = {};
    var output = [];
    (claims || []).forEach(function (claim) {
      (claim.citations || []).forEach(function (citation) {
        var key = citation.sourceId + '|' + citation.locator;
        if (!seen[key]) { seen[key] = true; output.push('<span class="rc-cite" title="' + esc(citation.excerpt) + '">' + esc(citation.sourceId) + ' &middot; ' + esc(citation.locator) + '</span>'); }
      });
    });
    return output.join('');
  }

  function reportColumn(kind, items) {
    var body = (items || []).map(function (item) {
      var claims = item.claims || [];
      if (item.positions) claims = item.positions.reduce(function (all, position) { return all.concat(position.claims || []); }, []);
      var statement = claims.map(function (claim) { return claim.statement; }).filter(Boolean).join(' ');
      var detail = item.positions
        ? item.positions.map(function (position) { return title(position.stance) + ': ' + (position.participants || []).map(title).join(', '); }).join(' · ')
        : (item.stance ? title(item.stance) + ' · ' + (item.participants || []).map(title).join(', ') : 'Insufficient agreement');
      return '<div class="rc-topic"><b>' + esc(item.topic) + '</b><p>' + esc(detail) + '</p>' + (statement ? '<p>' + esc(statement) + '</p>' : '') + citations(claims) + '</div>';
    }).join('');
    return '<section class="rc-decision" data-kind="' + kind + '"><h3>' + title(kind) + ' (' + (items || []).length + ')</h3>' + (body || '<div class="rc-empty">None recorded.</div>') + '</section>';
  }

  function renderReport(report) {
    report = report || {};
    byId('rc-report').innerHTML = '<div class="rc-decision-grid">' +
      reportColumn('consensus', report.consensus) + reportColumn('conflict', report.conflicts) + reportColumn('unresolved', report.unresolved) + '</div>';
  }

  function renderAnswer(report, rows) {
    report = report || {};
    var latest = {};
    (rows || []).forEach(function (row) {
      var participant = row.participant || (row.message || {}).participant;
      if (!latest[participant] || Number(row.round) >= Number(latest[participant].round)) latest[participant] = row;
    });
    var allClaims = [];
    Object.keys(latest).forEach(function (participant) {
      var message = latest[participant].message || latest[participant];
      (message.claims || []).forEach(function (claim) { allClaims.push(claim); });
    });
    function unique(values) {
      var seen = {};
      return values.filter(function (value) {
        var key = String(value || '').trim();
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      });
    }
    function concise(values, limit, maxLength) {
      return unique(values).slice(0, limit).map(function (value) {
        var text = String(value || '').trim();
        if (text.length <= maxLength) return text;
        var shortened = text.slice(0, maxLength - 1);
        var lastSpace = shortened.lastIndexOf(' ');
        return shortened.slice(0, lastSpace > maxLength * 0.7 ? lastSpace : shortened.length).trim() + '\u2026';
      });
    }
    function matching(pattern) {
      return unique(allClaims.filter(function (claim) { return pattern.test(String(claim.topic || '')); }).map(function (claim) { return claim.statement; }));
    }
    var risks = unique(Object.keys(latest).reduce(function (all, participant) {
      var message = latest[participant].message || latest[participant];
      return all.concat(message.risks || []);
    }, []));
    var questions = unique(Object.keys(latest).reduce(function (all, participant) {
      var message = latest[participant].message || latest[participant];
      return all.concat(message.questions || []);
    }, []));
    var summaries = unique(Object.keys(latest).map(function (participant) {
      var message = latest[participant].message || latest[participant];
      return message.summary;
    }));
    // Found 2026-08-20: "cash crisis severity" (a real claim topic from this
    // debate) matches BOTH Company intelligence's regex (has "cash") AND
    // Financial impact's (also has "cash") -- matching() has no notion of
    // "already shown elsewhere", so the exact same claim statement rendered
    // verbatim in two different sections. live-confirmed against a real run
    // (18d4fa3b-...): every one of ChatGPT's round-1 claims appeared in both.
    // usedStatements makes section assignment mutually exclusive: whichever
    // section is built FIRST (the declared order below is the priority) claims
    // a statement, and every section after it skips anything already shown --
    // a claim that doesn't make an earlier section's own length limit is still
    // free for a later one to pick up.
    var usedStatements = {};
    function claimSection(label, pattern, limit, maxLength, extra) {
      var unclaimed = matching(pattern).filter(function (statement) { return !usedStatements[statement]; });
      var picked = concise(unclaimed.concat(extra || []), limit, maxLength);
      picked.forEach(function (text) { usedStatements[text] = true; });
      return [label, picked];
    }
    var sections = [
      claimSection('Executive recommendation', /executive|recommendation|decision/i, 3, 360, summaries),
      claimSection('Company intelligence', /company signal|intelligence|trend|pattern|data|growth|market|opportunity|customer|competitive|revenue|cash|capacity|performance/i, 3, 300),
      claimSection('Financial impact', /financial|price|cost|budget|cash|margin|profit|return|roi|allowance/i, 2, 300),
      claimSection('Risks and open questions', /risk|downside|objection|unknown|constraint|conflict|governance|information|evidence gap|assumption|verification/i, 3, 300, risks.concat(questions)),
      claimSection('Next actions', /30|60|90|next step|action|milestone|implementation/i, 3, 300)
    ].filter(function (section) { return section[1].length; });
    var completion = report.completionStandard;
    var gate = report.completionGate || { authoritativeLabel: 'NOT DONE', reason: 'No machine-verifiable completion receipt exists.' };
    sections.unshift(['Authoritative work status', [gate.authoritativeLabel || 'NOT DONE', gate.reason || 'Verification evidence is incomplete.']]);
    if (completion && completion.rule) {
      sections.push(['Definition of done', [completion.rule, 'Until the required test evidence is recorded and every discovered defect is resolved, this recommendation is unverified—not done.']]);
    }
    if (!sections.length) {
      sections = [['Executive recommendation', concise(Object.keys(latest).map(function (participant) {
        var message = latest[participant].message || latest[participant];
        return message.summary;
      }), 3, 360)]];
    }
    byId('rc-answer').innerHTML = sections.map(function (section) {
      return '<section class="rc-proposal-section"><h3>' + esc(section[0]) + '</h3><ul>' + section[1].map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul></section>';
    }).join('');
  }

  function renderMessages(rows) {
    rows = (rows || []).slice().sort(function (a, b) {
      return Number(a.round) - Number(b.round) || String(a.participant).localeCompare(String(b.participant));
    });
    byId('rc-messages').innerHTML = rows.map(function (row) {
      var message = row.message || row;
      var claims = message.claims || [];
      return '<article class="rc-message"><header><b>' + esc(title(row.participant || message.participant)) + '</b><span>' + (Number(row.round == null ? message.round : row.round) === 0 ? 'Independent director brief' : 'Board round ' + esc(row.round == null ? message.round : row.round)) + '</span></header><div>' +
        '<p>' + esc(message.summary) + '</p>' +
        claims.map(function (claim) { return '<div class="rc-topic"><b>' + esc(claim.topic) + ' · ' + esc(title(claim.stance)) + '</b><p>' + esc(claim.statement) + '</p>' + citations([claim]) + '</div>'; }).join('') +
        ((message.risks || []).length ? '<b class="rc-empty">RISKS</b><ul>' + message.risks.map(function (risk) { return '<li>' + esc(risk) + '</li>'; }).join('') + '</ul>' : '') +
        ((message.questions || []).length ? '<b class="rc-empty">QUESTIONS</b><ul>' + message.questions.map(function (question) { return '<li>' + esc(question) + '</li>'; }).join('') + '</ul>' : '') +
        '</div></article>';
    }).join('') || '<div class="rc-empty">Transcript unavailable.</div>';
  }

  function renderAudit(events) {
    byId('rc-audit').innerHTML = (events || []).map(function (event) {
      return '<div class="rc-event"><time>' + esc(event.occurredAt || event.occurred_at || event.at) + '</time><b>' + esc(event.eventType || event.event_type || event.type) + '</b><code>' + esc(JSON.stringify(event.detail || event.data || {})) + '</code></div>';
    }).join('') || '<div class="rc-empty">No audit events returned.</div>';
  }

  function renderApproval(run) {
    var host = byId('rc-approval');
    var request = run.execution_request || run.executionRequest;
    if (run.state !== 'awaiting_human_approval' || !request) {
      host.innerHTML = run.state === 'queued_for_hivebridge' ? '<div class="rc-approval-box"><h3>Approved and queued</h3><p>The typed, read-only task was handed to HiveBridge. The Boardroom itself executed nothing.</p></div>' : '';
      return;
    }
    host.innerHTML = '<div class="rc-approval-box"><h3>Human approval required</h3><p><b>' + esc(title(request.taskType)) + '</b> on <code>' + esc(request.path) + '</code> using registered agent <code>' + esc(request.agentId) + '</code>. No shell command can be supplied.</p>' +
      '<label><input type="checkbox" id="rc-approval-check"> I reviewed the Boardroom record and approve this exact read-only HiveBridge request.</label>' +
      '<div class="rc-approval-actions"><input id="rc-approval-reason" maxlength="500" placeholder="Approval reason (recommended)"><button type="button" class="rc-approve" id="rc-approve">Approve &amp; queue</button></div></div>';
    byId('rc-approve').addEventListener('click', approve);
  }

  function tmNumber(id) {
    var input = byId(id);
    if (!input || input.value === '') return null;
    var value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function tmMoney(value) {
    var absolute = Math.abs(Math.round(Number(value || 0)));
    return (value < 0 ? '-$' : '$') + absolute.toLocaleString();
  }

  function tmProjection(input, config, months) {
    var revenue = input.revenue * config.revenue;
    var cost = input.cost * config.cost;
    var investment = input.investment * config.investment;
    var ramp = input.ramp * config.ramp;
    var accumulatedRevenue = 0;
    for (var month = 1; month <= months; month += 1) {
      accumulatedRevenue += revenue * (ramp <= 0 ? 1 : Math.min(1, month / ramp));
    }
    var net = accumulatedRevenue - (cost * months) - investment;
    var endRunRate = revenue * (ramp <= 0 ? 1 : Math.min(1, months / ramp)) - cost;
    return { net: net, runRate: endRunRate };
  }

  function tmPayback(input, config) {
    var revenue = input.revenue * config.revenue;
    var cost = input.cost * config.cost;
    var investment = input.investment * config.investment;
    if (investment === 0) return revenue - cost >= 0 ? 'Immediate payback' : 'No investment to recover';
    var total = -investment;
    var ramp = input.ramp * config.ramp;
    for (var month = 1; month <= 120; month += 1) {
      total += revenue * (ramp <= 0 ? 1 : Math.min(1, month / ramp)) - cost;
      if (total >= 0) return 'Estimated payback: month ' + month;
    }
    return 'No payback inside 10 years';
  }

  function renderTimeMachine() {
    var input = {
      revenue: tmNumber('rc-tm-revenue'), cost: tmNumber('rc-tm-cost'),
      investment: tmNumber('rc-tm-investment'), ramp: tmNumber('rc-tm-ramp')
    };
    var ready = Object.keys(input).every(function (key) { return input[key] !== null; });
    byId('rc-tm-empty').hidden = ready;
    byId('rc-tm-futures').hidden = !ready;
    byId('rc-tm-plan').disabled = !ready;
    if (!ready) { byId('rc-tm-futures').innerHTML = ''; return; }
    var futures = [
      { id: 'conservative', title: 'Protect the downside', config: { revenue: .65, cost: 1.15, investment: 1.1, ramp: 1.4 } },
      { id: 'recommended', title: 'Best balanced future', config: { revenue: 1, cost: 1, investment: 1, ramp: 1 } },
      { id: 'aggressive', title: 'Push for the upside', config: { revenue: 1.25, cost: 1.3, investment: 1.2, ramp: .85 } }
    ];
    byId('rc-tm-futures').innerHTML = futures.map(function (future) {
      var horizons = [[1, '30 DAYS'], [3, '90 DAYS'], [12, '1 YEAR']].map(function (horizon) {
        var result = tmProjection(input, future.config, horizon[0]);
        return '<div class="rc-tm-horizon"><b>' + horizon[1] + '</b><strong class="' + (result.net >= 0 ? 'rc-tm-positive' : 'rc-tm-negative') + '">' + tmMoney(result.net) + '</strong><span>' + tmMoney(result.runRate) + ' monthly run-rate at that point</span></div>';
      }).join('');
      return '<button type="button" class="rc-tm-future' + (selectedFuture === future.id ? ' is-selected' : '') + '" data-scenario="' + future.id + '"><h3>' + future.title + '</h3>' + horizons + '<div class="rc-tm-payback">' + tmPayback(input, future.config) + '</div></button>';
    }).join('');
  }

  function loadTimeMachine(run) {
    timeMachineRun = run;
    selectedFuture = 'recommended';
    var baseline = (run.report || {}).simulation || {};
    [['rc-tm-revenue', baseline.monthlyRevenueChange], ['rc-tm-cost', baseline.monthlyCostChange], ['rc-tm-investment', baseline.oneTimeInvestment], ['rc-tm-ramp', baseline.rampMonths]].forEach(function (entry) {
      byId(entry[0]).value = Number.isFinite(entry[1]) ? entry[1] : '';
    });
    var confidence = baseline.confidence || 'insufficient_data';
    var label = { company_data: 'GROUNDED IN COMPANY DATA', user_supplied: 'GROUNDED IN YOUR NUMBERS', board_estimate: 'BOARD ESTIMATE - VERIFY', insufficient_data: 'ASSUMPTIONS REQUIRED' }[confidence];
    byId('rc-tm-confidence').dataset.confidence = confidence;
    byId('rc-tm-confidence').textContent = label;
    var assumptions = Array.isArray(baseline.assumptions) ? baseline.assumptions : [];
    byId('rc-tm-assumptions').innerHTML = (assumptions.length ? assumptions : ['Revenue and cost changes must be entered or confirmed by the owner.', 'The projection is directional and does not include taxes, financing, or unknown operational constraints.']).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('');
    byId('rc-tm-panel').hidden = true;
    byId('rc-tm-launch').innerHTML = '<span aria-hidden="true">&#9654;</span> Show Me the Future';
    renderTimeMachine();
  }

  function openTimeMachine() {
    var panel = byId('rc-tm-panel');
    panel.hidden = !panel.hidden;
    byId('rc-tm-launch').innerHTML = panel.hidden ? '<span aria-hidden="true">&#9654;</span> Show Me the Future' : 'Hide futures';
    if (!panel.hidden) {
      renderTimeMachine();
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function buildTimeMachinePlan() {
    var input = { revenue: tmNumber('rc-tm-revenue'), cost: tmNumber('rc-tm-cost'), investment: tmNumber('rc-tm-investment'), ramp: tmNumber('rc-tm-ramp') };
    if (Object.keys(input).some(function (key) { return input[key] === null; })) return;
    var config = {
      conservative: { revenue: .65, cost: 1.15, investment: 1.1, ramp: 1.4 },
      recommended: { revenue: 1, cost: 1, investment: 1, ramp: 1 },
      aggressive: { revenue: 1.25, cost: 1.3, investment: 1.2, ramp: .85 }
    }[selectedFuture];
    var outcome = { day30: tmProjection(input, config, 1), day90: tmProjection(input, config, 3), year1: tmProjection(input, config, 12), payback: tmPayback(input, config) };
    var context = { sourceRunId: timeMachineRun && timeMachineRun.id, selectedFuture: selectedFuture, ownerInputs: input, forecast: outcome, notice: 'Directional forecast only; not a verified outcome and nothing has been executed.' };
    applyBoardroomDraft({
      brief: 'Build a practical, owner-ready 90-day action plan for the ' + selectedFuture + ' future from the Business Time Machine. Validate the assumptions before recommending action. Include owners, milestones, weekly scorecard metrics, stop-loss triggers, cash safeguards, and the exact decisions that still require my approval.',
      label: title(selectedFuture) + ' Business Time Machine future attached',
      evidence: [{ sourceId: 'time-machine-' + String(activeRunId || 'draft').slice(0, 80), label: 'Business Time Machine - directional owner scenario', content: JSON.stringify(context) }]
    });
    byId('rc-brief').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderRun(run) {
    activeRunId = run.id || activeRunId;
    var usage = run.usage || {};
    if (run.brief) byId('rc-user-message').textContent = run.brief;
    byId('rc-results').hidden = false;
    byId('rc-thinking').hidden = true;
    byId('rc-board-response').hidden = false;
    var gate = (run.report || {}).completionGate || { authoritativeLabel: 'NOT DONE' };
    byId('rc-run-meta').innerHTML = '<div class="rc-run-id">Boardroom discussion finished &middot; Work ' + esc(gate.authoritativeLabel || 'NOT DONE') + '<br>' + esc(activeRunId) + '</div>';
    byId('rc-usage').innerHTML = '<span class="rc-chip">' + number(usage.inputTokens) + ' input tokens</span><span class="rc-chip">' + number(usage.outputTokens) + ' output tokens</span><span class="rc-chip">' + money(usage.totalCostCents) + ' provider cost</span><span class="rc-chip">' + number((run.budget || {}).maxRounds) + ' rounds</span>';
    renderReport(run.report);
    renderMessages(run.messages);
    renderAnswer(run.report, run.messages);
    loadTimeMachine(run);
    renderApproval(run);
    renderAudit(run.audit || run.audit_events);
    byId('rc-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showPending(brief) {
    byId('rc-user-message').textContent = brief;
    byId('rc-results').hidden = false;
    byId('rc-board-response').hidden = true;
    var thinking = byId('rc-thinking');
    thinking.classList.remove('is-error');
    thinking.querySelector('p').textContent = 'Reina is meeting with the directors…';
    thinking.querySelector('small').textContent = 'Reviewing company intelligence, risks, and opportunities';
    thinking.hidden = false;
    byId('rc-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showResponseError(message) {
    var thinking = byId('rc-thinking');
    thinking.classList.add('is-error');
    thinking.querySelector('p').textContent = 'The Boardroom could not finish this response.';
    thinking.querySelector('small').textContent = message;
    thinking.hidden = false;
  }

  async function loadRun(runId) {
    var result = await api('/api/reina-council?runId=' + encodeURIComponent(runId));
    renderRun(result.run);
  }

  function historyPreview(run) {
    var report = run.report || {};
    var groups = [].concat(report.consensus || [], report.conflicts || [], report.unresolved || []);
    var first = groups[0] || {};
    var claims = first.claims || [];
    if (!claims.length && first.positions) claims = first.positions.reduce(function (all, position) { return all.concat(position.claims || []); }, []);
    return claims[0] && claims[0].statement ? claims[0].statement : 'Open the complete Boardroom recommendation.';
  }

  function renderHistory(rows) {
    var host = byId('rc-history');
    if (!host) return;
    var filtered = (rows || []).filter(function (run) {
      if (historyMode === 'pinned' && !run.pinned) return false;
      if (selectedProjectId && run.project_id !== selectedProjectId) return false;
      return true;
    });
    host.innerHTML = filtered.map(function (run) {
      var project = workspaceProjects.find(function (item) { return item.id === run.project_id; });
      return '<article class="rc-history-item"><button type="button" class="rc-history-open" data-run-id="' + esc(run.id) + '">' +
        '<span><b>' + esc(run.brief) + '</b><small>' + esc(dateLabel(run.created_at)) + ' &middot; ' + esc(title(run.state)) + '</small></span>' +
        (project ? '<em class="rc-project-badge">' + esc(project.name) + '</em>' : '') +
        '<p>' + esc(historyPreview(run)) + '</p><i aria-hidden="true">&#8594;</i></button>' +
        '<button type="button" class="rc-history-pin" data-pin-run="' + esc(run.id) + '" aria-label="' + (run.pinned ? 'Unpin' : 'Pin') + ' this conversation">' + (run.pinned ? '&#9733;' : '&#9734;') + '</button></article>';
    }).join('') || '<div class="rc-empty">Your completed Boardroom decisions will appear here.</div>';
    byId('rc-history-count').textContent = filtered.length + (filtered.length === 1 ? ' conversation' : ' conversations') + (historyDone ? '' : ' loaded');
    updateHistoryControls();
  }

  function renderProjects() {
    var select = byId('rc-project-filter');
    if (!select) return;
    select.innerHTML = '<option value="">All projects</option>' + workspaceProjects.map(function (project) {
      return '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>';
    }).join('');
    select.value = selectedProjectId;
  }

  async function loadWorkspace() {
    try {
      var result = await api('/api/reina-council?workspace=1');
      workspaceProjects = Array.isArray(result.projects) ? result.projects : [];
      renderProjects();
    } catch (error) {
      showError('Boardroom projects are temporarily unavailable. ' + error.message);
    }
  }

  async function createProject() {
    var name = window.prompt('Name this Boardroom project:');
    if (!name || !name.trim()) return;
    showError('');
    try {
      var result = await api('/api/reina-council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create_project', name: name.trim() }) });
      // The server now fails loudly if it has no project row to return, but
      // guard here too rather than trust that forever -- an unguarded unshift
      // of `undefined` here is exactly what corrupted workspaceProjects and
      // crashed the next history render at a completely different line.
      if (!result.project) { showError('Boardroom project could not be created.'); return; }
      workspaceProjects.unshift(result.project);
      selectedProjectId = result.project.id;
      renderProjects();
      renderHistory(historyRows);
    } catch (error) { showError(error.message); }
  }

  async function togglePin(runId) {
    var row = historyRows.find(function (item) { return item.id === runId; });
    if (!row) return;
    try {
      var result = await api('/api/reina-council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update_run_metadata', runId: runId, pinned: !row.pinned }) });
      row.pinned = Boolean(result.run && result.run.pinned);
      renderHistory(historyRows);
    } catch (error) { showError(error.message); }
  }

  function newConversation() {
    activeRunId = '';
    pendingKey = '';
    pendingFingerprint = '';
    attachments = [];
    renderAttachments();
    clearDraftContext();
    byId('rc-brief').value = '';
    byId('rc-results').hidden = true;
    showError('');
    byId('rc-brief').focus();
  }

  function setHistoryMode(mode) {
    historyMode = mode;
    byId('rc-show-recent').classList.toggle('is-active', mode === 'recent');
    byId('rc-show-pinned').classList.toggle('is-active', mode === 'pinned');
    renderHistory(historyRows);
  }

  function updateHistoryControls() {
    var host = byId('rc-history');
    if (!host) return;
    byId('rc-history-prev').disabled = host.scrollLeft <= 4;
    byId('rc-history-next').disabled = historyDone && host.scrollLeft + host.clientWidth >= host.scrollWidth - 4;
  }

  function slideHistory(direction) {
    var host = byId('rc-history');
    if (!host) return;
    host.scrollBy({ left: direction * Math.max(300, host.clientWidth * .82), behavior: 'smooth' });
    if (direction > 0 && !historyDone && host.scrollLeft + host.clientWidth >= host.scrollWidth - 500) loadHistory(false);
    window.setTimeout(updateHistoryControls, 350);
  }

  async function loadHistory(reset) {
    var host = byId('rc-history');
    if (!host || historyLoading) return;
    var replace = reset !== false;
    var visibleRows = historyRows.slice();
    if (replace) {
      historyOffset = 0;
      historyDone = false;
      // Keep the existing conversation cards visible while the newest page is
      // fetched. A refresh must never make durable history appear to vanish.
      if (!visibleRows.length) host.innerHTML = '<div class="rc-empty">Loading past decisions&hellip;</div>';
    } else if (historyDone) return;
    historyLoading = true;
    try {
      var result = await api('/api/reina-council?history=1&limit=' + HISTORY_PAGE_SIZE + '&offset=' + historyOffset);
      var incoming = Array.isArray(result.history) ? result.history : [];
      if (replace) historyRows = [];
      var known = {};
      historyRows.forEach(function (run) { known[run.id] = true; });
      incoming.forEach(function (run) { if (!known[run.id]) { known[run.id] = true; historyRows.push(run); } });
      historyOffset = Number.isInteger(result.nextOffset) ? result.nextOffset : historyOffset + incoming.length;
      historyDone = result.hasMore === false || incoming.length < HISTORY_PAGE_SIZE;
      renderHistory(historyRows);
    } catch (error) {
      if (visibleRows.length) {
        historyRows = visibleRows;
        renderHistory(historyRows);
      } else if (!historyRows.length) {
        host.innerHTML = '<div class="rc-empty">Past decisions are temporarily unavailable.</div>';
      }
    } finally {
      historyLoading = false;
    }
  }

  async function approve() {
    if (!byId('rc-approval-check').checked) return showError('Confirm that you reviewed and approve the exact HiveBridge request.');
    if (!window.confirm('Queue this exact read-only task for HiveBridge? This is the human approval boundary.')) return;
    var button = byId('rc-approve');
    button.disabled = true;
    showError('');
    try {
      await api('/api/reina-council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve_execution', runId: activeRunId, reason: byId('rc-approval-reason').value.trim() }) });
      await loadRun(activeRunId);
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  }

  async function start(event) {
    event.preventDefault();
    var button = byId('rc-start');
    showError('');
    var sentBrief = '';
    try {
      var request = collect();
      sentBrief = request.brief;
      var fingerprint = JSON.stringify(request);
      if (!pendingKey || pendingFingerprint !== fingerprint) {
        pendingKey = uuid();
        pendingFingerprint = fingerprint;
      }
      request.idempotencyKey = pendingKey;
      button.disabled = true;
      button.querySelector('span').textContent = 'Sending…';
      byId('rc-brief').value = '';
      showPending(sentBrief);
      var result = await api('/api/reina-council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      if (result.project) {
        if (!workspaceProjects.some(function (project) { return project.id === result.project.id; })) workspaceProjects.unshift(result.project);
        selectedProjectId = result.project.id;
        renderProjects();
      }
      activeRunId = result.runId;
      await loadRun(result.runId);
      // loadRun() -> renderRun() overwrites rc-run-meta's innerHTML, so this
      // notice has to be appended AFTER it, not before -- otherwise it would
      // be wiped the instant the run finished loading. Surfaces an
      // unrecognized "did you want a project?" phrasing instead of silently
      // doing nothing, which is the same failure PR #339 tried to fix, just
      // for the phrasings requestedProjectFromBrief still cannot recognize.
      if (result.projectRequestAmbiguous) {
        var meta = byId('rc-run-meta');
        if (meta) meta.insertAdjacentHTML('beforeend', '<div class="rc-project-hint">Didn’t create a project for this — try phrasing like &ldquo;create a master project for this&rdquo; if you want one saved.</div>');
      }
      // The independent round always gets all 3 fresh (retried once if
      // needed), but a later debate round can silently carry forward a
      // provider's last position when that provider is unavailable mid-debate
      // instead of failing. Surfaced so "review each other" is verifiable per
      // round, not just assumed from a completed-looking report.
      if (Array.isArray(result.staleDebatePositions) && result.staleDebatePositions.length) {
        var staleMeta = byId('rc-run-meta');
        if (staleMeta) {
          var names = { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };
          var lines = result.staleDebatePositions.map(function (entry) {
            var who = entry.participants.map(function (name) { return names[name] || name; }).join(' and ');
            return who + ' carried forward a prior position in round ' + (entry.round + 1) + ' (no fresh response).';
          });
          staleMeta.insertAdjacentHTML('beforeend', '<div class="rc-stale-hint">' + esc(lines.join(' ')) + '</div>');
        }
      }
      // Wait for a full newest-first refresh so the new request and every
      // previous conversation remain visible before the send flow completes.
      await loadHistory(true);
      clearDraftContext();
      pendingKey = '';
      pendingFingerprint = '';
    } catch (error) {
      if (sentBrief) {
        showResponseError(error.message);
        if (!byId('rc-brief').value) byId('rc-brief').value = sentBrief;
      } else {
        showError(error.message);
      }
    } finally {
      button.disabled = false;
      button.querySelector('span').textContent = 'Send';
    }
  }

  async function readiness() {
    try {
      var result = await api('/api/reina-council?status=1');
      var limits = result.limits || {};
      [
        ['rc-rounds', limits.maxRounds],
        ['rc-tokens', limits.maxTokensPerResponse],
        ['rc-cost', limits.maxCostCents]
      ].forEach(function (entry) {
        var input = byId(entry[0]);
        var ceiling = Number(entry[1]);
        if (!input || !Number.isInteger(ceiling) || ceiling < Number(input.min || 0)) return;
        input.max = String(ceiling);
        if (Number(input.value) > ceiling) input.value = String(ceiling);
      });
      setStatus(result.ready ? 'ready' : 'error', result.ready ? 'PROTECTED PREVIEW READY' : 'CONFIGURATION INCOMPLETE');
    } catch (error) {
      setStatus(error.status === 404 ? 'disabled' : 'error', error.status === 404 ? 'FEATURE DISABLED' : 'UNAVAILABLE');
    }
  }

  function bind() {
    byId('rc-drop').addEventListener('click', function () { byId('rc-files').click(); });
    byId('rc-files').addEventListener('change', function (event) { addFiles(event.target.files); });
    byId('rc-drop').addEventListener('dragover', function (event) { event.preventDefault(); byId('rc-drop').classList.add('dragging'); });
    byId('rc-drop').addEventListener('dragleave', function () { byId('rc-drop').classList.remove('dragging'); });
    byId('rc-drop').addEventListener('drop', function (event) { event.preventDefault(); byId('rc-drop').classList.remove('dragging'); addFiles(event.dataTransfer.files); });
    byId('rc-attachments').addEventListener('click', function (event) {
      var button = event.target.closest('[data-attachment-id]');
      if (!button) return;
      attachments = attachments.filter(function (item) { return item.id !== button.getAttribute('data-attachment-id'); });
      renderAttachments();
    });
    byId('rc-form').addEventListener('submit', start);
    byId('rc-handoff-clear').addEventListener('click', clearDraftContext);
    byId('rc-history').addEventListener('click', function (event) {
      var pin = event.target.closest('[data-pin-run]');
      if (pin) { event.preventDefault(); event.stopPropagation(); togglePin(pin.getAttribute('data-pin-run')); return; }
      var button = event.target.closest('[data-run-id]');
      if (!button) return;
      loadRun(button.getAttribute('data-run-id')).catch(function (error) { showError(error.message); });
    });
    byId('rc-history-refresh').addEventListener('click', function () { loadHistory(true); });
    byId('rc-history-prev').addEventListener('click', function () { slideHistory(-1); });
    byId('rc-history-next').addEventListener('click', function () { slideHistory(1); });
    byId('rc-history').addEventListener('scroll', function () {
      updateHistoryControls();
      var host = byId('rc-history');
      if (!historyDone && host.scrollLeft + host.clientWidth >= host.scrollWidth - 400) loadHistory(false);
    });
    byId('rc-new-conversation').addEventListener('click', newConversation);
    byId('rc-show-recent').addEventListener('click', function () { setHistoryMode('recent'); });
    byId('rc-show-pinned').addEventListener('click', function () { setHistoryMode('pinned'); });
    byId('rc-project-filter').addEventListener('change', function (event) { selectedProjectId = event.target.value; renderHistory(historyRows); });
    byId('rc-add-project').addEventListener('click', createProject);
    byId('rc-open-settings').addEventListener('click', function () { var details = document.querySelector('#view-council .rc-advanced'); details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    byId('rc-tm-launch').addEventListener('click', openTimeMachine);
    ['rc-tm-revenue', 'rc-tm-cost', 'rc-tm-investment', 'rc-tm-ramp'].forEach(function (id) { byId(id).addEventListener('input', renderTimeMachine); });
    byId('rc-tm-futures').addEventListener('click', function (event) {
      var future = event.target.closest('[data-scenario]');
      if (!future) return;
      selectedFuture = future.getAttribute('data-scenario');
      renderTimeMachine();
    });
    byId('rc-tm-plan').addEventListener('click', buildTimeMachinePlan);
    readiness();
    loadWorkspace();
    loadHistory(true);
    if (pendingBoardroomDraft || window.__hlPendingBoardroomDraft) {
      applyBoardroomDraft(pendingBoardroomDraft || window.__hlPendingBoardroomDraft);
      pendingBoardroomDraft = null;
      window.__hlPendingBoardroomDraft = null;
    }
  }

  window.hlOpenBoardroomDraft = function (payload) {
    pendingBoardroomDraft = payload;
    window.__hlPendingBoardroomDraft = payload;
    if (loaded && byId('rc-brief')) {
      applyBoardroomDraft(payload);
      pendingBoardroomDraft = null;
      window.__hlPendingBoardroomDraft = null;
    }
  };

  window.hlInitReinaCouncil = async function () {
    if (loaded) return;
    loaded = true;
    var host = byId('view-council');
    try {
      var response = await fetch('/views/reina-council.html');
      if (!response.ok) throw new Error('Boardroom view could not be loaded.');
      host.innerHTML = await response.text();
      bind();
    } catch (error) {
      host.innerHTML = '<div class="rc-error">' + esc(error.message) + '</div>';
    }
  };
})();
