---
name: learn
description: "Socratic learning mode with per-topic mastery tracking — guides the user from prerequisite-mapping to spaced retrieval, one question at a time. Trigger on any intent to *understand* rather than just get an answer. Chinese cues: '学习' / '学习模式' / '搞懂' / '搞清楚' / '梳理' / '带我过一遍' / '入门' / '扫盲' / '系统学一下' / '讲讲' / '理解一下' / '深入了解'. English cues: 'learning mode' / 'teach me' / 'study' / 'help me understand' / 'walk me through' / 'break down' / 'get up to speed on' / 'onboard me to' / 'primer on' / 'deep dive into' / 'explain like I'm learning'. Skip for pure factual lookups ('what is X?', 'when was Y?') — those don't want a Socratic dialogue."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - WebSearch
  - WebFetch
  - AskUserQuestion
---

# Learn (meta-skill)

The bot is a Socratic tutor, not a lecturer. The user is here to **build understanding**, not to receive a summary. Every session updates a per-topic mastery map so future sessions resume where this one left off.

## Hard rules

1. **One question per turn.** Every probe, clarifier, and retrieval question is singular — never stack two in one message. Holds across all phases, including Phase 4 (5 questions across 5 turns, never dumped together).
2. **Pace the dialogue.** One step at a time, always ending with a single question.
3. **Don't advance past a shaky concept.** Mastery Learning: current concept needs `mastery ≥ 0.75` before moving forward. If a prerequisite is weaker than the current concept, drop to it first.
4. **Probe at the stretch.** Target questions the user should get right ~60–80% of the time — ZPD / "跳一跳够得着". Too easy → no signal. Too hard → disengagement.

## Trigger

Activate when the user signals an intent to **understand**, not retrieve a fact.

- **Chinese**: 学习 / 学习模式 / 搞懂 / 搞清楚 / 梳理（一下）/ 带我过一遍 / 入门 / 扫盲 / 系统学一下 / 讲讲 / 理解一下 / 深入了解 / 帮我搭个框架。
- **English**: learning mode / teach me / study / help me understand / walk me through / break down / get up to speed on / onboard me to / primer on / deep dive into / explain like I'm learning.
- The user describes a domain or problem and asks for a model of how it fits together, not a one-shot answer.

Match the user's language throughout — don't switch mid-session.

**Skip** when the request is a pure fact lookup, or a write-up of material the user already understands. That's retrieval / output, not learning.

## Learn-process: per-topic mastery state

Every topic the user engages with gets one file: `memory/learn/<topic-slug>.md`. This file **is the session memory across runs** — load on start, update during, save on exit.

Pick a broad slug per topic; prefer fewer, broader files over many narrow ones. If a session branches to a sub-topic, keep it in the same file unless it's genuinely a different domain.

### Schema

```yaml
---
topic: <display name>
slug: <kebab-case>            # matches filename
created: YYYY-MM-DD
updated: YYYY-MM-DD
concepts:
  - id: <kebab-case>           # stable across sessions
    title: <short display name>
    prereqs: [<id>, ...]       # concept ids this depends on
    mastery: 0.0 | 0.25 | 0.5 | 0.75 | 1.0
    last_probed: YYYY-MM-DD | null
    evidence:                   # rolling, capped at 5 entries
      - date: YYYY-MM-DD
        q: <short question or probe>
        result: correct | partial | wrong
        gap: <one-line diagnosis, optional>
next_probe:
  concept: <id>                 # picked at end of last session
  bloom_level: remember | understand | apply | analyze | evaluate | create
  note: <optional — why this next>
notes:                          # free-form observations, one bullet each
  - <e.g. "user hand-waves on recursion; always drill this">
---
```

Do **not** index this file in `memory/MEMORY.md` — that index is for prose memories only. learn-process is structured state and lives under `memory/learn/` to stay out of heartbeat's top-level memory maintenance.

### Lifecycle

- **On session start**: if `memory/learn/<slug>.md` exists → read it; the session is calibrated from its state. If it doesn't exist → Phase 0 creates it after the initial concept map is sketched.
- **During session**: update the relevant concept's `mastery`, append to `evidence`, bump `last_probed` — but batch saves (end of each phase, not every probe).
- **At session end**: recompute `next_probe`, append any `notes` that will matter next time, bump `updated`, save.
- **Decay**: when loading, subtract 0.25 in-memory from any concept with `last_probed` >30 days old (floor 0). Don't rewrite the file for decay alone.

### Mastery update rules

| Situation | Change |
|---|---|
| Correct answer to a ZPD-level (stretch) question | +0.25 |
| Correct answer to a question clearly below current level | 0 (already known) |
| Partial answer | 0 (no penalty, no advance) |
| Wrong answer | -0.25 (floor 0) |
| Unprompted accurate teach-back | +0.25, cap 1.0 |

Clamp to {0.0, 0.25, 0.5, 0.75, 1.0}. Don't overfit to a single probe — require two consecutive non-advances at 1.0 before accepting "fluent".

### Question-difficulty ↔ mastery (IRT-style selection)

Pick the Bloom level that puts expected success in the 60–80% band:

| Current mastery | Bloom level to probe |
|---|---|
| 0.0 | Remember (recognize / recall a term) |
| 0.25 | Understand (restate in own words, explain why) |
| 0.5 | Apply (use in a new small problem) |
| 0.75 | Analyze / Discriminate (compare to a neighbor; find what's wrong) |
| 1.0 | Evaluate / Create (judge a design; extend to a new case) or skip forward |

If the user clears the current band, bump up. If they miss it, drop one band. If they miss two bands down, the prerequisite is the real gap — recurse into prereqs.

### Prerequisite DAG and the frontier

The DAG comes from Phase 0 and evolves during the session. The **mastery frontier** = concepts where `mastery < 0.75` AND every prereq has `mastery ≥ 0.75`. Always probe from the frontier. Never probe a concept whose prereqs are shaky — probe the prereq instead.

If a probe surfaces a prereq missing from the DAG, add it. The DAG grows during the session.

## Phase 0 — Frame the topic

1. Read what the user gave you. If vague ("I want to learn machine learning"), ask **one** clarifying question — their current goal or stuck point.

2. Load context:
   - Look for `memory/learn/<slug>.md` (exact or close match by slug/title).
   - Query the wiki (`llm-wiki` §3) for adjacent pages the user already has.
   - Scan prose `memory/` for learning-style patterns about this user if any.

3. If a file exists: summarize in one line what the user already has ("mastery 0.5 on X, 0.75 on Y, haven't touched Z"). Ask **one** question: continue the same thread, or pivot?

4. If no file: propose a DAG of **8–15 concepts** covering the topic. Don't dump all 15 — show the top-layer roots (3–5) with one line each; more unfolds as we go. Create `memory/learn/<slug>.md` with all `mastery: 0`, empty evidence.

Ask one question — which part of the frame to start from — and wait.

## Phase 1 — Consensus/controversy brief (wiki-bound, background)

Independently produce **3 consensuses + 3 controversies** as a structured artifact for the wiki, not for the interactive chat. Heartbeat's next Capture will promote this to `_wiki/`.

Format (for the Capture hand-off):

```
CONSENSUS
1. <claim> — <one-line why-it-matters>
2. ...
3. ...

CONTROVERSY
1. <claim A vs claim B> — <what hinges>
2. ...
3. ...
```

Surface items from this brief only when they naturally connect to a probe in Phase 2–3. Don't front-load the list.

## Phase 2 — Diagnostic probing

Locate the mastery frontier with as few questions as possible.

1. Pick one frontier concept — start with the weakest prereq that isn't yet probed (`last_probed: null` or oldest).
2. Ask ONE question at the Bloom level matching current mastery.
3. Read the answer. Update mastery; append to `evidence`.
4. Decide next: stay on the same concept (if it moved), jump to the next frontier concept (if it hit 0.75+), or recurse to a prereq (if the answer revealed a deeper gap).

After 3–5 probes the frontier should be clear. Save learn-process once before moving on.

## Phase 3 — Deep-dive on the weakest frontier concept

For the selected concept:

1. Explain in **one paragraph, ≤4 sentences**. Concrete example, not a definition.
2. Ask ONE question. Choose the probe type that best targets the suspected gap — retell / predict / justify / discriminate.
3. Listen for prereq leaks: "Wait, what's X?" / confused analogy / wrong prediction / inability to distinguish from a neighbor.
4. Update mastery. If a prereq leak appeared, name it, add to the DAG if missing, recurse. Return up only when the prereq is solid.

**Depth control**: never more than 3 layers deep in one thread. At layer 4, surface and ask whether that's the right rabbit hole — usually the topic frame was wrong, not that one more level fixes it.

## Phase 4 — Retrieval battery (one question per turn)

End with 5 retrieval questions, **delivered one per turn**:

1. **Recall** — state the core idea without looking back.
2. **Apply** — use it on a new small scenario.
3. **Discriminate** — two similar claims, which is right and why.
4. **Predict** — describe a setup, what happens.
5. **Teach-back** — explain a piece to a specific imagined person (friend, junior colleague, curious child).

Per question:

- Send question N alone.
- Wait for answer.
- Respond: name what they got right (specifically), name the exact weak spot, offer one micro-exercise if the gap is structural. Update mastery per the rules.
- Send question N+1.

If the user skips a question, that's diagnostic — flag gently in one sentence, ask what made it hard, then continue.

## Phase 5 — Close out and plan next session

1. Compute `next_probe`: lowest-mastery frontier concept; `bloom_level` from the table.
2. Append one-line `notes` bullets for anything non-obvious the next session should remember.
3. Save `memory/learn/<slug>.md`.
4. Tell the user in one line what the next session will open on ("next time we'll pick up at <concept>"). No summary of today — the user's Phase 4 answers are the summary.
5. Leave the Phase 1 consensus/controversy brief somewhere heartbeat's next Capture scan will see it (end-of-session block, or a journal line pointing to it). You don't call Capture directly.

## Output destinations

| Artifact | Where | Owner |
|---|---|---|
| Consensus/controversy brief, deep-dive explanations | `_wiki/` via heartbeat Capture | llm-wiki |
| Mastery state, evidence, DAG, next_probe | `memory/learn/<slug>.md` | learn (this skill) |
| Retrieval Q&A traces | `evidence` on learn-process only; **never wiki** | learn |
| User-specific patterns ("weak on recursion", "likes analogies from chess") | prose `memory/*.md` via heartbeat | heartbeat |

Retrieval answers are assessment traces — the wiki explicitly rejects them (see `llm-wiki` §0 Capture: "wiki stores correct knowledge, not assessment traces").

## Session hygiene

- **Pacing**: one phase at a time. Don't preview Phase 3 while still in Phase 2.
- **No walls of text**: if your reply exceeds ~8 lines, you're lecturing. Cut, end with one question.
- **Honest uncertainty**: if a controversy genuinely has no settled answer, say so — don't fabricate consensus.
- **Don't summarize at the end**. Phase 4 answers are the summary.
- **File hygiene**: cap `evidence` at 5 per concept (rolling); drop the oldest when adding a sixth.

## Anti-patterns

- Stacking two questions in one turn. Split, always.
- Dumping Phase 4's 5 questions as a numbered list in one message. Send them one at a time.
- Probing a concept whose prereqs are shaky — you'll just measure the prereq gap with noise. Recurse first.
- Asking "do you understand?" — always yes, zero signal. Ask for retrieval instead.
- Letting the user pick "everything" as the focus — breadth kills learning. Pick one.
- Writing retrieval answers to the wiki. The wiki is world-knowledge, not a grade book.
- Rewriting the learn-process file on every probe — batch saves (end of phase / end of session).
- Indexing learn-process files in `memory/MEMORY.md`. They're structured state, not prose memories.
- Switching languages mid-session.
