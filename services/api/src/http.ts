/**
 * MODULE: services/api/src/http
 *
 * PURPOSE
 *   Tiny HTTP error type plus a Fastify error handler. Route handlers throw
 *   `HttpError` instead of calling `reply.code()` so the policy helpers can
 *   stay sync-looking (`throw notFound()`) and still produce a consistent
 *   JSON envelope.
 *
 * INPUTS  : status + message
 * OUTPUTS : thrown errors that the error handler serialises
 */

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unavailable = (message: string) => new HttpError(503, message);
