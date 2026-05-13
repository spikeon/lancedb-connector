import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "./types.js";

function parseBasicAuth(header: string | undefined): {
  user: string;
  pass: string;
} | null {
  if (!header?.startsWith("Basic ")) return null;
  const b64 = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  return {
    user: decoded.slice(0, idx),
    pass: decoded.slice(idx + 1),
  };
}

export async function authenticateRequest(
  request: FastifyRequest,
  users: AuthUser[],
): Promise<{ username: string; roles: import("./types.js").Role[] }> {
  const parsed = parseBasicAuth(request.headers.authorization);
  if (!parsed) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  const account = users.find((u) => u.username === parsed.user);
  if (!account) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  const ok = await account.verifyPassword(parsed.pass);
  if (!ok) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  return { username: account.username, roles: account.roles };
}

export async function sendUnauthorized(reply: FastifyReply): Promise<void> {
  await reply
    .header("WWW-Authenticate", 'Basic realm="LanceDB Connector"')
    .code(401)
    .send({ error: "Unauthorized", detail: "Valid Basic credentials required" });
}
