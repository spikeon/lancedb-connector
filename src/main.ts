import { loadConfig, resolveAuthUsers } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const authUsers = await resolveAuthUsers(config);
  const app = await buildServer(config, authUsers);
  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
