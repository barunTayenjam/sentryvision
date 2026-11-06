import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function collectFromHtmlFile(filePath: string, hashes: Set<string>): void {
  let html: string;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  let match: RegExpExecArray | null;
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const content = match[2] ?? '';
    if (!content.trim()) continue;
    const digest = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
    hashes.add(`'sha256-${digest}'`);
  }
}

function walk(dir: string, hashes: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(fullPath, hashes);
    } else if (entry.name.endsWith('.html')) {
      collectFromHtmlFile(fullPath, hashes);
    }
  }
}

export function collectInlineScriptHashes(frontendDistPath: string): string[] {
  const hashes = new Set<string>();
  if (fs.existsSync(frontendDistPath)) {
    walk(frontendDistPath, hashes);
  }
  return [...hashes].sort();
}

// The allowlist must follow `next build` while the app keeps running: a
// startup-only snapshot goes stale and the new inline scripts are blocked
// (blank page). TTL cache — cheap re-walk at most once per window; 0 disables.
let hashCache: { path: string; at: number; hashes: string[] } | null = null;

export function getInlineScriptHashesCached(frontendDistPath: string): string[] {
  const ttlMs = Number(process.env.CSP_HASH_TTL_MS ?? 30_000);
  const now = Date.now();
  if (hashCache && hashCache.path === frontendDistPath && now - hashCache.at < ttlMs) {
    return hashCache.hashes;
  }
  const hashes = collectInlineScriptHashes(frontendDistPath);
  hashCache = { path: frontendDistPath, at: now, hashes };
  return hashes;
}
