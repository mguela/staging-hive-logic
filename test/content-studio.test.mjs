import assert from 'node:assert/strict';
import { test } from 'node:test';

// Storage helpers build real URLs from these, so they must be set before the
// modules under test are imported.
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
import {
  selectReelCandidates,
  chooseReelFrames,
  writeReelScript,
  renderReelVoiceover,
  narrationText,
} from '../api/_lib/reel-builder.js';
import {
  handleReelDraftPost,
  handleReelQueuePost,
  handleReelVideoPost,
  handleReelScriptPost,
} from '../api/content-studio.js';

// Two things this file exists to keep true, both of which would be invisible
// until the damage was public:
//   1. A reel is public marketing, so no customer name, address, or price may
//      reach the script model or the caption.
//   2. Nothing reaches a platform without a rendered file and a human. There
//      is no fabricated media URL and no auto-publish anywhere in the path.

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function fakeSupabase(routes, log = []) {
  return async (path, opts = {}) => {
    log.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    for (const [match, rows] of routes) {
      if (path.includes(match)) {
        const value = typeof rows === 'function' ? rows(path, opts) : rows;
        return { ok: true, json: async () => value, text: async () => JSON.stringify(value) };
      }
    }
    return { ok: true, json: async () => [], text: async () => '[]' };
  };
}

const NOW = new Date('2026-08-24T12:00:00.000Z');

function photo(id, jobId, isoDate) {
  return { id, job_id: jobId, job_uuid: null, storage_path: jobId + '/' + id + '.jpg', captured_at: isoDate, media_type: 'photo' };
}

const CANDIDATE_ROUTES = [
  ['media?', [
    photo('p1', 'j1', '2026-08-01T09:00:00Z'),
    photo('p2', 'j1', '2026-08-01T11:00:00Z'),
    photo('p3', 'j1', '2026-08-01T13:00:00Z'),
    photo('p4', 'j1', '2026-08-01T16:00:00Z'),
    photo('p5', 'j2', '2026-08-02T09:00:00Z'),   // only one photo -- not enough
    photo('p6', 'j3', '2024-01-01T09:00:00Z'),   // old enough to be out of window
  ]],
  ['jobs?', [
    { jobber_id: 'j1', uuid_id: 'u1', title: 'Furnace replacement', completed_at: '2026-08-01T18:00:00Z' },
    { jobber_id: 'j2', uuid_id: 'u2', title: 'Faucet repair', completed_at: '2026-08-02T18:00:00Z' },
    { jobber_id: 'j3', uuid_id: 'u3', title: 'Deck build', completed_at: '2024-01-01T18:00:00Z' },
  ]],
  ['content_reels?select=job_id', []],
];

test('candidates are only real completed jobs with enough real photos in window', async () => {
  const out = await selectReelCandidates({}, { supabaseRequest: fakeSupabase(CANDIDATE_ROUTES), now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].jobId, 'j1');
  assert.equal(out[0].photoCount, 4);
  assert.equal(out[0].division, 'HVAC');
  // Chronological order is the before-and-after story; without it the "after"
  // shot could land anywhere in the edit.
  assert.deepEqual(out[0].photos.map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
});

test('a job that already has a live reel is never offered again', async () => {
  const routes = CANDIDATE_ROUTES.map(([m, v]) => (m === 'content_reels?select=job_id' ? [m, [{ job_id: 'j1' }]] : [m, v]));
  const out = await selectReelCandidates({}, { supabaseRequest: fakeSupabase(routes), now: NOW });
  assert.deepEqual(out, []);
});

test('frame selection always keeps the first and last shot -- the before and the after', () => {
  const photos = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i }));
  const frames = chooseReelFrames(photos);
  assert.equal(frames.length, 6);
  assert.equal(frames[0].id, 'p0');
  assert.equal(frames[frames.length - 1].id, 'p29');
  assert.equal(new Set(frames.map((f) => f.id)).size, 6, 'no frame may repeat');
});

test('a short photo set is used whole rather than padded', () => {
  const photos = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(chooseReelFrames(photos).map((f) => f.id), ['a', 'b', 'c', 'd']);
});

test('the script model is never given a customer name, address, or price', async () => {
  let seenPrompt = '';
  const anthropic = {
    messages: {
      create: async ({ messages }) => {
        seenPrompt = messages[0].content;
        return { content: [{ type: 'text', text: JSON.stringify({
          hook: 'Cold house, fixed in a day', caption: 'Furnace day', hashtags: ['#hvac'],
          beats: [{ onScreenText: 'Before', say: 'This furnace had given up.' }, { onScreenText: 'After', say: 'A new one, running clean.' }],
        }) }] };
      },
    },
  };
  await writeReelScript({ division: 'HVAC', jobTitle: 'Furnace replacement', frameCount: 2, territoryFacts: { avgDistanceMiles: 6.2 } }, { anthropic });

  assert.match(seenPrompt, /Furnace replacement/, 'the work itself is fair game');
  assert.match(seenPrompt, /Never name or describe the customer/);

  // Only the facts block is checked, not the instructions -- the instructions
  // legitimately contain words like "street" because they forbid using one.
  const facts = JSON.parse(seenPrompt.match(/Facts:\n(\{[\s\S]*?\n\})/)[1]);
  assert.deepEqual(Object.keys(facts).sort(),
    ['numberOfPhotos', 'serviceAreaAvgDistanceMiles', 'tradeDivision', 'workDescription'],
    'the facts handed to the model must be exactly these four -- any new key is a potential leak');
  const factsText = JSON.stringify(facts).toLowerCase();
  for (const leak of ['clientname', 'address', 'street', 'invoice', 'total', 'client_id', 'email', 'phone']) {
    assert.ok(!factsText.includes(leak), 'the facts leaked ' + leak);
  }
});

test('a script with the wrong number of beats is rejected, not silently trimmed', async () => {
  const anthropic = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        hook: 'h', caption: 'c', hashtags: [],
        beats: [{ onScreenText: 'only one', say: 'but four shots were asked for' }],
      }) }] }),
    },
  };
  await assert.rejects(
    () => writeReelScript({ division: 'HVAC', jobTitle: 'x', frameCount: 4 }, { anthropic }),
    /returned 1 beats for 4 shots/);
});

test('narration order matches playback order, which is what keeps captions on the voice', () => {
  const script = {
    hook: 'Cold house.',
    beats: [{ say: 'The furnace was dead.' }, { say: 'New unit in.' }, { say: 'Heat back on.' }],
  };
  assert.equal(narrationText(script), 'Cold house. The furnace was dead. New unit in. Heat back on.');
});

test('voiceover refuses honestly when no TTS key is configured rather than writing a silent file', async () => {
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => renderReelVoiceover({ reelId: 'r1', script: { hook: 'h', beats: [] } }, {}),
      /OPENAI_API_KEY is not set/);
  } finally {
    if (prior !== undefined) process.env.OPENAI_API_KEY = prior;
  }
});

test('voiceover stores the real mp3 bytes the TTS call returned', async () => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key-long-enough-to-pass-validation';
  try {
    const uploads = [];
    const out = await renderReelVoiceover(
      { reelId: 'r1', script: { hook: 'Cold house.', beats: [{ say: 'Fixed.' }] }, voice: 'nova' },
      {
        createNeuralSpeech: async ({ text, voice }) => {
          assert.equal(text, 'Cold house. Fixed.');
          assert.equal(voice, 'nova');
          return { ok: true, bytes: Buffer.from('ID3realmp3bytes') };
        },
        storageUpload: async (bucket, path, body, contentType) => { uploads.push({ bucket, path, body, contentType }); },
      });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].bucket, 'content-reels');
    assert.equal(uploads[0].path, 'voice/r1.mp3');
    assert.equal(uploads[0].contentType, 'audio/mpeg');
    assert.equal(uploads[0].body.toString(), 'ID3realmp3bytes');
    assert.match(out.publicUrl, /content-reels\/voice\/r1\.mp3$/);
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
});

test('a reel cannot be started from a job that is not a real candidate', async () => {
  const r = res();
  await handleReelDraftPost({ body: { jobId: 'nope' } }, r, { supabaseRequest: fakeSupabase(CANDIDATE_ROUTES), now: NOW });
  assert.equal(r.statusCode, 404);
  assert.match(r.body.error, /not a reel candidate/);
});

test('a reel cannot be queued for posting before a real video exists', async () => {
  const r = res();
  await handleReelQueuePost(
    { body: { reelId: 'r1', surface: 'instagram' } }, r,
    { supabaseRequest: fakeSupabase([['content_reels?id=eq.r1', [{ id: 'r1', status: 'voice_ready', video_public_url: null }]]]) });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /Render the video first/);
});

test('queueing creates a DRAFT social post -- it never publishes', async () => {
  const log = [];
  const r = res();
  await handleReelQueuePost(
    { body: { reelId: 'r1', surface: 'instagram' } }, r,
    {
      supabaseRequest: fakeSupabase([
        ['content_reels?id=eq.r1', [{
          id: 'r1', status: 'rendered', video_public_url: 'https://s/content-reels/video/r1.mp4',
          script: { caption: 'Furnace day', hashtags: ['#hvac', '#beforeandafter'] },
        }]],
        ['social_posts', (path, opts) => JSON.parse(opts.body).map((row) => ({ ...row, id: 'post1' }))],
        ['content_reels?id=eq.r1&', [{ id: 'r1', status: 'queued', photo_ids: [], frame_assets: [] }]],
      ], log),
    });

  const created = log.find((c) => c.path.startsWith('social_posts') && c.method === 'POST');
  assert.equal(created.body[0].status, 'draft', 'queueing must never post');
  assert.equal(created.body[0].post_type, 'video');
  assert.equal(created.body[0].content.mediaUrl, 'https://s/content-reels/video/r1.mp4');
  assert.equal(created.body[0].content.text, 'Furnace day\n\n#hvac #beforeandafter');
  assert.equal(r.body.socialPostId, 'post1');
});

test('an unknown surface is refused rather than defaulted to one that would post somewhere unintended', async () => {
  const r = res();
  await handleReelQueuePost({ body: { reelId: 'r1', surface: 'linkedin' } }, r, {});
  assert.equal(r.statusCode, 400);
});

test('the video upload endpoint refuses anything that is not a real video type', async () => {
  const r = res();
  await handleReelVideoPost({ body: { reelId: 'r1', contentType: 'text/html', dataBase64: 'AAA' } }, r, {});
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /contentType must be/);
});

test('the video upload endpoint refuses a file too large to store', async () => {
  const r = res();
  await handleReelVideoPost({ body: { reelId: 'r1', contentType: 'video/mp4', dataBase64: 'A'.repeat(61 * 1024 * 1024) } }, r, {});
  assert.equal(r.statusCode, 413);
});

test('a script cannot be written for a reel that has no frames', async () => {
  const r = res();
  await handleReelScriptPost(
    { body: { reelId: 'r1' } }, r,
    {
      anthropic: { messages: { create: async () => ({ content: [] }) } },
      supabaseRequest: fakeSupabase([['content_reels?id=eq.r1', [{ id: 'r1', photo_ids: [], frame_assets: [] }]]]),
    });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /no frames yet/);
});
