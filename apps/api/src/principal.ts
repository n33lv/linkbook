import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';

// §5.8 rule 2: ALL authentication and authorization flows go through a
// single accessor. Today it returns the signed-in Google user (single-user
// v1, §5.5). Tomorrow it can return a (tenant_id, user_id, role) tuple.
//
// No SQL filter is hardcoded against "the" user. Every route that needs
// caller identity asks this function.
//
// In dev we hard-code the principal from env so we don't need real OAuth
// for the inner loop. In prod, this will read from a session cookie /
// JWT / etc. — the call sites don't change.

export type Principal = {
  // future: tenant_id
  user_id: string; // currently the email — opaque from the caller's POV
  email: string;
  name: string;
};

export function currentPrincipal(_req: FastifyRequest, cfg: AppConfig): Principal {
  // TODO(auth): replace with real session lookup once Google SSO lands.
  return {
    user_id: cfg.DEV_PRINCIPAL_EMAIL,
    email: cfg.DEV_PRINCIPAL_EMAIL,
    name: cfg.DEV_PRINCIPAL_NAME,
  };
}
