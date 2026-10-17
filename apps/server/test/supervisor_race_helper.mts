// Test-only cross-process helper: exercises the REAL supervisor store from a
// separate OS process (spawned via tsx). Modes:
//   stop <dbPath> <nonce>  -> atomic operator-stop commit, prints STOPPED
//   lock <dbPath> <nonce>  -> try lock acquire; winner holds 1.5s, prints
//                             ACQUIRED, releases, exits 0; loser prints the
//                             failure message and exits 2.
import {
  acquireSupervisorLock,
  persistSupervisorStopAtomically,
  releaseSupervisorLock,
  supervisorPathsForDb,
} from "../src/supervisor.js";

const mode = process.argv[2] as string;
const dbPath = process.argv[3] as string;
const nonce = process.argv[4] as string;
const paths = supervisorPathsForDb(dbPath);

if (mode === "stop") {
  persistSupervisorStopAtomically(paths, Date.now(), nonce);
  process.stdout.write("STOPPED\n");
  process.exit(0);
}

if (mode === "lock") {
  try {
    const lock = acquireSupervisorLock(paths, nonce, Date.now());
    process.stdout.write(`ACQUIRED pid=${lock.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    releaseSupervisorLock(paths, nonce);
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      `DENIED ${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exit(2);
  }
}

process.stderr.write("unknown helper mode\n");
process.exit(3);
