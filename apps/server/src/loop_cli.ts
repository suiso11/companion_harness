// Operator CLI for the self-improvement loop measurement (P0/P1).
//
// Read-only: this command never writes a row. It reports the deterministic
// label coverage the loop will run on, the 10% quarantine count, and the
// trial calibration summary (which stays `insufficient` until there are
// enough (confidence, outcome) pairs).
//
// Usage:
//   pnpm loop report [--limit N]
//
// stdout is the JSON report. stderr carries fixed safe messages only.

import {
  closeKernelDatabase,
  computeCoverage,
  computeDprime,
  createKernelRepository,
  labelRun,
  openKernelDatabase,
} from "@companion/kernel";
import { loadServerConfig } from "./config.js";

export const LOOP_USAGE = "Use: loop report [--limit N]";

export class LoopCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "LoopCliError";
    this.cliCode = cliCode;
  }
}

export function runLoopCli(argv: readonly string[]): string {
  if (argv[0] !== "report") {
    throw new LoopCliError("usage", LOOP_USAGE);
  }
  let limit = 2000;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      const raw = argv[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
        throw new LoopCliError("usage", LOOP_USAGE);
      }
      limit = parsed;
      i += 1;
      continue;
    }
    throw new LoopCliError("usage", LOOP_USAGE);
  }
  const config = loadServerConfig();
  const handle = openKernelDatabase(config.dbPath);
  try {
    const repo = createKernelRepository(handle.raw);
    const facts = repo.readLoopRunFacts(limit);
    const labels = facts.map((fact) => labelRun(fact));
    const coverage = computeCoverage(labels);
    const calibration = computeDprime(repo.readCalibrationPairs());
    return JSON.stringify(
      {
        runs: {
          total: coverage.total,
          labeled: coverage.labeled,
          quarantined: coverage.quarantined,
        },
        byClass: coverage.byClass,
        calibration,
      },
      null,
      2,
    );
  } finally {
    closeKernelDatabase(handle);
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked?.endsWith("loop_cli.ts") ?? false;
}

if (isMainModule()) {
  try {
    process.stdout.write(`${runLoopCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof LoopCliError ? error.message : "loop report failed"}\n`,
    );
    process.exit(1);
  }
}
