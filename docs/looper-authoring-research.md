# Research for Looper spec and PRD skills

Research date: October 2, 2026. Recommendation: build three focused skills—looper-spec, looper-prd, and looper-audit—around Looper's existing artifacts and phase protocol.

The strongest combination for this use is Poteto's Pstack engineering and verification discipline, Matt Pocock's story decomposition, Spec Kit and GSD's coverage checks, OpenSpec's explicit contract changes, and Ralph's focused context and concrete feedback. This is a comparative source review, not an execution benchmark or an exhaustive inventory of every Ralph fork. “Best” means useful for Looper: clear requirements, independently verifiable outcomes, explicit dependencies, preserved decisions, and runtime compatibility.

## Sources and recommendations

| Workflow | Practice observed in primary sources | Fit for Looper |
|---|---|---|
| Poteto's Pstack | Repository-grounded constraints, explicit migration boundaries, evidence-bearing plans, executable verification recipes, and structural checks. | Primary engineering foundation. Adapt its orchestration and review overhead to Looper. The dedicated analysis below links the relevant skills. [Collection](https://github.com/cursor/plugins/tree/main/pstack) |
| Poteto's Noodle | Planning and refinement produce bounded implementation briefs with explicit handoffs. | Useful internal task design; its tiny phases are not equivalent to independently merged Looper stories. [Planning skill](https://github.com/poteto/noodle/blob/main/.agents/skills/plan/SKILL.md) |
| Geoffrey Huntley's original Ralph | Conversational requirements become topic-specific specs. One task per loop, codebase search, and feedback guide execution. | Preserve focused context and evidence. Treat implementation plans as revisable without silently rewriting requirements. [Original article](https://ghuntley.com/ralph/) |
| The Ralph Playbook | Separates requirements, planning, and building. Proposes deriving verification requirements directly from acceptance criteria. | Adopt requirement-to-evidence mapping. The acceptance-driven section is explicitly exploratory; its context-size figures and judge loops are not universal empirical guarantees. [Playbook](https://github.com/ghuntley/how-to-ralph-wiggum) |
| Snarktank Ralph | Separate PRD-writing and JSON-conversion skills; critical questions, verifiable criteria, dependency order, and bounded stories. | Best simple artifact-pipeline baseline. Replace mutable passes, feature-wide branches, and archive/reset conventions with Looper semantics. Layer-based splitting examples need adaptation to Lando's complete-outcome rule. [PRD skill](https://github.com/snarktank/ralph/blob/main/skills/prd/SKILL.md), [conversion skill](https://github.com/snarktank/ralph/blob/main/skills/ralph/SKILL.md) |
| Matt Pocock's skills | Current to-spec synthesizes prior discussion and records testing decisions. To-tickets creates complete vertical slices with blocking edges and recognizes wide refactors as exceptions. | Strongest story-boundary model. Its expand–contract and integration-branch alternatives conflict with this Lando wave's no-shim rules. Older write-a-prd and prd-to-issues references are not the current entrypoints. [To Spec](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md), [To Tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) |
| Superpowers | Design and implementation planning are separate. Plans preserve agreed constraints and interfaces, attach verification to meaningful tasks, and check coverage and consistency. Brainstorming distinguishes spike, bounded, and architectural work. | Borrow the decisions, interfaces, and review focus. Do not import repeated approval gates or mandatory execution-skill handoffs. [Brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md), [Writing Plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md) |
| GitHub Spec Kit | Prioritized journeys have independent tests and Given/When/Then scenarios. Analysis checks ambiguity, duplication, coverage, and inconsistencies across artifacts. | Strong model for readiness review. Preserve technical requirements when those are themselves the requested outcome, as in a migration. [Spec template](https://github.com/github/spec-kit/blob/main/templates/spec-template.md), [analysis](https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md) |
| OpenSpec | Separates proposal, behavioral specifications, technical design, and tasks. Deltas distinguish added, modified, removed, and renamed requirements. Verification accompanies tasks. | Best model for later contract reconciliation. Keep tests and documentation with the work they validate; avoid adding a competing directory system. [Workflow schema](https://github.com/Fission-AI/OpenSpec/blob/main/schemas/spec-driven/schema.yaml) |
| Get Shit Done | A plan checker works backward from outcomes and checks coverage, dependencies, integration wiring, scope, and compliance with prior decisions. Findings distinguish blockers from warnings. | Borrow semantic readiness checks. An ID appearing in a plan is not proof of coverage. Numerical ambiguity scores should not replace naming the unresolved decision. [Plan checker](https://github.com/gsd-build/get-shit-done/blob/main/agents/gsd-plan-checker.md), [spec phase](https://github.com/gsd-build/get-shit-done/blob/main/commands/gsd/spec-phase.md) |
| BMad Method | Current guidance separates product PRDs, concise implementation contracts, and story ticketing. Capability IDs stay stable; story decisions feed back into specs; create, update, and validate differ. | Borrow stable IDs and change reconciliation without recreating the whole framework. [Requirements](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/plan/define-requirements-and-a-specification.md), [planning paths](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/plan/choose-a-planning-path.md) |
| Snarktank AI Dev Tasks | Parent tasks, subtasks, relevant files, and a human pause before expansion. | Useful task-list baseline. Branch creation and generic test defaults are execution instructions, not portable requirements. [Task generator](https://github.com/snarktank/ai-dev-tasks/blob/main/generate-tasks.md) |
| Anthropic Ralph Wiggum plugin | A stop hook repeats the prompt inside the current session, with completion promises and iteration limits. | A different execution model from fresh-context loops. Borrow clear success/stopping conditions; retain Looper's richer signals. [Plugin](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md) |
| fstandhartinger Ralph Wiggum | Executes from specs, with an optional detailed plan and testable acceptance criteria. | Useful reminder that small work need not produce every possible artifact. Its commit/push completion behavior belongs to separate Looper steps. [Repository](https://github.com/fstandhartinger/ralph-wiggum) |
| Ralph Orchestrator | Planning produces requirements, design, and an implementation plan; execution uses roles and events. Its own configuration rejects placeholder acceptance checks. | Borrow clear handoffs and observable proof. Looper already supplies the controller. [Repository](https://github.com/mikeyobrien/ralph-orchestrator), [configuration](https://github.com/mikeyobrien/ralph-orchestrator/blob/main/ralph.yml) |

These sources disagree about story size, implementation detail, human checkpoints, and completion authority. Copying their prompts together would create conflicts. The recommendations below are my synthesis for the inspected repository.

## Poteto: the strongest engineering foundation for this design

Poteto is Lauren Tan. The primary Pstack collection is maintained in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), whose [manifest](https://github.com/cursor/plugins/blob/main/pstack/.cursor-plugin/plugin.json) names her as author. Her [Noodle repository](https://github.com/poteto/noodle) also contains planning and refinement skills. These are related sources with different execution assumptions, not a single portable PRD template.

Pstack is my strongest engineering foundation for these Looper skills. That is a fit assessment from source inspection, not a measured claim that it outperforms every alternative. The most useful parts are:

- **Understand the constraints before designing.** The why skill separates observed history from inference and turns findings into Preserve, Change, Avoid, and Risk constraints. That would help a spec retain the reason a seemingly awkward migration boundary exists. Pair it with concrete understanding of the current code. [Why](https://github.com/cursor/plugins/blob/main/pstack/skills/why/SKILL.md)
- **Make proof part of the plan.** The multi-phase plan connects each PR to dependencies, visible behavior, checks, and retained evidence. It settles empirical questions through prototypes and leaves product choices to the user. Performance comparisons must measure comparable work; otherwise use an explicit absolute budget. For Looper, each acceptance criterion should name its observable outcome and how to prove it. [Multi-phase plan](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/multi-phase-plan.md)
- **Specify how to drive the real application.** The verification-skill generator discovers the repository's launch, interaction, observation, and isolation mechanisms. It includes readiness checks, evidence capture, and cleanup, then runs the generated instructions once. This fits Lando's compiled-binary verification. Authoring should reference an executable verification recipe and mark an untried recipe as unverified. [Create Verification Skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md)
- **Allow deliberate migration boundaries.** Outcome-oriented execution permits planned, scoped, reversible intermediate breakage and requires verification at explicit boundaries. This closely matches US-662's no-shim migration. My adaptation is to allow internal work-in-progress on the story branch while requiring the merged story to satisfy the contract; it does not authorize broken merges. [Migration principle](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-outcome-oriented-execution/SKILL.md)
- **Turn repeated mistakes into checks.** The structural-lessons principle favors enforceable mechanisms over accumulating reminders. Pstack supplies a plan checker. For Looper, implement dependency, identity, and representation checks; do not transplant Pstack's exact phrases or formatting rules. Keep questions of intent and evidence quality in the review. [Principle](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-encode-lessons-in-structure/SKILL.md), [plan checker](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/scripts/check-plan.mjs)
- **Evaluate outputs instead of trusting the prompt.** Its evaluation playbook uses a declared rubric, equivalent organic requests, isolated environments, blind output labels, and inspection of actual artifacts. Use that approach to compare the proposed skills against a baseline on the cases below. No such execution comparison was performed in this research pass. [Evaluation playbook](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/eval.md)

Noodle adds a useful distinction: its plan skill writes brief, narrowly scoped implementation phases for a later agent, with alternatives and verification. Its refine skill skips clear backlog items and resolves unclear ones into self-contained work. Its literal phase limits are much smaller than Looper's PR-sized stories. Borrow those briefs for internal execution units when useful, without turning every function into a story. [Plan](https://github.com/poteto/noodle/blob/main/.agents/skills/plan/SKILL.md), [Refine](https://github.com/poteto/noodle/blob/main/.agents/skills/refine/SKILL.md)

Adapt the machinery proportionally. Pstack's multi-PR playbook mandates ten live verification lanes and specific orchestration machinery; Noodle's planner enforces tiny file and function limits. Those are local workflow choices. Looper should size verification by the behavior and risk, and keep its own phases, signals, branch policy, and completion authority. A project-specific verification skill could follow later; the first three authoring skills can consume existing harnesses and recipes.

## What the Lando example already does well

The Effect wave has a normative specification, an implementation index, nine detailed stories, a JSON index, and a progress log. Priorities run from 75 through 83. A structural check found no duplicate story IDs or references to absent dependencies. All nine entries retain a legacy passes field.

Preserve these practices:

- A story delivers a complete outcome through one PR against main, with relevant tests and documentation.
- Exact versions, upstream evidence, rejected alternatives, and revisit conditions explain technical decisions.
- Characterization tests cover behavior changes that typechecking cannot detect.
- Gate classes distinguish ordinary, SDK, user-facing, measurement, and repository-wide migration work.
- Performance requirements include thresholds; compiled-binary journeys verify real behavior.
- Each story owns specified amendments to durable documentation.
- Build, Review, Verify, Push, and Babysit have separate responsibilities; adjudication addresses contract disputes.

Evidence: [specification](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/spec-effect-v4.md), [index](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/prd-effect-v4-00-index.md), [stories](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/prd-effect-v4-01-stories.md), [configuration](U:/home/aaron/projects/experiments/lando4-rewrite2/.local/looper/looper.yaml), [Verify](U:/home/aaron/projects/experiments/lando4-rewrite2/.local/looper/verify.md).

## Concrete gaps the skills should detect

**Atomic migration versus context size.** US-662 changes shared Effect types together because splitting independently merged packages would require a forbidden shim. The progress log records an incomplete first Build pass and a subsequent drift audit. Support an explicit large-story exception: one merge unit with a bounded internal sequence, resumable evidence, and the reason it cannot be split. Do not assume one PR must equal one invocation, or that intermediate commits are independently releasable. [Migration rationale](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/spec-effect-v4.md:48), [progress](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/progress.txt:66).

**Verification ownership is implicit.** The index requires full-suite gates, while Build and Verify prohibit the full local suite and assign it to CI. These can coexist if the contract says which checks gate implemented, verified, and merged, and where each runs. The baseline entry already substitutes CI timing for local unit-suite timing. Make the handoff explicit before execution. [Gate classes](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/prd-effect-v4-00-index.md:19), [Build rules](U:/home/aaron/projects/experiments/lando4-rewrite2/.local/looper/build.md:20), [baseline](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/progress.txt:58).

**A valid no-change result lacks an ordinary completion route.** US-670 permits recording benchmark results and shipping no code when AOT decoding misses the threshold. Build expects implemented; the run terminates at merged. With a resolvable main ref, implemented requires a commit touching a path outside the PRD directory, so a result recorded only in progress.txt cannot satisfy it. A no-op signal is not terminal completion. This is a predicted incompatibility, not an observed US-670 failure. Resolve through an explicitly supported decision-only completion policy or a genuinely required material deliverable; do not manufacture code or empty commits. [US-670](U:/home/aaron/projects/experiments/lando4-rewrite2/spec/effect-v4/prd-effect-v4-01-stories.md:217), [precondition](U:/home/aaron/projects/looper/src/lib/signal-story-phase.ts:47).

**Representations can disagree after adjudication.** Build and Verify read JSON and source Markdown. Adjudicate can amend only JSON and cannot update normative Markdown. Blindly regenerating JSON could erase an authorized adjudication; reading older Markdown could reopen the dispute. Existing bundles need an explicit reconciliation rule. A generated projection is a useful future contract, not the current universal truth. [Authority](U:/home/aaron/projects/experiments/lando4-rewrite2/.local/looper/adjudicate.md:33).

**Dependency validation belongs before execution.** The current selector ignores absent dependency IDs and deliberately selects a remaining story on dependency deadlock. The example's references are valid, but authoring should reject missing references, self-dependencies, and cycles. Cross-wave prerequisites need explicit treatment; a dangling dependsOn string does not enforce them. [Selector](U:/home/aaron/projects/looper/src/engine/story-phases.ts:92).

**Documentation must be checked against the runtime.** The README still describes git-derived phase upgrades. The actual resolver and current AGENTS guidance explicitly prohibit that inference. Skills should use the parser and resolver as compatibility evidence and flag stale documentation. [README](U:/home/aaron/projects/looper/README.md:339), [resolver](U:/home/aaron/projects/looper/src/engine/story-phases.ts:23).

## Proposed skills

| Skill | Typical request | Deliverable |
|---|---|---|
| looper-spec | Turn this idea or migration into a Looper spec. | Repository-grounded outcome, scope, behavior, constraints, decisions, proof, and unresolved questions. |
| looper-prd | Turn this spec into stories, or revise this PRD. | Complete stories, ordered dependency index, compatible prd.json, and checks that preserve existing identities and sanctioned amendments. |
| looper-audit | Is this ready for an unattended run? | Evidence-based blockers and warnings across spec, stories, JSON, configuration, and relevant step prompts, with proposed resolutions. Review-only requests remain read-only. |

Discovery belongs inside looper-spec when needed; export belongs inside looper-prd. An audit is independently useful for existing bundles. Spec creation does not imply starting Looper, switching branches, publishing issues, changing phases, or clearing runtime state.

The spec skill should inspect the repository first, answer factual questions through evidence, and ask only about missing product choices. Distinguish confirmed decisions, proposed assumptions, and blocking unknowns. A well-specified request should not restart a generic interview. Technical choices are normative when the user requires them; implementation guesses remain recommendations.

The PRD skill should distinguish product outcomes, PR-sized stories, and internal implementation tasks. Prefer the smallest independently useful and verifiable outcome that fits normal execution. A cross-cutting migration may retain a larger merge boundary when smaller green slices are impossible under the contract. Preserve global story IDs and existing priority conventions.

The audit skill should ask whether these stories can deliver the stated outcome, whether required evidence can be obtained in the configured environments, and whether every permitted outcome can reach the terminal state. Valid JSON alone cannot answer those questions.

## Artifact contract

Preserve the existing layout for comparable waves:

    spec/<wave>/
      spec-<wave>.md
      prd-<wave>-00-index.md
      prd-<wave>-01-stories.md
      prd.json
      progress.txt

Small changes can use fewer human documents when local conventions permit. Do not duplicate prose just to fill a template. Preserve any existing progress log.

The spec owns normative requirements and constraints. Stories own bounded delivery and acceptance details consistent with it. The index gives order, dependencies, gate classes, and unusual risks. JSON provides scheduling metadata and agent-facing acceptance context. Runtime phases remain separate. Before making JSON a generated projection for an existing bundle, reconcile its authorized amendments.

Each story should identify its outcome, scope boundary, requirement references, dependencies, acceptance criteria, proof, verification environment and owning step, documentation changes, and any sizing exception. Use a requirement-to-story-to-evidence table where it makes coverage easier to check. Stable requirement IDs help larger specs; small specs can use section references.

Acceptance criteria should specify input or stimulus, observable result, relevant failure behavior, and evidence. Passing general checks is necessary where required, but does not demonstrate a feature. Migration criteria preserve behavior through characterization unless a particular difference is authorized. Conditional optimization stories define both adoption and rejection outcomes and their completion routes.

For authoring, make the proof contract explicit: outcome → acceptance criterion → probe → environment and owning step → retained evidence → phase gate. Record whether the probe is established, newly executed, or still unverified. Prototype only the empirical uncertainty that could change the plan, using an isolated setup and the task's authorized scope.

A gate table should state what runs, where it runs, what constitutes a pass, and which phase it gates. Discover real script names in the target repository. Lando's sandbox and gate classes are examples, not universal defaults.

## Looper compatibility requirements

Ground these rules in the current [parser](U:/home/aaron/projects/looper/src/lib/prd.ts), [resolver](U:/home/aaron/projects/looper/src/engine/story-phases.ts), and repo instructions:

- The engine reads userStories entries with id, optional title and priority, and dependsOn. Descriptions and acceptance criteria are agent-facing; the parser does not prove their fulfillment.
- The passes flag is ignored. Omit it in a new format unless compatibility needs it; do not rewrite old flags as a status operation.
- Preserve IDs on revision. Renumbering is not a completion reset.
- The sample's branchName is legacy project metadata. Story branches follow the story-ID convention.
- Outcomes come from the generated context. Do not copy hand-maintained legal-exit lists into authoring templates or prompts.
- Phase stores, locks, leases, identity records, resume pointers, and signals belong to the runtime. Creating a new PRD does not authorize clearing them.
- Discover configuration and PRD paths. Avoid hard-coded Lando paths in reusable skills.

## Validation and implementation order

A small read-only validator is the most valuable reusable script. Check JSON structure, nonblank and unique IDs, finite priorities, dependency existence and acyclicity, referenced paths, and ID consistency across representations. No new production dependency is needed.

Add an exporter only after defining its source representation and how it preserves adjudication amendments. Do not parse arbitrary Markdown acceptance criteria with fragile regular expressions.

Keep semantic judgment in the skills: complete outcomes, actual requirement coverage, contradictory constraints, meaningful evidence, workable story size, environment availability, and reachable completion. A validator should not certify those merely because IDs or strings match.

Build the shared Looper contract and audit checklist first, then the spec and PRD skills. Keep entrypoints short; place schemas, migration examples, and review criteria in supporting references.

Evaluate the resulting skills on:

1. A small complete feature.
2. US-662's atomic migration.
3. US-670's conditional no-change result.
4. A deliberately invalid dependency graph.
5. A bundle containing an authorized JSON-only adjudication.
6. An existing PRD revision that must preserve IDs, progress, and runtime state.

Success means preserving intent, producing usable stories, detecting the real incompatibilities, and leaving runtime state unchanged. It should not be measured by matching prescribed headings.

Before comparing skill variants, define a short rubric covering those outcomes. Run the same ordinary authoring requests against the baseline and candidate in separate fixture copies; review anonymized artifacts and inspect actual changes. Keep evaluation instructions outside the candidate's task context. This is a proposed evaluation, not a result.

This pass created only this research document. No skills were installed, and the Lando artifacts, runtime state, and existing Looper files were not changed.
