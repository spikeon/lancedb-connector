import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "./config.js";
import { getConnection } from "./lancedb-connection.js";
import {
  HttpError,
  addRows,
  createTable,
  deleteRows,
  dropTable,
  listTables,
  openTable,
  requireRole,
  scanQuery,
  tableSchema,
  vectorSearch,
} from "./lancedb-ops.js";
import { authenticateRequest, sendUnauthorized } from "./auth-http.js";
import type { AuthUser } from "./types.js";

export async function buildServer(
  config: AppConfig,
  authUsers: AuthUser[],
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "LanceDB Connector API",
        description:
          "REST facade over LanceDB OSS. Uses Lance column-oriented filters (SQL-like strings). Vector search expects a numeric embedding column as configured in your table.",
        version: "1.0.0",
      },
      servers: [{ url: "/" }],
      tags: [
        { name: "health", description: "Process readiness" },
        { name: "tables", description: "Table lifecycle and metadata" },
        { name: "data", description: "Rows and queries" },
      ],
      components: {
        securitySchemes: {
          basicAuth: {
            type: "http",
            scheme: "basic",
            description:
              "HTTP Basic authentication when `auth.enabled` is true in config.yaml.",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  const authEnabled = config.auth.enabled;

  app.addHook("preHandler", async (request, reply) => {
    if (!authEnabled) return;
    const path = request.url.split("?")[0] ?? "";
    if (path === "/health") return;
    if (config.auth.exposeDocsWithoutAuth && path.startsWith("/documentation"))
      return;

    try {
      request.authUser = await authenticateRequest(request, authUsers);
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "statusCode" in e
          ? (e as { statusCode: number }).statusCode
          : 401;
      if (code === 401) await sendUnauthorized(reply);
      else await reply.code(500).send({ error: "Auth failure", detail: String(e) });
      return;
    }

    const minRole = request.routeOptions.config?.minRole ?? "read";
    try {
      requireRole(request.authUser!.roles, minRole);
    } catch (err) {
      if (err instanceof HttpError) {
        await reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    request.log.error(error);
    void reply.code(500).send({ error: "Internal Server Error" });
  });

  app.get(
    "/health",
    {
      config: {},
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              lancedbUri: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      lancedbUri: config.lancedb.uri,
    }),
  );

  app.get(
    "/v1/tables",
    {
      config: { minRole: "read" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["tables"],
        summary: "List table names",
        response: {
          200: {
            type: "object",
            properties: {
              tables: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
    async () => {
      const conn = await getConnection(config);
      const tables = await listTables(conn);
      return { tables };
    },
  );

  app.post<{
    Body: {
      name: string;
      data: Record<string, unknown>[];
      mode?: "create" | "overwrite";
      existOk?: boolean;
    };
  }>(
    "/v1/tables",
    {
      config: { minRole: "write" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["tables"],
        summary: "Create a table from initial rows",
        body: {
          type: "object",
          required: ["name", "data"],
          properties: {
            name: { type: "string" },
            data: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            mode: { type: "string", enum: ["create", "overwrite"] },
            existOk: { type: "boolean" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const conn = await getConnection(config);
      const result = await createTable(conn, request.body);
      void reply.code(201);
      return result;
    },
  );

  app.delete<{
    Params: { name: string };
  }>(
    "/v1/tables/:name",
    {
      config: { minRole: "admin" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["tables"],
        summary: "Drop a table",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        response: {
          204: { description: "Table removed" },
        },
      },
    },
    async (request, reply) => {
      const conn = await getConnection(config);
      await dropTable(conn, request.params.name);
      void reply.code(204);
    },
  );

  app.get<{
    Params: { name: string };
  }>(
    "/v1/tables/:name/schema",
    {
      config: { minRole: "read" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["tables"],
        summary: "Inspect Arrow schema",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      return tableSchema(table);
    },
  );

  app.get<{
    Params: { name: string };
  }>(
    "/v1/tables/:name/stats",
    {
      config: { minRole: "read" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["tables"],
        summary: "Row counts (optional filter uses Lance `countRows`)",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        querystring: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "Optional SQL-like predicate passed to countRows",
            },
          },
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      const filter = (request.query as { filter?: string }).filter;
      const rowCount = await table.countRows(filter);
      return { rowCount };
    },
  );

  app.post<{
    Params: { name: string };
    Body: {
      rows: Record<string, unknown>[];
      mode?: "append" | "overwrite";
    };
  }>(
    "/v1/tables/:name/rows",
    {
      config: { minRole: "write" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["data"],
        summary: "Append or overwrite rows",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        body: {
          type: "object",
          required: ["rows"],
          properties: {
            rows: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            mode: { type: "string", enum: ["append", "overwrite"] },
          },
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      return addRows(table, request.body.rows, request.body.mode);
    },
  );

  app.delete<{
    Params: { name: string };
    Body: { where: string };
  }>(
    "/v1/tables/:name/rows",
    {
      config: { minRole: "write" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["data"],
        summary: "Delete rows matching a Lance filter expression",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        body: {
          type: "object",
          required: ["where"],
          properties: {
            where: {
              type: "string",
              description: `SQL-like predicate (example: id = 2 or label = 'spam')`,
            },
          },
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      return deleteRows(table, request.body.where);
    },
  );

  app.post<{
    Params: { name: string };
    Body: {
      vector: number[];
      limit?: number;
      columns?: string[];
      where?: string;
    };
  }>(
    "/v1/tables/:name/search",
    {
      config: { minRole: "read" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["data"],
        summary: "Vector similarity search",
        description:
          "Runs `table.vectorSearch`. Ensure your table contains a compatible vector column.",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        body: {
          type: "object",
          required: ["vector"],
          properties: {
            vector: { type: "array", items: { type: "number" } },
            limit: { type: "integer", minimum: 1, default: 10 },
            columns: { type: "array", items: { type: "string" } },
            where: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      return {
        results: await vectorSearch(table, request.body),
      };
    },
  );

  app.post<{
    Params: { name: string };
    Body: {
      limit?: number;
      columns?: string[] | Record<string, string>;
      where?: string;
    };
  }>(
    "/v1/tables/:name/query",
    {
      config: { minRole: "read" },
      schema: {
        security: [{ basicAuth: [] }],
        tags: ["data"],
        summary: "Scan / filter rows (`table.query`)",
        params: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        body: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, default: 100 },
            columns: {
              oneOf: [
                { type: "array", items: { type: "string" } },
                {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              ],
              description:
                "Column names or computed columns map (`{ alias: sqlExpr }`).",
            },
            where: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const conn = await getConnection(config);
      const table = await openTable(conn, request.params.name);
      return {
        rows: await scanQuery(table, request.body),
      };
    },
  );

  return app;
}
