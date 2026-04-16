# wiki-skill

Karpathy-style incremental wiki compiler as a Claude Code skill.

- **raw notes = source**
- **`_wiki/` pages = compiled artifacts**
- **LLM = compiler** (rules in `skill/SKILL.md`)
- **`meta.json` = Makefile** (tracks raw↔page dependency graph)
- **BM25 + `[[link]]` graph = primary lookup**
- **Vector search = optional aux**

## Status

Milestones:

- [x] M1 — dependency graph (`wiki-graph`)
- [x] M2 — BM25 index + search (`wiki-index`, `wiki-search`)
- [x] M3 — `SKILL.md` compiler rules
- [x] M4 — lint (`wiki-lint`)
- [x] M5 — vector aux (opt-in `@xenova/transformers`)
- [x] M6 — embedding model config (`.wiki-cache/config.json`)
- [x] M7 — heartbeat-driven `Maintain` op

## Install

`wiki` is a meta-skill. In a zero-claw project, it's installed into every bot by:

```bash
/upgrade-meta-skill
```

That copies `skills/wiki/` into each `<bot>/.claude/skills/wiki/`. Then run `npm install` inside each bot's skill dir (add to your setup if automating).

For vector search, add the optional dep on bots that need it:

```bash
cd <bot>/.claude/skills/wiki && npm install @xenova/transformers
```

## Vault

`wiki` doesn't assume where your vault lives. On first Ingest / Query, the LLM asks — or you can pre-set a path in the bot's `CLAUDE.md` so it finds it without asking. A vault is any directory with raw `.md` notes; `_wiki/` is created inside it on first Ingest.

**Boundary with `evolve`**: `wiki` never touches the bot's own `skills/`, `SOUL.md`, `USER.md`, `journal/`, or `memory/`. Those are `evolve`'s domain. `wiki` operates only on its configured vault.

## CLI

```bash
VAULT=/path/to/vault

# scan vault → meta.json (dependency graph)
node scripts/wiki-graph.mjs $VAULT

# list dirty pages (source changed since compile) + orphan raw notes
node scripts/wiki-graph.mjs $VAULT --diff

# after recompiling a page, stamp current raw hashes into its sourceHashes
node scripts/wiki-graph.mjs $VAULT --stamp _wiki/concepts/foo.md

# incremental BM25 index (requires wiki-graph run first)
node scripts/wiki-index.mjs $VAULT           # incremental
node scripts/wiki-index.mjs $VAULT --full    # rebuild from scratch

# search
node scripts/wiki-search.mjs $VAULT "query" --k 10
node scripts/wiki-search.mjs $VAULT "query" --type concept --json

# lint (broken [[links]], island pages, missing frontmatter)
node scripts/wiki-lint.mjs $VAULT [--json]    # exit 2 if issues

# enable vector search (one-time, downloads ~120MB model)
node scripts/wiki-index.mjs $VAULT --with-vectors [--model multilingual-e5-small]
node scripts/wiki-search.mjs $VAULT "query"              # auto hybrid after enable
node scripts/wiki-search.mjs $VAULT "query" --bm25       # force keyword-only
node scripts/wiki-index.mjs $VAULT --no-vectors          # disable (full rebuild)
```

Models: `multilingual-e5-small` (default, mixed), `bge-small-zh-v1.5`, `bge-small-en-v1.5`. All 384-dim.

All scripts accept `--json` for machine-readable output.

See [`SKILL.md`](SKILL.md) for the LLM-facing compiler rules (Ingest / Recompile / Query / Lint / Maintain).

## Heartbeat integration

If you use zero-claw's `heartbeat` skill, add one bullet to your heartbeat SKILL.md's "Every Heartbeat" (or "Last Heartbeat of the Day" for lower frequency):

```markdown
- If a vault path is configured and contains `_wiki/`, run the `wiki` skill's Maintain operation (§5 in its SKILL.md).
```

The Maintain op is intentionally quiet — it produces output only when something needs attention. Auto-Recompile kicks in for small diffs; larger edits and new orphan sources surface as user-visible summaries, never silently applied.
