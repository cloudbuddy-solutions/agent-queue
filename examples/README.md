# Examples

Two sample tasks that pass the schema and the handoff gate. Use them to see the queue run end to end.

```bash
# from the repo root
npx agent-queue init
npx agent-queue add --file examples/tasks/example-autonomous-task.json
npx agent-queue add --file examples/tasks/example-needs-owner-task.json

npx agent-queue status
# the needs_owner task shows as awaiting approval

npx agent-queue next --by worker        # claims the autonomous task
npx agent-queue complete <task-id> \
  --summary "Wrapped the fetch in a 3x backoff retry and added a test." \
  --evidence "npm test => 12 passing, including retries-on-503"

npx agent-queue approve <the-needs-owner-id> --by owner
npx agent-queue next --by worker        # now claimable
```

- [`example-autonomous-task.json`](tasks/example-autonomous-task.json) - a bounded, verifiable code change. Runs without approval.
- [`example-needs-owner-task.json`](tasks/example-needs-owner-task.json) - touches billing, so it waits for an owner.

Both are fictional. Write your real tasks the same way: enough context that a worker starting cold could finish without asking a question.
