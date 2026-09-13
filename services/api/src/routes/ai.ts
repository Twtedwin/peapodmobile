/**
 * MODULE: services/api/src/routes/ai
 *
 * PURPOSE
 *   Work It Out compromise proposals. If an LLM key is configured we ask
 *   the provider; otherwise (and on any provider failure) we use
 *   `compromiseSuggestions` from `@peapod/shared` so the screen still
 *   offers three specific, actionable options.
 *
 * INPUTS  : an idea-shaped body (`duration_days`, `compromise_options`, ...)
 * OUTPUTS : `{ suggestions, source: 'llm' | 'fallback' }`
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compromiseSuggestions } from '@peapod/shared';
import { env } from '../env.js';
import { parseBody } from './helpers.js';

const ideaShape = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  duration_days: z.number().int().nullable().optional(),
  compromise_options: z.array(z.string()).nullable().optional(),
  destination: z.string().nullable().optional(),
});

export async function registerAi(app: FastifyInstance): Promise<void> {
  app.post('/ai/compromise', async (request) => {
    const body = parseBody(ideaShape, request.body);
    const fallback = compromiseSuggestions({
      duration_days: body.duration_days,
      compromise_options: body.compromise_options,
    });

    if (!env.LLM_API_KEY || env.LLM_PROVIDER === 'none') {
      return { suggestions: fallback, source: 'fallback' as const };
    }

    try {
      const suggestions = await askProvider(body);
      if (suggestions.length === 0) return { suggestions: fallback, source: 'fallback' as const };
      return { suggestions: suggestions.slice(0, 3), source: 'llm' as const };
    } catch {
      return { suggestions: fallback, source: 'fallback' as const };
    }
  });
}

async function askProvider(idea: z.infer<typeof ideaShape>): Promise<string[]> {
  const model = env.LLM_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'You help a small group find a compromise on a shared plan. Reply with JSON: {"suggestions":["...","...","..."]} -- at most three short, specific, actionable options. No preamble.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: idea.title,
            description: idea.description,
            duration_days: idea.duration_days,
            destination: idea.destination,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`llm ${response.status}`);
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) return [];
  return parsed.suggestions.filter((item): item is string => typeof item === 'string');
}
