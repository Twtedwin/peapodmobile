/**
 * MODULE: services/api/src/services/storage
 *
 * PURPOSE
 *   Presign an S3 PUT URL using AWS Signature Version 4 and `node:crypto`
 *   only. There is no AWS SDK in this service: presigning is ~60 lines of
 *   HMAC, and the SDK would add tens of megabytes to the image for that
 *   one function.
 *
 * INPUTS  : object key, content type
 * OUTPUTS : a time-limited PUT URL, or null when S3 is not configured
 *
 * WHEN UNSET
 *   The upload route returns 503 and points at SETUP-EXTERNAL-APIS.md.
 *   Placeholder images stay in the app until an operator provisions a bucket.
 */

import { createHash, createHmac } from 'node:crypto';
import { env } from '../env.js';

const PRESIGN_TTL_SECONDS = 900;

export function isStorageConfigured(): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET);
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function amzDate(date: Date): { date: string; datetime: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { date: iso.slice(0, 8), datetime: iso };
}

/**
 * Build a SigV4 query-string-authenticated PUT URL.
 *
 * UNSIGNED-PAYLOAD is used because the client streams the bytes directly
 * to the bucket; we cannot hash a body we have not seen.
 */
export function presignPut(key: string, contentType: string): { url: string; method: 'PUT'; headers: Record<string, string>; public_url: string } {
  if (!isStorageConfigured()) {
    throw new Error('Object storage is not configured');
  }

  const endpoint = env.S3_ENDPOINT!.replace(/\/$/, '');
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION || 'auto';
  const accessKey = env.S3_ACCESS_KEY_ID!;
  const secretKey = env.S3_SECRET_ACCESS_KEY!;

  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const host = new URL(endpoint).host;
  const path = `/${bucket}/${encodedKey}`;
  const now = new Date();
  const { date, datetime } = amzDate(now);
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': datetime,
    'X-Amz-Expires': String(PRESIGN_TTL_SECONDS),
    'X-Amz-SignedHeaders': 'content-type;host',
  };

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join('&');

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    'PUT',
    path,
    canonicalQuery,
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const url = `${endpoint}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  const publicBase = (env.S3_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`).replace(/\/$/, '');
  const public_url = `${publicBase}/${encodedKey}`;

  return {
    url,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    public_url,
  };
}
