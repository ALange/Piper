---
name: review-checklist
description: What to check when reviewing a code change: correctness, failure paths, security, tests, and clarity.
---

# Review checklist

Go through these in order and note a finding only where you can point to the code.

1. **Does it do what was asked?** Compare the change with the stated goal. Look for missing cases and for changes that are not part of the goal.
2. **Failure paths.** What happens on empty input, a missing file, a timeout, a partial failure, a repeated call? Are errors reported or swallowed?
3. **Security and data.** Untrusted input reaching a shell, a path, a query or an HTML page; secrets in code or logs; permissions; anything that deletes or overwrites.
4. **Concurrency and state.** Shared state, ordering assumptions, resources that are opened and not closed.
5. **Tests.** Is the new behaviour tested, including the failure path? Would the test fail without the change?
6. **Clarity.** Names, comments that explain why, dead code, duplicated logic, surprising side effects.
7. **Compatibility.** Public interfaces, stored data, configuration and migrations.
