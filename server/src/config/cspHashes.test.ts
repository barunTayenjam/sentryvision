import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInlineScriptHashesCached } from './cspHashes.js';

// The CSP inline-script allowlist is read from frontend-next/out. Without a
// cache it re-walks the tree on every request; with an unbounded cache it
// goes stale after `next build` while the app keeps running — the exact
// blank-page footgun. The cache must expire.
describe('getInlineScriptHashesCached', () => {
  let dir: string;
  const originalTtl = process.env.CSP_HASH_TTL_MS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-'));
    if (originalTtl === undefined) delete process.env.CSP_HASH_TTL_MS;
    else process.env.CSP_HASH_TTL_MS = originalTtl;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalTtl === undefined) delete process.env.CSP_HASH_TTL_MS;
    else process.env.CSP_HASH_TTL_MS = originalTtl;
  });

  const write = (body: string) =>
    fs.writeFileSync(path.join(dir, 'index.html'), `<html><body><script>${body}</script></body></html>`);

  it('hashes the current inline scripts', () => {
    write('console.log("v1")');
    const hashes = getInlineScriptHashesCached(dir);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-/);
  });

  it('serves stale hashes within the TTL, then refreshes after it', () => {
    process.env.CSP_HASH_TTL_MS = '0'; // expire on every call
    write('console.log("v1")');
    const before = getInlineScriptHashesCached(dir);
    write('console.log("v2")');
    expect(getInlineScriptHashesCached(dir)).not.toEqual(before);
  });
});
