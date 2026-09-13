/**
 * MODULE: services/api/src/types
 *
 * PURPOSE
 *   Shared TypeScript shapes used across plugins and routes. Kept tiny on
 *   purpose -- domain records live in `@peapod/shared`, not here.
 *
 * INPUTS  : none
 * OUTPUTS : the authenticated principal decorated onto every request
 */

/**
 * The verified caller, as attached by `src/auth/plugin.ts`.
 *
 * `id` is `users.id`. `role` is the PLATFORM role (`admin` | `user`), never
 * the per-pod Seed/member role -- those live on `pod_memberships` and are
 * resolved live by `src/policy/rls.ts`.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
  display_name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth preHandler on every non-public route. */
    user: AuthUser;
  }
}
