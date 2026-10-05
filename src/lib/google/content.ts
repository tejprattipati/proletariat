import type { Resource } from '../types';
import type { GoogleContent, GoogleDocument, GoogleDocumentTab, GoogleReadLimits, GoogleStore } from './contracts';
import { GoogleProvider } from './provider';
import { SCOPES } from './oauth';
import { GoogleIntegrationError, canonicalDriveUrl, fingerprint, identifier, stableResourceId } from './security';
import { extractDocumentText } from './template';
import { apiUrl } from './transport';

interface SheetMetadata { sheets?: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[]; namedRanges?: { namedRangeId: string; name: string; range: GridRange }[]; }
interface GridRange { sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number; }
const MAX_CHARS = 250_000;
const MAX_BYTES = 8 * 1024 * 1024;
export class GoogleContentReader {
  constructor(private provider: GoogleProvider, private store: GoogleStore, private now = () => new Date(), private extractPdfText?: (bytes: Uint8Array) => Promise<{ text: string; truncated: boolean }>) {}
  async read(resource: Resource, limits: GoogleReadLimits = {}): Promise<GoogleContent> {
    if (!resource.providerId || resource.mode !== 'live' || resource.kind === 'folder') throw new GoogleIntegrationError('GOOGLE_CONTENT_UNAVAILABLE', 'Select a live Google file, not a folder.');
    const maxChars = limit(limits.maxChars, MAX_CHARS, MAX_CHARS);
    const maxBytes = limit(limits.maxBytes, MAX_BYTES, 16 * 1024 * 1024);
    await this.provider.transport.authorize([SCOPES.driveRead]);
    const file = await this.provider.getFile(resource.providerId, limits.fresh === true);
    const cacheKey = `content:${file.id}:${resource.tabId ?? '*'}:${resource.namedRangeId ?? '*'}:${maxChars}:${maxBytes}`;
    const cached = await this.provider.cache.get<{ result: GoogleContent; expiresAt: number; modifiedAt?: string }>(cacheKey);
    if (!limits.fresh && cached && cached.expiresAt > this.now().getTime() && cached.modifiedAt === file.modifiedTime) { this.provider.cacheHits++; return cached.result; }
    let result: { text: string; bytesRead: number; truncated: boolean };
    if (file.mimeType === 'application/vnd.google-apps.document') result = await this.document(resource, maxChars);
    else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') result = await this.spreadsheet(resource, maxChars);
    else if (file.mimeType === 'application/pdf') {
      if (!this.extractPdfText) throw new GoogleIntegrationError('GOOGLE_PDF_PARSER_REQUIRED', 'The backend must configure its bounded PDF parser before reading PDF text.', 503);
      const bytes = await this.provider.transport.bytes(apiUrl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { alt: 'media', supportsAllDrives: true }), [SCOPES.driveRead], maxBytes);
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new GoogleIntegrationError('GOOGLE_CONTENT_TYPE_MISMATCH', 'The Drive PDF does not have a PDF signature.');
      const extracted = await this.extractPdfText(bytes);
      result = boundedText(extracted.text, maxChars, bytes.length);
      result.truncated ||= extracted.truncated;
    } else if (file.mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/csv'].includes(file.mimeType)) {
      const bytes = await this.provider.transport.bytes(apiUrl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { alt: 'media', supportsAllDrives: true }), [SCOPES.driveRead], maxBytes);
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new GoogleIntegrationError('GOOGLE_TEXT_ENCODING_UNSUPPORTED', 'This text file is not valid UTF-8. Convert it before attaching.'); }
      result = boundedText(file.mimeType === 'text/html' ? htmlToText(decoded) : decoded, maxChars, bytes.length);
    } else throw new GoogleIntegrationError('GOOGLE_CONTENT_TYPE_UNSUPPORTED', `Content extraction is not configured for ${file.mimeType}. Metadata was read; file contents were not.`);
    const source: GoogleContent = { id: stableResourceId(file.id), provider: 'drive', providerId: file.id, name: file.name, url: canonicalDriveUrl(file.id, resource.kind, resource.tabId), text: result.text, contentHash: fingerprint(result.text), modifiedAt: file.modifiedTime, truncated: result.truncated, bytesRead: result.bytesRead, metadataOnly: false, tabId: resource.tabId, namedRangeId: resource.namedRangeId };
    await this.provider.cache.set(cacheKey, { result: source, expiresAt: this.now().getTime() + 5 * 60_000, modifiedAt: file.modifiedTime });
    return source;
  }
  private async document(resource: Resource, maxChars: number) {
    const document = await this.provider.transport.request<GoogleDocument>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(identifier(resource.providerId))}?includeTabsContent=true`, [SCOPES.driveRead]);
    if (document.documentId !== resource.providerId) throw new GoogleIntegrationError('GOOGLE_CONTENT_ID_MISMATCH', 'Google returned a document different from the selected attachment.');
    const tabs = flattenTabs(document.tabs ?? []);
    let selected = resource.tabId ? tabs.filter(tab => tab.tabProperties?.tabId === resource.tabId) : tabs;
    if (resource.tabId && !selected.length) throw new GoogleIntegrationError('DOCUMENT_TAB_MISSING', 'The selected document tab no longer exists.', 409);
    let value: string;
    if (resource.namedRangeId) {
      const segments: string[] = [];
      const roots = selected.length ? selected.map(tab => ({ root: tab.documentTab, tabId: tab.tabProperties?.tabId, ranges: tab.documentTab?.namedRanges })) : [{ root: document, tabId: undefined, ranges: document.namedRanges }];
      let found = false;
      for (const section of roots) for (const group of Object.values(section.ranges ?? {})) for (const named of group.namedRanges ?? []) if (named.namedRangeId === resource.namedRangeId) {
        found = true;
        for (const range of named.ranges ?? []) {
          if (range.tabId && range.tabId !== section.tabId) continue;
          if (!Number.isInteger(range.startIndex) || !Number.isInteger(range.endIndex)) throw new GoogleIntegrationError('DOCUMENT_RANGE_INVALID', 'The selected document range has no stable text indices.', 409);
          segments.push(textWithinRange(section.root, range.startIndex!, range.endIndex!, range.segmentId));
        }
      }
      if (!found) throw new GoogleIntegrationError('MANAGED_RANGE_MISSING', 'The selected document named range no longer exists.', 409);
      if (!segments.length) throw new GoogleIntegrationError('DOCUMENT_RANGE_INVALID', 'The selected range has no readable text indices.', 409);
      value = segments.join('\n');
    } else if (selected.length) value = selected.map(tab => `${tab.tabProperties?.title ? `[Tab: ${tab.tabProperties.title}]\n` : ''}${extractDocumentText(tab.documentTab)}`).join('\n');
    else value = extractDocumentText(document);
    return boundedText(value, maxChars);
  }
  private async spreadsheet(resource: Resource, maxChars: number) {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(identifier(resource.providerId))}`;
    const metadata = await this.provider.transport.request<SheetMetadata>(apiUrl(base, { fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount))),namedRanges(namedRangeId,name,range)' }), [SCOPES.driveRead], { maxResponseBytes: 2 * 1024 * 1024 });
    const allSheets = metadata.sheets ?? [];
    let sheets = resource.tabId ? allSheets.filter(sheet => String(sheet.properties.sheetId) === resource.tabId) : allSheets;
    if (resource.tabId && !sheets.length) throw new GoogleIntegrationError('SHEET_TAB_MISSING', 'The selected sheet tab no longer exists.', 409);
    const named = resource.namedRangeId ? metadata.namedRanges?.find(range => range.namedRangeId === resource.namedRangeId) : undefined;
    if (resource.namedRangeId && !named) throw new GoogleIntegrationError('SHEET_RANGE_MISSING', 'The selected sheet named range no longer exists.', 409);
    if (named) {
      if (resource.tabId && String(named.range.sheetId) !== resource.tabId) throw new GoogleIntegrationError('SHEET_RANGE_TAB_MISMATCH', 'The selected named range belongs to a different sheet tab.', 409);
      sheets = allSheets.filter(sheet => sheet.properties.sheetId === named.range.sheetId);
    }
    if (named && !sheets.length) throw new GoogleIntegrationError('SHEET_RANGE_MISSING', 'The named range refers to a missing sheet.', 409);
    let truncated = sheets.length > 20;
    const sections: string[] = [];
    let totalBytes = 0;
    for (const sheet of sheets.slice(0, 20)) {
      const properties = sheet.properties;
      const requested = named?.range ?? { sheetId: properties.sheetId, startRowIndex: 0, startColumnIndex: 0, endRowIndex: properties.gridProperties?.rowCount ?? 1000, endColumnIndex: properties.gridProperties?.columnCount ?? 26 };
      const startRow = requested.startRowIndex ?? 0; const startCol = requested.startColumnIndex ?? 0;
      const endCol = Math.min(requested.endColumnIndex ?? properties.gridProperties?.columnCount ?? 26, startCol + 100);
      const endRow = Math.min(requested.endRowIndex ?? properties.gridProperties?.rowCount ?? 1000, startRow + Math.max(1, Math.min(1000, Math.floor(10000 / Math.max(1, endCol - startCol)))));
      truncated ||= endRow < (requested.endRowIndex ?? properties.gridProperties?.rowCount ?? 1000) || endCol < (requested.endColumnIndex ?? properties.gridProperties?.columnCount ?? 26);
      if (endRow <= startRow || endCol <= startCol) continue;
      const range = `'${properties.title.replace(/'/g, "''")}'!${columnName(startCol)}${startRow + 1}:${columnName(endCol - 1)}${endRow}`;
      const data = await this.provider.transport.request<{ values?: unknown[][] }>(apiUrl(`${base}/values/${encodeURIComponent(range)}`, { valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' }), [SCOPES.driveRead], { maxResponseBytes: 5 * 1024 * 1024 });
      const section = `[Sheet: ${properties.title}; range: ${range}]\n${(data.values ?? []).map(row => row.map(cell => String(cell ?? '')).join('\t')).join('\n')}`;
      totalBytes += Buffer.byteLength(section); sections.push(section);
      if (sections.join('\n').length >= maxChars) { truncated = true; break; }
    }
    const result = boundedText(sections.join('\n\n'), maxChars, totalBytes); result.truncated ||= truncated;
    return result;
  }
}
export function boundedText(text: string, maxChars: number, bytesRead = Buffer.byteLength(text)) { return { text: text.slice(0, maxChars), truncated: text.length > maxChars, bytesRead }; }
function limit(value: number | undefined, fallback: number, max: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new GoogleIntegrationError('INVALID_READ_LIMIT', `Read limit must be an integer between 1 and ${max}.`); return value; }
function flattenTabs(tabs: GoogleDocumentTab[]): GoogleDocumentTab[] { return tabs.flatMap(tab => [tab, ...flattenTabs(tab.childTabs ?? [])]); }
function textWithinRange(root: unknown, start: number, end: number, segmentId?: string): string {
  if (segmentId && root && typeof root === 'object') {
    const object = root as Record<string, unknown>;
    const containers = ['headers', 'footers', 'footnotes'].flatMap(key => object[key] && typeof object[key] === 'object' ? [(object[key] as Record<string, unknown>)[segmentId]] : []);
    return containers.map(container => textWithinRange(container, start, end)).join('');
  }
  if (Array.isArray(root)) return root.map(item => textWithinRange(item, start, end)).join('');
  if (!root || typeof root !== 'object') return '';
  const object = root as Record<string, unknown>;
  if (object.textRun && typeof object.textRun === 'object' && typeof object.startIndex === 'number') {
    const text = String((object.textRun as { content?: string }).content ?? '');
    return text.slice(Math.max(0, start - object.startIndex), Math.max(0, Math.min(text.length, end - object.startIndex)));
  }
  return Object.entries(object).filter(([key]) => !['namedRanges', 'headers', 'footers', 'footnotes'].includes(key)).map(([, value]) => textWithinRange(value, start, end)).join('');
}
function columnName(zeroBased: number): string { let number = zeroBased + 1; let name = ''; while (number > 0) { number--; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26); } return name; }

export function htmlToText(html: string): string {
  return html.replace(/<!--[^]*?-->/g, '').replace(/<(script|style|head|template)\b[^>]*>[^]*?<\/\1\s*>/gi, '').replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!entity.startsWith('#')) return names[entity.toLowerCase()] ?? '';
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
  }).replace(/\n{3,}/g, '\n\n').trim();
}
