import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { configuredCouncilProviders, createCouncilProviders } from '../api/_lib/reina/council-providers.js';

function hangingFetch() {
  return (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });
}

const env = {
  OPENAI_API_KEY: 'openai-key', REINA_COUNCIL_OPENAI_MODEL: 'openai-model',
  ANTHROPIC_API_KEY: 'anthropic-key', REINA_COUNCIL_ANTHROPIC_MODEL: 'anthropic-model',
  XAI_API_KEY: 'xai-key', REINA_COUNCIL_XAI_MODEL: 'xai-model',
  REINA_COUNCIL_OPENAI_INPUT_CENTS_PER_MILLION: '100', REINA_COUNCIL_OPENAI_OUTPUT_CENTS_PER_MILLION: '200',
  REINA_COUNCIL_ANTHROPIC_INPUT_CENTS_PER_MILLION: '100', REINA_COUNCIL_ANTHROPIC_OUTPUT_CENTS_PER_MILLION: '200',
  REINA_COUNCIL_XAI_INPUT_CENTS_PER_MILLION: '100', REINA_COUNCIL_XAI_OUTPUT_CENTS_PER_MILLION: '200',
};

test('all providers require an explicit key, model, and price configuration', () => {
  assert.deepEqual(configuredCouncilProviders(env), ['chatgpt', 'claude', 'grok']);
  assert.deepEqual(configuredCouncilProviders({ ...env, XAI_API_KEY: '' }), ['chatgpt', 'claude']);
  assert.deepEqual(configuredCouncilProviders({ ...env, REINA_COUNCIL_XAI_INPUT_CENTS_PER_MILLION: '' }), ['chatgpt', 'claude']);
});

test('adapters issue tool-free requests and normalize provider token usage', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const body = url.includes('openai')
      ? { output_text: '{}', usage: { input_tokens: 12, output_tokens: 8 } }
      : url.includes('anthropic')
        ? { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 12, output_tokens: 8 } }
        : url.includes('chat/completions')
          ? { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }
          : { output_text: '{}', usage: { input_tokens: 12, output_tokens: 8 } };
    return { ok: true, json: async () => body };
  };
  const paddedEnv = {
    ...env,
    OPENAI_API_KEY: ' openai-key\n', REINA_COUNCIL_OPENAI_MODEL: ' openai-model ',
    ANTHROPIC_API_KEY: ' anthropic-key\n', REINA_COUNCIL_ANTHROPIC_MODEL: ' anthropic-model ',
    XAI_API_KEY: ' xai-key\n', REINA_COUNCIL_XAI_MODEL: ' xai-model ',
  };
  const providers = createCouncilProviders({ env: paddedEnv, fetchImpl });
  for (const provider of Object.values(providers)) {
    assert.equal(provider.estimateMaxCostCents({ prompt: 'Return JSON.', maxTokens: 50 }) > 0, true);
  }
  await Promise.all(Object.values(providers).map((provider) => provider.generate({ prompt: 'Return JSON.', maxTokens: 50 })));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const serialized = JSON.stringify(call.body).toLowerCase();
    assert.equal(serialized.includes('"tools"'), false);
    assert.equal(serialized.includes('shell'), false);
    assert.equal(serialized.includes('function_call'), false);
  }
  const openai = calls.find((call) => call.url.includes('openai.com')).body;
  const anthropic = calls.find((call) => call.url.includes('anthropic.com')).body;
  const grok = calls.find((call) => call.url.includes('api.x.ai')).body;
  assert.equal(openai.reasoning.effort, 'none');
  assert.equal(openai.text.format.type, 'json_schema');
  assert.equal(anthropic.output_config.format.type, 'json_schema');
  assert.equal(JSON.stringify(anthropic.output_config).includes('minItems'), false);
  assert.equal(JSON.stringify(anthropic.output_config).includes('maxItems'), false);
  assert.equal(grok.reasoning.effort, 'low');
  assert.equal(grok.text.format.type, 'json_schema');
  assert.equal(grok.text.format.strict, true);
  assert.equal(calls.every((call) => !JSON.stringify(call.headers).includes('\\n')), true);
  assert.equal(openai.model, 'openai-model');
  assert.equal(anthropic.model, 'anthropic-model');
  assert.equal(grok.model, 'xai-model');
});

test('provider network failures expose only a safe diagnostic code', async () => {
  const failure = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  const providers = createCouncilProviders({ env, fetchImpl: async () => { throw failure; } });
  await assert.rejects(
    providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 }),
    { code: 'network_und_err_connect_timeout' },
  );

  const aggregateFailure = new TypeError('fetch failed', {
    cause: new AggregateError([{ code: 'ETIMEDOUT' }, { code: 'ENETUNREACH' }]),
  });
  const aggregateProviders = createCouncilProviders({ env, fetchImpl: async () => { throw aggregateFailure; } });
  await assert.rejects(
    aggregateProviders.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 }),
    { code: 'network_etimedout' },
  );
});

test('a provider request that never resolves is aborted at a configured timeout', async () => {
  const providers = createCouncilProviders({ env: { ...env, REINA_COUNCIL_PROVIDER_TIMEOUT_MS: '20' }, fetchImpl: hangingFetch() });
  await assert.rejects(
    providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 }),
    { code: 'provider_timeout' },
  );
});

test('the provider timeout defaults to 45 seconds when unset', async () => {
  // Vercel's own maxDuration force-kills the function without running any JS
  // catch/finally, leaving a hung admission stuck for its full 15-minute
  // expiry -- the default must actually be well inside that ceiling, not
  // just "some positive number", so this pins the literal value.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const providers = createCouncilProviders({ env, fetchImpl: hangingFetch() });
    const pending = assert.rejects(
      providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 }),
      { code: 'provider_timeout' },
    );
    mock.timers.tick(44_999);
    await Promise.resolve();
    mock.timers.tick(1);
    await pending;
  } finally {
    mock.timers.reset();
  }
});

test('an invalid provider timeout override falls back to the 45 second default', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const providers = createCouncilProviders({ env: { ...env, REINA_COUNCIL_PROVIDER_TIMEOUT_MS: 'not-a-number' }, fetchImpl: hangingFetch() });
    const pending = assert.rejects(
      providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 }),
      { code: 'provider_timeout' },
    );
    mock.timers.tick(44_999);
    await Promise.resolve();
    mock.timers.tick(1);
    await pending;
  } finally {
    mock.timers.reset();
  }
});

test('Vercel OIDC does not silently replace the explicitly configured xAI model', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ output_text: '{}', usage: { input_tokens: 12, output_tokens: 8 } }),
    };
  };
  const providers = createCouncilProviders({ env: { ...env, VERCEL_OIDC_TOKEN: ' oidc-token\n' }, fetchImpl });
  await providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xai-key');
  assert.equal(calls[0].body.model, 'xai-model');
});

test('an explicit Gateway-qualified model opts Grok into AI Gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    };
  };
  const providers = createCouncilProviders({
    env: {
      ...env,
      VERCEL_OIDC_TOKEN: ' oidc-token\n',
      REINA_COUNCIL_XAI_GATEWAY_MODEL: ' xai/grok-4.1-fast-non-reasoning ',
    },
    fetchImpl,
  });
  await providers.grok.generate({ prompt: 'Return JSON.', maxTokens: 50 });
  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer oidc-token');
  assert.equal(calls[0].body.model, 'xai/grok-4.1-fast-non-reasoning');
  assert.equal(calls[0].body.reasoning_effort, 'none');
});

test('photos and PDFs are delivered as read-only provider context and xAI files are deleted', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({ url, method: options.method, body });
    if (url === 'https://api.x.ai/v1/files' && options.method === 'POST') return { ok: true, json: async () => ({ id: 'file-1' }) };
    if (url.endsWith('/file-1') && options.method === 'DELETE') return { ok: true, json: async () => ({}) };
    if (url.includes('anthropic')) return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 12, output_tokens: 8 } }) };
    return { ok: true, json: async () => ({ output_text: '{}', usage: { input_tokens: 12, output_tokens: 8, cost_in_usd_ticks: 50_000_000 } }) };
  };
  const attachments = [
    { id: 'photo', name: 'photo.jpg', kind: 'image', mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    { id: 'paper', name: 'paper.pdf', kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'aGVsbG8=' },
  ];
  const providers = createCouncilProviders({ env, fetchImpl });
  const results = [];
  for (const provider of Object.values(providers)) {
    assert.equal(provider.estimateMaxCostCents({ prompt: 'Return JSON.', attachments, maxTokens: 50 }) > 0, true);
    results.push(await provider.generate({ prompt: 'Return JSON.', attachments, maxTokens: 50 }));
  }
  const openai = calls.find((call) => call.url.includes('openai.com/v1/responses')).body;
  assert.equal(openai.input[0].content.some((item) => item.type === 'input_image'), true);
  assert.equal(openai.input[0].content.some((item) => item.type === 'input_file'), true);
  const anthropic = calls.find((call) => call.url.includes('anthropic.com')).body;
  assert.equal(anthropic.messages[0].content.some((item) => item.type === 'image'), true);
  assert.equal(anthropic.messages[0].content.some((item) => item.type === 'document'), true);
  const grok = calls.find((call) => call.url === 'https://api.x.ai/v1/responses').body;
  assert.equal(grok.input[0].content.some((item) => item.type === 'input_image'), true);
  assert.equal(grok.input[0].content.some((item) => item.type === 'input_file' && item.file_id === 'file-1'), true);
  assert.equal(grok.max_turns, 5);
  assert.equal(results[2].usage.costCents, 0.5);
  const upload = calls.find((call) => call.url === 'https://api.x.ai/v1/files').body;
  assert.equal(upload.get('expires_after'), '3600');
  assert.equal(upload.get('purpose'), 'assistants');
  assert.equal(calls.some((call) => call.url.endsWith('/file-1') && call.method === 'DELETE'), true);
  assert.equal(JSON.stringify([openai, anthropic, grok]).toLowerCase().includes('shell'), false);
});
