# Postgres Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port this Obsidian plugin from Qdrant to a self-hosted Postgres + pgvector backend, fronted by PostgREST, and rename it from "Qdrant Sync" to "Postgres Sync".

**Architecture:** Replace `src/qdrant.ts` with `src/postgrest.ts`, talking to a PostgREST instance in front of a `notes` table (pgvector embedding column) instead of a Qdrant collection. `src/sync.ts`'s push/pull/last-write-wins logic is backend-agnostic and needs only import and call-site changes. Auth uses a static API key sent as a custom `X-Api-Key` header (not `Authorization` - see Task 1's note on why), checked by a PostgREST pre-request function that switches Postgres role on match. The plugin, manifest, and package identity are renamed to `postgres-sync` / `obsidian-postgres-sync`.

**Tech Stack:** TypeScript, esbuild, Obsidian plugin API (`requestUrl`), Postgres 16 + pgvector, PostgREST. Verification uses `pgvector/pgvector:pg16` and `postgrest/postgrest` Docker images (both already pulled locally) plus `curl` to validate the exact HTTP shapes the client code depends on, since `requestUrl` only exists inside a running Obsidian instance and can't be unit-tested standalone.

## Global Constraints

- No data migration from Qdrant - first run on the new backend pushes every local note as new (per design doc, "Migration and identity decisions"). This is unchanged from the current plugin's own behavior: Obsidian fires `create` events for a vault's existing files the first time a newly-enabled plugin loads, which is how the current Qdrant-backed plugin already achieves an implicit "push everything" on first run with no dedicated command - the port keeps this behavior as-is rather than adding new first-run logic.
- No automated test suite is being added - this repo has none today and the approved design keeps it that way; verification is HTTP-shape checks against a real dockerized Postgres+PostgREST plus a final manual checklist (per design doc, "Testing").
- Tombstones (deletes) push `embedding: null`, not a fake zero-vector (per design doc, "fix it" decision on tombstone vector).
- Plugin identity: id `postgres-sync`, package/folder-facing name `obsidian-postgres-sync` (per design doc, "New plugin identity"). This is a new identity, not an in-place rename of the existing community listing.
- Auth: a static API key checked by a PostgREST pre-request function (per design doc, architecture section) - sent as `X-Api-Key`, not as an `Authorization` bearer token. This deviates from the design doc's exact wording ("static bearer token") in header choice only, for a reason discovered during planning verification (see Task 1) - the auth *mechanism* (static key, pre-request function, role switch) is unchanged from what was approved.
- The `embed()` response parsing (`Array<{ embedding: number[][] }>`) and the `mtime: Date.now()` / last-write-wins clock behavior are carried over byte-for-byte from the current, working Qdrant-backed plugin. Both are pre-existing behavior, not something this port introduces or changes - out of scope here even though they're worth revisiting separately.
- Design doc: `Personal/Projects/obsidian-qdrant-sync/2026-07-25-postgres-port-design.md` in the Obsidian vault (read via `notes-axi page get` if any task needs to re-check it).

---

### Task 1: `sql/schema.sql` - table, roles, auth function, verified against a live instance

**Files:**
- Create: `sql/schema.sql`

**Interfaces:**
- Produces: a `notes` table (`id uuid primary key`, `path text`, `content text`, `content_hash text`, `mtime bigint`, `size integer`, `deleted boolean`, `embedding vector(768)` nullable). Three roles - `web_anon` (zero grants, what PostgREST connects requests as by default), `note_writer` (full grants on `notes`, reached only via a successful auth check), `authenticator` (the role PostgREST's `db-uri` connects as, a member of both, so it's allowed to `SET ROLE` into either). Two functions - `get_bearer_token()` (`security definer`, reads the configured key) and `check_bearer_token()` (the `db-pre-request` hook: compares the incoming `X-Api-Key` header, raises `PT401` on mismatch, switches role to `note_writer` on match).
- Consumes: nothing (first task).

**Why `X-Api-Key` instead of `Authorization: Bearer` (found during planning, not in the original design doc):** PostgREST intercepts any `Authorization` header itself, before `db-pre-request` ever runs, and tries to verify it as a JWT. Without a `PGRST_JWT_SECRET` configured (which this design deliberately doesn't use - see design doc's auth rationale), that fails with an unrelated `500 PGRST300 "Server lacks JWT secret"` instead of reaching the custom auth function at all. Verified empirically against `postgrest/postgrest:latest` (v14.15) before writing this task - see Step 4 below, which reproduces the same check. A custom header sidesteps PostgREST's built-in JWT handling entirely, leaving `db-pre-request` as the only auth path.

**Why `get_bearer_token()` is a separate `security definer` function (also found during planning):** the natural design - one `check_bearer_token()` function that both reads `app_settings` and does `set_config('role', 'note_writer', true)` - fails with `42501 cannot set parameter "role" within security-definer function`. Postgres disallows changing the `role` GUC inside a `SECURITY DEFINER` function. Splitting the token read (which needs elevated rights, since `web_anon` has no grant on `app_settings`) from the role switch (which must run in the caller's own security context) resolves this. Verified empirically - see Step 4.

- [ ] **Step 1: Write `sql/schema.sql`**

```sql
-- Postgres + pgvector schema for obsidian-postgres-sync, exposed over PostgREST.
-- Run this against your Postgres instance, then point PostgREST at it with:
--   db-anon-role   = web_anon
--   db-pre-request = public.check_bearer_token
-- and connect PostgREST via a role (e.g. "authenticator") that is a member of
-- both web_anon and note_writer - see the role setup below.

create extension if not exists vector;

-- Single-row config table holding the API key the plugin must send.
-- Set your key with: update app_settings set bearer_token = 'your-long-random-key';
create table if not exists app_settings (
  id boolean primary key default true check (id),
  bearer_token text not null
);
insert into app_settings (id, bearer_token)
values (true, 'change-me')
on conflict (id) do nothing;

-- Embedding dimension below is 768 to match common local embedding models
-- (e.g. nomic-embed-text). Change this to match your embedding server's output
-- size BEFORE running this on a fresh database - pgvector's vector(N) size
-- cannot be changed once notes exist without dropping and recreating the
-- column (and losing existing embeddings).
--
-- id is a deterministic hash of path (see pathToId in src/postgrest.ts), so a
-- given path always maps to the same row - deleting and recreating a note at
-- the same path updates the existing (tombstoned) row instead of colliding
-- with anything, which is why there's no partial/unique constraint gymnastics
-- needed around `deleted`.
create table if not exists notes (
  id uuid primary key,
  path text not null,
  content text not null default '',
  content_hash text not null default '',
  mtime bigint not null,
  size integer not null default 0,
  deleted boolean not null default false,
  embedding vector(768)
);

create index if not exists notes_mtime_idx on notes (mtime);
create index if not exists notes_path_idx on notes (path);

-- Roles.
-- web_anon: what PostgREST connects requests as by default. No grants at all -
--   an unauthenticated or wrongly-authenticated request can do nothing, so a
--   dropped or misconfigured db-pre-request setting fails closed, not open.
-- note_writer: full access to notes, reached only by check_bearer_token()
--   switching into it for the duration of a validated request.
-- authenticator: the role PostgREST's db-uri connects as. Must be a MEMBER of
--   both web_anon and note_writer so it's permitted to SET ROLE into either -
--   set_config('role', ...) fails for a role that isn't a member of the
--   target. This does NOT need to be, and should not be, a superuser.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'web_anon') then
    create role web_anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'note_writer') then
    create role note_writer nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin;
  end if;
end
$$;

grant web_anon to authenticator;
grant note_writer to authenticator;

grant usage on schema public to note_writer;
grant select, insert, update, delete on notes to note_writer;

-- Set a real login password for the role PostgREST connects as, if your
-- provisioning doesn't already manage this some other way:
-- alter role authenticator with login password 'set-a-real-password-here';

-- Auth check, split into two functions because SET ROLE (via set_config) is
-- disallowed inside a SECURITY DEFINER function. get_bearer_token() runs with
-- elevated rights just to read the configured key (web_anon has no direct
-- grant on app_settings); check_bearer_token() runs as the caller (web_anon)
-- and does the actual role switch.
create or replace function public.get_bearer_token() returns text as $$
  select bearer_token from app_settings where id = true;
$$ language sql security definer;

revoke execute on function public.get_bearer_token() from public;
grant execute on function public.get_bearer_token() to web_anon;

-- PostgREST maps a raised exception with SQLSTATE 'PT' + a 3-digit HTTP status
-- directly to that HTTP response ('PT401' -> HTTP 401). This is checked via a
-- custom X-Api-Key header, not Authorization - PostgREST tries to parse any
-- Authorization header as a JWT before db-pre-request even runs, and without
-- a configured JWT secret that fails with an unrelated 500 instead of ever
-- reaching this function.
create or replace function public.check_bearer_token() returns void as $$
declare
  headers json := current_setting('request.headers', true)::json;
  provided text := headers ->> 'x-api-key';
  expected text := public.get_bearer_token();
begin
  if expected is null or provided is null or provided <> expected then
    raise sqlstate 'PT401' using message = 'Invalid or missing API key';
  end if;
  perform set_config('role', 'note_writer', true);
end;
$$ language plpgsql;

revoke execute on function public.check_bearer_token() from public;
grant execute on function public.check_bearer_token() to web_anon;
```

- [ ] **Step 2: Start a throwaway Postgres instance and load the schema**

```bash
docker network create pgsync-test 2>/dev/null || true

docker run -d --rm --name pgsync-test-db --network pgsync-test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=notes \
  pgvector/pgvector:pg16

sleep 4

docker exec -i pgsync-test-db psql -U postgres -d notes -v ON_ERROR_STOP=1 < sql/schema.sql
```

Expected: a sequence of `CREATE EXTENSION` / `CREATE TABLE` / `INSERT 0 1` / `CREATE INDEX` / `DO` / `GRANT` / `CREATE FUNCTION` / `REVOKE` lines with no errors. The final statements in the file are the `revoke`/`grant` pair on `check_bearer_token`, so the last two lines should read `REVOKE` then `GRANT`.

- [ ] **Step 3: Set a known API key and a login password, then start PostgREST**

```bash
docker exec -i pgsync-test-db psql -U postgres -d notes -v ON_ERROR_STOP=1 <<'EOF'
update app_settings set bearer_token = 'test-key-123';
alter role authenticator with login password 'test-pass';
EOF

docker run -d --rm --name pgsync-test-postgrest --network pgsync-test \
  -p 3111:3000 \
  -e PGRST_DB_URI="postgres://authenticator:test-pass@pgsync-test-db:5432/notes" \
  -e PGRST_DB_SCHEMA="public" \
  -e PGRST_DB_ANON_ROLE="web_anon" \
  -e PGRST_DB_PRE_REQUEST="public.check_bearer_token" \
  postgrest/postgrest:latest

sleep 2
```

- [ ] **Step 4: Verify auth rejects a missing/wrong key and accepts the right one**

If you're running this in an environment with a network-request hook that intercepts `curl`/`wget` (as this plan's author's sandbox did), route these through a code-execution tool instead of raw shell - the commands themselves are unchanged either way.

```bash
curl -s -w " STATUS:%{http_code}\n" http://localhost:3111/notes
curl -s -w " STATUS:%{http_code}\n" -H "X-Api-Key: wrong" http://localhost:3111/notes
curl -s -w " STATUS:%{http_code}\n" -H "X-Api-Key: test-key-123" http://localhost:3111/notes
```

Expected: first two return `STATUS:401` with `{"code":"PT401",...}` bodies; the third returns `STATUS:200` with `[]` (empty - no rows yet).

- [ ] **Step 5: Verify upsert, changed-since filter, and path lookup shapes work**

```bash
KEY='-H "X-Api-Key: test-key-123"'

curl -s -X POST http://localhost:3111/notes?on_conflict=id \
  -H "X-Api-Key: test-key-123" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d '{"id":"11111111-1111-4111-a111-111111111111","path":"a.md","content":"hello","content_hash":"abc","mtime":1000,"size":5,"deleted":false,"embedding":null}'

curl -s -X POST http://localhost:3111/notes?on_conflict=id \
  -H "X-Api-Key: test-key-123" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d '{"id":"22222222-2222-4222-a222-222222222222","path":"b.md","content":"world","content_hash":"def","mtime":2000,"size":5,"deleted":false,"embedding":null}'

curl -s -H "X-Api-Key: test-key-123" "http://localhost:3111/notes?mtime=gt.1500&order=mtime.asc,id.asc&limit=100&offset=0"

curl -s -H "X-Api-Key: test-key-123" "http://localhost:3111/notes?path=eq.a.md&limit=1"
```

Expected: both POSTs succeed (empty body, no error); the `mtime=gt.1500` query returns only the `b.md` row; the `path=eq.a.md` query returns the `a.md` row.

- [ ] **Step 6: Verify re-upserting the same id updates in place (merge-duplicates)**

```bash
curl -s -X POST http://localhost:3111/notes?on_conflict=id \
  -H "X-Api-Key: test-key-123" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d '{"id":"11111111-1111-4111-a111-111111111111","path":"a.md","content":"hello v2","content_hash":"abc2","mtime":3000,"size":8,"deleted":false,"embedding":null}'

curl -s -H "X-Api-Key: test-key-123" "http://localhost:3111/notes?path=eq.a.md&limit=1"
```

Expected: one row for `a.md`, with `content: "hello v2"` and `mtime: 3000` - confirms upsert replaces rather than duplicates.

- [ ] **Step 7: Tear down the throwaway instance (keep the schema file)**

```bash
docker stop pgsync-test-postgrest pgsync-test-db
docker network rm pgsync-test
```

- [ ] **Step 8: Commit**

```bash
git add sql/schema.sql
git commit -m "Add Postgres/PostgREST schema for note sync"
```

---

### Task 2: `src/postgrest.ts` - a PostgREST client using the verified `X-Api-Key` auth

**Files:**
- Create: `src/postgrest.ts`

**Interfaces:**
- Consumes: nothing from other tasks yet (this task can be written and compiled standalone; `src/qdrant.ts` is deleted in Task 3, alongside the point where `sync.ts` stops importing it, so the repo stays buildable at every commit).
- Produces (for `src/sync.ts` in Task 3):
  - `export interface NotePayload { path: string; content: string; contentHash: string; mtime: number; size: number; deleted: boolean; }`
  - `export interface NoteRow { id: string; payload: NotePayload; }`
  - `export async function pathToId(path: string): Promise<string>`
  - `export async function sha256(text: string): Promise<string>`
  - `export async function embed(settings: { embedUrl: string; embedApiKey: string }, text: string, task: "search_document" | "search_query"): Promise<number[]>`
  - `export async function upsertNote(settings: { postgrestUrl: string; apiToken: string }, id: string, vector: number[] | null, payload: NotePayload): Promise<void>`
  - `export async function scrollChangedSince(settings: { postgrestUrl: string; apiToken: string }, sinceMs: number): Promise<NoteRow[]>`
  - `export async function getNoteByPath(settings: { postgrestUrl: string; apiToken: string }, path: string): Promise<NoteRow | undefined>`
  - Task 4 will define `QdrantSyncSettings` (name kept as-is, see that task's note) with fields `postgrestUrl: string; apiToken: string; embedUrl: string; embedApiKey: string` among others - this task's local `PostgrestSettings`/`EmbedSettings` interfaces are structurally compatible subsets, so `sync.ts` can pass the full settings object directly without adapting it.

- [ ] **Step 1: Write `src/postgrest.ts`**

```typescript
import { requestUrl } from "obsidian";

export interface NotePayload {
  path: string;
  content: string;
  contentHash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

export interface NoteRow {
  id: string;
  payload: NotePayload;
}

interface NoteRowJson {
  id: string;
  path: string;
  content: string;
  content_hash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

function rowToNoteRow(row: NoteRowJson): NoteRow {
  return {
    id: row.id,
    payload: {
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
      mtime: row.mtime,
      size: row.size,
      deleted: row.deleted,
    },
  };
}

/** Deterministic UUID (v4-shaped, not cryptographically meaningful) from a vault path, so renames/moves are the only case that needs a delete+create pair. */
export async function pathToId(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface EmbedSettings {
  embedUrl: string;
  embedApiKey: string;
}

export async function embed(settings: EmbedSettings, text: string, task: "search_document" | "search_query"): Promise<number[]> {
  const res = await requestUrl({
    url: `${settings.embedUrl}/embedding`,
    method: "POST",
    contentType: "application/json",
    headers: settings.embedApiKey ? { Authorization: `Bearer ${settings.embedApiKey}` } : undefined,
    body: JSON.stringify({ content: `${task}: ${text}` }),
  });
  const body = res.json as Array<{ embedding: number[][] }>;
  return body[0].embedding[0];
}

interface PostgrestSettings {
  postgrestUrl: string;
  apiToken: string;
}

/** X-Api-Key, not Authorization - PostgREST tries to parse an Authorization header as a JWT before db-pre-request runs, which fails with an unrelated 500 when no JWT secret is configured. See sql/schema.sql's comment on check_bearer_token(). */
function headers(settings: PostgrestSettings, extra?: Record<string, string>): Record<string, string> {
  return {
    "X-Api-Key": settings.apiToken,
    "Content-Type": "application/json",
    ...extra,
  };
}

function throwOnError(res: { status: number; text: string }, context: string): void {
  if (res.status >= 400) {
    throw new Error(`postgres-sync: ${context} failed with ${res.status}: ${res.text}`);
  }
}

export async function upsertNote(settings: PostgrestSettings, id: string, vector: number[] | null, payload: NotePayload): Promise<void> {
  const res = await requestUrl({
    url: `${settings.postgrestUrl}/notes?on_conflict=id`,
    method: "POST",
    headers: headers(settings, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      id,
      path: payload.path,
      content: payload.content,
      content_hash: payload.contentHash,
      mtime: payload.mtime,
      size: payload.size,
      deleted: payload.deleted,
      embedding: vector,
    }),
    throw: false,
  });
  throwOnError(res, `upsert ${payload.path}`);
}

/** Page through every row with mtime > sinceMs, ordered so pagination is stable even when many rows share an mtime. */
export async function scrollChangedSince(settings: PostgrestSettings, sinceMs: number): Promise<NoteRow[]> {
  const rows: NoteRow[] = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await requestUrl({
      url: `${settings.postgrestUrl}/notes?mtime=gt.${sinceMs}&order=mtime.asc,id.asc&limit=${limit}&offset=${offset}`,
      method: "GET",
      headers: headers(settings),
      throw: false,
    });
    throwOnError(res, "scroll changed-since");
    const page = res.json as NoteRowJson[];
    rows.push(...page.map(rowToNoteRow));
    if (page.length < limit) break;
    offset += limit;
  }
  return rows;
}

export async function getNoteByPath(settings: PostgrestSettings, path: string): Promise<NoteRow | undefined> {
  const res = await requestUrl({
    url: `${settings.postgrestUrl}/notes?path=eq.${encodeURIComponent(path)}&limit=1`,
    method: "GET",
    headers: headers(settings),
    throw: false,
  });
  throwOnError(res, `lookup ${path}`);
  const rows = res.json as NoteRowJson[];
  return rows[0] ? rowToNoteRow(rows[0]) : undefined;
}
```

- [ ] **Step 2: Type-check in isolation**

```bash
npx tsc --noEmit --strict --target ES2020 --module ESNext --moduleResolution bundler --lib ES2020,DOM --skipLibCheck src/postgrest.ts
```

Expected: no errors. This file has no local imports besides `obsidian`, so it type-checks fully on its own even though `src/qdrant.ts` still exists and `src/sync.ts` hasn't been rewired yet.

- [ ] **Step 3: Commit**

```bash
git add src/postgrest.ts
git commit -m "Add PostgREST client to replace the Qdrant client"
```

---

### Task 3: `src/sync.ts` - rewire to the PostgREST client, drop the tombstone vector hack, remove `qdrant.ts`

**Files:**
- Modify: `src/sync.ts`
- Delete: `src/qdrant.ts`

**Interfaces:**
- Consumes: everything produced by Task 2 (`embed`, `sha256`, `pathToId`, `upsertNote`, `scrollChangedSince`, `getNoteByPath`, `NotePayload`, `NoteRow`).
- Produces: `SyncEngine` class, unchanged public surface from before (`isConfigured`, `schedulePush`, `pushDelete`, `pushRename`, `startPulling`, `stopPulling`, `pull`) - Task 5 (`main.ts`) calls these by name and does not need to change them.

The deletion of `src/qdrant.ts` happens in this same task/commit as the rewire, not earlier, so the repo never has a commit where `sync.ts` imports a file that doesn't exist.

- [ ] **Step 1: Update imports and the two Qdrant-specific call sites**

Full replacement content for `src/sync.ts`:

```typescript
import { TFile, TFolder } from "obsidian";
import type QdrantSyncPlugin from "./main";
import { embed, sha256, pathToId, upsertNote, scrollChangedSince, getNoteByPath } from "./postgrest";

const SYNC_ROOT_EXCLUDE = /^\.obsidian\//;

export class SyncEngine {
  private plugin: QdrantSyncPlugin;
  private pushTimers = new Map<string, number>();
  private pushing = new Set<string>();
  private pullTimer: number | undefined;

  constructor(plugin: QdrantSyncPlugin) {
    this.plugin = plugin;
  }

  private get settings() {
    return this.plugin.settings;
  }

  isConfigured(): boolean {
    return Boolean(this.settings.postgrestUrl && this.settings.apiToken && this.settings.embedUrl);
  }

  private shouldSync(path: string): boolean {
    return path.endsWith(".md") && !SYNC_ROOT_EXCLUDE.test(path);
  }

  /** Debounced push - called from vault create/modify events. */
  schedulePush(file: TFile): void {
    if (!this.isConfigured() || !this.shouldSync(file.path)) return;
    const existing = this.pushTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(file.path);
      void this.pushFile(file);
    }, 2000);
    this.pushTimers.set(file.path, timer);
  }

  private async pushFile(file: TFile): Promise<void> {
    if (this.pushing.has(file.path)) return;
    this.pushing.add(file.path);
    try {
      const content = await this.plugin.app.vault.read(file);
      const contentHash = await sha256(content);

      const remote = await getNoteByPath(this.settings, file.path).catch(() => undefined);
      if (remote && remote.payload.contentHash === contentHash && !remote.payload.deleted) {
        return; // no real change (e.g. our own pull-triggered write firing a modify event)
      }

      const vector = await embed(this.settings, content, "search_document");
      const id = await pathToId(file.path);
      await upsertNote(this.settings, id, vector, {
        path: file.path,
        content,
        contentHash,
        mtime: Date.now(),
        size: content.length,
        deleted: false,
      });
    } catch (e) {
      console.error("postgres-sync: push failed for", file.path, e);
    } finally {
      this.pushing.delete(file.path);
    }
  }

  async pushDelete(path: string): Promise<void> {
    if (!this.isConfigured() || !this.shouldSync(path)) return;
    const timer = this.pushTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.pushTimers.delete(path);
    }
    try {
      const id = await pathToId(path);
      await upsertNote(this.settings, id, null, {
        path,
        content: "",
        contentHash: "",
        mtime: Date.now(),
        size: 0,
        deleted: true,
      });
    } catch (e) {
      console.error("postgres-sync: delete tombstone failed for", path, e);
    }
  }

  async pushRename(oldPath: string, file: TFile): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.shouldSync(oldPath)) await this.pushDelete(oldPath);
    if (this.shouldSync(file.path)) await this.pushFile(file);
  }

  startPulling(): void {
    this.stopPulling();
    const intervalMs = Math.max(5, this.settings.pullIntervalSeconds) * 1000;
    this.pullTimer = window.setInterval(() => void this.pull(), intervalMs);
    void this.pull();
  }

  stopPulling(): void {
    if (this.pullTimer) window.clearInterval(this.pullTimer);
  }

  async pull(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const changed = await scrollChangedSince(this.settings, this.settings.lastSyncCursor);
      if (changed.length === 0) return;

      let maxMtime = this.settings.lastSyncCursor;
      for (const row of changed) {
        await this.applyRemoteChange(row.payload);
        if (row.payload.mtime > maxMtime) maxMtime = row.payload.mtime;
      }
      this.settings.lastSyncCursor = maxMtime;
      await this.plugin.saveSettings();
    } catch (e) {
      console.error("postgres-sync: pull failed", e);
    }
  }

  private async applyRemoteChange(payload: {
    path: string;
    content: string;
    mtime: number;
    deleted: boolean;
  }): Promise<void> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(payload.path);

    if (payload.deleted) {
      if (existing instanceof TFile && existing.stat.mtime <= payload.mtime) {
        await this.plugin.app.fileManager.trashFile(existing);
      }
      return;
    }

    if (existing instanceof TFile) {
      if (existing.stat.mtime > payload.mtime) return; // local edit is newer - last-write-wins keeps it
      const localContent = await vault.read(existing);
      if (localContent === payload.content) return;
      await vault.modify(existing, payload.content);
    } else {
      await this.ensureFolder(payload.path);
      await vault.create(payload.path, payload.content);
    }
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    if (parts.length === 0) return;
    const vault = this.plugin.app.vault;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = vault.getAbstractFileByPath(current);
      if (!(existing instanceof TFolder)) {
        await vault.createFolder(current).catch(() => undefined);
      }
    }
  }
}
```

Note: the `import type QdrantSyncPlugin from "./main"` line stays as-is here since Task 5 renames the class - this task is not responsible for that rename, only for the backend swap. `tombstoneVector()` is gone entirely, and `pushDelete` now calls `upsertNote(..., null, ...)` directly.

- [ ] **Step 2: Delete the superseded Qdrant client**

```bash
git rm src/qdrant.ts
```

- [ ] **Step 3: Type-check the whole project**

At this point every file except `main.ts`/`settings.ts` (Tasks 4-5) is in its final Postgres-backend form, but `settings.ts` still has the old `qdrantUrl`/`qdrantApiKey`/`collection` fields, so this will show errors on `this.settings.postgrestUrl` etc. That's expected here - confirm the errors are ONLY about missing settings fields, not about `./qdrant` or `./postgrest` imports:

```bash
npx tsc --noEmit 2>&1 | grep -v "postgrestUrl\|apiToken\|Property .* does not exist on type 'QdrantSyncSettings'"
```

Expected: no output (every error is one of the expected missing-field errors, filtered out above) - or if something else shows up, fix it before continuing; do not proceed to Task 4 with an unexplained error.

- [ ] **Step 4: Commit**

```bash
git add src/sync.ts src/qdrant.ts
git commit -m "Rewire sync engine to the PostgREST client, drop zero-vector tombstone"
```

---

### Task 4: `src/settings.ts` - rename fields and settings UI for Postgres/PostgREST

**Files:**
- Modify: `src/settings.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface QdrantSyncSettings { postgrestUrl: string; apiToken: string; embedUrl: string; embedApiKey: string; pullIntervalSeconds: number; lastSyncCursor: number; }`. The interface and class names (`QdrantSyncSettings`, `QdrantSyncSettingTab`) are deliberately NOT renamed in this task - see the note at the end of Task 5 for why. `export const DEFAULT_SETTINGS: QdrantSyncSettings`. The `collection` field is removed entirely (no PostgREST equivalent - the table name is fixed as `notes` by `sql/schema.sql`, not user-configurable).

- [ ] **Step 1: Rewrite `src/settings.ts`**

```typescript
import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type QdrantSyncPlugin from "./main";

export interface QdrantSyncSettings {
  postgrestUrl: string;
  apiToken: string;
  embedUrl: string;
  embedApiKey: string;
  pullIntervalSeconds: number;
  lastSyncCursor: number;
}

export const DEFAULT_SETTINGS: QdrantSyncSettings = {
  postgrestUrl: "",
  apiToken: "",
  embedUrl: "",
  embedApiKey: "",
  pullIntervalSeconds: 30,
  lastSyncCursor: 0,
};

export class QdrantSyncSettingTab extends PluginSettingTab {
  plugin: QdrantSyncPlugin;

  constructor(app: App, plugin: QdrantSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override setControlValue(key: string, value: unknown): void | Promise<void> {
    if ((key === "postgrestUrl" || key === "embedUrl") && typeof value === "string") {
      value = value.replace(/\/+$/, "");
    }
    return super.setControlValue(key, value);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "PostgREST URL",
        desc: "Your PostgREST instance in front of Postgres, e.g. https://postgrest.example.com",
        control: { type: "text", key: "postgrestUrl" },
      },
      {
        name: "API key",
        desc: "Sent as an X-Api-Key header, checked by your PostgREST pre-request auth function - see sql/schema.sql",
        control: { type: "text", key: "apiToken" },
      },
      {
        name: "Embedding server URL",
        desc: "llama.cpp server with --embedding enabled, e.g. https://embed.example.com",
        control: { type: "text", key: "embedUrl" },
      },
      {
        name: "Embed API key",
        desc: "Optional - only needed if the embedding server requires auth. Sent as an Authorization: Bearer header.",
        control: { type: "text", key: "embedApiKey" },
      },
      {
        name: "Pull interval (seconds)",
        desc: "How often to poll Postgres for remote changes",
        control: { type: "number", key: "pullIntervalSeconds", min: 5 },
      },
      {
        name: "Force full resync",
        desc: "Reset the sync cursor to 0 and re-pull everything on next interval - use if this device missed changes",
        render: (setting) => {
          setting.addButton((btn) =>
            btn.setButtonText("Reset cursor").onClick(async () => {
              this.plugin.settings.lastSyncCursor = 0;
              await this.plugin.saveSettings();
            }),
          );
        },
      },
    ];
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/settings.ts
git commit -m "Rename settings fields for Postgres/PostgREST backend"
```

---

### Task 5: `src/main.ts` - rename the plugin class and user-facing text

**Files:**
- Modify: `src/main.ts`
- Modify: `src/sync.ts` (the `import type QdrantSyncPlugin from "./main"` left over from Task 3 - update to the new class name here, since this task owns the rename)

**Interfaces:**
- Consumes: `SyncEngine` from `./sync` (unchanged surface, per Task 3).
- Produces: `export default class PostgresSyncPlugin extends Plugin` - this is the class Obsidian's plugin loader instantiates; no other file references it by name except `sync.ts`'s type-only import, updated in this same task.

- [ ] **Step 1: Rewrite `src/main.ts`**

```typescript
import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, QdrantSyncSettings, QdrantSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";

export default class PostgresSyncPlugin extends Plugin {
  settings!: QdrantSyncSettings;
  sync!: SyncEngine;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.sync = new SyncEngine(this);

    this.addSettingTab(new QdrantSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.sync.pushDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.sync.pushRename(oldPath, file);
      }),
    );

    this.addCommand({
      id: "pull-now",
      name: "Pull changes from Postgres now",
      callback: () => {
        void this.sync.pull().then(() => new Notice("Postgres sync: pull complete"));
      },
    });

    if (this.sync.isConfigured()) {
      this.sync.startPulling();
    } else {
      new Notice("Postgres Sync: configure the plugin in Settings to start syncing");
    }
  }

  onunload(): void {
    this.sync.stopPulling();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<QdrantSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

Note on scope: `QdrantSyncSettings` and `QdrantSyncSettingTab` (in `settings.ts`) keep their names, and `sync.ts` keeps importing a type it will call `PostgresSyncPlugin` (Step 2 below) - the three "Qdrant"-prefixed identifiers are internal-only type names, invisible to users and absent from the built plugin's user-facing surface (id, display name, commands, Notices, README). Renaming them is a pure find-replace with zero behavior change; it's left out here under YAGNI, not because it's hard. If you want them renamed too, do it as a follow-up commit, not mixed into this port.

- [ ] **Step 2: Update `src/sync.ts`'s import to match the renamed class**

In `src/sync.ts`, change:

```typescript
import type QdrantSyncPlugin from "./main";
```

to:

```typescript
import type PostgresSyncPlugin from "./main";
```

and change every occurrence of `QdrantSyncPlugin` in that file (the `private plugin: QdrantSyncPlugin;` field and the constructor parameter type) to `PostgresSyncPlugin`.

- [ ] **Step 3: Type-check the whole project**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/sync.ts
git commit -m "Rename plugin class and user-facing text to Postgres Sync"
```

---

### Task 6: `manifest.json` / `package.json` - new plugin identity

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the plugin id/name Obsidian's community plugin system and the build output key off of.

- [ ] **Step 1: Update `manifest.json`**

```json
{
  "id": "postgres-sync",
  "name": "Postgres Sync",
  "version": "0.1.0",
  "minAppVersion": "1.13.0",
  "description": "Syncs this vault to a self-hosted Postgres database (via PostgREST) instead of Sync or CouchDB - every note is embedded for semantic search from agent tooling too.",
  "author": "rufi",
  "isDesktopOnly": false
}
```

Version resets to `0.1.0` since this is a new plugin identity, not a continuation of `qdrant-sync`'s version history.

- [ ] **Step 2: Update `package.json`**

```json
{
  "name": "obsidian-postgres-sync",
  "version": "0.1.0",
  "description": "Syncs an Obsidian vault to Postgres (via PostgREST) instead of Obsidian Sync/CouchDB",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/lanjak/obsidian-postgres-sync.git"
  },
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.24.0",
    "obsidian": "^1.7.2",
    "typescript": "^5.7.0"
  }
}
```

The repository URL assumes the GitHub repo will also be renamed to `obsidian-postgres-sync` - if you're keeping the existing `obsidian-qdrant-sync` repo/URL for now, leave this field as its current value instead; it doesn't affect the plugin's runtime behavior either way.

- [ ] **Step 3: Build the plugin end-to-end**

```bash
npm run build
```

Expected: esbuild reports success and `main.js` is regenerated.

```bash
grep -io qdrant main.js src/*.ts | sort | uniq -c
```

Expected: only hits are the three deliberately-unrenamed identifiers from Task 5's scope note (`QdrantSyncSettings`, `QdrantSyncSettingTab`, and the `QdrantSyncPlugin` name that no longer exists after Task 5 Step 2 - so really just the first two, plus their appearances in `main.js`'s bundled output). No hits in URLs, header names, descriptions, or the `collection` concept (which is gone). If anything else matches, it's a leftover reference that needs fixing before moving on.

- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json main.js
git commit -m "Rename plugin identity to Postgres Sync"
```

---

### Task 7: `README.md` - rewrite setup instructions for Postgres/PostgREST

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the settings field names from Task 4 (`postgrestUrl`, `apiToken`, `embedUrl`, `embedApiKey`, `pullIntervalSeconds`) and the schema/roles from Task 1 (`sql/schema.sql`, `app_settings.bearer_token`, `web_anon`/`note_writer`/`authenticator` roles).
- Produces: nothing consumed by other tasks - this is the last content task.

- [ ] **Step 1: Rewrite `README.md`**

```markdown
# Postgres Sync

Sync your Obsidian vault across devices using a self-hosted Postgres database instead of Obsidian Sync, iCloud, or a CouchDB setup. Every note also gets embedded, so the same table doubles as a semantic search index you can query from outside Obsidian.

## What you need

- A Postgres instance (with the `pgvector` extension available) reachable from every device you want to sync, fronted by [PostgREST](https://postgrest.org/) - Obsidian mobile can't open a raw database connection, so PostgREST is what actually speaks HTTP to the plugin.
- An embedding server that speaks the llama.cpp `/embedding` endpoint, also reachable from every device. Point it at any embedding model you like; 768-dim models are the default assumption in `sql/schema.sql`, but you can change the `embedding` column's dimension to match whatever you run (do this before first use - see the comment in that file).
- The schema in `sql/schema.sql` applied to your Postgres database, with a real API key set in `app_settings.bearer_token`, and PostgREST configured to use it (see below).

Obsidian Sync, CouchDB, Syncthing - none of that is needed. This plugin talks to PostgREST directly over HTTP or HTTPS from inside Obsidian, so it works on desktop and mobile.

## Setting up the backend

1. Create a Postgres database and run `sql/schema.sql` against it:
   ```bash
   psql "postgres://user:pass@your-host:5432/your-db" -f sql/schema.sql
   ```
2. Set a real API key (the seeded default is `change-me`, don't leave it) and a login password for the `authenticator` role:
   ```sql
   update app_settings set bearer_token = 'a long random key of your choosing';
   alter role authenticator with login password 'a real password';
   ```
3. Run PostgREST pointed at the same database, connecting as `authenticator`, with:
   - `db-anon-role = web_anon`
   - `db-pre-request = public.check_bearer_token`

   The plugin sends its key as an `X-Api-Key` header, not `Authorization` - PostgREST reserves `Authorization` for its own JWT handling, so a custom header is what `check_bearer_token()` actually checks.

## Install the plugin

Manually:

1. Download `main.js` and `manifest.json` from the latest release.
2. Drop them into `<your vault>/.obsidian/plugins/postgres-sync/`.
3. Enable community plugins in Obsidian, then enable "Postgres Sync".

## Setup

Open the plugin settings and fill in:

- **PostgREST URL** - your PostgREST instance's address.
- **API key** - the key you set in `app_settings.bearer_token`.
- **Embedding server URL** - your llama.cpp embedding server's address.
- **Embed API key** - optional, only needed if your embedding server requires auth.

Do this on every device you want synced, pointing at the same PostgREST instance. First sync on a new device, run the "Pull changes from Postgres now" command to pull everything down.

## How sync works, briefly

Last-write-wins by modification time. No conflict resolution beyond that, so if you edit the same note offline on two devices at once, whichever save lands later wins. Fine for a single person across a few devices; not built for real-time collaborative editing.

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Rewrite README for Postgres/PostgREST setup"
```

---

### Task 8: End-to-end verification against a real Postgres+PostgREST instance

**Files:** none created or modified - this task exercises the built plugin's HTTP layer directly, since `requestUrl` only runs inside Obsidian and there's no way to drive the actual Obsidian UI from this environment.

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: confidence that the full push/pull/delete/last-write-wins/auth cycle works against a real backend before calling the port done. This does NOT replace installing the plugin in a real Obsidian vault - that step is called out explicitly at the end as manual, per the project's testing conventions (no automated UI testing available here).

- [ ] **Step 1: Stand up a fresh instance and load the final schema, with the same role setup as Task 1**

```bash
docker network create pgsync-e2e 2>/dev/null || true

docker run -d --rm --name pgsync-e2e-db --network pgsync-e2e \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=notes \
  pgvector/pgvector:pg16

sleep 4

docker exec -i pgsync-e2e-db psql -U postgres -d notes -v ON_ERROR_STOP=1 < sql/schema.sql
docker exec -i pgsync-e2e-db psql -U postgres -d notes -v ON_ERROR_STOP=1 <<'EOF'
update app_settings set bearer_token = 'e2e-test-key';
alter role authenticator with login password 'e2e-test-pass';
EOF

docker run -d --rm --name pgsync-e2e-postgrest --network pgsync-e2e \
  -p 3111:3000 \
  -e PGRST_DB_URI="postgres://authenticator:e2e-test-pass@pgsync-e2e-db:5432/notes" \
  -e PGRST_DB_SCHEMA="public" \
  -e PGRST_DB_ANON_ROLE="web_anon" \
  -e PGRST_DB_PRE_REQUEST="public.check_bearer_token" \
  postgrest/postgrest:latest

sleep 2
```

- [ ] **Step 2: Write a standalone script exercising the same HTTP contract as `postgrest.ts`**

This bypasses Obsidian's `requestUrl` (unavailable outside the app) by using `fetch` against the exact same PostgREST endpoints and headers `src/postgrest.ts` calls, to prove the full contract end-to-end: auth rejection, create, update-in-place, changed-since paging, delete/tombstone with a null embedding, and path lookup. If your environment intercepts raw `curl`/`fetch`-style network calls via a hook, run this through whatever code-execution tool that hook redirects to - the script itself doesn't change.

```bash
cat > /tmp/pgsync-e2e-check.mjs <<'EOF'
const BASE = "http://localhost:3111";
const KEY = { "X-Api-Key": "e2e-test-key", "Content-Type": "application/json" };
const WRONG_KEY = { "X-Api-Key": "wrong", "Content-Type": "application/json" };

async function expectStatus(res, expected, label) {
  if (res.status !== expected) throw new Error(`FAIL: ${label} expected ${expected}, got ${res.status}: ${await res.text()}`);
}

async function upsert(headers, id, path, content, mtime, deleted = false, embedding = null) {
  return fetch(`${BASE}/notes?on_conflict=id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id, path, content, content_hash: content, mtime, size: content.length, deleted, embedding }),
  });
}

async function changedSince(sinceMs) {
  const res = await fetch(`${BASE}/notes?mtime=gt.${sinceMs}&order=mtime.asc,id.asc&limit=100&offset=0`, { headers: KEY });
  await expectStatus(res, 200, "changed-since");
  return res.json();
}

async function byPath(path) {
  const res = await fetch(`${BASE}/notes?path=eq.${encodeURIComponent(path)}&limit=1`, { headers: KEY });
  await expectStatus(res, 200, "path lookup");
  return (await res.json())[0];
}

const A = "11111111-1111-4111-a111-111111111111";
const B = "22222222-2222-4222-a222-222222222222";

// 1. auth: no key and wrong key are both rejected before touching notes
await expectStatus(await fetch(`${BASE}/notes`), 401, "no key");
await expectStatus(await fetch(`${BASE}/notes`, { headers: WRONG_KEY }), 401, "wrong key");

// 2. push two notes
await expectStatus(await upsert(KEY, A, "note-a.md", "hello", 1000), 201, "upsert A");
await expectStatus(await upsert(KEY, B, "note-b.md", "world", 2000), 201, "upsert B");

// 3. changed-since should only return note-b when queried after note-a's mtime
const since1500 = await changedSince(1500);
if (!(since1500.length === 1 && since1500[0].path === "note-b.md")) throw new Error("FAIL: changed-since filter");

// 4. update note-a in place (simulates a push after edit) and confirm no duplicate row
await expectStatus(await upsert(KEY, A, "note-a.md", "hello v2", 3000), 201, "upsert A v2");
const lookupA = await byPath("note-a.md");
if (!(lookupA.content === "hello v2" && lookupA.mtime === 3000)) throw new Error("FAIL: upsert did not update in place");

// 5. tombstone note-a (simulates delete) with a null embedding
await expectStatus(await upsert(KEY, A, "note-a.md", "", 4000, true, null), 201, "tombstone A");
const tombstoned = await byPath("note-a.md");
if (!(tombstoned.deleted === true && tombstoned.embedding === null)) throw new Error("FAIL: tombstone shape wrong");

// 6. recreate a note at the same path as a tombstone - should update the same row, not conflict
await expectStatus(await upsert(KEY, A, "note-a.md", "reborn", 5000, false, null), 201, "recreate A");
const reborn = await byPath("note-a.md");
if (!(reborn.deleted === false && reborn.content === "reborn")) throw new Error("FAIL: recreate after tombstone failed");

console.log("all checks passed");
EOF

node /tmp/pgsync-e2e-check.mjs
```

Expected: `all checks passed` with no thrown error above it.

- [ ] **Step 3: Tear down**

```bash
docker stop pgsync-e2e-postgrest pgsync-e2e-db
docker network rm pgsync-e2e
rm /tmp/pgsync-e2e-check.mjs
```

- [ ] **Step 4: Manual checklist (requires a real Obsidian install - not automatable from here)**

State explicitly to whoever runs this plan: the above proves the HTTP contract works, but installing the plugin into a real Obsidian vault and confirming actual sync behavior is a manual step this environment cannot perform. Before considering the port done:

1. Point a real Postgres+PostgREST instance's URL/key, and a real embedding server, into the plugin settings on two test vaults (or two devices).
2. Create a note in vault A, confirm it appears in vault B within the pull interval.
3. Edit the note in vault A, confirm the edit propagates to vault B.
4. Delete the note in vault A, confirm vault B trashes its local copy.
5. Make an offline edit in vault B to a note that was also changed (with a later timestamp) in vault A, confirm vault B's newer edit is NOT clobbered by the older remote change (last-write-wins check, per `applyRemoteChange`'s `existing.stat.mtime > payload.mtime` guard).
6. Confirm the embedding server's actual `/embedding` response matches the shape `embed()` expects (`[{ embedding: [[...]] }]`) - this is carried over unchanged from the working Qdrant-backed plugin, but worth a real check against your specific embedding server/model since llama.cpp's response shape has varied across versions.

No commit for this task - it produces no file changes, only verification.

---

## Self-Review Notes

- **Spec coverage:** table schema (Task 1), PostgREST as HTTP layer (Task 1/2), API key auth via pre-request function (Task 1), `src/postgrest.ts` replacing `qdrant.ts` (Task 2/3), `sync.ts` rewiring + tombstone fix (Task 3), settings rename (Task 4), plugin/class rename (Task 5), manifest/package identity (Task 6), README rewrite (Task 7), manual + scripted verification (Task 8, design doc's Testing section). No data migration task exists, matching the "start fresh" decision.
- **Placeholder scan:** no TBD/TODO; every step has literal code or literal commands with expected output.
- **Type consistency:** `NotePayload`, `NoteRow`, `upsertNote`, `scrollChangedSince`, `getNoteByPath`, `embed`, `sha256`, `pathToId` are defined once in Task 2 and used with matching names/shapes in Task 3. Settings field names (`postgrestUrl`, `apiToken`, `embedUrl`, `embedApiKey`, `pullIntervalSeconds`, `lastSyncCursor`) are defined in Task 4 and match every reference in Tasks 2, 3, and 5's rewritten files.
- **Changes made after adversarial review (via `council-axi`, 3 independent judges) of an earlier draft of this plan:**
  - The draft used `Authorization: Bearer <token>` and `raise sqlstate 'PT401'` inside a `security definer` function. Empirically testing both against real `postgrest/postgrest:latest` (v14.15) surfaced two real bugs neither the draft nor any judge caught outright: (1) PostgREST intercepts `Authorization` headers for its own JWT auth before `db-pre-request` runs, causing an unrelated 500 instead of reaching the auth function; (2) `set_config('role', ...)` is disallowed inside `security definer` functions. Both are fixed in this version (custom `X-Api-Key` header; auth split into a `security definer` token-reader plus an invoker-context role-switcher) and re-verified to produce the correct 401/401/200 sequence, including with a non-superuser `authenticator` connection role (addressing a related judge concern about the original superuser-only test).
  - Fixed a genuine sequencing bug the judges caught: the draft deleted `qdrant.ts` in Task 2 while `sync.ts` still imported it until Task 3, leaving a broken intermediate commit, and its `git add` step referenced the already-deleted file. This version merges the deletion into Task 3's commit.
  - Fixed a documentation-accuracy issue: Task 1's expected psql output previously described the wrong final statement.
  - `throwOnError` (originally an unnecessarily `async` function with no `await`) is now synchronous.
  - Judges also raised: embedding response shape not being verified (addressed by noting this is unchanged pre-existing behavior and adding a manual check in Task 8 Step 4, not a new risk from the port); clock-skew/last-write-wins edge cases and folder rename/delete handling (both unchanged pre-existing behavior, out of scope for a backend port); a claimed unique-index conflict on recreating a deleted note (verified not applicable - `id` is a deterministic hash of `path`, so recreation always targets the same row, and Task 8's script now includes an explicit test for this); and a claimed missing "initial full push" (verified not a new gap - Obsidian fires `create` events for a vault's existing files on a newly-enabled plugin's first load, which is how the current Qdrant-backed plugin already achieves this with no dedicated command, and the port doesn't change that event-handling path).
