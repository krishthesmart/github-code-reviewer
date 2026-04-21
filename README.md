# 🤖 AI Code Reviewer

Automatically reviews every pull request using **Groq AI** — covering Security, Bugs, Performance, Maintainability, and Best Practices. Optionally commits fixes directly to the PR branch with zero human intervention.

## Features

- **Full 5-category review** on every PR open and push
- **Inline comments** on specific lines with severity levels (CRITICAL → SUGGESTION)
- **Auto-fix mode** — AI commits fixes directly to the PR branch, re-review runs automatically
- **OWASP Top 10** security checks built-in
- **Free to use** — powered by [Groq](https://console.groq.com) (free API key)

## Quick Start

Add this file to your repo at `.github/workflows/code-review.yml`:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  ai-review:
    name: Review PR with Groq AI
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: krishthesmart/github-code-reviewer@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          auto_fix: "true"   # remove this line if you only want reviews, no auto-fix
```

Then add your `GROQ_API_KEY` secret (free at [console.groq.com](https://console.groq.com)).

> Also enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.

That's it — open a PR and the AI will review it automatically.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `groq_api_key` | ✅ | — | Your Groq API key |
| `github_token` | ✅ | — | Use `secrets.GITHUB_TOKEN` |
| `auto_fix` | ❌ | `false` | Commit AI fixes directly to the PR branch |
| `mode` | ❌ | `review` | `review` or `fix` (used internally by the `/fix` command) |

## Commands

Comment on any PR to trigger actions:

| Command | Action |
|---------|--------|
| `/review` | Re-run the AI review |
| `/fix` | Apply AI fixes to this PR |

To enable commands, add a second workflow file at `.github/workflows/fix-review.yml`:

```yaml
name: AI Fix / Review Command

on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  fix:
    name: Auto-fix issues with Groq AI
    runs-on: ubuntu-latest
    if: github.event.issue.pull_request != null && (contains(github.event.comment.body, '/fix') || contains(github.event.comment.body, '/review'))
    steps:
      - uses: krishthesmart/github-code-reviewer@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          mode: ${{ contains(github.event.comment.body, '/fix') && 'fix' || 'review' }}
```

## What the Review Looks Like

Every PR gets a full report with all 5 categories:

```
## 🤖 AI Code Review — ❌ CHANGES REQUESTED

#### 🔒 Security ❌
SQL injection vulnerability on line 19. Use parameterized queries.
  🔴 CRITICAL — SQL Injection in /user endpoint

#### 🐛 Bugs ✅
No logic errors or null dereferences found.

#### ⚡ Performance ✅
No N+1 queries or blocking calls detected.

#### 🧹 Maintainability 💡
Consider extracting the auth logic into a middleware function.

#### 📐 Best Practices ❌
Password is logged in plaintext on line 41.
  🟠 HIGH — Sensitive data logged
```

## Autonomous Flow (with `auto_fix: "true"`)

```
Developer opens PR
       ↓
AI reviews all 5 categories
       ↓
Issues found → AI commits fixes directly to the PR branch
       ↓
Push triggers a new review automatically
       ↓
Clean → APPROVE ✅
```

## License

MIT
