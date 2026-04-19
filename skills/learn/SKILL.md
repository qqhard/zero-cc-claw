---
name: learn
description: "ZPD game-difficulty learning mode — probes the user (Layer A coarse + Layer B domain-specific MCQs, ~5 rounds default), then runs a question-driven conversation: on a miss, mini-teach the missed concept and drop 1–2 notches; on 2 consecutive clean hits, bump +1. After each test cycle, offer 2–3 concrete branches + 'next' for user-driven clarifying exchanges before the next test. Drop fast, rise slow. Difficulty is a live read of which concepts/links the user hasn't yet grasped — not a fixed ladder. **No curriculum exposed** — topic graph, node IDs, difficulty ordinals, streak counters are all internal state; the user experiences a conversation, not a course. Trigger on any intent to *understand* rather than just get an answer. Chinese cues: '学习' / '学习模式' / '搞懂' / '搞清楚' / '梳理' / '带我过一遍' / '入门' / '扫盲' / '系统学一下' / '讲讲' / '理解一下' / '深入了解'. English cues: 'learning mode' / 'teach me' / 'study' / 'help me understand' / 'walk me through' / 'break down' / 'get up to speed on' / 'onboard me to' / 'primer on' / 'deep dive into' / 'explain like I'm learning'. Skip for pure factual lookups ('what is X?', 'when was Y?') — those don't want a Socratic dialogue."
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

ZPD learning as a **game-difficulty conversation**. Ask a question at current difficulty; on miss, **mini-teach the missed concept + drop 1–2 notches**; on a clean hit, continue; **after 2 consecutive clean hits, bump +1**. Drop fast, rise slow. **No lecture-first phase** — teaching happens inline, sized to the miss. **No curriculum exposed** — the user is in a conversation, not a course. Topic structure, node IDs, difficulty ordinals, and streak counters are Claude's internal bookkeeping; the user sees only questions, answers, mini-teaches, and clarifying exchanges.

## Output discipline (check before every user-facing message)

Every message to the user must be **one of these 5 types**. If it's not, rewrite before sending.

1. **Probe question** — MCQ / preference about the user's own goals, level, experience.
2. **Test question** — one question at current difficulty, natural language, **no labels** (no "M4 Q1:", "Level 3:", "Module: Tensor Parallelism").
3. **Mini-teach** — triggered *only* by a miss; 6–15 lines scoped to the concept the question exposed.
4. **Clarify answer** — answering a branch the user picked during Beat 3.
5. **Transition** — at most 1 sentence ("OK, 从通信代价切入" / "got it, moving on").

Explicit not-allowed: upfront maps, syllabi, "here's what we'll cover" bullets, pre-teaches before any miss, unsolicited lectures, progress / streak indicators, node labels, difficulty labels, curriculum summaries.

## Three principles (the compass)

1. **ZPD = live read of what's not yet grasped.** Difficulty isn't a fixed taxonomy; it's which concepts and which links between them the user hasn't demonstrated. Stay at ~70–85% success — too many hits means you're not catching the frontier; too many misses means you're testing a concept that isn't there yet.

2. **Drop fast, rise slow.** A miss drops 1–2 notches immediately. A single hit is held (could be luck). **Two consecutive hits at a notch = +1.** This asymmetry is what makes the loop feel like calibrated game difficulty instead of a flat quiz.

3. **Q-driven, not lecture-first.** After the probe, don't teach up front. Ask a question at an estimated starting notch. The mini-teach is the payload *after a miss*, aimed exactly at the concept/link the question exposed. Teach-then-test wastes turns on material the user already has.

## Workflow

### Step 1 — Multi-round MCQ probe (两层)

Probe in two layers. **Default ~5 rounds total.** Extend past 5 only if each added round still shifts the next question Claude would ask. **One question per turn**, each a *different orthogonal dimension*. Prefer `AskUserQuestion` so options are explicit; the user can always free-text to elaborate.

**Layer A — coarse probes (pick 2–3 from this menu):**
- **Goal shape** — specific problem / mental model / full mastery / just curious.
- **Current level** — never heard / heard the name / used a few times / use regularly.
- **Adjacent knowledge** — pick 3–4 prerequisite concepts; ask which are solid.
- **Delivery preference** — conceptual / worked example / code walkthrough / compare-to-known.

**Layer B — domain-specific probes (pick 2–3, tailored to THIS topic):**

Layer A locates the user generically. Layer B makes the picture *theirs*. Typical axes:
- **Framework / tool exposure** — which specific implementations have they used?
- **Paper / primary-source exposure** — which canonical sources have they read?
- **Scale of prior experience** — toy / single-node / production.
- **Hardware / environment** — because answers are often hardware-conditional.
- **Concrete pain point that drove them here** — with a "haven't hit one" option.
- **The one question they most want answered** — forces them to name the real goal.

Target: move from "intermediate user" to "read ZeRO paper but not Megatron; trained 4-GPU single-node with FSDP; bottleneck was OOM." That density makes the internal plan targeted.

**Stop rule: signal saturation, default ~5 rounds.** Stop when 2 consecutive rounds don't shift the next question you'd ask. Extend past 5 only when each added round still brings a surprise.

### Step 2 — Plan silently (nothing shown to the user)

After the probe, Claude **plans internally** — **none of this is presented**:

- **Dependency graph — 4–8 topic nodes** with Start (where the probe lands us) and End (user's stated goal). Stored in the state file with descriptive IDs.
- **Pareto planning notes** — the 20% load-bearing ideas, ~3 field consensuses, ~3 live controversies. Claude uses these to choose questions and to know which controversies to flag during a mini-teach. **Never presented as an upfront bulleted document.**
- **Persist** to `memory/learn/<slug>.md` (see state schema below).

Transition from probe to the first test question with **at most a 1-sentence orientation** ("OK, 从通信代价这条线切入"). No map, no syllabus, no "here are 3 consensuses" list. The user should feel they're in a conversation, not a course.

Pareto content surfaces **inline during mini-teaches** when a question happens to hit a load-bearing, settled, or contested point — not as a structured briefing.

If `memory/learn/<slug>.md` exists, continue silently from last session's state — don't announce "loading prior session," just pick up where it left off.

### Step 3 — The ZPD loop (main phase)

Start at the Start node at an **estimated difficulty** — for novices, near recognition/recall; for intermediates, mechanism-level; for advanced, application. When in doubt, start one notch LOW — an easy hit is free information; a miss costs a drop + mini-teach.

**Each cycle of the loop has three beats — all three, in order.**

**Beat 1 — Test.** Ask one question at current difficulty, in natural language. One question per turn. **Never prefix with `Q1 (M4 / L3):` or similar** — node IDs and difficulty ordinals are internal, never shown. If topic context genuinely helps, use the descriptive topic name inline ("about pipeline parallelism:") — but no numbering, no level tags.

**Beat 2 — Calibrate.** Read the answer and apply:

| Outcome | Action | Δ difficulty | Streak |
|---|---|---|---|
| **Clean hit** (correct, clear reasoning) | Note the hit. **2nd consecutive clean hit at this notch → bump +1, reset streak.** | 0, then +1 after 2 hits | +1 |
| **Partial / hedged** | 2–3 line clarification on the hedged part. | 0 | reset to 0 |
| **Miss / blank** | **Mini-teach the missed concept or link** (6–15 lines: what / why / how, tied to the question). Drop **1–2 notches** (full miss = 2, confused miss = 1). | −1 or −2 | reset to 0 |

**Beat 3 — Clarify (branches + next).** After Beat 2, Claude offers **2–3 concrete branches + "下一题/next"** — each branch is a specific direction the conversation could go (drill into a sub-topic, chase a connection to adjacent material, a real-world example, a relevant controversy from Pareto notes). User points to one or picks "next".

Example shape (Chinese): *想挖 X / 转到 Y / 看 Z 的具体例子 / 下一题*

Example shape (English): *dig into X / pivot to Y / see a real example of Z / next*

- User picks a branch → Claude answers one round on that branch; can then offer branches again or move on.
- User picks "next" → move immediately to Beat 1 of the next cycle.
- **Default budget: ~3 branch-rounds per cycle.** User can follow a branch naturally past 3; Claude can gently push forward if a branch loops.
- Beat 3 is **not self-assessment**. Branches are concrete things to point at — user picks by interest, not by judging their own comprehension. "Next" with nothing picked is a valid pacing choice.
- **Claude does not start Beat 1 of the next cycle until Beat 3 resolves.**

**Advance to the next topic node** when the current one has cleanly hit the high end (tradeoff / synthesis) AND its core sub-concepts have been touched.

**Rhythm check after each cycle:**
- Hitting 100% with empty Beat 3s every time? Too easy — bump even before the 2-streak completes.
- Missing 2 in a row even after stripping the question down to its simplest concept/link? Prerequisite shaky — walk up the internal graph, run the loop on the prior topic.
- Beat 3 branches consistently pulled long (5+ rounds)? User is exploring and in the zone — hold difficulty or branch into the sub-topic they keep returning to.

**When drop-retry still misses,** escalate via the 6-stage hint gradient (Step 5).

### Step 4 — Difficulty as dynamic judgment (not a fixed ladder)

Difficulty is not a registered taxonomy. It is Claude's continuous read of **which concepts — and which links between concepts — the user hasn't yet grasped**. A question is "hard" for this user right now *iff* answering it requires activating a concept or link they haven't demonstrated.

After every answer, Claude silently judges:
- Which concepts and links did this answer show as **solid**? Lean on them next.
- Which are **shaky**? The concept is there but its connection to adjacent material is thin — hold, or aim the next question at that specific link.
- Which are **missing**? Mini-teach them; retry with a question that routes around them, then approach again.

Difficulty changes are **relative to the observed frontier**: `+1` = "one more concept or link to activate than the last clean hit"; `−2` = "strip 2 notches of dependency until you're on solid ground".

For *sorting when observation is ambiguous*, a common rubric: recognition < recall < mechanism < application < tradeoff < synthesis. Use it as a hint, not a law. Domain-specific reality overrides — if recognition with subtle distractors is harder than a simple mechanism question in this topic, trust what you see.

The internal `difficulty: 1–6` field is a running ordinal, useful for tracking direction. The ordinal *labels* are bookkeeping; the *judgment of which concepts/links are missing* is the real driver.

### Step 5 — Hint gradient (when drop-retry still misses)

Escalate **one stage per turn**, never skip:

1. **Rephrase** — say it differently.
2. **Narrow** — "focus on just the first half."
3. **Point to the concept** — "this is about [X]."
4. **Partial structure** — "it's a two-part answer; the first part is about..."
5. **Key insight** — the single fact or move that unlocks it.
6. **Full answer + gap diagnosis** — complete answer, plus one line on what made it hard.

Reaching stages 5–6 **repeatedly** = the prerequisite is broken. Walk up the internal graph; don't drown in hints.

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
graph:
  - id: <kebab-case>
    title: <short display name>
    prereqs: [<id>, ...]
    status: untouched | in-progress | cleared | shaky
    top_difficulty: <1–6>
start: <id>
end_goal: <id>
next_node: <id>
difficulty: <1–6>          # current running ordinal; see Step 4
streak: <0 | 1 | 2+>
pareto:
  core: [<bullet>, ...]
  consensus: [<bullet>, ...]
  controversy: [<bullet>, ...]
notes:
  - <one-line observations about which concepts/links are shaky>
---
```

Do **not** index this file in `memory/MEMORY.md` — it's structured state, not prose memory.

## Session hygiene

- **Match the user's language.** Never switch mid-session.
- **One question per turn.** Probes, Q-loop questions, retries — all singular.
- **No curriculum exposure.** Node IDs, difficulty ordinals (L3, L4), streak counters, dependency graphs, and Pareto briefing structure are all internal. The user sees a conversation. If you find yourself writing "M4 Q1:", "Level 3:", "Module: Tensor Parallelism" — stop and rewrite as plain conversation.
- **Honest uncertainty.** If something is genuinely contested, say so inline during the mini-teach.
- **No "is it clear?" pings.** Use the next question (after Beat 3 resolves) to find out.
- **No closing summary.** State is in the file; user doesn't need a recap.

## Anti-patterns

- **Lecture-first.** Teaching before asking anything wastes turns on material the user already has and buries the real gap. Ask first; teach on miss.
- **Exposing curriculum structure.** Presenting a dependency map, a Pareto briefing as a document, or labeling questions with "M4 Q1" / "Level 3:" / "Module 4 — Pipeline Parallelism" — the user should feel they're in a conversation, not a course. All of that is internal state.
- **Skipping Beat 3.** Jumping straight from mini-teach (or from a clean hit) to the next test question skips the user's chance to dig in. Offer 2–3 branches + "next" after every Beat 2.
- **Single-hit bump.** One right answer could be luck — rise slow (2 consecutive).
- **Timid drop.** A full miss drops 2, not 1 — drop fast.
- **Staying at the same notch after a miss.** Drop at least 1, usually 2, even if it feels embarrassing — you're not being kind by leaving them stuck.
- **Difficulty as a fixed taxonomy.** The L1–L6 rubric is a sorting hint, not a law. Domain reality overrides — recognition with subtle distractors can be harder than simple mechanism in your topic. Judge by which concepts/links aren't yet grasped, not by the label.
- **Asking "is it clear?" / "which sub-part cloudy?" / "does this match?"** The learner can't judge content they haven't learned; answers are fake or noise. Surface gaps via questions, not self-report.
- **Skipping Layer B probes in Step 1.** Without framework / paper / scale / hardware / pain-point signal, the plan is a generic syllabus. Probe until saturation.
- **Running probes on autopilot past saturation.** Default ~5 rounds; stop when 2 consecutive rounds don't shift the next question. Don't anchor to a fixed round count past saturation.
- **Internal graph of 15 nodes.** Plan 4–8 topic nodes with dependencies. Larger internal graph = you haven't decided what matters; compress or split the topic.
- **Skipping internal Pareto planning.** Even though the Pareto briefing is never shown, Claude needs the 20%/consensus/controversy notes in state to pick good questions and to know what to flag during mini-teaches.
- **Reaching hint stages 5–6 repeatedly without walking up the graph.** That's the "prerequisite broken" signal — change topic, don't drown in hints.
- **Stacking questions.** Two questions in one turn violates one-question-per-turn.
- Switching languages mid-session.
- Indexing `memory/learn/*.md` in `memory/MEMORY.md`.
