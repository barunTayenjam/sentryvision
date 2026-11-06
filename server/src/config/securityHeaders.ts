import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { getInlineScriptHashesCached } from './cspHashes.js';
import { getFrontendDistPath } from './frontendDist.js';

// CSP is built per request (hashes TTL-cached): a `next build` while the app
// runs must not leave the inline-script allowlist stale — that blocks every
// inline script and blanks the page. helmet 8 cannot express this (directive
// values must be plain arrays), so helmet's CSP is disabled and the header is
// set here. Semantics are unchanged from the previous helmet-built header.
const buildCsp = (): string =>
  [
    "default-src 'self'",
    `script-src 'self' ${getInlineScriptHashesCached(getFrontendDistPath()).join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "script-src-attr 'none'",
    // HTTP-only LAN deployment — upgrade-insecure-requests would rewrite
    // every subresource to https:// and break all asset loading.
  ].join(';');

// Build security header config based on environment.
export const securityHeaders = () => {
  const helmetMiddleware = helmet({
    strictTransportSecurity:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
    contentSecurityPolicy: false,
  });
  return (req: Request, res: Response, next: NextFunction) => {
    helmetMiddleware(req, res, () => {
      res.setHeader('Content-Security-Policy', buildCsp());
      next();
    });
  };
};
