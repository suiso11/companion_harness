export interface InspectView {
  executionId: string;
  state: string;
  scopeUnit: string;
  configFingerprint: string;
  sourceRevision: string;
  workspaceAlias: string;
  exitCode: number | null;
  hasResult: boolean;
  artifactSha256: string | null;
}
export class CompanionJournal {
  constructor(
    stateDir: string,
    storage: {
      maxRequestBytes: number;
      maxArtifactBytes: number;
      maxResultBytes: number;
      maxDbBytes: number;
    },
  );
  reserve(
    request: unknown,
    active: {
      configFingerprint: string;
      sourceRevision: string;
      workspaceAlias: string;
    },
    caps: { artifactCapBytes: number; resultCapBytes: number },
  ): {
    kind: string;
    ownerToken?: string;
    scopeUnit?: string;
    resultJsonLf?: string;
    exitCode?: number;
  };
  finalize(
    request: { executionId: string },
    input: {
      resultJsonLf: string;
      exitCode: number;
      ownerToken: string;
      artifactBytes?: Uint8Array;
    },
  ): { kind: string };
  inspect(executionId: string): InspectView | undefined;
  readArtifact(
    executionId: string,
  ): { bytes: Buffer; sha256: string } | undefined;
  close(): void;
}
