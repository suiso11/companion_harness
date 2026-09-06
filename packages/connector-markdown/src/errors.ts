/**
 * Fixed connector error vocabulary (ToolError-like, lowercase, no paths).
 *
 * Whole-call failures (never per-file skips):
 * - `invalid_input`: malformed connector config, query, limit, or key.
 * - `markdown_vault_too_large`: >10000 unique .md files (before content).
 * - `markdown_path_unsafe`: root escape / external symlink / NOFOLLOW trap.
 * - `markdown_read_failed`: safe bounded read could not complete.
 * - `markdown_read_changed`: pre/post fstat or realpath identity mismatch.
 * - `reference_not_found`: well-formed but unknown alias/canonical key.
 *
 * Per-file skips (never whole-call failures, never truncated):
 * - `file_too_large`: >1MiB raw or NFC-normalized UTF-8 bytes.
 * - `invalid_utf8`: fatal UTF-8 decode failure.
 *
 * Budget overflow (never truncation, never partial output):
 * - `output_too_large`: the expanded link graph (persisted normalized
 *   metadata only: kind / status / ordered path-free candidates /
 *   ordering) exceeds the agreed 256KiB per tool call, summed over all
 *   presented hits (search) or the single document (readCanonical).
 *
 * `MarkdownConnectorError.message` carries only the code plus an
 * alias-relative key or alias (never an absolute path, raw OS error, or
 * file content).
 */

export const CONNECTOR_ERROR_CODES = [
  "invalid_input",
  "markdown_vault_too_large",
  "markdown_path_unsafe",
  "markdown_read_failed",
  "markdown_read_changed",
  "reference_not_found",
  "output_too_large",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export const SKIPPED_REASONS = ["file_too_large", "invalid_utf8"] as const;

export type ConnectorSkippedReason = (typeof SKIPPED_REASONS)[number];

export class MarkdownConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly canonicalKey: string | null;

  constructor(code: ConnectorErrorCode, canonicalKey: string | null) {
    super(
      canonicalKey === null
        ? `markdown connector: ${code}`
        : `markdown connector: ${code}: ${canonicalKey}`,
    );
    this.name = "MarkdownConnectorError";
    this.code = code;
    this.canonicalKey = canonicalKey;
  }
}
