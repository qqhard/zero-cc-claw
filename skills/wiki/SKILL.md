---
name: wiki
description: "Karpathy-style incremental wiki compiler. Use when the user asks to ingest raw notes into their wiki, recompile stale wiki pages, search their knowledge base, or lint wiki consistency. Wiki lives in `<vault>/_wiki/`, raw notes are everything else under the vault."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Wiki (meta-skill)

You are the compiler. Raw notes are the source. `_wiki/` pages are the compiled artifact. `meta.json` is the Makefile.

**Never touch `.wiki-cache/` manually** — scripts own it.
**The `sources:` frontmatter list is the dependency edge.** If you don't record it, the incremental compiler can't invalidate the page.

## Environment

Every operation expects a vault path. Find it from:
1. User-provided path (e.g. `ingest /path/to/vault/notes/x.md`)
2. Current working directory if it contains `_wiki/`
3. Ask the user if neither applies

Scripts live in `<skill>/scripts/`. Run them with `node`.

## Operations

### 1. Ingest `<raw-path>` — compile new source

Self-reference first. You are about to write wiki pages, and the existing wiki is your own prior work — query it before writing.

1. `node scripts/wiki-search.mjs <vault> "<topic from raw filename/heading>" --k 10 --json`
   Look at what pages already exist on related topics.
2. Read the raw note fully. Read the top candidate wiki pages.
3. Decide: **new page** vs **extend existing page** vs **split an over-grown page**. Prefer extending over creating. Prefer splitting when a page crosses ~400 words on distinct sub-topics.
4. Write/edit wiki pages under `_wiki/concepts/`, `_wiki/entities/{people,organizations,tools}/`, or `_wiki/sources/`. Use the frontmatter contract below.
5. For each page you touched:
   - Append the raw path to `sources:` (vault-relative, e.g. `notes/2026/foo.md`). **Required — this is the dep edge.**
   - Add bidirectional `[[links]]` in body and `related:` between this page and any page it references.
   - Bump `updated:` to today.
6. Append one line to `_wiki/_wiki-log.md`:
   ```
   - YYYY-MM-DD HH:MM ingest <raw-path> → [page1, page2] (<short reason>)
   ```
   Create the file if missing.
7. Build + stamp + index:
   ```
   node scripts/wiki-graph.mjs <vault>
   for each page you touched: node scripts/wiki-graph.mjs <vault> --stamp <page>
   node scripts/wiki-index.mjs <vault>
   ```
8. Report to user: what pages changed, what links were added, any pages you almost wrote but folded into existing ones.

### 2. Recompile — invalidate dirty pages

Run when the user says "recompile", "the sources changed", or on heartbeat.

1. `node scripts/wiki-graph.mjs <vault>` (refresh raw hashes)
2. `node scripts/wiki-graph.mjs <vault> --diff --json` → `{dirtyPages, orphanSources}`
3. For **each** entry in `dirtyPages`:
   - Read the page + every `source:` it declares (current filesystem content).
   - Rewrite only the sections the sources no longer support. Keep what's still accurate. Add what's new. Preserve `related:` links unless the topic changed.
   - Save the page. Bump `updated:`.
   - Stamp it: `node scripts/wiki-graph.mjs <vault> --stamp <page-rel-path>` — this writes the current raw hashes into the page's `sourceHashes`, clearing the dirty flag.
4. For **orphan sources**: ask the user whether to Ingest them now.
5. `node scripts/wiki-index.mjs <vault>` (re-index changed pages).
6. Append log:
   ```
   - YYYY-MM-DD HH:MM recompile [page1, page2] (sources: [a, b])
   ```
7. Final `--diff` should return empty `dirtyPages`. If any remain, you missed stamping.

### 3. Query `<topic>` — look up compiled artifacts

1. `node scripts/wiki-search.mjs <vault> "<topic>" --k 10 --json`
2. Read the top 3-5 candidate pages. Follow `[[links]]` in bodies (= graph traversal) for 1-2 hops when the answer spans pages.
3. Synthesize. Cite which pages you drew from.
4. If the synthesis is valuable and no single page captures it, offer to write a new concept page. If accepted, that's an Ingest over the synthesis (treat your chat as the raw source; `sources:` may be empty or point to the original raws you pulled from).

### 4. Lint

`node scripts/wiki-lint.mjs <vault>` → reports broken `[[links]]`, islands (no inbound + no outbound), missing frontmatter. Exit code 2 when issues exist — useful for heartbeat gating.

### 5. Maintain — heartbeat-triggered self-check

Called by a periodic loop (e.g. `skills/heartbeat`), not by the user directly. Keep it quiet: if nothing needs attention, produce no output.

1. `node scripts/wiki-graph.mjs <vault>` (refresh hashes)
2. `node scripts/wiki-graph.mjs <vault> --diff --json`
3. `node scripts/wiki-lint.mjs <vault> --json`
4. Decide:
   - **Dirty pages with few sources (≤ 3) and small raw diffs**: auto-Recompile (per §2). Log.
   - **Dirty pages with many sources or large raw diffs**: surface to user — don't silently rewrite dense pages.
   - **Orphan sources**: never auto-Ingest. Add to a pending list (`_wiki/_wiki-inbox.md`) — appended, not rewritten — and mention in daily summary.
   - **Broken links**: surface in daily summary; don't fix silently (could mask real drift).
   - **Islands**: surface weekly, not every heartbeat.
5. `node scripts/wiki-index.mjs <vault>` at the end if anything changed.

Principle: Maintain preserves the invariant "the wiki reflects its sources." It doesn't extend scope. Ingest and Query are user-facing; Maintain is janitorial.

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

- Forgetting `sources:` → dep edge invisible → recompile can't find the page.
- Editing a wiki page to add new facts without touching `sources:` → `sources:` lies about which raws back the page.
- Rewriting a whole page when one section changed → wasteful; edit the affected section.
- Creating a new page when an existing one would do (silent duplication).
- Running `wiki-index` without first running `wiki-graph` — index reads stale meta.
