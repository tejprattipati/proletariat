import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { GoogleStore, GoogleTokens, GoogleTokenStore, OperationRecord } from './contracts';
import { GoogleIntegrationError } from './security';

/** Optional single-account token vault. Lead may instead supply an encrypted database store. */
export class EncryptedFileTokenStore implements GoogleTokenStore {
  private key: Buffer;
  constructor(private path: string, base64Key: string, private repositoryRoot = process.cwd()) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'Google token encryption key must decode to exactly 32 bytes.');
    if (!isAbsolute(path)) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'Token path must be absolute and outside the repository.');
    this.assertOutside(resolve(path), resolve(repositoryRoot));
  }
  private assertOutside(path: string, root: string): void {
    const rel = relative(root, path);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'Google tokens must be stored outside the repository.');
  }
  private async prepare(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.assertOutside(await realpath(dirname(this.path)), await realpath(this.repositoryRoot));
    const stat = await lstat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'Token vault must be a regular file, not a symbolic link.');
  }
  async load(): Promise<GoogleTokens | undefined> {
    await this.prepare();
    let encoded: string;
    try { encoded = await readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const envelope = JSON.parse(encoded) as { v: number; iv: string; tag: string; data: string };
      if (envelope.v !== 1) throw new Error('Unsupported envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('proletariat-google-tokens-v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const tokens = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as GoogleTokens;
      if (!tokens.accessToken || !Array.isArray(tokens.scopes) || !Number.isFinite(tokens.expiresAt)) throw new Error('Invalid token record');
      return tokens;
    } catch { throw new GoogleIntegrationError('GOOGLE_VAULT_UNREADABLE', 'Token vault cannot be decrypted. Check its encryption key or reconnect Google.', 503); }
  }
  async save(tokens: GoogleTokens): Promise<void> {
    await this.prepare();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('proletariat-google-tokens-v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
    } finally { await rm(temp, { force: true }); }
  }
  async clear(): Promise<void> { await this.prepare(); await rm(this.path, { force: true }); }
}

/** Test-only store: deliberately never used by the production singleton. */
export class MemoryGoogleStore implements GoogleStore {
  readonly synthetic = true;
  private values = new Map<string, unknown>();
  private operations = new Map<string, OperationRecord>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async reserveOperation(key: string, fingerprint: string): Promise<{ created: boolean; record: OperationRecord }> {
    const existing = this.operations.get(key);
    if (existing) return { created: false, record: structuredClone(existing) };
    const record: OperationRecord = { fingerprint, status: 'pending' };
    this.operations.set(key, record);
    return { created: true, record: structuredClone(record) };
  }
  async finishOperation(key: string, record: OperationRecord): Promise<void> { this.operations.set(key, structuredClone(record)); }
}

/** Account/grant namespace avoids stale caches and operation IDs crossing an OAuth reconnection. */
export class ScopedGoogleStore implements GoogleStore {
  constructor(private base: GoogleStore, private namespace: () => Promise<string>) {}
  private async key(key: string): Promise<string> { return `${await this.namespace()}:${key}`; }
  async get<T>(key: string): Promise<T | undefined> { return this.base.get<T>(await this.key(key)); }
  async set<T>(key: string, value: T): Promise<void> { await this.base.set(await this.key(key), value); }
  async delete(key: string): Promise<void> { await this.base.delete(await this.key(key)); }
  async reserveOperation(key: string, fingerprint: string): Promise<{ created: boolean; record: OperationRecord }> { return this.base.reserveOperation(await this.key(key), fingerprint); }
  async finishOperation(key: string, record: OperationRecord): Promise<void> { await this.base.finishOperation(await this.key(key), record); }
}
