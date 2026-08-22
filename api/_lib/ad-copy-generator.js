// api/_lib/ad-copy-generator.js
// AI ad-copy generation grounded only in real business facts (see
// api/_lib/ad-copy-grounding.js). Mirrors the same real-facts-only prompt
// discipline api/marketing.js already uses for its own email campaign copy
// (handleCampaignRegenerateCopyPost) -- never invent a number, review, or
// claim that is not present in the facts object passed in.

import Anthropic from '@anthropic-ai/sdk';

const anthropicAds = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function isAdCopyGenerationConfigured(opts = {}) {
  return !!(opts.anthropic || anthropicAds);
}

export async function generateAdCopy({ platform, objective, division, divisionFacts, territoryFacts }, opts = {}) {
  const anthropic = opts.anthropic || anthropicAds;
  if (!anthropic) {
    const err = new Error('ANTHROPIC_API_KEY is not set for this deployment -- cannot generate AI ad copy yet.');
    err.notConfigured = true;
    throw err;
  }
  const realFacts = { platform, objective, division, divisionFacts, territoryFacts };
  const factsText = JSON.stringify(realFacts, null, 2);
  const prompt = 'You are drafting ad copy for a home services company\'s ' + platform + ' ' + objective + ' campaign in the ' + division + ' division. ' +
    'Use ONLY the real facts below -- never invent a statistic, review count, price, or claim that is not present. ' +
    'If a fact is null (for example avgJobValueCents), do not reference it or guess a number for it. ' +
    'Do not name the company (its name is not in these facts) -- write copy that works with any business name inserted afterward. ' +
    'Keep the headline under 40 characters, primary text under 125 characters, description under 30 characters (standard ad-platform limits).\n\n' +
    'Facts:\n' + factsText + '\n\n' +
    'Return ONLY a JSON object with exactly four string keys: "headline", "primaryText", "description", "cta" -- no other text, no markdown code fences.';

  const resp = await anthropic.messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-5',
    max_tokens: 500,
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
  const requiredKeys = ['headline', 'primaryText', 'description', 'cta'];
  for (const k of requiredKeys) {
    if (!parsed || typeof parsed[k] !== 'string') {
      const err = new Error('AI response was missing required field "' + k + '" -- try again.');
      err.badResponse = true;
      throw err;
    }
  }
  return { headline: parsed.headline, primaryText: parsed.primaryText, description: parsed.description, cta: parsed.cta };
}
