export interface TrialWireRequest {
  version: 1;
  executionId: string;
  taskHash: string;
  configFingerprint: string;
  sourceRevision: string;
  workspaceAlias: string;
  mode: "read_only" | "write";
  purpose: { statement: string; scope: string };
  objective: string;
  relevantPaths: string[];
  acceptance: string[];
  requiredChecks: string[];
  constraints: string[];
  budget: { timeoutMs: number; maxOutputBytes: number };
  externalModelConsent: boolean;
}
export interface TrialWireResult {
  version: 1;
  executionId: string;
  taskHash: string;
  status: "done" | "error" | "cancelled" | "unknown";
  verified: boolean;
  /** Stored bridge/journal exit code (0..255). Absent on legacy lines. */
  exitCode?: number;
  report: {
    summary: string;
    files: string[];
    findings: string[];
    unresolved: string[];
  };
  evidence: {
    workerIds: string[];
    workspaceTrial: true;
    productionApplied: false;
    checks: {
      id: string;
      exitCode: number | null;
      timedOut: boolean;
      outputMatched: boolean;
    }[];
    artifact?: { sha256: string; entryCount: number; bytes: number };
  };
}
export const COMPANION_WIRE_VERSION: number;
export function canonicalize(value: unknown): string;
export function computeTaskHash(
  request: Omit<TrialWireRequest, "taskHash"> | TrialWireRequest,
): string;
export function validateWireRequest(raw: unknown): TrialWireRequest;
export function parseRequestFrame(
  frame: Uint8Array,
  maxBytes: number,
): TrialWireRequest;
export function validateWireResult(
  raw: unknown,
  requiredChecks: readonly string[],
): TrialWireResult;
export function serializeResult(result: TrialWireResult): string;
export function companionScopeIdentity(
  request: Pick<TrialWireRequest, "executionId" | "taskHash">,
): { scopeUuid: string; scopeNonce: string };
export function expectedScopeUnit(identity: {
  scopeUuid: string;
  scopeNonce: string;
}): string;
export function companionScopeUnit(
  request: Pick<TrialWireRequest, "executionId" | "taskHash">,
): string;
export function isCompanionScopeUnit(
  parsedUnit: string | undefined,
  request: Pick<TrialWireRequest, "executionId" | "taskHash">,
): boolean;
export function isPathInScopes(rel: string, scopes: readonly string[]): boolean;
