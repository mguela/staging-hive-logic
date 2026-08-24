// api/_lib/reel-builder.js
// Turns real job photos into a narrated short-form vertical video.
//
// The pipeline, and which part is real vs. which part is a refusal:
//   1. selectReelCandidates  Real completed jobs that already carry enough
//                            real photos. No photo, no reel -- there is no
//                            stock-footage fallback anywhere in this file.
//   2. writeReelScript       Claude writes hook / per-photo beats / caption,
//                            grounded ONLY in the real job facts passed in,
//                            with the same never-invent-a-number discipline
//                            as api/_lib/ad-copy-generator.js.
//   3. renderReelVoiceover   A REAL spoken mp3, via the same OpenAI TTS call
//                            Reina's own voice already uses in production
//                            (api/reina-neural-speech.js). Not a stub.
//   4. (browser)             Frames + voiceover are assembled into the actual
//                            video client-side and posted back -- see
//                            public/reel-studio.js for why that lives in the
//                            browser and not here.
//
// PRIVACY RULE, and it is the reason several obvious fields are missing from
// the facts handed to the model: a reel is public marketing. No customer
// name, no address, no street, no invoice total, and no client id is ever
// passed into script generation or written into a caption. The script only
// ever knows what KIND of work was done and how many photos exist.

import Anthropic from '@anthropic-ai/sdk';
import { supabaseRequest as defaultSupabaseRequest } from './jobber.js';
import { fetchAllRows, jobDivision } from './ad-copy-grounding.js';
import { createNeuralSpeech } from '../reina-neural-speech.js';
import { storageUpload, storagePublicUrl } from './supabase-storage.js';

const anthropicReels = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const DAY_MS = 24 * 60 * 60 * 1000;
export const REEL_BUCKET = 'content-reels';
export const MEDIA_BUCKET = 'media';

// A 30-second vertical reel is roughly 75 spoken words. Beats are capped at
// 6 because more than that on a 30s clip gives each photo under 5 seconds,
// which reads as a slideshow rather than a story.
const MAX_BEATS = 6;
const MIN_PHOTOS = 4;

export function isReelScriptConfigured(opts = {}) {
  return !!(opts.anthropic || anthropicReels);
}

export function isReelVoiceConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------
// 1. Candidate selection
// ---------------------------------------------------------------------
// Real completed jobs from the last 180 days carrying at least `minPhotos`
// real photos, that do not already have a live reel. Sorted by photo count
// then recency -- the richest, freshest job makes the best video.
export async function selectReelCandidates(opts = {}, deps = {}) {
  const supabaseRequest = deps.supabaseRequest || defaultSupabaseRequest;
  const now = deps.now || new Date();
  const minPhotos = Number.isFinite(Number(opts.minPhotos)) ? Number(opts.minPhotos) : MIN_PHOTOS;
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 5;
  const cutoff = now.getTime() - 180 * DAY_MS;

  const [media, jobs, existingRes] = await Promise.all([
    fetchAllRows('media', '?select=id,job_id,job_uuid,storage_path,captured_at,media_type&job_id=not.is.null', supabaseRequest),
    fetchAllRows('jobs', '?select=jobber_id,uuid_id,title,completed_at&completed_at=not.is.null', supabaseRequest),
    supabaseRequest('content_reels?select=job_id&status=neq.rejected'),
  ]);
  if (!existingRes.ok) throw new Error('Failed to read content_reels: ' + (await existingRes.text()));
  const alreadyReeled = new Set((await existingRes.json()).map((r) => String(r.job_id)));

  const jobById = new Map(jobs.map((j) => [String(j.jobber_id), j]));

  const photosByJob = new Map();
  for (const m of media) {
    if (m.media_type && m.media_type !== 'photo' && m.media_type !== 'image') continue;
    if (!m.storage_path) continue;
    const t = m.captured_at ? new Date(m.captured_at).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = String(m.job_id);
    if (!jobById.has(key) || alreadyReeled.has(key)) continue;
    if (!photosByJob.has(key)) photosByJob.set(key, []);
    photosByJob.get(key).push({ id: m.id, storagePath: m.storage_path, capturedAt: m.captured_at, jobUuid: m.job_uuid });
  }

  const candidates = [];
  for (const [jobId, photos] of photosByJob) {
    if (photos.length < minPhotos) continue;
    const job = jobById.get(jobId);
    // Chronological order IS the before-and-after story: the first photo of
    // the day is the "before", the last is the "after". Sorting by capture
    // time is what makes that true rather than assumed.
    photos.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    candidates.push({
      jobId,
      jobUuid: job.uuid_id || photos[0].jobUuid || null,
      title: job.title || '',
      division: jobDivision(job.title),
      completedAt: job.completed_at,
      photoCount: photos.length,
      photos,
    });
  }

  candidates.sort((a, b) => {
    if (b.photoCount !== a.photoCount) return b.photoCount - a.photoCount;
    return new Date(b.completedAt) - new Date(a.completedAt);
  });
  return candidates.slice(0, limit);
}

// Picks the frames for the reel out of a candidate's full photo set: always
// the first and last (the before and the after), plus an even spread of the
// middle so the story covers the whole job rather than its first five minutes.
export function chooseReelFrames(photos, maxBeats = MAX_BEATS) {
  if (photos.length <= maxBeats) return photos.slice();
  const chosen = [photos[0]];
  const innerCount = maxBeats - 2;
  const step = (photos.length - 2) / (innerCount + 1);
  for (let i = 1; i <= innerCount; i++) {
    chosen.push(photos[Math.min(photos.length - 2, Math.round(i * step))]);
  }
  chosen.push(photos[photos.length - 1]);
  return chosen;
}

// ---------------------------------------------------------------------
// 2. Script
// ---------------------------------------------------------------------
export async function writeReelScript({ division, jobTitle, frameCount, territoryFacts }, deps = {}) {
  const anthropic = deps.anthropic || anthropicReels;
  if (!anthropic) {
    const err = new Error('ANTHROPIC_API_KEY is not set for this deployment -- cannot write a reel script yet.');
    err.notConfigured = true;
    throw err;
  }
  // Everything the model is allowed to know. Note what is absent: no customer
  // name, no address, no price. See the privacy rule in the file header.
  const facts = {
    tradeDivision: division,
    workDescription: jobTitle,
    numberOfPhotos: frameCount,
    serviceAreaAvgDistanceMiles: territoryFacts ? territoryFacts.avgDistanceMiles : null,
  };
  const prompt = 'You are writing a ' + frameCount + '-shot vertical short-form video (TikTok / Instagram Reel) for a home services company, ' +
    'built from real before-and-after photos of one real job.\n\n' +
    'Use ONLY the real facts below. Never invent a price, a statistic, a review, a timeframe, or a customer detail. ' +
    'Never name or describe the customer, their house, or their street -- this is public marketing about the WORK, not the client. ' +
    'Do not name the company; its name is added afterwards.\n\n' +
    'The photos are in chronological order, so shot 1 is the earliest (the "before") and shot ' + frameCount + ' is the latest (the "after").\n\n' +
    'Facts:\n' + JSON.stringify(facts, null, 2) + '\n\n' +
    'Write:\n' +
    '- "hook": the first line spoken and shown on screen. Under 60 characters. It must earn a stranger stopping their scroll.\n' +
    '- "beats": exactly ' + frameCount + ' objects, one per shot, each with "onScreenText" (under 40 characters) and "say" (one spoken sentence, under 20 words, conversational).\n' +
    '- "caption": the post caption, under 200 characters.\n' +
    '- "hashtags": 3 to 6 relevant hashtag strings, each starting with #.\n\n' +
    'Total spoken words across hook + all beats must be under 90 so the finished video stays around 30 seconds.\n\n' +
    'Return ONLY a JSON object with exactly these four keys -- no other text, no markdown code fences.';

  const resp = await anthropic.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error('AI response was not valid JSON -- try again.');
    err.badResponse = true;
    throw err;
  }
  if (!parsed || typeof parsed.hook !== 'string' || typeof parsed.caption !== 'string'
    || !Array.isArray(parsed.beats) || !Array.isArray(parsed.hashtags)) {
    const err = new Error('AI response was missing hook, beats, caption, or hashtags -- try again.');
    err.badResponse = true;
    throw err;
  }
  // The model is asked for exactly frameCount beats. Trusting it would let a
  // short response silently drop the "after" shot, so the count is enforced
  // here rather than hoped for.
  if (parsed.beats.length !== frameCount) {
    const err = new Error('AI returned ' + parsed.beats.length + ' beats for ' + frameCount + ' shots -- try again.');
    err.badResponse = true;
    throw err;
  }
  for (const b of parsed.beats) {
    if (!b || typeof b.onScreenText !== 'string' || typeof b.say !== 'string') {
      const err = new Error('AI returned a beat without onScreenText and say -- try again.');
      err.badResponse = true;
      throw err;
    }
  }
  return {
    hook: parsed.hook.trim(),
    beats: parsed.beats.map((b) => ({ onScreenText: b.onScreenText.trim(), say: b.say.trim() })),
    caption: parsed.caption.trim(),
    hashtags: parsed.hashtags.filter((h) => typeof h === 'string').map((h) => h.trim()),
  };
}

// The single narration string, assembled from the script in playback order.
// Kept as its own exported function because the browser renderer needs the
// exact same ordering to line captions up with the audio.
export function narrationText(script) {
  const lines = [script.hook, ...script.beats.map((b) => b.say)];
  return lines.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------
// 3. Voiceover -- a real spoken mp3, not a placeholder
// ---------------------------------------------------------------------
export async function renderReelVoiceover({ reelId, script, voice }, deps = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is not set for this deployment -- cannot record a voiceover yet.');
    err.notConfigured = true;
    throw err;
  }
  const speak = deps.createNeuralSpeech || createNeuralSpeech;
  const result = await speak({ text: narrationText(script), voice: voice || 'nova', apiKey, fetchImpl: deps.fetchImpl || fetch });
  if (!result || !result.ok) {
    const err = new Error('Voice generation was unavailable (' + ((result && result.code) || 'unknown') + ').');
    err.upstream = true;
    throw err;
  }
  // createNeuralSpeech returns { ok, bytes } -- a Buffer of real mp3.
  const bytes = result.bytes;
  if (!bytes || !bytes.length) throw new Error('Voice generation returned no audio.');

  const path = 'voice/' + reelId + '.mp3';
  const upload = deps.storageUpload || storageUpload;
  await upload(REEL_BUCKET, path, bytes, 'audio/mpeg', deps);
  return { path, publicUrl: storagePublicUrl(REEL_BUCKET, path), voice: voice || 'nova' };
}
