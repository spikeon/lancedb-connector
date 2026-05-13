import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";
import type { AuthUser } from "./types.js";

dotenv.config();

const RoleSchema = z.enum(["read", "write", "admin"]);

const UserEntrySchema = z
  .object({
    username: z.string().min(1),
    /** Dev-only; compared with timing-safe equality (no bcrypt). Not for production. */
    password: z.string().optional(),
    /** bcrypt hash (`$2a$`, `$2b$`, …). Preferred for production. */
    passwordHash: z.string().optional(),
    roles: z.array(RoleSchema).default(["read"]),
  })
  .superRefine((u, ctx) => {
    if (!u.password && !u.passwordHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each user needs either password (dev) or passwordHash",
      });
    }
    if (u.password && u.passwordHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Specify only one of password or passwordHash per user",
      });
    }
  });

const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.coerce.number().int().positive().default(3030),
    })
    .default({ host: "0.0.0.0", port: 3030 }),
  lancedb: z.object({
    uri: z.string().min(1),
  }),
  auth: z
    .object({
      enabled: z.boolean().default(false),
      /** When auth is enabled, allow Swagger UI + raw OpenAPI JSON without credentials. */
      exposeDocsWithoutAuth: z.boolean().default(false),
      users: z.array(UserEntrySchema).default([]),
    })
    .default({ enabled: false, exposeDocsWithoutAuth: false, users: [] }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type UserEntry = z.infer<typeof UserEntrySchema>;

function readConfigFile(explicit?: string): unknown | undefined {
  const p =
    explicit ??
    process.env.CONNECTOR_CONFIG_PATH ??
    path.resolve(process.cwd(), "config.yaml");
  if (!fs.existsSync(p)) return undefined;
  const raw = fs.readFileSync(p, "utf8");
  return YAML.parse(raw);
}

function envOverrides(base: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  if (process.env.LANCEDB_URI) {
    out.lancedb = { ...(out.lancedb as object), uri: process.env.LANCEDB_URI };
  }
  if (process.env.PORT) {
    out.server = {
      ...(out.server as object),
      port: Number(process.env.PORT),
    };
  }
  if (process.env.HOST) {
    out.server = { ...(out.server as object), host: process.env.HOST };
  }
  if (process.env.AUTH_ENABLED === "true" || process.env.AUTH_ENABLED === "1") {
    out.auth = { ...(out.auth as object), enabled: true };
  }
  return out;
}

export function loadConfig(): AppConfig {
  const fileData = readConfigFile();
  const merged = envOverrides(
    fileData && typeof fileData === "object"
      ? { ...(fileData as object) }
      : {
          server: {},
          lancedb: {
            uri:
              process.env.LANCEDB_URI ??
              path.resolve(process.cwd(), "data", "lancedb"),
          },
          auth: { enabled: false, users: [] },
        },
  );
  return ConfigSchema.parse(merged);
}

export async function resolveAuthUsers(config: AppConfig): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  for (const u of config.auth.users) {
    if (u.passwordHash) {
      const hash = u.passwordHash;
      users.push({
        username: u.username,
        roles: u.roles,
        verifyPassword: (plain: string) => bcrypt.compare(plain, hash),
      });
      continue;
    }
    if (u.password !== undefined) {
      const secret = u.password;
      users.push({
        username: u.username,
        roles: u.roles,
        verifyPassword: async (plain: string) => {
          try {
            const a = Buffer.from(plain, "utf8");
            const b = Buffer.from(secret, "utf8");
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
          } catch {
            return false;
          }
        },
      });
    }
  }
  return users;
}
