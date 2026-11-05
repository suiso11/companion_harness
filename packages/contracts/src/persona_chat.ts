import { z } from "zod";

export const PERSONA_PROVIDERS = ["openai", "deepseek"] as const;
export const PersonaProviderSchema = z.enum(PERSONA_PROVIDERS);
export type PersonaProvider = z.infer<typeof PersonaProviderSchema>;

/** Suggested model ids only; the model field stays free text. */
export const PERSONA_PROVIDER_CATALOG: readonly {
  readonly id: PersonaProvider;
  readonly label: string;
  readonly suggestedModels: readonly string[];
}[] = [
  {
    id: "openai",
    label: "OpenAI",
    suggestedModels: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
];

export const PersonaProviderInfoSchema = z.strictObject({
  id: PersonaProviderSchema,
  label: z.string().min(1).max(40),
  suggestedModels: z.array(z.string().min(1).max(256)),
  /** true when the host holds an API key for this provider. */
  available: z.boolean(),
});

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0);

export const PersonaNameSchema = nonBlank(80);
export const PersonaAvatarSchema = nonBlank(16);
export const PersonaModelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:/-]+$/);
export const PersonaSystemPromptSchema = nonBlank(8000);

export const CreatePersonaRequestSchema = z.strictObject({
  name: PersonaNameSchema,
  avatar: PersonaAvatarSchema,
  provider: PersonaProviderSchema,
  model: PersonaModelSchema,
  systemPrompt: PersonaSystemPromptSchema,
});
export const UpdatePersonaRequestSchema = CreatePersonaRequestSchema;

export const PersonaSchema = z.strictObject({
  id: z.string().uuid(),
  name: PersonaNameSchema,
  avatar: PersonaAvatarSchema,
  provider: PersonaProviderSchema,
  model: PersonaModelSchema,
  systemPrompt: PersonaSystemPromptSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const PersonasResponseSchema = z.strictObject({
  personas: z.array(PersonaSchema),
  providers: z.array(PersonaProviderInfoSchema),
});

export const ChatTitleSchema = nonBlank(120);

export const CreateChatRequestSchema = z.strictObject({
  personaId: z.string().uuid(),
  title: ChatTitleSchema.optional(),
});
export const UpdateChatRequestSchema = z.strictObject({
  title: ChatTitleSchema,
});

export const ChatSummarySchema = z.strictObject({
  id: z.string().uuid(),
  personaId: z.string().uuid(),
  personaName: z.string().min(1).max(80),
  avatar: z.string().min(1).max(16),
  provider: PersonaProviderSchema,
  title: ChatTitleSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Newest message, cut to 80 code points; "" when empty. */
  preview: z.string().max(80),
  messageCount: z.number().int().nonnegative(),
});

export const ChatsResponseSchema = z.strictObject({
  chats: z.array(ChatSummarySchema),
});

export const ChatMessageRoleSchema = z.enum(["user", "assistant"]);
export const ChatMessageSchema = z.strictObject({
  id: z.string().uuid(),
  role: ChatMessageRoleSchema,
  content: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

export const ChatMessagesResponseSchema = z.strictObject({
  chat: ChatSummarySchema,
  messages: z.array(ChatMessageSchema),
  hasMore: z.boolean(),
});

export const ChatMessageTextSchema = nonBlank(8000);
export const ChatClientKeySchema = z.string().min(8).max(128);

export const PostChatMessageRequestSchema = z.strictObject({
  text: ChatMessageTextSchema,
  clientKey: ChatClientKeySchema.optional(),
});

export const PostChatMessageResponseSchema = z.strictObject({
  chat: ChatSummarySchema,
  messages: z.strictObject({
    user: ChatMessageSchema,
    assistant: ChatMessageSchema,
  }),
});
