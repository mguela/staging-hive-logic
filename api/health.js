// api/health.js - Vercel serverless function
// Minimal status check for the Reina chat widget's "am I talking to a real
// brain?" probe -- mirrors the fields the widget actually reads from the
// reina-ai prototype's /api/health.
export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    reina: 'online',
    engine: process.env.REINA_MODEL || 'claude-sonnet-4-5',
    api_key_configured: Boolean(process.env.ANTHROPIC_API_KEY)
  });
}
