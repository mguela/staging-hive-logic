// api/health-test.js — DISABLED. The one-time test trigger (2026-07-28) has
// served its purpose (test email delivered to chris@ghgrp.net, Resend id
// 52fb7655). Endpoint neutralized: no token, no send logic. Safe to delete the
// file entirely later. The real daily report is api/health-cron.js.
export default function handler(req, res) {
  return res.status(410).json({ ok: false, error: 'This one-time test endpoint has been retired. See /api/health-cron (daily).' });
}
