# Lens: test coverage

You are reviewing this change for **test-coverage gaps only** — the concern holistic review
systematically under-weights. Given the diff and the full file contents:

- Which behavior this change introduces or modifies is **exercised by no test**? Be specific about
  the untested path (e.g. effect ordering, an auth/identity transition, a cleanup action, an error
  branch).
- Are there **new constants/config/contract values** the change sets that no test asserts and a
  future refactor could silently revert (e.g. a cookie `max_age`, a timeout, a limit)?
- Do the added tests cover only pure helpers while the **integration/wiring** that actually carries
  the risk is untested?

Only raise test-coverage findings. Severity reflects how likely an untested path is to regress
silently and how costly that regression would be. Use `"area": "test-coverage"`.
