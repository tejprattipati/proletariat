import type { GmailMessage } from './contracts';
import { GoogleProvider } from './provider';
import { GoogleIntegrationError } from './security';
import { boundedText, htmlToText } from './content';

/** MIME text only. Message snippets and binary attachments are never substituted for a full body. */
export async function readMailText(provider: GoogleProvider, message: GmailMessage, maxChars = 40_000) {
  const read = async (part: GmailMessage['payload']): Promise<string | undefined> => {
    if (!part || part.filename) return undefined;
    if (part.parts?.length) {
      const children = part.mimeType === 'multipart/alternative' ? [...part.parts].sort((a, b) => Number(b?.mimeType === 'text/plain') - Number(a?.mimeType === 'text/plain')) : part.parts;
      const values: string[] = [];
      for (const child of children) {
        const value = await read(child);
        if (value !== undefined) { values.push(value); if (part.mimeType === 'multipart/alternative') break; }
      }
      return values.length ? values.join('\n') : undefined;
    }
    if (!['text/plain', 'text/html'].includes(part.mimeType ?? '')) return undefined;
    if ((part.body?.size ?? 0) > 1024 * 1024) throw new GoogleIntegrationError('GOOGLE_CONTENT_TOO_LARGE', 'Gmail text body exceeds the 1 MiB extraction limit.', 413);
    const encoded = part.body?.data ?? (part.body?.attachmentId ? await provider.getMessagePart(message.id, part.body.attachmentId) : undefined);
    if (encoded === undefined && part.body?.size !== 0) return undefined;
    if ((encoded?.length ?? 0) > 1400000 || encoded && !/^[A-Za-z0-9_\-=]*$/.test(encoded)) throw new GoogleIntegrationError('GOOGLE_GMAIL_BODY_INVALID', 'Google returned an invalid or oversized MIME text body.');
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded ?? '', 'base64url')); }
    catch { throw new GoogleIntegrationError('GOOGLE_TEXT_ENCODING_UNSUPPORTED', 'The Gmail text body is not valid UTF-8.'); }
    return part.mimeType === 'text/html' ? htmlToText(decoded) : decoded;
  };
  const body = await read(message.payload);
  if (body === undefined) throw new GoogleIntegrationError('GOOGLE_GMAIL_BODY_UNAVAILABLE', 'No readable MIME text body was returned. A snippet was not counted as a content read.');
  return boundedText(body, maxChars);
}
export function mailTitle(message: GmailMessage): string { return message.payload?.headers?.find(header => header.name.toLowerCase() === 'subject')?.value.slice(0, 1000) ?? '(No subject)'; }
export { htmlToText } from './content';
