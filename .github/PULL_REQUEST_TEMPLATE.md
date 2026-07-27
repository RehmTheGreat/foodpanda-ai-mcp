## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Why?

<!-- What problem does it solve? If it changes upstream handling, what did you observe
     live that motivated it? -->

## How was it verified?

<!-- Be specific. "Ran the tests" is fine if the tests cover it; say which ones. -->

- [ ] `npm run verify` passes (lint + typecheck + tests)
- [ ] New behaviour has a test
- [ ] Ran `npm run smoke` against the live API (if upstream behaviour changed)

## Checklist

- [ ] Conventional Commit message (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- [ ] No upstream URLs, params or headers added outside `src/adapters/`
- [ ] Nothing writes to stdout (logging goes to stderr)
- [ ] Unexpected upstream shapes degrade with a warning rather than throwing
- [ ] README / docs updated if user-visible behaviour changed
- [ ] `docs/API-RESEARCH.md` updated if upstream findings changed
- [ ] Tool schema changes follow [docs/VERSIONING.md](../docs/VERSIONING.md)

## Scope confirmation

- [ ] This does **not** add ordering, authentication, account access or payments
- [ ] This does **not** attempt to circumvent upstream bot protection
