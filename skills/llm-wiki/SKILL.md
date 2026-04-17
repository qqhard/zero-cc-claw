---
name: llm-wiki
description: "Karpathy-style LLM wiki — an incremental, LLM-compiled knowledge base, co-maintained by human and bot. Use when the user asks to ingest raw notes into their wiki, recompile stale wiki pages, search their knowledge base, lint wiki consistency, or when the bot decides to capture durable context from conversation/memory into the vault as a new raw source. Wiki lives in `<vault>/_wiki/`, raw notes are everything else under the vault."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# LLM-Wiki (meta-skill)

Implementation of Karpathy's LLM Wiki pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Core idea

The wiki is a **persistent, compounding artifact** — not re-derived on every query. Three layers:

- **Raw sources** (`<vault>/` minus `_wiki/`): the source collection, **co-maintained by human and bot** (see below). Once a raw note exists, it's treated as source of truth for the wiki compiler — edits to it are rare and deliberate.
- **Wiki** (`<vault>/_wiki/`): LLM-generated, LLM-owned markdown. Summaries, entity pages, concept pages, connections. You read it; the LLM writes it.
- **Schema** (this `SKILL.md`): the conventions and workflows. Co-evolves with the user.

The human curates sources, asks questions, and drives direction. The LLM does the bookkeeping — summarizing, cross-referencing, filing, maintaining consistency — *and*, when warranted, the LLM also promotes its own running context into new raw sources (see "Raw sources: co-maintained"). That's what kills human-maintained wikis: the maintenance burden grows faster than the value. Here it doesn't, because the LLM carries it.

## Raw sources: co-maintained

Karpathy's original pattern treats raw sources as purely human-curated and immutable. We relax that: **raws can originate from either human or bot**.

**Where raws come from**:

- **Human-added** — articles clipped in Obsidian, meeting notes, journal entries, papers, whatever the user drops into the vault. Placed anywhere under `<vault>/` (except `_wiki/`) in whatever structure the user prefers.
- **Bot-captured** — consolidations the bot itself writes to the vault when a running conversation, memory entry, or recurring theme is worth preserving as a durable source. See op §0 Capture.

**Attribution**:

- Use frontmatter `origin:` — `human` (default, may be omitted), `bot`, or `imported` (e.g. web-clip). The bot-written raws carry `origin: bot` and `captured: YYYY-MM-DD` so the user can review them at any time.
- Default directory for bot-captured raws: `<vault>/captured/YYYY/MM/<slug>.md`. If the user's vault already has a folder convention (e.g. `<vault>/notes/` for raws), ask once, record the choice in the vault's `CLAUDE.md` or an adjacent schema note, and follow it thereafter.

**Invariant**: once a raw exists (from either origin), both sides treat it the same — it's compiled into the wiki via Ingest, tracked via `sources:` dep edges, and only edited in rare, deliberate ways. The *origin* is metadata, not a lifecycle distinction.

**Boundary with `evolve`**: `evolve` maintains the bot's own memory (`memory/`, `SOUL.md`, self-skills). `llm-wiki` maintains the shared knowledge vault. When the bot decides something in its private memory has grown to deserve *shared* preservation (durable, queryable, cross-linked), Capture promotes it from `memory/` into the vault — that's where the two skills meet.

## Two navigation files (live in `_wiki/`)

- **`_wiki/index.md`** — content-oriented catalog. Every wiki page listed with a link + one-line summary, grouped by category (concepts, entities, sources). LLM updates on every Ingest. LLM reads **first** on Query to find relevant pages before drilling in.
- **`_wiki/log.md`** — chronological append-only record. Each entry starts with `## [YYYY-MM-DD HH:MM] <op> | <title>` so `grep "^## \[" _wiki/log.md | tail -20` works. Track ingests, recompiles, non-trivial queries that were filed back, lint passes.

## Our additions on top of Karpathy

Not in the original gist — ours, for an always-on Telegram-bot use case:

- **Co-maintained raws** — bot can Capture durable context into the vault's raw layer, not just Ingest what the user provides.
- **`sources:` dependency edge** in page frontmatter → the `meta.json` Makefile knows which pages go stale when a raw changes.
- **Recompile** op (§2) — incremental invalidation of dirty pages. Runs every heartbeat (cheap, silent when clean).
- **Heartbeat cadence** — every hour Capture+Recompile keep the wiki fresh; the last heartbeat of the day runs Lint for health review. No dedicated "Maintain" op; the heartbeat skill orchestrates directly.
- **BM25 / vector search** via `wiki-search` (analogous to qmd; see §"Enabling vector search").

**Never touch `.wiki-cache/` manually** — scripts own it.
**The `sources:` list is the dep edge.** Without it, Recompile can't invalidate the page.

## Environment

Every operation expects a vault path. Find it from:
1. User-provided path (e.g. `ingest /path/to/vault/notes/x.md`)
2. Current working directory if it contains `_wiki/`
3. Ask the user if neither applies

Scripts live in `<skill>/scripts/`. Run them with `node`.

## Operations

### 0. Capture — promote bot context into a raw source

Use when the bot has accumulated material (chat, journal, memory entry, recurring theme) that deserves to live as a durable raw source in the vault, not just in `memory/`. Capture **writes a new raw .md** and then hands off to Ingest.

**When to Capture** (any of the following). The heartbeat skill checks these at the cadence noted — see `skills/heartbeat/SKILL.md`:

*Per-heartbeat (last-hour signals):*

- A `learn` session just wrapped — the consensus/controversy map, deep-dive, 20/80 extraction, and retrieval Q&A are exactly the kind of compounding material the vault exists for.
- A multi-turn exchange produced a consolidated fact/analysis/decision that you'll want to cite later, and no existing raw or wiki page holds it.
- The user explicitly says "remember this as a note" / "保存下来" / "记到 wiki 原始区".
- The user sends in free-form content ("here's what I've been thinking about X...") and asks to file it.

*Last-heartbeat-of-day only (fires after `evolve`):*

- `evolve` / EOD distillation surfaces a `memory/` entry or `SOUL.md` phrase that has outgrown private-memory format — structured enough to become a source, queryable to the user, worth cross-linking. Promote to vault here rather than leaving it in private memory.

Do **not** Capture when:

- The material belongs in `memory/`, `SOUL.md`, or a self-skill — that's `evolve`'s scope. Capture is only for vault-worthy content.
- The content is ephemeral or trivially re-derivable.
- A matching raw or wiki page already captures it (extend that instead).

**How to Capture**:

1. Pick destination. Default: `<vault>/captured/<YYYY>/<MM>/<slug>.md`. If the vault has a schema note declaring a different folder for bot-captured content, follow it.
2. Write the raw with frontmatter:
   ```yaml
   ---
   title: <short descriptive title>
   origin: bot
   captured: YYYY-MM-DD
   basis: <one-line what this was distilled from — "chat 2026-04-17" / "memory/foo.md superseded" / "journal pattern over last 7 days">
   ---
   ```
3. Body: the content itself, in prose or structured sections. Don't over-format — Ingest will extract what matters when it compiles this into wiki pages. Aim for a clean, self-contained note someone could read independently.
4. Append to `_wiki/log.md`:
   ```
   ## [YYYY-MM-DD HH:MM] capture | <title>
   - path: captured/YYYY/MM/slug.md
   - basis: <same as frontmatter>
   ```
5. Immediately proceed to **Ingest** (§1) with the new raw as input. Capture-without-Ingest leaves the wiki untouched; both halves should happen in one motion.
6. Report to the user: what was captured, where it landed, what wiki pages changed as a result. The user can review `captured/` later and delete/edit anything that shouldn't have been saved.

**Size discipline**: one Capture = one focused topic in one file. If the material spans topics, write multiple files. Don't dump an entire chat transcript.

### 1. Ingest `<raw-path>` — compile new source

Self-reference first. You are about to write wiki pages, and the existing wiki is your own prior work — consult it before writing.

1. Read `_wiki/index.md` (if it exists) to see the shape of the existing wiki.
2. `node scripts/wiki-search.mjs <vault> "<topic from raw filename/heading>" --k 10 --json`
   Find pages related to this source.
3. Read the raw note fully. Read the top candidate wiki pages.
4. Decide per candidate page: **new page** vs **extend existing page** vs **split an over-grown page**. Prefer extending over creating. Prefer splitting when a page crosses ~400 words on distinct sub-topics. A single raw source often touches 10-15 wiki pages.
5. Write/edit wiki pages under `_wiki/concepts/`, `_wiki/entities/{people,organizations,tools}/`, or `_wiki/sources/`. Use the frontmatter contract below.
6. For each page you touched:
   - Append the raw path to `sources:` (vault-relative, e.g. `notes/2026/foo.md`). **Required — this is the dep edge.**
   - Add bidirectional `[[links]]` in body and `related:` between this page and any page it references.
   - Bump `updated:` to today.
   - Note contradictions: if a new source contradicts an existing claim on a page, don't silently overwrite — record both and flag which source supports which (brief inline note or a `confidence:` downgrade).
7. Update `_wiki/index.md`: add entries for new pages (link + one-line summary, under the right category). Revise summaries for pages whose scope materially changed. Create the file if missing, using categories: Concepts, Entities (People / Orgs / Tools), Sources.
8. Append to `_wiki/log.md`:
   ```
   ## [YYYY-MM-DD HH:MM] ingest | <raw-title-or-path>
   - pages: [[Page One]], [[Page Two]]
   - note: <one-line what was added or why>
   ```
   Create the file if missing.
9. Build + stamp + index:
   ```
   node scripts/wiki-graph.mjs <vault>
   for each page you touched: node scripts/wiki-graph.mjs <vault> --stamp <page>
   node scripts/wiki-index.mjs <vault>
   ```
10. Report to user: what pages changed, what links were added, any pages you almost wrote but folded into existing ones, any contradictions flagged.

### 2. Recompile — invalidate dirty pages

Run when the user says "recompile", "the sources changed", or **on every heartbeat**. Cheap and silent when nothing is dirty.

1. `node scripts/wiki-graph.mjs <vault>` (refresh raw hashes)
2. `node scripts/wiki-graph.mjs <vault> --diff --json` → `{dirtyPages, orphanSources}`
3. Classify each dirty page by risk:
   - **Simple** — ≤3 sources AND the raw diff is small (few lines changed). Auto-Recompile these.
   - **Dense** — more sources, or the raw diff is large, or the page is long. **Don't silently rewrite** — list these for user review in the next report. Touched in user-invoked `recompile` only if the user explicitly confirms, or passes a force flag.
4. For **each simple** dirty page:
   - Read the page + every `source:` it declares (current filesystem content).
   - Rewrite only the sections the sources no longer support. Keep what's still accurate. Add what's new. Preserve `related:` links unless the topic changed.
   - Save the page. Bump `updated:`.
   - Stamp it: `node scripts/wiki-graph.mjs <vault> --stamp <page-rel-path>` — this writes the current raw hashes into the page's `sourceHashes`, clearing the dirty flag.
5. For **orphan sources** (raw files the wiki doesn't reference yet):
   - Append them to `_wiki/inbox.md` (appended, never rewritten) if not already listed.
   - Do **not** auto-Ingest. Surface them in the report so the user can decide.
6. `node scripts/wiki-index.mjs <vault>` (re-index changed pages) — only if anything changed.
7. If a page's scope or one-liner changed, update its entry in `_wiki/index.md`.
8. Append to `_wiki/log.md` **only if something changed**:
   ```
   ## [YYYY-MM-DD HH:MM] recompile | <short reason>
   - pages: [[Page One]], [[Page Two]]
   - sources: notes/a.md, notes/b.md
   ```
9. Report format: silent if nothing happened. Otherwise: what was auto-recompiled, what dense pages need user review, what orphan sources landed in inbox. Heartbeat callers pass this upward; user-invoked calls show it directly.
10. Final `--diff` should return empty `dirtyPages` (modulo dense pages deferred to user). If simple pages remain dirty, you missed stamping.

### 3. Query `<topic>` — look up compiled artifacts

1. Read `_wiki/index.md` first. Often the answer is "this page exists" and you can skip search entirely.
2. If the index didn't resolve it, or you suspect related pages beyond what it lists: `node scripts/wiki-search.mjs <vault> "<topic>" --k 10 --json`
3. Read the top 3-5 candidate pages. Follow `[[links]]` in bodies (= graph traversal) for 1-2 hops when the answer spans pages.
4. Synthesize. Cite which pages you drew from (and any raw sources if you dipped into them).
5. Output format matches the question — a markdown answer, a comparison table, a slide (Marp), a chart, whatever fits.
6. **File valuable synthesis back as a new wiki page** (first-class, not optional). If your answer pieced together an analysis, comparison, or connection that the wiki didn't already have, create a new page for it — the synthesis compounds just like an ingested source. Treat your chat as the raw source; `sources:` points to the original raws you pulled from. Append a `## [YYYY-MM-DD HH:MM] query | <topic>` entry to `_wiki/log.md` when you file a query back. Skip only when the answer is trivial retrieval (the page already says it).

### 4. Lint

Health-check the wiki. Two layers:

**Mechanical** (script-checkable):
`node scripts/wiki-lint.mjs <vault>` → broken `[[links]]`, islands (no inbound + no outbound), missing frontmatter. Exit code 2 when issues exist — useful for heartbeat gating.

**Semantic** (LLM reads and judges — run when user asks "lint" explicitly):
- Contradictions between pages (page A says X, page B says not-X, both citing sources).
- Stale claims newer sources superseded (page still reflects an older source's view).
- Important concepts mentioned across pages but lacking their own page.
- Missing cross-references (page A mentions concept page B exists for, but doesn't `[[link]]` it).
- Data gaps a web search could fill — surface these as "suggested follow-ups," don't auto-search.

Report both layers together. Ask before fixing.

## Heartbeat orchestration

`llm-wiki` has no dedicated "Maintain" op. The heartbeat skill is the conductor — every hour it decides whether any of the ops below should fire:

| Cadence | Action | Why |
|---|---|---|
| Every heartbeat | **Capture** recent durable context (if warranted), then **Ingest** each new raw, then **Recompile** | Keep raws flowing into the vault and wiki pages close to their sources. All three silent when there's nothing to do. |
| Last heartbeat of the day | **Lint** (mechanical first, semantic when warranted) | One daily sweep for contradictions, broken links, orphan inbox, islands. Surface in the daily summary. |

See `skills/heartbeat/SKILL.md` for the exact flow. The ops themselves (§0-§4 above) don't care who called them.

### Capture cadence on heartbeat

Capture runs at two cadences (see `skills/heartbeat/SKILL.md` for the actual flow):

- **Every heartbeat** — last-hour signals only: finished `learn` session, multi-turn resolution worth reusing, explicit user ask.
- **Last heartbeat of the day, after `evolve`** — promote `memory/` or `SOUL.md` entries that distillation + evolve surfaced as vault-worthy.

One Capture per focused topic, not one per chat.

## Enabling vector search (one-time per vault)

Vector search is optional. BM25 + `[[link]]` graph traversal is the primary path. Enable vectors when the user mentions semantic search gaps, cross-lingual queries, or finding near-duplicates before Ingest.

When the user asks to enable vectors (or you decide to), check `.wiki-cache/config.json` first:

- If it exists: vectors already enabled — nothing to do.
- If not: ask which embedding model, then run `wiki-index --with-vectors --model <name>`.

Offer these choices, phrased for the user's language:

| choice | model | size | lang |
|---|---|---|---|
| 1 (default) | `multilingual-e5-small` | ~120MB | mixed / multilingual |
| 2 | `bge-small-zh-v1.5` | ~95MB | Chinese-heavy |
| 3 | `bge-small-en-v1.5` | ~130MB | English-heavy |

First run triggers a one-time model download to `~/.cache/huggingface/`. Once enabled, `wiki-search` auto-uses hybrid mode. Use `--bm25` to force BM25. To switch models, run `--with-vectors --model <other>` (rebuilds index). To disable, `--no-vectors`.

## Frontmatter contract

```yaml
---
title: 页面标题
type: concept | entity | source-summary
sources:
  - notes/2026/foo.md          # vault-relative, required dep edges
  - notes/2026/bar.md
related:
  - "[[Other Page Title]]"     # optional, mirrors body [[links]]
updated: 2026-04-16
confidence: high | medium | low   # optional
---
```

- `sources:` is the truth table for the compiler. Missing sources → the page can't be invalidated when raw changes → stale wiki.
- `related:` is informational; the body's `[[links]]` are what lint actually checks.

## Conventions

- Page filenames: kebab-case, ASCII when possible (`incremental-compilation.md`, not `增量编译.md`). `title:` frontmatter holds the display name.
- `[[links]]` resolve by page `title:`, not filename. Be consistent — lint will flag drift.
- When a concept is a person/org/tool, put it under `_wiki/entities/`, not `_wiki/concepts/`.
- Keep pages under ~400 words; split when they grow.
- Never edit `.wiki-cache/` by hand.

## Anti-patterns

- Forgetting `sources:` → dep edge invisible → Recompile can't find the page.
- Editing a wiki page to add new facts without touching `sources:` → `sources:` lies about which raws back the page.
- Rewriting a whole page when one section changed → wasteful; edit the affected section.
- Creating a new page when an existing one would do (silent duplication).
- Forgetting to update `_wiki/index.md` on Ingest → future queries miss the page.
- Capturing without Ingesting → raw file sits in `captured/` and never makes it into the compiled wiki; the point of Capture is the round-trip.
- Capturing content that belongs in `memory/` / `SOUL.md` / self-skills instead → that's `evolve`'s scope, not the vault. Capture is only for durable, shareable source material.
- Bulk-dumping a chat transcript as a single Capture → one file per focused topic, not one file per session.
- Letting valuable Query synthesis live only in chat → exploration doesn't compound, and you'll re-derive the same answer next week.
- Copying raw source text wholesale into wiki pages → wiki becomes a mirror, not a synthesis. Summarize, connect, cite back.
- Silently overwriting a claim when a new source contradicts an old one → record both, let the user (or a later pass) decide.
- Confusing `_wiki/index.md` (human-readable content catalog) with `wiki-index.mjs` (BM25/vector search script). They're different tools.
- Running `wiki-index` without first running `wiki-graph` — the search index reads stale meta.
