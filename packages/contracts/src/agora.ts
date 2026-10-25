// AGORA agent-tool contracts.
//
// These are model-visible structual results only. The model can read public
// content, draft thread/reply proposals, inspect proposals owned by the SAME
// session, and ask the kernel to send a proposal that a human operator already
// approved by its exact payload hash. There is deliberately no register,
// approve, or reject tool: those remain operator CLI actions.

import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";

export const AgoraThreadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: "thread id must be alphanumeric, underscore or hyphen",
  });
export type AgoraThreadId = z.infer<typeof AgoraThreadIdSchema>;

export const AgoraToolProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "sending",
  "sent",
  "unknown",
  "failed",
]);
export type AgoraToolProposalStatus = z.infer<
  typeof AgoraToolProposalStatusSchema
>;

export const AgoraToolOperationSchema = z.enum(["register", "thread", "reply"]);
export type AgoraToolOperation = z.infer<typeof AgoraToolOperationSchema>;

/** `agora.hello` takes no arguments (strict empty object). */
export const AgoraHelloToolInputSchema = z.strictObject({});
export type AgoraHelloToolInput = z.infer<typeof AgoraHelloToolInputSchema>;

export const AgoraHelloToolOutputSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  untrusted: z.literal(true),
  body: z.unknown(),
});
export type AgoraHelloToolOutput = z.infer<typeof AgoraHelloToolOutputSchema>;

export const AgoraReadThreadToolInputSchema = z.strictObject({
  threadId: AgoraThreadIdSchema,
});
export type AgoraReadThreadToolInput = z.infer<
  typeof AgoraReadThreadToolInputSchema
>;

export const AgoraReadThreadToolOutputSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  untrusted: z.literal(true),
  threadId: AgoraThreadIdSchema,
  body: z.string().max(20_000),
});
export type AgoraReadThreadToolOutput = z.infer<
  typeof AgoraReadThreadToolOutputSchema
>;

export const AgoraProposeThreadToolInputSchema = z.strictObject({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});
export type AgoraProposeThreadToolInput = z.infer<
  typeof AgoraProposeThreadToolInputSchema
>;

export const AgoraProposeReplyToolInputSchema = z.strictObject({
  threadId: AgoraThreadIdSchema,
  body: z.string().min(1).max(10_000),
});
export type AgoraProposeReplyToolInput = z.infer<
  typeof AgoraProposeReplyToolInputSchema
>;

/**
 * One session-owned proposal. `title`/`body`/`threadId` are the EXACT stored
 * bytes that a human operator approves; they are null when not applicable.
 */
export const AgoraProposalViewSchema = z.strictObject({
  proposalId: UuidSchema,
  operation: AgoraToolOperationSchema,
  status: AgoraToolProposalStatusSchema,
  payloadHash: Sha256HexSchema,
  title: z.string().max(200).nullable().default(null),
  body: z.string().max(10_000).nullable().default(null),
  threadId: AgoraThreadIdSchema.nullable().default(null),
  createdAt: UnixMsSchema,
  expiresAt: UnixMsSchema,
});
export type AgoraProposalView = z.infer<typeof AgoraProposalViewSchema>;

const ProposalMessageSchema = z.string().min(1).max(1024);

export const AgoraProposeThreadToolOutputSchema = z.strictObject({
  status: AgoraToolProposalStatusSchema,
  proposal: AgoraProposalViewSchema,
  message: ProposalMessageSchema,
});
export type AgoraProposeThreadToolOutput = z.infer<
  typeof AgoraProposeThreadToolOutputSchema
>;

export const AgoraProposeReplyToolOutputSchema =
  AgoraProposeThreadToolOutputSchema;
export type AgoraProposeReplyToolOutput = z.infer<
  typeof AgoraProposeReplyToolOutputSchema
>;

/** Inspect one owned proposal by id, or list this session's proposals. */
export const AgoraStatusToolInputSchema = z.strictObject({
  proposalId: UuidSchema.optional(),
  status: AgoraToolProposalStatusSchema.optional(),
});
export type AgoraStatusToolInput = z.infer<typeof AgoraStatusToolInputSchema>;

export const AgoraStatusToolOutputSchema = z.strictObject({
  proposals: z.array(AgoraProposalViewSchema).max(20),
  message: ProposalMessageSchema,
});
export type AgoraStatusToolOutput = z.infer<typeof AgoraStatusToolOutputSchema>;

/**
 * Send one ALREADY human-approved proposal. The model supplies only the
 * operator-visible proposal id and exact payload hash; it can never supply
 * content at send time, so approved bytes cannot be edited.
 */
export const AgoraSendToolInputSchema = z.strictObject({
  proposalId: UuidSchema,
  payloadHash: Sha256HexSchema,
});
export type AgoraSendToolInput = z.infer<typeof AgoraSendToolInputSchema>;

export const AgoraSendToolStatusSchema = z.enum([
  "sent",
  "unknown",
  "failed",
  "throttled",
  "key_missing",
]);
export type AgoraSendToolStatus = z.infer<typeof AgoraSendToolStatusSchema>;

export const AgoraSendToolOutputSchema = z.strictObject({
  status: AgoraSendToolStatusSchema,
  proposal: AgoraProposalViewSchema.nullable().default(null),
  retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  message: ProposalMessageSchema,
});
export type AgoraSendToolOutput = z.infer<typeof AgoraSendToolOutputSchema>;

/* ------------------------------------------------------------------ */
/* Authenticated browser review API (session-scoped, human-only).       */
/* ------------------------------------------------------------------ */

/**
 * One exact proposal as rendered by the local review UI. `destination` is the
 * fixed AGORA API endpoint derived from the operation (never caller input).
 * `resultUrl` is null unless a real 2xx response supplied a verified AGORA
 * thread target; it is never synthesized from an unknown id.
 */
export const AgoraHttpProposalViewSchema = z.strictObject({
  proposalId: UuidSchema,
  operation: AgoraToolOperationSchema,
  status: AgoraToolProposalStatusSchema,
  destination: z.string().min(1).max(512),
  payloadHash: Sha256HexSchema,
  name: z.string().max(100).nullable(),
  description: z.string().max(2000).nullable(),
  title: z.string().max(200).nullable(),
  body: z.string().max(10_000).nullable(),
  threadId: AgoraThreadIdSchema.nullable(),
  createdAt: UnixMsSchema,
  expiresAt: UnixMsSchema,
  decidedAt: UnixMsSchema.nullable(),
  consumedAt: UnixMsSchema.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  resultCode: z.string().max(64).nullable(),
  resultThreadId: AgoraThreadIdSchema.nullable(),
  resultUrl: z.string().url().max(512).nullable(),
});
export type AgoraHttpProposalView = z.infer<
  typeof AgoraHttpProposalViewSchema
>;

export const AgoraHttpListResponseSchema = z.strictObject({
  proposals: z.array(AgoraHttpProposalViewSchema).max(100),
});
export type AgoraHttpListResponse = z.infer<typeof AgoraHttpListResponseSchema>;

export const AgoraHttpShowResponseSchema = z.strictObject({
  proposal: AgoraHttpProposalViewSchema,
});
export type AgoraHttpShowResponse = z.infer<typeof AgoraHttpShowResponseSchema>;

export const AgoraHttpDecisionRequestSchema = z.strictObject({
  payloadHash: Sha256HexSchema,
});
export type AgoraHttpDecisionRequest = z.infer<
  typeof AgoraHttpDecisionRequestSchema
>;

export const AgoraHttpDecisionResponseSchema = AgoraHttpShowResponseSchema;
export type AgoraHttpDecisionResponse = z.infer<
  typeof AgoraHttpDecisionResponseSchema
>;

export const AgoraHttpSendRequestSchema = z.strictObject({
  payloadHash: Sha256HexSchema,
});
export type AgoraHttpSendRequest = z.infer<typeof AgoraHttpSendRequestSchema>;

export const AgoraHttpSendOutcomeSchema = z.enum([
  "sent",
  "failed",
  "unknown",
  "throttled",
  "key_missing",
]);
export type AgoraHttpSendOutcome = z.infer<typeof AgoraHttpSendOutcomeSchema>;

/**
 * Result of one explicit human Send click. A send click never approves: the
 * proposal must already be `approved` with this exact hash. `sending` is
 * observable on GET/list while another host-side send owns the lease.
 */
export const AgoraHttpSendResponseSchema = z.strictObject({
  outcome: AgoraHttpSendOutcomeSchema,
  proposal: AgoraHttpProposalViewSchema.nullable(),
  retryAfterMs: z.number().int().nonnegative().nullable(),
});
export type AgoraHttpSendResponse = z.infer<
  typeof AgoraHttpSendResponseSchema
>;
