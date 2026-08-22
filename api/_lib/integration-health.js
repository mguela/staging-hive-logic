const OAUTH_INTEGRATIONS = Object.freeze([
  {
    id: 'jobber',
    label: 'Jobber',
    env: ['JOBBER_CLIENT_ID', 'JOBBER_CLIENT_SECRET'],
    reconnectUrl: '/api/jobber/connect',
  },
  {
    id: 'qbo',
    label: 'QuickBooks Online',
    env: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'],
    reconnectUrl: '/api/qbo',
  },
  {
    id: 'gusto',
    label: 'Gusto',
    env: ['GUSTO_CLIENT_ID', 'GUSTO_CLIENT_SECRET'],
    reconnectUrl: '/api/gusto',
  },
]);

function present(env, key) {
  return typeof env[key] === 'string' && env[key].trim().length > 0;
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function buildIntegrationHealth({ rows = [], env = {}, now = Date.now(), supabaseReachable = true } = {}) {
  const rowByKey = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row && typeof row.key === 'string')
      .map((row) => [row.key.toLowerCase(), row])
  );

  const oauth = OAUTH_INTEGRATIONS.map((definition) => {
    const row = rowByKey.get(definition.id) || null;
    const configured = definition.env.every((key) => present(env, key));
    const expiresAt = safeIso(row && row.expires_at);
    const updatedAt = safeIso(row && row.updated_at);
    const expiryMs = expiresAt ? new Date(expiresAt).getTime() : null;
    const refreshDue = Boolean(row && expiryMs !== null && expiryMs <= now + 5 * 60 * 1000);

    let state = 'connected';
    let detail = 'Stored OAuth connection; refresh is automatic.';
    if (!configured) {
      state = 'not_configured';
      detail = 'Provider application credentials are not configured.';
    } else if (!row) {
      state = 'disconnected';
      detail = 'No stored OAuth connection.';
    } else if (refreshDue) {
      state = 'refresh_due';
      detail = 'Access token is due for automatic refresh on the next provider call.';
    }

    return {
      id: definition.id,
      label: definition.label,
      state,
      configured,
      connected: Boolean(configured && row),
      healthVerified: false,
      refreshMode: 'oauth',
      refreshDue,
      detail,
      updatedAt,
      expiresAt,
      reconnectUrl: definition.reconnectUrl,
    };
  });

  const gatewayOidc = present(env, 'VERCEL_OIDC_TOKEN');
  const gatewayKey = present(env, 'AI_GATEWAY_API_KEY');
  const directProviders = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY'].filter((key) => present(env, key));
  const aiConfigured = gatewayOidc || gatewayKey || directProviders.length > 0;
  const ai = {
    id: 'ai-council',
    label: 'AI Council',
    state: aiConfigured ? 'configured' : 'not_configured',
    configured: aiConfigured,
    connected: aiConfigured,
    healthVerified: false,
    refreshMode: gatewayOidc ? 'oidc' : (gatewayKey ? 'gateway_key' : (directProviders.length ? 'provider_keys' : 'none')),
    detail: gatewayOidc
      ? 'Vercel OIDC is active; production credentials renew automatically.'
      : gatewayKey
        ? 'AI Gateway key is configured.'
        : directProviders.length
          ? `${directProviders.length}/3 direct provider credentials are configured.`
          : 'No AI provider authentication is configured.',
    updatedAt: null,
    expiresAt: null,
    reconnectUrl: null,
  };

  const supabase = {
    id: 'supabase',
    label: 'Supabase',
    state: supabaseReachable ? 'connected' : 'unavailable',
    configured: present(env, 'SUPABASE_URL') && present(env, 'SUPABASE_SERVICE_KEY'),
    connected: Boolean(supabaseReachable),
    healthVerified: Boolean(supabaseReachable),
    refreshMode: 'managed_key',
    detail: supabaseReachable
      ? 'Server connection verified while loading integration metadata.'
      : 'Integration metadata could not be read.',
    updatedAt: null,
    expiresAt: null,
    reconnectUrl: null,
  };

  const authnetPaymentsConfigured = present(env, 'AUTHNET_API_LOGIN_ID') && present(env, 'AUTHNET_TRANSACTION_KEY');
  const authnetWebhookConfigured = present(env, 'AUTHNET_SIGNATURE_KEY');
  const authnetConfigured = authnetPaymentsConfigured && authnetWebhookConfigured;
  const authnetEnvironment = env.AUTHNET_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  const authnet = {
    id: 'authorize-net',
    label: 'Authorize.Net',
    state: authnetConfigured ? 'configured' : (authnetPaymentsConfigured || authnetWebhookConfigured ? 'partial_setup' : 'not_configured'),
    configured: authnetConfigured,
    connected: authnetConfigured,
    healthVerified: false,
    refreshMode: 'static_keys',
    detail: authnetConfigured
      ? `Payment and webhook credentials are configured for ${authnetEnvironment}; no live charge was attempted.`
      : authnetPaymentsConfigured
        ? 'Payment credentials exist, but the webhook signature key is missing.'
        : authnetWebhookConfigured
          ? 'Webhook signature key exists, but payment API credentials are missing.'
          : 'Authorize.Net payment and webhook credentials are not configured.',
    updatedAt: null,
    expiresAt: null,
    reconnectUrl: null,
  };

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    integrations: [supabase, ...oauth, ai, authnet],
  };
}
