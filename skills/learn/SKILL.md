---
name: learn
description: "ZPD game-difficulty learning mode — probes the user in MCQ rounds (Layer A coarse + Layer B domain-specific), auto-generates a map + Pareto briefing (3 consensuses, 3 controversies), then runs a question-driven loop: ask at current difficulty → on miss, mini-teach the missed point and drop 1–2 levels → on 2 consecutive hits, bump +1. Drop fast, rise slow. No lecture-first phase — teaching happens inline, sized to the miss. Trigger on any intent to *understand* rather than just get an answer. Chinese cues: '学习' / '学习模式' / '搞懂' / '搞清楚' / '梳理' / '带我过一遍' / '入门' / '扫盲' / '系统学一下' / '讲讲' / '理解一下' / '深入了解'. English cues: 'learning mode' / 'teach me' / 'study' / 'help me understand' / 'walk me through' / 'break down' / 'get up to speed on' / 'onboard me to' / 'primer on' / 'deep dive into' / 'explain like I'm learning'. Skip for pure factual lookups ('what is X?', 'when was Y?') — those don't want a Socratic dialogue."
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

ZPD learning as a **game-difficulty loop**. Ask a question at current difficulty; on miss, **mini-teach the missed point + drop 1–2 levels**; on a clean hit, continue; **after 2 consecutive hits, bump +1**. Drop fast, rise slow. **No lecture-first phase** — teaching happens inline, sized to the miss.

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

### Step 2 — Auto-generate map + Pareto briefing

Two things in one turn, **auto-generated from Step 1 answers** — no confirmation prompt.

**(a) Dependency map — 4–8 modules.** One line each, with dependencies drawn. Mark **Start** (where the probe lands us) and **End** (user's stated goal).

**(b) Pareto briefing — the spark:**
- **The 20% that gives 80%** — 3–5 load-bearing ideas you'd tell someone in an elevator.
- **3 consensuses** — what the field broadly agrees on (stops re-litigating settled material).
- **3 controversies** — what's still debated or contested (tells the user what to hold loosely).

Present and proceed straight into Step 3. **Do not ask "does this match?"** — the learner can't judge content they haven't learned. If something is obviously mis-targeted, fix it silently before presenting. The user can course-correct mid-stream by speaking up.

If `memory/learn/<slug>.md` exists, use last session's map as a draft; otherwise create it when you present the map.

### Step 3 — The ZPD loop (main phase)

Start at the Start module at an **estimated difficulty** (novices L1–L2, intermediates L3, advanced L4). When in doubt, start one level LOW — an easy hit is free information; a miss costs a drop + mini-teach.

Repeat:

1. **Ask one question** at the current difficulty. One question per turn.
2. **Read the answer** and apply:

| Outcome | Action | Δ difficulty | Streak |
|---|---|---|---|
| **Clean hit** (correct, clear reasoning) | Continue to next sub-concept or harder variant. If this is the **2nd consecutive clean hit** at this level → bump +1, reset streak. | 0, then +1 after 2 hits | +1 |
| **Partial / hedged** | 2–3 line clarification on the hedged part; ask a reinforcing variant at the same level. | 0 | reset to 0 |
| **Miss / blank** | **Mini-teach the missed point** (6–15 lines: what / why / how, tied to the question). Drop **1–2 levels** (full miss = 2, confused miss = 1). Ask an easier related question. | −1 or −2 | reset to 0 |

3. If drop-retry still misses, escalate via the 6-level hint gradient (Step 5).
4. **Advance to the next module** when the current module has cleanly hit L5–L6 AND its core sub-concepts have all been touched.

**Rhythm check after each answer:**
- Hitting 100%? Too easy — bump even before the 2-streak is complete.
- Missing 2 in a row at L1–L2 of current module? The **prerequisite is shaky** — walk up the map, run the loop on the prior module.

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
- **Honest uncertainty.** If something is genuinely contested, say so (it belongs in the controversy list).
- **No "is it clear?" pings.** Use the next question to find out.
- **No closing summary.** `next_module` + `difficulty` + `streak` IS the state.

## Anti-patterns

- **Lecture-first.** Teaching the module before asking anything wastes turns on material the user already has and buries the real gap. Ask first; teach on miss.
- **Single-hit bump.** One right answer could be luck — rise slow (2 consecutive).
- **Timid drop.** A full miss drops 2, not 1 — drop fast.
- **Asking "is it clear?" / "which sub-part cloudy?" / "does this map match?"** The learner can't judge content they haven't learned; answers are fake or noise. Surface gaps via questions, not self-report.
- **Skipping Layer B probes in Step 1.** Without framework / paper / scale / hardware / pain-point signal, the map is a generic syllabus. Probe until saturation.
- **Stopping at 3–5 probe rounds.** Count surprises, not rounds. Broad domains need 8–10.
- **Staying at L4 when the user is missing.** Drop 2 even if it feels embarrassing — you're not being kind by leaving them stuck.
- **A map of 15 concepts.** 4–8 modules with dependencies. Larger = split.
- **Reaching L5–L6 hints repeatedly without walking up the map.** That's the "prerequisite broken" signal — change module, don't drown in hints.
- **Stacking questions.** Two questions in one turn violates one-question-per-turn.
- Switching languages mid-session.
- Indexing `memory/learn/*.md` in `memory/MEMORY.md`.
