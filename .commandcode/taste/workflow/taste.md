# Workflow Preferences

- Uses "commit push" as a single shorthand command to stage, commit, and push all changed files in one go; expects the assistant to handle the full git workflow (status check, staging, commit message generation, rebase on divergence, push) without further instructions. Confidence: 0.8
- Comfortable with conventional commit format (`feat:`, `fix:` prefix, summary line, detailed bullet points, co-authored-by trailer). Confidence: 0.7
- Expects comprehensive documentation updates: when making changes, all relevant doc files (CHANGELOG, feature docs, README) should be updated together, not just the subset initially identified. Confidence: 0.6
- After initial documentation updates, expects a follow-up verification pass to confirm nothing was missed — systematically searches for stale version numbers or references across the full docs directory (e.g., via grep for old version patterns) rather than relying on memory alone. Confidence: 0.4
