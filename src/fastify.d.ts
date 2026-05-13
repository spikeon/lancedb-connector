import type { Role } from "./types.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Minimum role when `auth.enabled` is true. Defaults to `read`. */
    minRole?: Role;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: { username: string; roles: Role[] };
  }
}
