// Test-only proof of the injected atomic store seam. This is intentionally not
// a production adapter and is never imported by application code.

export const PASS = Symbol('use-default-store-behavior');

export class AtomicMemoryStore {
  constructor({ events = [], overrides = {}, now = () => new Date().toISOString() } = {}) {
    this.events = events;
    this.overrides = overrides;
    this.now = now;
    this.calls = [];
    this.conversations = new Map();
    this.claims = new Map();
    this.reviewIntents = new Map();
    this.claimCounter = 0;
    this.resultCounter = 0;
  }

  scopeKey(ownerPrincipalId, conversationId) {
    return `${ownerPrincipalId}\u0000${conversationId}`;
  }

  claimKey(ownerPrincipalId, conversationId, idempotencyKey) {
    return `${this.scopeKey(ownerPrincipalId, conversationId)}\u0000${idempotencyKey}`;
  }

  record(method, input) {
    this.events.push(method);
    this.calls.push(Object.freeze({ method, input }));
  }

  async override(method, input) {
    if (!Object.hasOwn(this.overrides, method)) return Object.freeze({ used: false });
    const value = await this.overrides[method](input, this);
    return value === PASS
      ? Object.freeze({ used: false })
      : Object.freeze({ used: true, value });
  }

  findClaim(input) {
    const key = this.claimKey(input.ownerPrincipalId, input.conversationId, input.idempotencyKey);
    const claim = this.claims.get(key);
    return claim?.claimId === input.claimId && claim.inputDigest === input.inputDigest ? claim : null;
  }

  async loadConversation(input) {
    this.record('loadConversation', input);
    const overridden = await this.override('loadConversation', input);
    if (overridden.used) return overridden.value;
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    return conversation
      ? { status: 'found', conversation: { ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId } }
      : { status: 'not_found' };
  }

  async createConversation(input) {
    this.record('createConversation', input);
    const overridden = await this.override('createConversation', input);
    if (overridden.used) return overridden.value;
    const key = this.scopeKey(input.ownerPrincipalId, input.conversationId);
    if (this.conversations.has(key)) return { status: 'exists' };
    this.conversations.set(key, { messages: [] });
    return { status: 'created', conversation: { ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId } };
  }

  async claimTurn(input) {
    this.record('claimTurn', input);
    const overridden = await this.override('claimTurn', input);
    if (overridden.used) return overridden.value;
    const scope = this.scopeKey(input.ownerPrincipalId, input.conversationId);
    const key = this.claimKey(input.ownerPrincipalId, input.conversationId, input.idempotencyKey);
    let claim = this.claims.get(key);
    if (!claim) {
      const unresolved = [...this.claims.entries()].find(([otherKey, otherClaim]) => (
        otherKey.startsWith(`${scope}\u0000`) && otherClaim.state !== 'completed'
      ));
      if (unresolved) {
        if (unresolved[1].state === 'in_flight') return { status: 'in_flight' };
        if (unresolved[1].state === 'failed_terminal') return { status: 'failed' };
        return { status: 'incomplete' };
      }
      claim = {
        claimId: `claim-${++this.claimCounter}`,
        inputDigest: input.inputDigest,
        state: 'in_flight',
        userMessage: null,
        result: null,
      };
      this.claims.set(key, claim);
      return { status: 'claimed', claimId: claim.claimId, progress: 'claimed' };
    }
    if (claim.inputDigest !== input.inputDigest) return { status: 'conflict' };
    if (claim.state === 'completed') return { status: 'replay', result: claim.result };
    if (claim.state === 'in_flight') return { status: 'in_flight' };
    if (claim.state === 'incomplete') return { status: 'incomplete' };
    if (claim.state === 'failed_terminal') return { status: 'failed' };
    if (claim.state === 'failed_retryable') {
      const unresolved = [...this.claims.entries()].some(([otherKey, otherClaim]) => (
        otherKey !== key && otherKey.startsWith(`${scope}\u0000`) && otherClaim.state !== 'completed'
      ));
      if (unresolved) return { status: 'incomplete' };
      claim.state = 'in_flight';
      claim.claimId = `claim-${++this.claimCounter}`;
      return { status: 'resumed', claimId: claim.claimId, progress: claim.userMessage ? 'user_persisted' : 'claimed' };
    }
    return { status: 'failed' };
  }

  async appendUserMessageOnce(input) {
    this.record('appendUserMessageOnce', input);
    const overridden = await this.override('appendUserMessageOnce', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim || claim.state !== 'in_flight') throw new Error('unknown claim');
    if (claim.userMessage) {
      return {
        status: 'existing',
        ownerPrincipalId: input.ownerPrincipalId,
        conversationId: input.conversationId,
        message: claim.userMessage,
      };
    }
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const message = Object.freeze({
      messageId: `user-${claim.claimId}`,
      sequence: conversation.messages.length + 1,
      role: 'user',
      content: input.content,
      contentDigest: input.contentDigest,
    });
    conversation.messages.push(message);
    claim.userMessage = message;
    return {
      status: 'appended',
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      message,
    };
  }

  async loadHistory(input) {
    this.record('loadHistory', input);
    const overridden = await this.override('loadHistory', input);
    if (overridden.used) return overridden.value;
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const throughIndex = conversation?.messages.findIndex(message => message.messageId === input.throughMessageId) ?? -1;
    if (throughIndex < 0) throw new Error('missing through message');
    return {
      status: 'loaded',
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      messages: conversation.messages.slice(0, throughIndex + 1),
    };
  }

  async appendAssistantAndCompleteTurn(input) {
    this.record('appendAssistantAndCompleteTurn', input);
    const overridden = await this.override('appendAssistantAndCompleteTurn', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim || !claim.userMessage || claim.userMessage.messageId !== input.userMessageId || claim.state !== 'in_flight') {
      throw new Error('invalid completion claim');
    }
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const assistantMessage = Object.freeze({
      messageId: `assistant-${claim.claimId}`,
      sequence: conversation.messages.length + 1,
      role: 'assistant',
      content: input.content,
      contentDigest: input.contentDigest,
    });
    conversation.messages.push(assistantMessage);
    claim.result = Object.freeze({
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      inputDigest: input.inputDigest,
      userMessageId: claim.userMessage.messageId,
      userMessageSequence: claim.userMessage.sequence,
      assistantMessage,
      resultReference: `result-${++this.resultCounter}`,
      policyReference: input.policyReference,
    });
    claim.state = 'completed';
    return { status: 'completed', result: claim.result };
  }

  async markTurnFailed(input) {
    this.record('markTurnFailed', input);
    const overridden = await this.override('markTurnFailed', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim || claim.state !== 'in_flight') return { status: 'incomplete' };
    claim.state = 'failed_retryable';
    claim.failure = Object.freeze({ stage: input.stage, reasonCode: input.reasonCode });
    return { status: 'recorded', state: 'failed_retryable' };
  }

  async issueReviewIntent(input) {
    this.record('issueReviewIntent', input);
    const overridden = await this.override('issueReviewIntent', input);
    if (overridden.used) return overridden.value;
    if (this.reviewIntents.has(input.intentId)) return { status: 'invalid' };
    this.reviewIntents.set(input.intentId, Object.freeze({
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      intentId: input.intentId,
      expiresAt: input.expiresAt,
      policyReference: input.policyReference,
      consumed: false,
    }));
    return { status: 'issued', intentId: input.intentId, expiresAt: input.expiresAt };
  }

  async consumeReviewIntent(input) {
    this.record('consumeReviewIntent', input);
    const overridden = await this.override('consumeReviewIntent', input);
    if (overridden.used) return overridden.value;
    const issued = this.reviewIntents.get(input.intentId);
    if (!issued) return { status: 'not_found' };
    if (issued.ownerPrincipalId !== input.ownerPrincipalId
      || issued.conversationId !== input.conversationId) return { status: 'owner_mismatch' };
    if (JSON.stringify(issued.policyReference) !== JSON.stringify(input.policyReference)) {
      return { status: 'policy_mismatch' };
    }
    const now = Date.parse(this.now());
    if (!Number.isFinite(now) || Date.parse(issued.expiresAt) <= now) return { status: 'expired' };
    if (issued.consumed) return { status: 'duplicate' };
    this.reviewIntents.set(input.intentId, Object.freeze({ ...issued, consumed: true }));
    return { status: 'consumed', intentId: input.intentId };
  }

}
