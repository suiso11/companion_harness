import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { loadServerConfig } from "../src/config.js";

/**
 * Migrated in-memory kernel DB, repository, config and run engine shared by
 * the HTTP route fixtures. `cleanups` receives the DB close so each suite
 * keeps its own afterEach drain.
 */
export async function createServerFixtureContext(cleanups: Array<() => void>) {
  const handle = openKernelDatabase(":memory:");
  cleanups.push(() => closeKernelDatabase(handle));
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: ":memory:",
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  return { handle, repo, config, engine };
}
