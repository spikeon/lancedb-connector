import type { Connection, Table } from "@lancedb/lancedb";
import type { Role } from "./types.js";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function requireRole(userRoles: Role[], need: Role): void {
  const set = new Set(userRoles);
  if (set.has("admin")) return;
  if (need === "read" && (set.has("read") || set.has("write"))) return;
  if (need === "write" && set.has("write")) return;
  throw new HttpError(403, `Missing required role: ${need}`);
}

export async function listTables(conn: Connection): Promise<string[]> {
  return conn.tableNames();
}

export async function createTable(
  conn: Connection,
  params: {
    name: string;
    data: Record<string, unknown>[];
    mode?: "create" | "overwrite";
    existOk?: boolean;
  },
): Promise<{ name: string }> {
  const { name, data } = params;
  if (!data.length) {
    throw new HttpError(400, "data must be a non-empty array of rows");
  }
  await conn.createTable(name, data, {
    mode: params.mode ?? "create",
    existOk: params.existOk ?? false,
  });
  return { name };
}

export async function dropTable(conn: Connection, name: string): Promise<void> {
  await conn.dropTable(name);
}

export async function openTable(conn: Connection, name: string): Promise<Table> {
  try {
    return await conn.openTable(name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(404, `Table not found or unreadable: ${name} (${msg})`);
  }
}

export async function tableSchema(table: Table): Promise<{
  fields: Array<{ name: string; type: string }>;
}> {
  const schema = await table.schema();
  return {
    fields: schema.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
    })),
  };
}

export async function addRows(
  table: Table,
  rows: Record<string, unknown>[],
  mode?: "append" | "overwrite",
): Promise<{ version: number }> {
  if (!rows.length) throw new HttpError(400, "rows must be non-empty");
  const result = await table.add(rows, { mode: mode ?? "append" });
  return { version: result.version };
}

export async function deleteRows(
  table: Table,
  where: string,
): Promise<{ removed: number }> {
  const result = await table.delete(where);
  return { removed: result.numDeletedRows };
}

export async function vectorSearch(
  table: Table,
  params: {
    vector: number[];
    limit?: number;
    columns?: string[];
    where?: string;
  },
): Promise<unknown[]> {
  let q = table.vectorSearch(params.vector);
  if (params.where) q = q.where(params.where);
  if (params.columns?.length) q = q.select(params.columns);
  const limit = params.limit ?? 10;
  return q.limit(limit).toArray();
}

export async function scanQuery(
  table: Table,
  params: {
    limit?: number;
    columns?: string[] | Record<string, string>;
    where?: string;
  },
): Promise<unknown[]> {
  let q = table.query();
  if (params.where) q = q.where(params.where);
  if (params.columns) q = q.select(params.columns);
  const limit = params.limit ?? 100;
  return q.limit(limit).toArray();
}

export async function upsertRows(
  table: Table,
  params: { on: string | string[]; rows: Record<string, unknown>[] },
): Promise<{ version: number }> {
  if (!params.rows.length) throw new HttpError(400, "rows must be non-empty");
  const result = await table
    .mergeInsert(params.on)
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(params.rows);
  return { version: result.version };
}

