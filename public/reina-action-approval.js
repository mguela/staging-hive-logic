/* public/reina-action-approval.js
 *
 * The approval popup: the only way a person can turn one of Reina's proposals
 * into something that actually happens.
 *
 * This file is NOT the safety mechanism, and it is important to be clear about
 * that. The server will not send anything without spending a one-time approval
 * from the database. If this popup were bypassed entirely, nothing would send.
 * What this popup owns is the other half: making sure that when a person says
 * yes, they said yes to the thing they actually read.
 *
 * Which is why the draft is editable. A preview you cannot change is a preview
 * you stop reading by the third time you see one.
 *
 * Classic UMD: window.ReinaActionApproval in a browser, module.exports in Node.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaActionApproval = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var ENDPOINT = '/api/reina-action';

  // Which typed or spoken requests are asking Reina to DO something, rather
  // than to explain something. Deliberately narrow: a false positive opens a
  // popup the person did not ask for, which teaches them to click through
  // popups, which is the one habit this whole design cannot survive.
  var SEND_EMAIL_RE = /\b(?:send|email|e-mail|write|draft|shoot|fire off)\b[^.?!]*\b(?:e-?mail|message|note)\b|\bemail\s+(?:this|that|it|them|him|her|the\s+\w+)\b/iu;
  var ADDRESS_HINT_RE = /@|\bto\s+[A-Z][a-z]+/u;

  function looksLikeEmailRequest(text) {
    if (typeof text !== 'string') return false;
    var value = text.trim();
    if (!value || value.length > 4000) return false;
    return SEND_EMAIL_RE.test(value) && ADDRESS_HINT_RE.test(value);
  }

  var FRIENDLY = {
    actions_disabled: 'Reina cannot take actions yet. Turn on actions to let her.',
    auth_expired: 'Your session expired. Sign in again, then ask once more.',
    no_mailbox_connected: 'No mailbox is connected, so there is nothing to send from. Add one in Settings.',
    draft_failed: 'Reina could not write that draft. Try asking again.',
    draft_invalid: 'That draft is not something that can be sent. Try wording the request differently.',
    approval_duplicate: 'That was already sent once. Ask again if you want another.',
    approval_expired: 'That approval expired. Ask again and approve within five minutes.',
    approval_rejected: 'That draft was cancelled.',
    approval_not_found: 'That approval no longer exists. Ask again.',
    send_failed: 'The mail server refused it.',
  };

  function friendly(code, detail) {
    var base = Object.prototype.hasOwnProperty.call(FRIENDLY, code) ? FRIENDLY[code] : 'That did not go through.';
    return detail ? base + ' (' + String(detail).slice(0, 160) + ')' : base;
  }

  function splitAddresses(value) {
    return String(value || '')
      .split(/[,;\s]+/u)
      .map(function (part) { return part.trim(); })
      .filter(Boolean);
  }

  function createApprovalUi(options) {
    options = options || {};
    var documentRef = options.documentRef || (root && root.document);
    if (!documentRef || typeof documentRef.createElement !== 'function') return null;
    var fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : (root && root.fetch ? root.fetch.bind(root) : null);
    if (!fetchFn) return null;
    var onResolved = typeof options.onResolved === 'function' ? options.onResolved : function () {};

    var open = null;

    function close() {
      if (!open) return;
      try { if (open.node && open.node.parentNode) open.node.parentNode.removeChild(open.node); } catch (_) {}
      open = null;
    }

    function el(tag, className, text) {
      var node = documentRef.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function field(labelText, value, multiline) {
      var wrap = el('label', 'rna-approve-field');
      wrap.appendChild(el('span', 'rna-approve-label', labelText));
      var input = documentRef.createElement(multiline ? 'textarea' : 'input');
      input.className = 'rna-approve-input';
      if (!multiline) input.type = 'text';
      input.value = value == null ? '' : String(value);
      if (multiline) input.rows = 12;
      wrap.appendChild(input);
      return { wrap: wrap, input: input };
    }

    async function post(body) {
      var response;
      try {
        response = await fetchFn(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(body),
        });
      } catch (_) {
        return { ok: false, code: 'network' };
      }
      var payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!payload || typeof payload !== 'object') return { ok: false, code: 'network' };
      return payload;
    }

    // Ask the server for a draft. Nothing is sent by this; the whole point is
    // that a proposal and a send are two different events with a person in
    // between.
    async function propose(utterance, conversationId, turnId) {
      var proposed = await post({
        op: 'propose',
        utterance: utterance,
        conversationId: conversationId,
        turnId: turnId,
      });
      if (!proposed.ok) return { ok: false, message: friendly(proposed.code, proposed.detail) };
      show(proposed);
      return { ok: true, approvalId: proposed.approvalId };
    }

    function show(proposed) {
      close();

      var node = el('div', 'rna-approve-backdrop');
      var card = el('div', 'rna-approve-card');
      node.appendChild(card);

      card.appendChild(el('div', 'rna-approve-kicker', 'REINA WANTS TO SEND THIS'));
      card.appendChild(el('h3', 'rna-approve-title', 'Read it before it goes'));
      card.appendChild(el('p', 'rna-approve-note',
        'Nothing has been sent. Edit anything you like — what you see here is exactly what will go out.'));

      var from = el('div', 'rna-approve-from', 'From ' + (proposed.proposal.from || ''));
      card.appendChild(from);

      var to = field('To', (proposed.proposal.to || []).join(', '), false);
      var cc = field('Cc', (proposed.proposal.cc || []).join(', '), false);
      var subject = field('Subject', proposed.proposal.subject, false);
      var body = field('Message', proposed.proposal.body, true);
      card.appendChild(to.wrap);
      card.appendChild(cc.wrap);
      card.appendChild(subject.wrap);
      card.appendChild(body.wrap);

      var error = el('div', 'rna-approve-error', '');
      card.appendChild(error);

      var actions = el('div', 'rna-approve-actions');
      var cancel = el('button', 'rna-approve-cancel', 'Cancel');
      cancel.type = 'button';
      var send = el('button', 'rna-approve-send', 'Send it');
      send.type = 'button';
      actions.appendChild(cancel);
      actions.appendChild(send);
      card.appendChild(actions);

      open = { node: node, approvalId: proposed.approvalId, busy: false };

      cancel.addEventListener('click', async function () {
        if (!open || open.busy) return;
        open.busy = true;
        var approvalId = open.approvalId;
        close();
        await post({ op: 'reject', approvalId: approvalId });
        onResolved({ status: 'cancelled', message: 'Cancelled. Nothing was sent.' });
      });

      send.addEventListener('click', async function () {
        if (!open || open.busy) return;
        open.busy = true;
        send.disabled = true;
        // The label has to stop saying "Send it" the moment it has been
        // pressed, or a slow mail server reads as a button that did nothing.
        send.textContent = 'Sending…';
        error.textContent = '';

        var payload = {
          to: splitAddresses(to.input.value),
          cc: splitAddresses(cc.input.value),
          bcc: [],
          subject: String(subject.input.value || '').trim(),
          body: String(body.input.value || ''),
          from: proposed.proposal.from,
        };

        var result = await post({ op: 'execute', approvalId: open.approvalId, payload: payload });
        if (!result.ok) {
          // A refusal that leaves the approval unspent is worth staying open
          // for -- the person can fix the address and press send again.
          var recoverable = result.code === 'draft_invalid' || result.code === 'network';
          if (recoverable && open) {
            open.busy = false;
            send.disabled = false;
            send.textContent = 'Send it';
            error.textContent = friendly(result.code, result.detail);
            return;
          }
          close();
          onResolved({ status: 'failed', message: friendly(result.code, result.detail) });
          return;
        }

        close();
        onResolved({
          status: 'sent',
          message: 'Sent to ' + (result.to || []).join(', ') + '.',
        });
      });

      try { documentRef.body.appendChild(node); } catch (_) {}
      try { to.input.focus(); } catch (_) {}
    }

    return Object.freeze({
      looksLikeEmailRequest: looksLikeEmailRequest,
      propose: propose,
      close: close,
      isOpen: function () { return open !== null; },
    });
  }

  return Object.freeze({
    createApprovalUi: createApprovalUi,
    looksLikeEmailRequest: looksLikeEmailRequest,
    splitAddresses: splitAddresses,
    friendly: friendly,
    ENDPOINT: ENDPOINT,
  });
});
