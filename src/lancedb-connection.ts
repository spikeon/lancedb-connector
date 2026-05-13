import * as lancedb from "@lancedb/lancedb";
import type { Connection } from "@lancedb/lancedb";
import type { AppConfig } from "./config.js";

let connection: Connection | null = null;

export async function getConnection(config: AppConfig): Promise<Connection> {
  if (!connection) {
    connection = await lancedb.connect(config.lancedb.uri);
  }
  return connection;
}

/** Test helper */
export function resetConnectionForTests(): void {
  connection = null;
}
