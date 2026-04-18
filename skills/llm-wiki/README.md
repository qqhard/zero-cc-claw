# llm-wiki

Karpathy-style LLM wiki — incremental wiki compiler as a Claude Code skill.

Based on Karpathy's LLM Wiki pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): raw notes are immutable sources, `_wiki/` pages are LLM-compiled synthesis artifacts, the LLM itself is the compiler.

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
- [x] M7 — heartbeat + sleep orchestration: hourly Capture + Ingest + Recompile (heartbeat), daily Lint (sleep)

## Install

`llm-wiki` is a meta-skill. In a zero-claw project, it's installed into every bot by:

```bash
/upgrade-meta-skill
```

That copies `skills/llm-wiki/` into each `<bot>/.claude/skills/llm-wiki/`. Then run `npm install` inside each bot's skill dir (add to your setup if automating).

For vector search, add the optional dep on bots that need it:

```bash
cd <bot>/.claude/skills/llm-wiki && npm install @xenova/transformers
```

## Vault

`llm-wiki` doesn't assume where your vault lives. On first Ingest / Query, the LLM asks — or you can pre-set a path in the bot's `CLAUDE.md` so it finds it without asking. A vault is any directory with raw `.md` notes; `_wiki/` is created inside it on first Ingest.

Raws are co-maintained: you drop in articles / notes / clips; the bot also Captures durable context (learn sessions, multi-turn resolutions, promotable memory) into `<vault>/captured/YYYY/MM/...` on every heartbeat. Both paths flow through the same Ingest.

**Ownership**: `llm-wiki` operates only on its configured vault. The bot's own surfaces are owned elsewhere — `memory/` by the heartbeat / sleep crons (via `HEARTBEAT.md` / `SLEEP.md`), `.claude/skills/` (self-skills) by `evolve`, `SOUL.md` by the user directly, `USER.md` by the main Agent reactively. `llm-wiki` never reads or writes any of them.

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

See [`SKILL.md`](SKILL.md) for the LLM-facing compiler rules: Capture / Ingest / Recompile / Query / Lint.

## Heartbeat + sleep integration

zero-claw's heartbeat and sleep cron jobs orchestrate the wiki directly — no dedicated Maintain op:

- **Every heartbeat** (hourly): if material qualifies (finished learn session, multi-turn resolution, promotable memory entry), Capture it → Ingest → Recompile. Silent when nothing qualifies.
- **Daily sleep**: Lint (mechanical + semantic) and surface findings + `_wiki/inbox.md` orphans in the daily summary.

Auto-recompile is gated to simple cases (≤3 sources, small raw diff). Dense-page rewrites and orphan ingests always surface for user review — never silently applied.
