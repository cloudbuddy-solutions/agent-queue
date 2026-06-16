# Task template and handoff bar

A task is a single JSON object validated against `schema/task.schema.json`. The fields below are required unless marked optional. The queue fills `task_id`, `created_at`, `created_by`, `status`, `schema_version`, and `sensitivity` for you if you omit them, so a planner usually writes the working fields and lets `add` stamp the rest.

## The handoff bar

`agent-queue add` rejects a task that a cold worker could not finish. Clear all of it:

- **context** >= 200 chars: why this exists, what is known, what was tried or ruled out, conventions, gotchas.
- **spec** >= 120 chars: the concrete change and the pattern to follow.
- **source_references**: a reference for every place the worker must touch or imitate, each with a note >= 20 chars. If you list several `files_likely_touched`, ground more than one of them.
- **verification**: exact checks with **specific** expected outcomes. Outcomes like "works", "passes", "ok", "looks good" are rejected. State which output, which behavior, which number.
- **out_of_scope**: at least one explicit non-goal.
- **acceptance_criteria**: specific, checkable statements.
- **risk**: an honest level and the reasons.

Write it so a competent worker with zero prior context could finish without asking a question.

## Annotated template

```json
{
  "title": "Short imperative summary of the task",
  "target": "optional label: a project, repo, dataset, or lane. Tasks sharing a target run one at a time.",
  "lane": "autonomous | needs_owner",
  "priority": 2,

  "context": "The handoff brief, 200+ chars. Why this task exists, what is already known (current behavior, root cause if diagnosed, what was tried or ruled out), the conventions or constraints that apply, and any gotchas. The worker has no other briefing.",

  "spec": "What to do, concretely, 120+ chars. The change in plain language, where it goes, and the existing pattern to follow.",

  "source_references": [
    { "path": "path/or/url/to/where/the/change/happens", "note": "Why this reference matters, 20+ chars." },
    { "path": "path/to/the/pattern/to/imitate", "note": "What to copy from here." }
  ],

  "files_likely_touched": ["optional/list/of/paths"],

  "acceptance_criteria": [
    "A specific, checkable statement of done.",
    "Another one."
  ],

  "verification": [
    { "check": "exact command or concrete manual check", "expected": "the specific observable result, not 'works'" }
  ],

  "out_of_scope": [
    "An explicit non-goal the worker must not touch."
  ],

  "risk": {
    "level": "low | medium | high",
    "reasons": ["Why this risk level is honest."]
  }
}
```

## Lane decision

- **autonomous**: bounded, reproducible, and verifiable. Safe for a worker to claim without asking.
- **needs_owner**: product or design choices, irreversible or risky changes, or anything near credentials or customer data. It waits for `agent-queue approve`.

When in doubt, choose `needs_owner`. A person can always downgrade it.

## Verification examples

Good (specific, observable):

- `npm test => all pass, including the new retries-on-503 case`
- `node scripts/recompute-batch.js 2026-05 => batch total equals the finance ledger to the cent`
- `curl -s localhost:3000/health => {"status":"ok"} with HTTP 200`

Rejected (vague):

- `it works`
- `passes`
- `looks good`
