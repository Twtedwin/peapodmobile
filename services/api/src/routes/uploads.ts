/**
 * MODULE: services/api/src/routes/uploads
 *
 * PURPOSE
 *   Presign a PUT to object storage for avatars and memory photos. When S3
 *   is not configured the route returns 503 pointing at SETUP-EXTERNAL-APIS.md
 *   rather than pretending the upload succeeded.
 *
 * INPUTS  : `{ filename, content_type }`
 * OUTPUTS : `{ url, method, headers, public_url, key }`
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unavailable } from '../http.js';
import { isStorageConfigured, presignPut } from '../services/storage.js';
import { parseBody } from './helpers.js';

const SAFE_NAME = /[^a-zA-Z0-9._-]+/g;

export async function registerUploads(app: FastifyInstance): Promise<void> {
  app.post('/uploads/presign', async (request) => {
    if (!isStorageConfigured()) {
      throw unavailable(
        'Object storage is not configured. Avatars and memory photos need an S3-compatible bucket. See SETUP-EXTERNAL-APIS.md for how to provision one; until then the app keeps its placeholder images.',
      );
    }
    const body = parseBody(
      z.object({
        filename: z.string().min(1).max(200),
        content_type: z.string().min(1).default('application/octet-stream'),
        prefix: z.string().optional(),
      }),
      request.body,
    );
    const safe = body.filename.replace(SAFE_NAME, '_');
    const prefix = (body.prefix ?? 'uploads').replace(/^\/+|\/+$/g, '');
    const key = `${prefix}/${request.user.id}/${randomUUID()}-${safe}`;
    const signed = presignPut(key, body.content_type ?? 'application/octet-stream');
    return { ...signed, key };
  });
}
