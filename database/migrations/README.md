# Migrations

Runner: `database/migrations/migrate.ts` — applies every `*.sql` directly in
this directory, tracked in the `migrations` table by filename id. Boot does
not auto-migrate; `cd database && npm run migrate` runs it manually.

## Numbering

- `001`–`034`, `036`–`045`: 44 tracked migrations. **There is no `035` — it
  never existed** (absent from both the files and the `migrations` ledger).
  Do not renumber to "fill" it: ids are filenames, and renumbering breaks the
  ledger. New migrations continue from `047`.
- `wip/` holds drafts not ready to run. The runner only globs `*.sql` at the
  top level (`readdirSync` + `.endsWith('.sql')`), so anything in `wip/` is
  invisible to it. Move a draft out of `wip/` only when it is reviewed and
  committed. `scripts/check-invariants.sh` fails if an untracked `.sql`
  appears at the top level.
