import { describe, it, expect, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { securityHeaders } from './securityHeaders.js';

// SentryVision serves the UI over plain HTTP on the LAN (port 9753, no TLS
// terminator). `upgrade-insecure-requests` makes the browser rewrite every
// same-origin subresource to https://, which kills all JS/CSS loading and
// strands the app on its static "Loading your workspace…" prerender.
describe('securityHeaders content-security-policy', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  async function fetchCsp(env: string | undefined): Promise<string> {
    process.env.NODE_ENV = env;
    const app = express();
    app.use(securityHeaders());
    app.get('/', (_req, res) => res.send('ok'));
    const response = await request(app).get('/');
    return (response.headers['content-security-policy'] as string) ?? '';
  }

  it('production CSP must not contain upgrade-insecure-requests (HTTP-only deployment)', async () => {
    const csp = await fetchCsp('production');
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('development CSP must not contain upgrade-insecure-requests', async () => {
    const csp = await fetchCsp('development');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

// The blank-page footgun: securityHeaders() is mounted once at startup, but
// `next build` can rewrite frontend-next/out while the app keeps running.
// The script-src directive must follow the on-disk bundle, not the startup
// snapshot.
describe('securityHeaders CSP follows a rebuilt frontend', () => {
  it('picks up new inline-script hashes after out/ changes (no restart)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'csp-live-'));
    process.env.FRONTEND_DIST_PATH = dir;
    process.env.CSP_HASH_TTL_MS = '0';
    try {
      const write = (body: string) =>
        fs.writeFileSync(
          nodePath.join(dir, 'index.html'),
          `<html><body><script>${body}</script></body></html>`,
        );
      write('console.log("v1")');

      const app = express();
      app.use(securityHeaders());
      app.get('/', (_req, res) => res.send('ok'));
      const cspOf = async () =>
        ((await request(app).get('/')).headers['content-security-policy'] as string) ?? '';

      const v1 = await cspOf();
      write('console.log("v2")');
      const v2 = await cspOf();

      expect(v1).not.toBe(v2);
      expect(v2).not.toContain(v1.match(/'sha256-[^']+'/)?.[0] ?? 'never');
    } finally {
      delete process.env.FRONTEND_DIST_PATH;
      delete process.env.CSP_HASH_TTL_MS;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
