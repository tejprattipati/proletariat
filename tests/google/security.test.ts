import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore } from '../../src/lib/google/storage';
import { mimeMessage, resolveDriveReference, stableResourceId } from '../../src/lib/google/security';

describe('Google stable references and safe inputs', () => {
  it('resolves Docs tabs, Sheets gid, Drive folders and shared file links without fetching URLs', () => {
    expect(resolveDriveReference('https://docs.google.com/document/d/synthetic-doc-1/edit?tab=t.synthetic')).toEqual({ fileId: 'synthetic-doc-1', tabId: 't.synthetic', namedRangeId: undefined });
    expect(resolveDriveReference('https://docs.google.com/spreadsheets/d/synthetic-sheet-1/edit#gid=123').tabId).toBe('123');
    expect(resolveDriveReference('https://drive.google.com/drive/u/0/folders/synthetic-folder-1').fileId).toBe('synthetic-folder-1');
    expect(resolveDriveReference('https://drive.google.com/open?id=synthetic-doc-1').fileId).toBe('synthetic-doc-1');
    expect(stableResourceId('synthetic-doc-1')).toBe('google:drive:synthetic-doc-1');
  });
  it.each(['http://docs.google.com/document/d/fake/edit', 'https://docs.google.com.evil.example/document/d/fake/edit', 'https://example.com/?id=fake', 'https://user:pass@docs.google.com/document/d/fake/edit', 'file:///etc/passwd', 'https://drive.google.com/'])('rejects unsupported URL %s', value => { expect(() => resolveDriveReference(value)).toThrow(); });
  it('prevents MIME header injection and encodes Unicode safely', () => {
    expect(() => mimeMessage('receiver@example.com\r\nBcc: injected@example.com', 'Hello', 'body')).toThrow();
    expect(() => mimeMessage('receiver@example.com', 'Hello\r\nBcc: injected@example.com', 'body')).toThrow();
    const raw = Buffer.from(mimeMessage('receiver@example.com', 'Hello ☀', 'Fictional body ✓'), 'base64url').toString();
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).not.toContain('Bcc:');
  });
});

describe('encrypted external token vault', () => {
  it('refuses repository token paths and malformed keys', () => {
    expect(() => new EncryptedFileTokenStore(join(process.cwd(), 'tokens.json'), Buffer.alloc(32, 4).toString('base64'))).toThrow('outside the repository');
    expect(() => new EncryptedFileTokenStore('/tmp/synthetic-token-test', 'invalid')).toThrow('32 bytes');
  });
  it('encrypts round trips, restrictive modes, and detects tampering/wrong keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proletariat-google-test-'));
    const path = join(directory, 'tokens.enc');
    try {
      const store = new EncryptedFileTokenStore(path, Buffer.alloc(32, 4).toString('base64'));
      const token = { accessToken: 'synthetic-token-only', refreshToken: 'synthetic-refresh-only', expiresAt: 1234, scopes: ['synthetic-scope'] };
      expect(await store.load()).toBeUndefined();
      await store.save(token);
      expect(await store.load()).toEqual(token);
      expect(await readFile(path, 'utf8')).not.toContain('synthetic-token-only');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const wrongKey = new EncryptedFileTokenStore(path, Buffer.alloc(32, 5).toString('base64'));
      await expect(wrongKey.load()).rejects.toMatchObject({ code: 'GOOGLE_VAULT_UNREADABLE' });
      await store.clear(); expect(await store.load()).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
