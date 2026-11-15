// AI captions: turns a few words into a ready-to-post WhatsApp message.
// Off until ANTHROPIC_API_KEY is set.

import Anthropic from '@anthropic-ai/sdk';

const TONES = { friendly: 'warm and friendly', professional: 'clear and professional', excited: 'upbeat and energetic', short: 'as short as possible' };
export const AI_TONES = Object.keys(TONES);

export function createCaptioner({ apiKey, model = 'claude-opus-5-5', client } = {}) {
  if (!apiKey && !client) return null;
  client ??= new Anthropic({ apiKey });
  return async function caption({ prompt, tone = 'friendly' }) {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: 'You write posts for WhatsApp groups, channels and Status. Reply with the post text only: no preamble, no quotes, no options to choose from. '
          + 'Keep it under 600 characters. Use WhatsApp formatting sparingly (*bold*, _italic_). Keep any links, prices, dates and names exactly as given. Write in the language of the request.',
        messages: [{ role: 'user', content: `Tone: ${TONES[tone] ?? TONES.friendly}.\n\nWrite a post about:\n${prompt}` }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw Object.assign(new Error('The AI writer is busy — try again in a minute'), { status: 429 });
      if (err instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('The AI writer is not set up correctly'), { status: 503 });
      if (err instanceof Anthropic.APIError) throw Object.assign(new Error('The AI writer is unavailable right now'), { status: 502 });
      throw err;
    }
    if (response.stop_reason === 'refusal') throw Object.assign(new Error('The AI writer can’t help with that request'), { status: 400 });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw Object.assign(new Error('The AI writer returned nothing — try rewording it'), { status: 502 });
    return text;
  };
}
