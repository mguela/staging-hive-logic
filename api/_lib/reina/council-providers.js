// Provider adapters for the AI Council. Attachments are read-only context.
// No adapter grants shell, browser, function calling, or code execution.

import { Buffer } from 'node:buffer';

const PROVIDER_CONFIG = Object.freeze({
  chatgpt: { key: 'OPENAI_API_KEY', model: 'REINA_COUNCIL_OPENAI_MODEL', prefix: 'OPENAI', url: 'https://api.openai.com/v1/responses' },
  claude: { key: 'ANTHROPIC_API_KEY', model: 'REINA_COUNCIL_ANTHROPIC_MODEL', prefix: 'ANTHROPIC', url: 'https://api.anthropic.com/v1/messages' },
  grok: { key: 'XAI_API_KEY', model: 'REINA_COUNCIL_XAI_MODEL', gatewayModel: 'REINA_COUNCIL_XAI_GATEWAY_MODEL', prefix: 'XAI', url: 'https://api.x.ai/v1/responses', chatUrl: 'https://api.x.ai/v1/chat/completions' },
});

const COUNCIL_MESSAGE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    claims: {
      // Keep provider schemas to the cross-provider JSON Schema subset. The
      // Council parser below the adapters still enforces all array limits.
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          stance: { type: 'string', enum: ['support', 'oppose', 'conditional', 'unknown'] },
          statement: { type: 'string' },
          citations: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { sourceId: { type: 'string' }, locator: { type: 'string' }, excerpt: { type: 'string' } },
              required: ['sourceId', 'locator', 'excerpt'],
            },
          },
        },
        required: ['topic', 'stance', 'statement', 'citations'],
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'claims', 'risks', 'questions'],
});

function positiveNumber(value) {
  if ((typeof value === 'string' && value.trim().length === 0) || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pricing(env, prefix) {
  const inputCentsPerMillion = positiveNumber(env[`REINA_COUNCIL_${prefix}_INPUT_CENTS_PER_MILLION`]);
  const outputCentsPerMillion = positiveNumber(env[`REINA_COUNCIL_${prefix}_OUTPUT_CENTS_PER_MILLION`]);
  if (inputCentsPerMillion === null || outputCentsPerMillion === null) return null;
  return Object.freeze({ inputCentsPerMillion, outputCentsPerMillion });
}

function cost(usage, price) {
  return ((usage.inputTokens * price.inputCentsPerMillion) + (usage.outputTokens * price.outputCentsPerMillion)) / 1_000_000;
}

function attachmentTokenReserve(attachments) {
  return (attachments || []).reduce((total, item) => {
    if (item?.kind === 'image') return total + 10_000;
    if (item?.kind === 'pdf') return total + 50_000;
    return total;
  }, 0);
}

function maxCost(prompt, attachments, maxTokens, price, extraCents = 0) {
  if (typeof prompt !== 'string' || !Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error('Council provider cost estimate input was invalid.');
  }
  // Provider tokenizers use byte fallback; UTF-8 bytes are a conservative
  // upper bound for input tokens without making a provider request.
  const maxInputTokens = new TextEncoder().encode(prompt).length + attachmentTokenReserve(attachments);
  return cost({ inputTokens: maxInputTokens, outputTokens: maxTokens }, price) + extraCents;
}

function adapter(price, generate, extraEstimate = () => 0) {
  return Object.freeze({
    estimateMaxCostCents: ({ prompt, attachments, maxTokens }) => maxCost(prompt, attachments, maxTokens, price, extraEstimate(attachments)),
    generate,
  });
}

async function json(response) {
  if (!response?.ok || typeof response.json !== 'function') {
    const error = new Error('Council provider request failed.');
    let providerCode = '';
    if (typeof response?.json === 'function') {
      try {
        const body = await response.json();
        const rawCode = body?.error?.code || body?.error?.type || body?.code || body?.type;
        providerCode = typeof rawCode === 'string'
          ? rawCode.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 48)
          : '';
      } catch {
        // Provider error bodies are optional and never required for handling.
      }
    }
    error.code = Number.isInteger(response?.status)
      ? `http_${response.status}${providerCode ? `_${providerCode}` : ''}`
      : 'invalid_response';
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error('Council provider returned invalid JSON.');
    error.code = 'invalid_json';
    throw error;
  }
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function envText(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function xaiChatTransport(env, config) {
  const oidcToken = envText(env, 'VERCEL_OIDC_TOKEN');
  const gatewayKey = envText(env, 'AI_GATEWAY_API_KEY');
  const gatewayToken = gatewayKey || oidcToken;
  const configuredModel = envText(env, config.model);
  const gatewayModel = envText(env, config.gatewayModel);
  // Vercel injects an OIDC token into every deployment. That must not silently
  // replace the explicitly configured xAI model with an unrelated Gateway
  // default: model redirects can change reasoning usage, cost, and token-limit
  // behavior without an application deployment. Direct xAI is the default
  // whenever its required key/model pair is configured. Gateway routing is an
  // explicit operator choice made by setting a Gateway-qualified model.
  if (!gatewayToken || !gatewayModel) {
    return Object.freeze({ url: config.chatUrl, token: envText(env, config.key), model: configuredModel });
  }
  return Object.freeze({
    url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    token: gatewayToken,
    model: gatewayModel,
  });
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 45_000;

function providerTimeoutMs(env) {
  const value = positiveNumber(env.REINA_COUNCIL_PROVIDER_TIMEOUT_MS);
  return value === null ? DEFAULT_PROVIDER_TIMEOUT_MS : value;
}

async function providerFetch(fetchImpl, url, options, timeoutMs) {
  // Vercel's own maxDuration force-kills the function process without
  // running any JS catch/finally, which would otherwise leave a hung
  // provider call's admission record stuck in the "admitted" state for its
  // full 15-minute expiry. Aborting here well inside that ceiling lets the
  // normal error path -- and releaseAdmission() -- run instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw providerError('provider_timeout', 'Council provider request timed out.');
    }
    const nestedErrors = Array.isArray(cause?.cause?.errors) ? cause.cause.errors : [];
    const nestedCode = nestedErrors.find((entry) => typeof entry?.code === 'string')?.code;
    const rawCode = typeof cause?.cause?.code === 'string'
      ? cause.cause.code
      : typeof nestedCode === 'string'
        ? nestedCode
        : typeof cause?.code === 'string' ? cause.code : cause?.name;
    const safeCode = typeof rawCode === 'string'
      ? rawCode.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 40)
      : 'request';
    throw providerError(`network_${safeCode || 'request'}`, 'Council provider network request failed.');
  } finally {
    clearTimeout(timer);
  }
}

function safeText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80_000 ? value : null;
}

function responseText(body) {
  const direct = safeText(body?.output_text);
  if (direct) return direct;
  for (const output of body?.output || []) {
    for (const content of output?.content || []) {
      const text = safeText(content?.text);
      if (text) return text;
    }
  }
  return null;
}

function sharedUsage(inputTokens, outputTokens, price, extraCostCents = 0) {
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error('Council provider did not return usable token counts.');
  }
  const usage = Object.freeze({ inputTokens, outputTokens });
  return Object.freeze({ ...usage, costCents: cost(usage, price) + extraCostCents });
}

function xaiCostCents(usage, fallback) {
  const ticks = Number(usage?.cost_in_usd_ticks);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks / 100_000_000 : fallback;
}

function media(attachments) {
  return (attachments || []).filter((item) => item?.kind === 'image' || item?.kind === 'pdf');
}

function openAiContent(prompt, attachments) {
  return [
    ...media(attachments).map((item) => item.kind === 'image'
      ? { type: 'input_image', image_url: `data:${item.mimeType};base64,${item.dataBase64}`, detail: 'auto' }
      : { type: 'input_file', filename: item.name, file_data: `data:application/pdf;base64,${item.dataBase64}` }),
    { type: 'input_text', text: prompt },
  ];
}

function anthropicContent(prompt, attachments) {
  return [
    ...media(attachments).map((item) => item.kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.dataBase64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: item.dataBase64 } }),
    { type: 'text', text: prompt },
  ];
}

function xaiChatContent(prompt, attachments) {
  const images = media(attachments).filter((item) => item.kind === 'image');
  if (!images.length) return prompt;
  return [
    ...images.map((item) => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.dataBase64}` } })),
    { type: 'text', text: prompt },
  ];
}

function decodeBase64(value) {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function configured(env, config) {
  return typeof env[config.key] === 'string' && env[config.key].trim().length > 0
    && typeof env[config.model] === 'string' && env[config.model].trim().length > 0
    && pricing(env, config.prefix) !== null;
}

export function configuredCouncilProviders(env = process.env) {
  return Object.freeze(Object.entries(PROVIDER_CONFIG)
    .filter(([, config]) => configured(env, config))
    .map(([name]) => name));
}

export function createCouncilProviders({ env = process.env, fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const adapters = {};
  const timeoutMs = providerTimeoutMs(env);

  if (configured(env, PROVIDER_CONFIG.chatgpt)) {
    const config = PROVIDER_CONFIG.chatgpt;
    const price = pricing(env, config.prefix);
    adapters.chatgpt = adapter(price, async ({ prompt, attachments, maxTokens }) => {
      const body = await json(await providerFetch(fetchImpl, config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${envText(env, config.key)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: envText(env, config.model), input: [{ role: 'user', content: openAiContent(prompt, attachments) }], max_output_tokens: maxTokens,
          // Boardroom needs structured judgment without spending most of the
          // response allowance before the required JSON object is emitted.
          reasoning: { effort: 'none' },
          text: { format: { type: 'json_schema', name: 'council_message', strict: true, schema: COUNCIL_MESSAGE_SCHEMA } },
        }),
      }, timeoutMs));
      const text = responseText(body);
      if (!text) throw new Error('OpenAI did not return text.');
      return freezeResult(text, sharedUsage(body.usage?.input_tokens, body.usage?.output_tokens, price));
    });
  }

  if (configured(env, PROVIDER_CONFIG.claude)) {
    const config = PROVIDER_CONFIG.claude;
    const price = pricing(env, config.prefix);
    adapters.claude = adapter(price, async ({ prompt, attachments, maxTokens }) => {
      const body = await json(await providerFetch(fetchImpl, config.url, {
        method: 'POST',
        headers: {
          'x-api-key': envText(env, config.key), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: envText(env, config.model), max_tokens: maxTokens,
          messages: [{ role: 'user', content: anthropicContent(prompt, attachments) }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: COUNCIL_MESSAGE_SCHEMA } },
        }),
      }, timeoutMs));
      const text = safeText(body.content?.find((item) => item?.type === 'text')?.text);
      if (!text) throw new Error('Anthropic did not return text.');
      return freezeResult(text, sharedUsage(body.usage?.input_tokens, body.usage?.output_tokens, price));
    });
  }

  if (configured(env, PROVIDER_CONFIG.grok)) {
    const config = PROVIDER_CONFIG.grok;
    const price = pricing(env, config.prefix);
    adapters.grok = adapter(price, async ({ prompt, attachments, maxTokens }) => {
      const uploaded = [];
      try {
        const pdfs = media(attachments).filter((entry) => entry.kind === 'pdf');
        const transport = xaiChatTransport(env, config);
        // Direct Grok 4.5 uses xAI's current Responses API. Retain the
        // OpenAI-compatible Chat Completions path only when an operator has
        // explicitly selected a Gateway-qualified model.
        if (!pdfs.length && transport.url !== config.chatUrl) {
          const reasoningEffort = transport.model.includes('non-reasoning') ? 'none' : 'low';
          const body = await json(await providerFetch(fetchImpl, transport.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${transport.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: transport.model,
              messages: [{ role: 'user', content: xaiChatContent(prompt, attachments) }],
              max_completion_tokens: maxTokens,
              reasoning_effort: reasoningEffort,
              response_format: { type: 'json_schema', json_schema: { name: 'council_message', strict: true, schema: COUNCIL_MESSAGE_SCHEMA } },
            }),
          }, timeoutMs));
          const text = safeText(body?.choices?.[0]?.message?.content);
          if (!text) throw providerError('xai_chat_missing_text', 'xAI did not return chat text.');
          // xAI's OpenAI-compatible Chat Completions endpoint uses the
          // conventional prompt/completion token field names.
          const normalizedUsage = sharedUsage(body.usage?.prompt_tokens, body.usage?.completion_tokens, price);
          return freezeResult(text, { ...normalizedUsage, costCents: xaiCostCents(body.usage, normalizedUsage.costCents) });
        }
        for (const item of pdfs) {
          const form = new FormData();
          form.append('expires_after', '3600');
          form.append('purpose', 'assistants');
          form.append('file', new Blob([decodeBase64(item.dataBase64)], { type: item.mimeType }), item.name);
          const file = await json(await providerFetch(fetchImpl, 'https://api.x.ai/v1/files', {
            method: 'POST', headers: { Authorization: `Bearer ${envText(env, config.key)}` }, body: form,
          }, timeoutMs));
          if (typeof file.id !== 'string' || !file.id) throw new Error('xAI did not accept the PDF.');
          uploaded.push(file.id);
        }
        const content = [
          ...media(attachments).filter((item) => item.kind === 'image').map((item) => ({ type: 'input_image', image_url: `data:${item.mimeType};base64,${item.dataBase64}`, detail: 'auto' })),
          ...uploaded.map((fileId) => ({ type: 'input_file', file_id: fileId })),
          { type: 'input_text', text: prompt },
        ];
        const body = await json(await providerFetch(fetchImpl, config.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${envText(env, config.key)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: envText(env, config.model), input: [{ role: 'user', content }], max_output_tokens: maxTokens,
            reasoning: { effort: 'low' },
            text: { format: { type: 'json_schema', name: 'council_message', strict: true, schema: COUNCIL_MESSAGE_SCHEMA } },
            max_turns: uploaded.length ? 5 : undefined,
          }),
        }, timeoutMs));
        const text = responseText(body);
        if (!text) throw providerError('xai_responses_missing_text', 'xAI did not return response text.');
        const normalizedUsage = sharedUsage(body.usage?.input_tokens, body.usage?.output_tokens, price, uploaded.length);
        return freezeResult(text, { ...normalizedUsage, costCents: xaiCostCents(body.usage, normalizedUsage.costCents) });
      } finally {
        await Promise.allSettled(uploaded.map((fileId) => fetchImpl(`https://api.x.ai/v1/files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${env[config.key]}` },
        })));
      }
    }, (attachments) => media(attachments).filter((item) => item.kind === 'pdf').length * 10);
  }
  return Object.freeze(adapters);
}

function freezeResult(text, usage) {
  return Object.freeze({ text, usage: Object.freeze(usage) });
}
