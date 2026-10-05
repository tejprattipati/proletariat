import type { GoogleIdentityVerifier } from './identity';
import type { Permissions } from '../types';

/** Server-only interfaces. Never import Google modules in the Pages bundle. */
export interface GoogleTokens {
  /** Changes on each authorization; caches and source bindings are isolated from other grants. */
  connectionId?: string;
  /** Verified independently selected Google data account. */
  subject?: string;
  /** Verified application owner, independent of the selected data account. */
  ownerSubject?: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}
export interface GoogleTokenStore {
  load(): Promise<GoogleTokens | undefined>;
  save(tokens: GoogleTokens): Promise<void>;
  clear(): Promise<void>;
}
export interface OperationRecord {
  fingerprint: string;
  status: 'pending' | 'accepted' | 'failed' | 'unknown';
  externalId?: string;
  error?: string;
}
export interface GoogleStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomically insert pending; return the existing record on a collision. Must be durable before returning. */
  reserveOperation(key: string, fingerprint: string): Promise<{ created: boolean; record: OperationRecord }>;
  finishOperation(key: string, record: OperationRecord): Promise<void>;
}
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface GoogleDependencies {
  tokenStore: GoogleTokenStore;
  store: GoogleStore;
  config?: GoogleConfig;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Configure together for multi-user adapters. Both must be scoped to the verified session owner. */
  identityVerifier?: GoogleIdentityVerifier;
  getAuthenticatedSubject?: () => Promise<string>;
  /** Return current persisted permissions. Workers must recheck these immediately before each external write. */
  getPermissions?: () => Promise<Permissions>;
  /** Shared bounded parser supplied by the backend. Never execute document scripts or fetch embedded URLs. */
  extractPdfText?: (bytes: Uint8Array) => Promise<{ text: string; truncated: boolean }>;
}
export interface Page<T> { items: T[]; nextPageToken?: string; checkpoint?: string; }
export interface DriveFile {
  id: string; name: string; mimeType: string; modifiedTime?: string; parents?: string[];
  webViewLink?: string; trashed?: boolean; size?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}
export interface GmailMessage {
  id: string; threadId: string; historyId?: string; snippet?: string; internalDate?: string; labelIds?: string[];
  payload?: { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailMessage['payload'][] };
}
export interface GoogleEvent {
  id: string; summary?: string; status?: string; location?: string; description?: string; updated?: string; htmlLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}
export interface GoogleDocument {
  documentId: string; revisionId?: string;
  body?: unknown;
  tabs?: GoogleDocumentTab[];
  namedRanges?: Record<string, { namedRanges?: { namedRangeId: string; ranges?: { startIndex?: number; endIndex?: number; tabId?: string; segmentId?: string }[] }[] }>;
}
export interface GoogleDocumentTab {
  tabProperties?: { tabId?: string; title?: string }; childTabs?: GoogleDocumentTab[];
  documentTab?: { namedRanges?: GoogleDocument['namedRanges']; body?: unknown; headers?: unknown; footers?: unknown; footnotes?: unknown };
}
export interface DriveReference { fileId: string; tabId?: string; namedRangeId?: string; }

export interface GoogleContent {
  id: string;
  provider: 'drive' | 'gmail' | 'calendar';
  providerId: string;
  name: string;
  url: string;
  text: string;
  contentHash: string;
  modifiedAt?: string;
  truncated: boolean;
  bytesRead: number;
  metadataOnly: boolean;
  tabId?: string;
  namedRangeId?: string;
}
export interface GoogleReadLimits { maxBytes?: number; maxChars?: number; fresh?: boolean; }
