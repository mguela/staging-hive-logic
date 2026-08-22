// api/documents.js - Vercel serverless function
// AI classification for the Documents feature. Reads an uploaded file
// (filename + a page/image sample) and returns a best-guess document type
// with a confidence score. Read-only against Anthropic; never touches the
// database directly -- the browser writes to Supabase itself (RLS-gated)
// after the user confirms the suggestion.
import Anthropic from '@anthropic-ai/sdk';
import { requireUser } from './_lib/auth.js';

const DOC_TYPES = ['contract', 'permit', 'invoice', 'estimate', 'photo', 'payroll', 'other'];
// Keep the JSON request below common serverless body limits after base64's
// ~33% expansion. The browser may still file a larger document; it simply
// skips AI classification and asks the user to choose the type.
export const MAX_CLASSIFIER_SAMPLE_BYTES = 3 * 1024 * 1024;
const MAX_CLASSIFIER_BASE64_CHARS = Math.ceil(MAX_CLASSIFIER_SAMPLE_BYTES / 3) * 4;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function decodedBase64ByteLength(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function fallbackClassify(filename) {
  const lower = String(filename || '').toLowerCase();
  const hints = [
    ['contract', ['contract', 'agreement', 'signed']],
    ['permit', ['permit']],
    ['invoice', ['invoice', 'inv-', 'bill']],
    ['estimate', ['estimate', 'quote', 'proposal']],
    ['payroll', ['payroll', 'paystub', 'w2', 'w-2', '1099']],
    ['photo', ['img_', 'photo', '.jpg', '.jpeg', '.png', '.heic']]
  ];
  const match = hints.find(([, words]) => words.some((w) => lower.includes(w)));
  return {
    docType: match ? match[0] : 'other',
    confidence: match ? 0.4 : 0.15,
    reasoning: 'Matched from the filename only (AI unavailable right now).'
  };
}

async function classifyWithClaude(filename, mimeType, dataBase64) {
  const content = [
    {
      type: 'text',
      text:
        'You classify uploaded contractor documents for HiveLogic. ' +
        'Pick exactly one doc type from: ' + DOC_TYPES.join(', ') + '. ' +
        'Filename: "' + filename + '"\n' +
        'Respond with ONLY a JSON object: {"docType": string, "confidence": number 0..1, "reasoning": "one short sentence"}'
    }
  ];

  if (mimeType === 'application/pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } });
  } else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: dataBase64 } });
  }
  // Other types (docx, zip, etc.): classify from filename alone.

  const msg = await anthropic.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content }]
  });

  const text = msg.content.find((b) => b.type === 'text')?.text || '{}';
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const docType = DOC_TYPES.includes(json.docType) ? json.docType : 'other';
  return {
    docType,
    confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0)),
    reasoning: String(json.reasoning || '')
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  // Auth (2026-07-31): the classifier calls Anthropic -- require a signed-in
  // session so anonymous callers can't run up an API bill.
  const _user = await requireUser(req);
  if (!_user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try {
    const { filename, mimeType, dataBase64 } = req.body || {};
    const cleanFilename = typeof filename === 'string' ? filename.trim() : '';
    if (!cleanFilename) return res.status(400).json({ ok: false, error: 'filename required' });
    if (cleanFilename.length > 255) {
      return res.status(400).json({ ok: false, error: 'filename is too long' });
    }

    const cleanMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
    if (cleanMimeType.length > 100) {
      return res.status(400).json({ ok: false, error: 'mimeType is too long' });
    }

    if (dataBase64 !== undefined && dataBase64 !== null && dataBase64 !== '') {
      if (typeof dataBase64 !== 'string') {
        return res.status(400).json({ ok: false, error: 'dataBase64 must be valid base64' });
      }
      // Reject obviously oversized encoded bodies before normalizing whitespace,
      // which would otherwise allocate another large string.
      if (dataBase64.length > MAX_CLASSIFIER_BASE64_CHARS) {
        return res.status(413).json({
          ok: false,
          error: 'Classification sample is too large. File the document without automatic classification.',
          maxSampleBytes: MAX_CLASSIFIER_SAMPLE_BYTES,
        });
      }
      const sampleBytes = decodedBase64ByteLength(dataBase64);
      if (sampleBytes === null) {
        return res.status(400).json({ ok: false, error: 'dataBase64 must be valid base64' });
      }
      if (sampleBytes > MAX_CLASSIFIER_SAMPLE_BYTES) {
        return res.status(413).json({
          ok: false,
          error: 'Classification sample is too large. File the document without automatic classification.',
          maxSampleBytes: MAX_CLASSIFIER_SAMPLE_BYTES,
        });
      }
    }

    if (anthropic && dataBase64) {
      try {
        const suggestion = await classifyWithClaude(cleanFilename, cleanMimeType, dataBase64);
        return res.status(200).json({ ok: true, suggestion });
      } catch (e) {
        console.error('Claude classification failed, using fallback:', e);
      }
    }
    return res.status(200).json({ ok: true, suggestion: fallbackClassify(cleanFilename) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
