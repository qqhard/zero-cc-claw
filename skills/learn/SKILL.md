---
name: learn
description: "ZPD game-difficulty learning mode — probes the user (Layer A coarse + Layer B domain-specific MCQs), then runs a question-driven conversation: on a miss, mini-teach the missed point and drop 1–2 levels; on 2 consecutive hits, bump +1. After each test cycle, open the floor for ~3 rounds of user-driven clarifying questions before the next test. Drop fast, rise slow. **No curriculum exposed** — topic graph, module IDs, difficulty levels, streak counters are all internal state; the user experiences a conversation, not a course. Trigger on any intent to *understand* rather than just get an answer. Chinese cues: '学习' / '学习模式' / '搞懂' / '搞清楚' / '梳理' / '带我过一遍' / '入门' / '扫盲' / '系统学一下' / '讲讲' / '理解一下' / '深入了解'. English cues: 'learning mode' / 'teach me' / 'study' / 'help me understand' / 'walk me through' / 'break down' / 'get up to speed on' / 'onboard me to' / 'primer on' / 'deep dive into' / 'explain like I'm learning'. Skip for pure factual lookups ('what is X?', 'when was Y?') — those don't want a Socratic dialogue."
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

ZPD learning as a **game-difficulty conversation**. Ask a question at current difficulty; on miss, **mini-teach the missed point + drop 1–2 levels**; on a clean hit, continue; **after 2 consecutive hits, bump +1**. Drop fast, rise slow. **No lecture-first phase** — teaching happens inline, sized to the miss. **No curriculum exposed** — the user is in a conversation, not a course. Topic structure, module IDs, difficulty levels, and streak counters are Claude's internal bookkeeping; the user sees only questions, answers, mini-teaches, and clarifying exchanges.

## Three principles (the compass)

1. **ZPD stays at 70–85% success.** Every answer recalibrates. Too many hits = too easy (bump). Too many misses = too hard (drop + mini-teach). The user should almost-but-not-quite be able to answer each question.

2. **Drop fast, rise slow.** A miss drops 1–2 levels immediately. A single hit is held (could be luck). **Two consecutive hits at a level = +1.** This asymmetry is what makes the loop feel like calibrated game difficulty instead of a flat quiz.

3. **Q-driven, not lecture-first.** After Step 1 probe and Step 2 map, **don't teach the module upfront**. Ask a question at the estimated starting level. The mini-teach is the payload *after a miss*, aimed exactly at the gap that question exposed. Teach-then-test wastes turns on material the user already has.

## Workflow

### Step 1 — Multi-round MCQ probe (两层)

Probe **thoroughly**, in two layers. Most sessions need **6–10 rounds**, sometimes more. **One question per turn**, each a *different orthogonal dimension*. Prefer `AskUserQuestion` so options are explicit; the user can always free-text to elaborate.

**Layer A — coarse probes (3–4 rounds):**
- **Goal shape** — specific problem / mental model / full mastery / just curious.
- **Current level** — never heard / heard the name / used a few times / use regularly.
- **Adjacent knowledge** — pick 3–4 prerequisite concepts; ask which are solid.
- **Delivery preference** — conceptual / worked example / code walkthrough / compare-to-known.

**Layer B — domain-specific probes (3–5+ rounds):**

Layer A locates the user generically. Layer B makes the map *theirs*. Typical axes:
- **Framework / tool exposure** — which specific implementations have they used?
- **Paper / primary-source exposure** — which canonical sources have they read?
- **Scale of prior experience** — toy / single-node / production.
- **Hardware / environment** — because answers are often hardware-conditional.
- **Concrete pain point that drove them here** — with a "haven't hit one" option.
- **The one question they most want answered** — forces them to name the real goal.

Target: move from "intermediate user" to "read ZeRO paper but not Megatron; trained 4-GPU single-node with FSDP; bottleneck was OOM." That density is what makes the map targeted.

**Stop rule: signal saturation.** When 2 rounds in a row return answers that don't change the map you'd draw, stop. Don't count rounds; count surprises.

### Step 2 — Plan silently (nothing shown to the user)

After the probe, Claude **plans internally** — **none of this is presented**:

- **Dependency graph — 4–8 topic nodes** with Start (where the probe lands us) and End (user's stated goal). Stored in the state file with descriptive IDs.
- **Pareto planning notes** — the 20% load-bearing ideas, ~3 field consensuses, ~3 live controversies. Claude uses these to choose questions and to know which controversies to flag during a mini-teach. **Never presented as an upfront bulleted document.**
- **Persist** to `memory/learn/<slug>.md` (see state schema below).

Transition from probe to the first test question with **at most a 1-sentence orientation** ("OK, 从通信代价这条线切入"). No map, no syllabus, no "here are 3 consensuses" list. The user should feel they're in a conversation, not a course.

Pareto content surfaces **inline during mini-teaches** when a question happens to hit a load-bearing, settled, or contested point — not as a structured briefing.

If `memory/learn/<slug>.md` exists, continue silently from last session's state — don't announce "loading prior session," just pick up where it left off.

### Step 3 — The ZPD loop (main phase)

Start at the Start module at an **estimated difficulty** (novices L1–L2, intermediates L3, advanced L4). When in doubt, start one level LOW — an easy hit is free information; a miss costs a drop + mini-teach.

**Each cycle of the loop has three beats — all three, in order.**

**Beat 1 — Test.** Ask one question at current difficulty, in natural language. One question per turn. **Never prefix with `Q1 (M4 / L3):` or similar** — module IDs and difficulty levels are internal bookkeeping, never shown to the user. If topic context genuinely helps, use the descriptive topic name inline ("about pipeline parallelism:") — but no numbering, no level tags.

**Beat 2 — Calibrate.** Read the answer and apply:

| Outcome | Action | Δ difficulty | Streak |
|---|---|---|---|
| **Clean hit** (correct, clear reasoning) | Note the hit. **2nd consecutive clean hit at this level → bump +1, reset streak.** | 0, then +1 after 2 hits | +1 |
| **Partial / hedged** | 2–3 line clarification on the hedged part. | 0 | reset to 0 |
| **Miss / blank** | **Mini-teach the missed point** (6–15 lines: what / why / how, tied to the question). Drop **1–2 levels** (full miss = 2, confused miss = 1). | −1 or −2 | reset to 0 |

**Beat 3 — Clarify (user-driven).** After Beat 2, **open the floor** with a short invitation ("有什么想展开的吗？" / "want to dig into anything before the next question?"). Then:

- User asks clarifying questions → Claude answers inline, one exchange at a time.
- **Default budget: ~3 rounds** of user-Q → Claude-A. User controls pacing: "继续" / "next" ends Beat 3 immediately; "再问一个" extends naturally beyond 3.
- Zero rounds is fine — user may say "next" without asking anything.
- Beat 3 is **not** a self-assessment ("is it clear?" is disallowed). It's an open invitation to explore edges the test question didn't touch. User saying "continue" without questions is an answerable pacing choice, not a judgment on comprehension.
- **Claude does not start Beat 1 of the next cycle until Beat 3 resolves.**

**Advance to the next module** when the current module has cleanly hit L5–L6 AND its core sub-concepts have been touched.

**Rhythm check after each cycle:**
- Hitting 100% with empty Beat 3s every time? Too easy — bump even before the 2-streak completes.
- Missing 2 in a row at L1–L2 of current module? Prerequisite shaky — walk up the map, run the loop on the prior module.
- Beat 3 consistently running long (5+ rounds per cycle) is a signal too — the user is exploring, they're in the zone, consider holding difficulty or branching into the sub-topic they keep returning to.

**When drop-retry still misses,** escalate via the 6-level hint gradient (Step 5).

### Step 4 — Difficulty levels (anchors)

| Level | Cognitive load | Example question form |
|---|---|---|
| L1 Recognition | Pick from close options | "Which of these is X?" (MCQ) |
| L2 Recall | Reproduce a definition | "In your own words, what does X do?" |
| L3 Mechanism | Explain internal workings | "Why does X cost ∝ 2M/BW?" |
| L4 Application | Use in a new scenario | "Given constraint Y, would you use X?" |
| L5 Tradeoff | Compare, find crossovers | "When does X beat Y? Why?" |
| L6 Synthesis | Combine, design | "Design X+Y for scenario Z" |

### Step 5 — Hint gradient (when drop-retry still misses)

Escalate **one level per turn**, never skip:

1. **Rephrase** — say it differently.
2. **Narrow** — "focus on just the first half."
3. **Point to the module** — "this is about [X]."
4. **Partial structure** — "it's a two-part answer; the first part is about..."
5. **Key insight** — the single fact or move that unlocks it.
6. **Full answer + gap diagnosis** — complete answer, plus one line on what made it hard.

Reaching L5–L6 hints **repeatedly** = the prerequisite is broken. Walk up the map; don't drown in hints.

### The mini-teach (the payload after a miss)

Budget 6–15 lines. Structure:
- **What it is** — definition + one concrete example.
- **Why it exists** — problem it solves, what breaks without it.
- **How it connects** — tie to the question that was missed; set up the retry.

Use visible structure (headings, lists). End with the retry question. **Do not ask "is that clear?"** — unanswerable; the next question is the clarity test.

## Per-topic state (optional persistence)

Each topic: one file at `memory/learn/<slug>.md`. Load on start, update after each answer, save on exit.

```yaml
---
topic: <display name>
slug: <kebab-case>
created: YYYY-MM-DD
updated: YYYY-MM-DD
map:
  - id: <kebab-case>
    title: <short display name>
    prereqs: [<id>, ...]
    status: untouched | in-progress | cleared | shaky
    top_difficulty: <1–6>   # highest level the user cleanly hit here
start: <id>
end_goal: <id>
next_module: <id>
difficulty: <1–6>          # current ZPD level on next_module
streak: <0 | 1 | 2+>       # consecutive clean hits at current level
pareto:
  core: [<bullet>, ...]
  consensus: [<bullet>, ...]
  controversy: [<bullet>, ...]
notes:
  - <one-line observations about weak sub-concepts>
---
```

Do **not** index this file in `memory/MEMORY.md` — it's structured state, not prose memory.

## Session hygiene

- **Match the user's language.** Never switch mid-session.
- **One question per turn.** Probes, Q-loop questions, retries — all singular.
- **No curriculum exposure.** Module IDs, difficulty levels (L3, L4), streak counters, dependency graphs, and Pareto briefing structure are all internal. The user sees a conversation. If you find yourself writing "M4 Q1:", "Level 3:", "Module: Tensor Parallelism" — stop and rewrite as plain conversation.
- **Honest uncertainty.** If something is genuinely contested, say so inline during the mini-teach.
- **No "is it clear?" pings.** Use the next question (after Beat 3 clarify resolves) to find out.
- **No closing summary.** State is in the file; user doesn't need a recap.

## Anti-patterns

- **Lecture-first.** Teaching the module before asking anything wastes turns on material the user already has and buries the real gap. Ask first; teach on miss.
- **Exposing curriculum structure.** Presenting a dependency map, a Pareto briefing as a document, or labeling questions with "M4 Q1" / "Level 3:" / "Module 4 — Pipeline Parallelism" — the user should feel they're in a conversation, not a course. All of that is internal state.
- **Skipping Beat 3 (the clarify floor).** Jumping straight from mini-teach (or from a clean hit) to the next test question skips the user's chance to ask clarifying questions. Default ~3 rounds of user-driven Q&A between test Qs — user can "continue" to skip, but Claude must offer the floor.
- **Single-hit bump.** One right answer could be luck — rise slow (2 consecutive).
- **Timid drop.** A full miss drops 2, not 1 — drop fast.
- **Asking "is it clear?" / "which sub-part cloudy?" / "does this map match?"** The learner can't judge content they haven't learned; answers are fake or noise. Surface gaps via questions, not self-report.
- **Skipping Layer B probes in Step 1.** Without framework / paper / scale / hardware / pain-point signal, the map is a generic syllabus. Probe until saturation.
- **Stopping at 3–5 probe rounds.** Count surprises, not rounds. Broad domains need 8–10.
- **Staying at L4 when the user is missing.** Drop 2 even if it feels embarrassing — you're not being kind by leaving them stuck.
- **Internal graph of 15 nodes.** Plan 4–8 topic nodes with dependencies. Larger internal graph = you haven't decided what matters; compress or split the topic.
- **Skipping internal Pareto planning.** Even though the Pareto briefing is never shown, Claude needs the 20%/consensus/controversy notes in state to pick good questions and to know what to flag during mini-teaches.
- **Reaching L5–L6 hints repeatedly without walking up the map.** That's the "prerequisite broken" signal — change module, don't drown in hints.
- **Stacking questions.** Two questions in one turn violates one-question-per-turn.
- Switching languages mid-session.
- Indexing `memory/learn/*.md` in `memory/MEMORY.md`.
