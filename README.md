# LanceDB Connector (TypeScript)

Small **[Fastify](https://fastify.dev/)** service plus an **[MCP](https://modelcontextprotocol.io/)** stdio server that wrap **[LanceDB OSS](https://lancedb.github.io/lancedb/)** (`@lancedb/lancedb`). Use plain HTTP + JSON from Go, Rust, or any language, or expose the same capabilities to MCP-aware clients.

## Features

- **REST API** under `/v1/*` for listing tables, creating tables, inserting rows, deleting by predicate, vector search, and Lance SQL-like filters.
- **Interactive OpenAPI 3** at [`/documentation`](http://localhost:3030/documentation) (Swagger UI) and machine-readable spec at **`/documentation/json`**.
- **Optional HTTP Basic auth** with YAML-defined users and **`read` / `write` / `admin`** roles (admin required for dropping tables).
- **MCP tools** mirroring the core operations (stdio transport; shares the configured LanceDB URI).

## Requirements

- Node.js **20+**
- Native LanceDB bindings ship with `@lancedb/lancedb` for Linux x86_64/aarch64, macOS, and Windows as published by the package.

## Quick start

```bash
npm ci
npm run build
cp config.example.yaml config.yaml   # optional
LANCEDB_URI=./data/lancedb npm start
```

Development with reload:

```bash
npm run dev
```

Defaults if **`config.yaml` is missing**: `LANCEDB_URI` env var, else `./data/lancedb` under the current working directory; server listens on **`0.0.0.0:3030`** (override with `HOST` / `PORT`).

### Configuration

| Source | Purpose |
|--------|---------|
| `config.yaml` in cwd | Primary YAML configuration |
| `CONNECTOR_CONFIG_PATH` | Alternate path to YAML |
| `LANCEDB_URI` | Overrides `lancedb.uri` |
| `HOST`, `PORT` | Overrides server bind |
| `AUTH_ENABLED=true` | Forces `auth.enabled: true` |

See **`config.example.yaml`** for schema and commented samples.

### Roles

| Role | Access |
|------|--------|
| `read` | List tables, schema, stats, scan `query`, `search` |
| `write` | Everything read can do, plus create tables (except drop), append rows, delete rows |
| `admin` | Includes **`DELETE /v1/tables/:name`** |

Credentials use **HTTP Basic**. Prefer **`passwordHash`** (bcrypt) in YAML; plaintext **`password`** is supported for local development only (constant-time comparison, **not** bcrypt).

Generate a bcrypt hash:

```bash
node --input-type=module -e "import bcrypt from 'bcrypt'; console.log(bcrypt.hashSync('your-password', 10))"
```

### HTTP API overview

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/health` | *(none)* | Liveness; includes resolved Lance URI |
| GET | `/v1/tables` | read | List table names |
| POST | `/v1/tables` | write | Create table (`name`, `data[]`, optional `mode`, `existOk`) |
| DELETE | `/v1/tables/:name` | admin | Drop table |
| GET | `/v1/tables/:name/schema` | read | Arrow-style fields |
| GET | `/v1/tables/:name/stats` | read | `rowCount` via optional `?filter=` |
| POST | `/v1/tables/:name/rows` | write | Append rows (`rows`, optional `mode`) |
| DELETE | `/v1/tables/:name/rows` | write | Body `{ "where": "<Lance predicate>" }` |
| POST | `/v1/tables/:name/search` | read | Body `{ "vector": [...], "limit?", "columns?", "where?" }` |
| POST | `/v1/tables/:name/query` | read | Body `{ "limit?", "where?", "columns?" }` · wraps `table.query()` |

**Full request/response schemas** live in OpenAPI (`/documentation` and `/documentation/json`).

### Minimal Go client sketch

Use `encoding/json`, `net/http`, and Basic auth when enabled:

```go
req, _ := http.NewRequest(http.MethodGet, "http://localhost:3030/v1/tables", nil)
req.SetBasicAuth("readonly", "secret")
resp, err := http.DefaultClient.Do(req)
```

### MCP server

The MCP entrypoint loads the **same YAML/env configuration** as the HTTP server and opens LanceDB directly (it does **not** replay HTTP Basic headers — treat it as **trusted local access**).

```bash
CONNECTOR_CONFIG_PATH=/absolute/path/to/config.yaml node dist/mcp-server.js
```

**Cursor / Claude Desktop** (example):

```json
{
  "mcpServers": {
    "lancedb": {
      "command": "node",
      "args": ["/absolute/path/to/lancedb-connector/dist/mcp-server.js"],
      "cwd": "/absolute/path/to/lancedb-connector",
      "env": {
        "CONNECTOR_CONFIG_PATH": "/absolute/path/to/config.yaml"
      }
    }
  }
}
```

Registered tools: `list_tables`, `create_table`, `drop_table`, `describe_table`, `table_row_count`, `add_rows`, `delete_rows`, `vector_search`, `scan_query`.

## Docker

```bash
docker build -t lancedb-connector .
docker run --rm -p 3030:3030 \
  -v "$(pwd)/db:/data" \
  -e LANCEDB_URI=/data/lancedb \
  lancedb-connector
```

Mount a config file:

```bash
docker run --rm -p 3030:3030 \
  -v "$(pwd)/db:/data" \
  -v "$(pwd)/config.yaml:/app/config.yaml:ro" \
  -e CONNECTOR_CONFIG_PATH=/app/config.yaml \
  lancedb-connector
```

## Project layout

| Path | Role |
|------|------|
| `src/main.ts` | HTTP server bootstrap |
| `src/server.ts` | Fastify app + routes + OpenAPI |
| `src/mcp-server.ts` | MCP stdio server |
| `src/lancedb-ops.ts` | Shared LanceDB operations |
| `src/config.ts` | YAML + env loading |
| `config.example.yaml` | Sample configuration |

## License

MIT
