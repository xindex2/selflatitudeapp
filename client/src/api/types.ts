// Shapes returned by the Companion API (see docs/API.md)

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'owner' | 'superadmin';
  companionActive: boolean;
  companionEnd: string | null;
  courseAccess: boolean;
  onboardingCompleted: boolean;
  memoryEnabledDefault: boolean;
  journalShareAllowed: boolean;
  mfaEnabled: boolean;
  mfaMethod: 'none' | 'totp' | 'email';
  mfaRequired: boolean;
  planId: string | null;
  avatarUrl: string | null;
  pendingEmail: string | null;
  mfaVerified: boolean;
  mustChangePassword: boolean;
}

export interface AuthConfig {
  allowSelfRegistration: boolean;
  emailCodeMinutes: number;
  supportEmail: string;
}

export interface SupportInfo {
  email: string;
  responseTime: string;
  helpUrl: string;
  crisisNote: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  durationMonths: number;
  grantsCourse: boolean;
  repliesPerPeriod: number | null;
  costCeilingUsd: number | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  userCount?: number;
}

export interface UsageStatus {
  periodStart: string;
  periodEnd: string;
  repliesUsed: number;
  repliesLimit: number;
  repliesRemaining: number;
  costUsed: number;
  costLimit: number;
  costRemaining: number;
  includedExhausted: boolean;
  warning: 'none' | 'low' | 'very_low' | 'critical' | 'cost';
  paymentSource: 'included' | 'customer_key';
  customerKey: { last4: string; valid: boolean; activeUntil: string | null; keepUsing: boolean } | null;
}

export interface CompanionInfo {
  name: string;
  description: string;
  starters: { title: string; prompt: string }[];
  models: { id: string; label: string; included: boolean; isDefault: boolean }[];
  defaultModelId: string;
  depths: Record<'fast' | 'medium' | 'extended', string>;
  version: number;
}

export type Depth = 'fast' | 'medium' | 'extended';

export interface Conversation {
  id: string;
  title: string;
  modelId: string;
  depth: Depth;
  memoryEnabled: boolean;
  isTemporary: boolean;
  archived: boolean;
  lastMessageAt: string | null;
  createdAt: string;
  hasSummary: boolean;
  summary?: string | null;
}

export interface Source { fileId: string; title: string; module: string; section: string }

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'complete' | 'stopped' | 'failed' | 'streaming';
  modelId: string | null;
  depth: Depth | null;
  promptVersion: number | null;
  sources: Source[];
  attachments: { type: 'journal'; entryId: string; title: string }[];
  paymentSource: 'included' | 'customer_key' | null;
  error: string | null;
  createdAt: string;
}

export type MemoryCategory = 'value' | 'goal' | 'commitment' | 'preference' | 'theme' | 'practice' | 'other';

export interface Memory {
  id: string;
  category: MemoryCategory;
  content: string;
  status: 'pending' | 'approved' | 'rejected' | 'disabled';
  sourceConversationId: string | null;
  sourceConversationTitle: string | null;
  sourceJournalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntry {
  id: string;
  title: string;
  entryDate: string; // YYYY-MM-DD
  contentHtml?: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  id: string;
  label: string;
  included: boolean;
  isDefault?: boolean;
  inputPer1M: number;
  outputPer1M: number;
  enabled: boolean;
}
export interface DepthOption { label: string; maxOutputTokens: number; instruction: string; reasoning?: "minimal" | "low" | "medium" | "high" }

export interface CompanionConfig {
  id: number;
  versionNumber: number;
  status: 'draft' | 'published' | 'archived';
  name: string;
  description: string;
  instructions: string;
  safetyRules: string;
  starters: { title: string; prompt: string }[];
  models: ModelOption[];
  depth: Record<Depth, DepthOption>;
  fileIds: string[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CourseFile {
  id: string;
  title: string;
  moduleLabel: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  status: 'uploaded' | 'indexing' | 'indexed' | 'failed' | 'removed';
  chunkCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'owner' | 'superadmin';
  status: 'active' | 'suspended' | 'deleted';
  courseAccess: boolean;
  companionStart: string | null;
  companionEnd: string | null;
  replyLimitOverride: number | null;
  costLimitOverride: number | null;
  mfaEnabled: boolean;
  mfaMethod: 'none' | 'totp' | 'email';
  planId: string | null;
  planName: string | null;
  source: string;
  emailVerified: boolean;
  notes: string | null;
  repliesTotal?: number;
  lastActivityAt?: string | null;
  mustChangePassword: boolean;
  onboardingCompleted: boolean;
  consentAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSettings {
  repliesPerPeriod: number;
  costCeilingUsd: number;
  warnAtReplies: number[];
  warnAtCostFraction: number;
  reserveEstimateUsd: number;
  maxContextMessages: number;
  retrievalPassages: number;
  memoryPassages: number;
  privacyRequestDays: number;
}
