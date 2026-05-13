import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { getConnection } from "./lancedb-connection.js";
import {
  HttpError,
  addRows,
  createTable,
  deleteRows,
  dropTable,
  listTables,
  openTable,
  scanQuery,
  tableSchema,
  vectorSearch,
} from "./lancedb-ops.js";

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const conn = await getConnection(config);

  const mcp = new McpServer(
    {
      name: "lancedb-connector",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Tools operate on the LanceDB URI from connector config (CONNECTOR_CONFIG_PATH / config.yaml or env). MCP shares the API server's database path but bypasses HTTP Basic auth — run only on trusted hosts.",
    },
  );

  mcp.registerTool(
    "list_tables",
    {
      description: "List all LanceDB table names in the configured database.",
    },
    async () => {
      try {
        const tables = await listTables(conn);
        return jsonResult({ tables });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "create_table",
    {
      description:
        "Create a LanceDB table from non-empty row objects (schema is inferred).",
      inputSchema: {
        name: z.string(),
        data: z.array(z.record(z.string(), z.unknown())),
        mode: z.enum(["create", "overwrite"]).optional(),
        existOk: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const created = await createTable(conn, {
          name: args.name,
          data: args.data as Record<string, unknown>[],
          mode: args.mode,
          existOk: args.existOk,
        });
        return jsonResult(created);
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "drop_table",
    {
      description:
        "Drop a table permanently (same as HTTP admin-only DELETE /v1/tables/:name).",
      inputSchema: {
        name: z.string(),
      },
    },
    async (args) => {
      try {
        await dropTable(conn, args.name);
        return jsonResult({ dropped: args.name });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "describe_table",
    {
      description: "Return Arrow-style field names and types.",
      inputSchema: { name: z.string() },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const schema = await tableSchema(table);
        return jsonResult(schema);
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "table_row_count",
    {
      description: "Count rows; optional Lance filter expression.",
      inputSchema: {
        name: z.string(),
        filter: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const rowCount = await table.countRows(args.filter);
        return jsonResult({ rowCount });
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "add_rows",
    {
      description: "Insert or append rows into a table.",
      inputSchema: {
        name: z.string(),
        rows: z.array(z.record(z.string(), z.unknown())),
        mode: z.enum(["append", "overwrite"]).optional(),
      },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const v = await addRows(
          table,
          args.rows as Record<string, unknown>[],
          args.mode,
        );
        return jsonResult(v);
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "delete_rows",
    {
      description: "Delete rows using a Lance SQL-like predicate.",
      inputSchema: {
        name: z.string(),
        where: z.string(),
      },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const res = await deleteRows(table, args.where);
        return jsonResult(res);
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "vector_search",
    {
      description: "Nearest-neighbor vector search via LanceDB.",
      inputSchema: {
        name: z.string(),
        vector: z.array(z.number()),
        limit: z.number().optional(),
        columns: z.array(z.string()).optional(),
        where: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const results = await vectorSearch(table, {
          vector: args.vector,
          limit: args.limit,
          columns: args.columns,
          where: args.where,
        });
        return jsonResult({ results });
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  mcp.registerTool(
    "scan_query",
    {
      description:
        "Scan rows with optional filter (`where`), projection (`columns`), and `limit`.",
      inputSchema: {
        name: z.string(),
        limit: z.number().optional(),
        where: z.string().optional(),
        columns: z
          .union([z.array(z.string()), z.record(z.string(), z.string())])
          .optional(),
      },
    },
    async (args) => {
      try {
        const table = await openTable(conn, args.name);
        const rows = await scanQuery(table, {
          limit: args.limit,
          where: args.where,
          columns: args.columns as string[] | Record<string, string> | undefined,
        });
        return jsonResult({ rows });
      } catch (e) {
        if (e instanceof HttpError) return errorResult(e.message);
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
