import { z } from "zod";
import { UnixMsSchema, UuidSchema } from "./ids.js";

/**
 * AV05 notifications durable-projection contracts (kernel core only: no
 * service / HTTP / UI here).
 *
 * A NOTIFICATION is an immutable, session-owned, auditably-stored record
 * derived from ALREADY-DURABLE append-only sources (completed shadow jobs,
 * M5 action receipts, autonomy task events). Notifications NEVER become
 * execution authority: a recorded `permission` CLAIM stays a claim, an ack
 * changes NO purpose / task / control / Calendar grant / proposal /
 * hypothesis, and reading (list / get / history / cursor) NEVER mutates
 * delivered / ack state.
 *
 * Borrowed bounds (documented, not newly measured): list limits default 50
 * / max 100 (borrowed from the autonomy list pagination); scope strings cap
 * at 128 (borrowed from the strategy-name length cap); brief text caps at
 * 500 code points (borrowed from the shadow reason cap); cited deadlines
 * cap at 8 entries (borrowed from the shadow stop-condition array cap).
 * No new model / threshold / authority settings are introduced here.
 */

/** Closed notification-kind vocabulary. */
export const NotificationKindSchema = z.enum([
  "progress",
  "proposal",
  "question",
  "deadline",
  "commitment",
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/**
 * Closed priority vocabulary. Priority is CODE-computed (URGENT only for
 * commitment-verification notices over uncertain human-approved Calendar
 * receipts), never model-chosen urgency.
 */
export const NotificationPrioritySchema = z.enum(["routine", "urgent"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

/** Closed notification-source vocabulary (durable source tables only). */
export const NotificationSourceKindSchema = z.enum([
  "shadow_job",
  "action_receipt",
  "task_deadline",
]);
export type NotificationSourceKind = z.infer<
  typeof NotificationSourceKindSchema
>;

/** Closed notification cursor-source vocabulary (append-only sources). */
export const NotificationCursorSourceSchema = z.enum([
  "shadow_job_events",
  "action_receipts",
  "autonomy_task_events",
]);
export type NotificationCursorSource = z.infer<
  typeof NotificationCursorSourceSchema
>;

/** Closed ack-receipt status (fixed safe code, no free text). */
export const NotificationAckStatusSchema = z.enum(["acknowledged"]);
export type NotificationAckStatus = z.infer<typeof NotificationAckStatusSchema>;

/**
 * Immutable notification view. `briefText` carries FIXED safe system
 * provenance; any embedded model phrasing is UNTRUSTED (labels are source
 * labels, never claims or citations). Raw resource URLs / UUIDs are never
 * user-visible through this DTO (ids travel only as hidden links).
 */
export const NotificationViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  seq: z.number().int().min(1),
  scope: z.string().min(1).max(128),
  kind: NotificationKindSchema,
  priority: NotificationPrioritySchema,
  briefText: z.string().min(1).max(500),
  sourceKind: NotificationSourceKindSchema,
  sourceId: z.string().min(1).max(128),
  sourceVersion: z.number().int().min(1).nullable(),
  sourceEpoch: z.number().int().min(1).nullable(),
  citedDeadlines: z.array(z.string().min(1).max(128)).max(8),
  outdated: z.boolean(),
  createdAt: UnixMsSchema,
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

/** Bounded notification list response (truthful seq + unread counts). */
export const NotificationListResponseSchema = z.strictObject({
  items: z.array(NotificationViewSchema),
  latestSeq: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
});
export type NotificationListResponse = z.infer<
  typeof NotificationListResponseSchema
>;

/** Explicit ack receipt (separate immutable row, never mutates purpose/task). */
export const NotificationAckReceiptSchema = z.strictObject({
  notificationId: UuidSchema,
  sessionId: UuidSchema,
  key: UuidSchema,
  status: NotificationAckStatusSchema,
  createdAt: UnixMsSchema,
});
export type NotificationAckReceipt = z.infer<
  typeof NotificationAckReceiptSchema
>;

/** Pure-read notification history (record + its explicit ack, if any). */
export const NotificationHistoryResponseSchema = z.strictObject({
  notification: NotificationViewSchema,
  ack: NotificationAckReceiptSchema.nullable(),
});
export type NotificationHistoryResponse = z.infer<
  typeof NotificationHistoryResponseSchema
>;

/** Durable per-source cursor view (last consumed source rowid). */
export const NotificationCursorViewSchema = z.strictObject({
  source: NotificationCursorSourceSchema,
  lastSourceRowid: z.number().int().min(0),
  updatedAt: UnixMsSchema,
});
export type NotificationCursorView = z.infer<
  typeof NotificationCursorViewSchema
>;

/** Feed-cursor response (pure read: cursors + latest notification seq). */
export const NotificationFeedCursorResponseSchema = z.strictObject({
  cursors: z.array(NotificationCursorViewSchema),
  latestSeq: z.number().int().min(0),
});
export type NotificationFeedCursorResponse = z.infer<
  typeof NotificationFeedCursorResponseSchema
>;

/** Derived deadline-schedule row (projection only: tasks never changed). */
export const DeadlineScheduleViewSchema = z.strictObject({
  taskId: UuidSchema,
  sessionId: UuidSchema,
  scope: z.string().min(1).max(128),
  dueAt: UnixMsSchema,
  observedTaskVersion: z.number().int().min(1),
  sourceUpdatedAt: UnixMsSchema,
});
export type DeadlineScheduleView = z.infer<typeof DeadlineScheduleViewSchema>;

/** Closed next-deadline read status (honest paused reporting, no fake). */
export const NextDeadlineStatusSchema = z.enum(["ready", "control_paused"]);
export type NextDeadlineStatus = z.infer<typeof NextDeadlineStatusSchema>;

/** Future-deadline query response (earliest indexed numeric dueAt). */
export const NextDeadlineResponseSchema = z.strictObject({
  status: NextDeadlineStatusSchema,
  paused: z.boolean(),
  controlVersion: z.number().int().min(1),
  deadline: DeadlineScheduleViewSchema.nullable(),
});
export type NextDeadlineResponse = z.infer<typeof NextDeadlineResponseSchema>;

/** Closed due-deadline recording status (honest zero-recording codes). */
export const RecordDueDeadlinesStatusSchema = z.enum([
  "recorded",
  "control_paused",
  "stale_epoch",
]);
export type RecordDueDeadlinesStatus = z.infer<
  typeof RecordDueDeadlinesStatusSchema
>;

/** Due-deadline recording response (actual count, never faked). */
export const RecordDueDeadlinesResponseSchema = z.strictObject({
  status: RecordDueDeadlinesStatusSchema,
  recorded: z.number().int().min(0),
  controlVersion: z.number().int().min(1),
});
export type RecordDueDeadlinesResponse = z.infer<
  typeof RecordDueDeadlinesResponseSchema
>;

/** Bounded ingest report (actual progress, no retry spin). */
export const IngestNotificationsResponseSchema = z.strictObject({
  ingested: z.number().int().min(0),
  skipped: z.number().int().min(0),
  latestSeq: z.number().int().min(0),
});
export type IngestNotificationsResponse = z.infer<
  typeof IngestNotificationsResponseSchema
>;

/** Bounded deadline-schedule build report (full iterate, no truncation). */
export const BuildDeadlineScheduleResponseSchema = z.strictObject({
  upserted: z.number().int().min(0),
  removed: z.number().int().min(0),
  observed: z.number().int().min(0),
});
export type BuildDeadlineScheduleResponse = z.infer<
  typeof BuildDeadlineScheduleResponseSchema
>;

/**
 * Fixed safe notification error codes (closed set, no free text, no user
 * content, no invented physical-device semantics).
 */
export const NotificationErrorCodeSchema = z.enum([
  "notification_not_found",
  "notification_key_conflict",
  "notification_projection_reset_required",
  "notification_control_paused",
  "notification_stale_epoch",
]);
export type NotificationErrorCode = z.infer<typeof NotificationErrorCodeSchema>;
