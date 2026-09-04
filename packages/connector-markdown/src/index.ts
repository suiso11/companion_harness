/**
 * M1 Markdown connector core — errors, roots, text, markdown, discovery,
 * and safe read slices.
 *
 * RUNTIME PRIVACY (hard rule): configured absolute root paths are
 * runtime-private. They never appear in returned values, persisted metadata,
 * errors, logs, snapshots, or test assertions. Only root-relative POSIX
 * canonical keys (`<alias>/<relative-posix>`) leave this package.
 *
 * DETERMINISM: explicit `<`/`>` code-unit ordering (never locale-sensitive),
 * NFC normalization, locale-independent per-code-point lowercase folding,
 * whole-query literal matching, and fixed snippet windows around the first
 * body hit. No tokenization, FTS, GFM extensions, semantic search, HTML
 * rendering, unified/remark, or locale-sensitive comparison anywhere.
 *
 * Later slices (search/DB/ToolBroker) are explicitly out of scope for this
 * commit; this module exports only what exists so typecheck passes
 * coherently.
 */

export type {
  MarkdownConnector,
  MarkdownConnectorHooks,
  MarkdownDocument,
  MarkdownReadOptions,
  MarkdownSearchHit,
  MarkdownSearchInput,
  MarkdownSearchResult,
  MarkdownSkippedEntry,
  ResolvedStandardLink,
  ResolvedWikiLink,
  StandardLinkStatus,
  WikiLinkStatus,
} from "./connector.js";
export {
  createMarkdownConnector,
  filenameStemOf,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MIN_CODE_POINTS,
} from "./connector.js";
export type { DiscoveredFile, DiscoveryHooks } from "./discovery.js";
export {
  discoverMarkdownFiles,
  discoverMarkdownFilesForRoot,
  enforceVaultFileLimit,
  MAX_FILES_PER_VAULT,
} from "./discovery.js";
export type {
  ConnectorErrorCode,
  ConnectorSkippedReason,
} from "./errors.js";
export {
  CONNECTOR_ERROR_CODES,
  MarkdownConnectorError,
  SKIPPED_REASONS,
} from "./errors.js";
export type {
  ParsedMarkdown,
  StandardLink,
  WikiLink,
} from "./markdown.js";
export { parseMarkdown } from "./markdown.js";
export type {
  ConfiguredRootInput,
  InitializedRoot,
  InitializedRootInfo,
} from "./roots.js";
export {
  initializeRoots,
  isWithinRealRoot,
  validateRootInputs,
} from "./roots.js";
export type { SafeReadHooks, SafeReadResult } from "./safe_read.js";
export {
  isNoFollowSupported,
  MAX_FILE_BYTES,
  safeReadMarkdownFile,
} from "./safe_read.js";
export type { TextHit } from "./text.js";
export {
  containsFolded,
  countCodePointsLocal,
  equalsFolded,
  findFirstHit,
  foldQuery,
  makeSnippet,
  normalizeNFC,
  SNIPPET_CONTEXT_BEFORE,
  SNIPPET_MAX_CODE_POINTS,
  sliceCodePoints,
} from "./text.js";
