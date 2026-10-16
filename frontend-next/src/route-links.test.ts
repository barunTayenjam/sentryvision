import { test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function collectRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      let seg: string;
      if (e.name.startsWith('(') && e.name.endsWith(')')) seg = '';
      else if (e.name.startsWith('[') && e.name.endsWith(']'))
        seg = '/:' + e.name.slice(1, -1);
      else seg = '/' + e.name;
      out.push(...collectRoutes(full, prefix + seg));
    } else if (e.name === 'page.tsx') {
      out.push(prefix || '/');
    }
  }
  return out;
}

function collectLinkTargets(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const patterns = [
    /href=\{?["'`](\/[^"'`]*)["'`]/g,
    /\.(?:push|replace)\(\s*["'`](\/[^"'`]*)["'`]/g,
  ];
  const targets: string[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) targets.push(m[1]);
  }
  return targets;
}

function matchesRoute(route: string, target: string) {
  const rs = route.split('/').filter(Boolean);
  const ts = target.split('/').filter(Boolean);
  if (rs.length !== ts.length) return false;
  return rs.every((seg, i) => seg.startsWith(':') || seg === ts[i]);
}

test('every internal link target resolves to an app-router route', () => {
  const routes = collectRoutes(join(root, 'app'));
  expect(routes.length).toBeGreaterThanOrEqual(7);

  const dead: string[] = [];
  for (const file of walk(join(root))) {
    for (const raw of collectLinkTargets(file)) {
      const [pathPart] = raw.split(/[?#]/);
      if (!routes.some((r) => matchesRoute(r, pathPart))) {
        dead.push(`${file.replace(root + '/', '')}: ${raw}`);
      }
    }
  }
  expect(dead, `dead internal links found:\n${dead.join('\n')}`).toEqual([]);
});
