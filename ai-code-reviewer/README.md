# 🤖 AI Code Reviewer — GitHub Action

An automated code reviewer that triggers on every pull request, reads the diff, and posts AI-generated feedback as a PR comment — powered by **Groq** (LLaMA 3.3 70B).

---

## What It Does

| Step | Detail |
|------|--------|
| **Trigger** | Runs automatically when a PR is opened or updated (`synchronize`) |
| **Reads diff** | Fetches the list of changed files and their patches via the GitHub REST API |
| **AI review** | Sends each file's diff to the Groq API (LLaMA 3.3 70B) with an expert reviewer prompt |
| **Posts comment** | Consolidates all feedback into a single, formatted PR comment |
| **Skips noise** | Automatically skips binary files, lock files, and files with no patch |

### Example Output

> *(Replace this section with a screenshot of a real PR comment once deployed)*

```
## 🤖 AI Code Review

> Powered by Groq (llama-3.3-70b-versatile) — review generated automatically on every PR.

---

### 📄 `src/auth/login.js`

- **Bug**: The `catch` block on line 42 silently swallows errors — consider at minimum logging them.
- **Security**: User-supplied `redirectUrl` is passed directly to `res.redirect()` without validation; this enables open-redirect attacks.
- **Style**: `getUserById` is called twice with the same argument; cache the result in a variable.

---

### 📄 `src/utils/crypto.js`

- **Security**: MD5 is cryptographically broken — use SHA-256 or bcrypt depending on the use case.
- **Performance**: `Buffer.from(input)` inside a loop allocates a new buffer on every iteration; move it outside.
```

---

## Setup — Add to Any Repository

### 1. Copy the action files

Copy the following into the root of the target repository:

```
your-repo/
└── .github/
    ├── workflows/
    │   └── code-review.yml      ← triggers the action
    └── ai-code-reviewer/
        ├── src/
        │   └── index.js         ← core logic
        └── package.json
```

> The reviewer lives under `.github/ai-code-reviewer/` so it doesn't clutter the project root.

### 2. Add `GROQ_API_KEY` as a GitHub Secret

1. Go to **[https://console.groq.com](https://console.groq.com)** and create a free API key.
2. In your GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Click **New repository secret**.
4. Set the name to `GROQ_API_KEY` and paste your key as the value.
5. Click **Add secret**.

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no configuration needed.

### 3. Open a Pull Request

That's it. The next time a PR is opened or pushed to, the workflow will run and post a review comment.

---

## Configuration Options

All options live in [src/index.js](src/index.js).

| Constant | Default | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model to use for review |
| `MAX_DIFF_CHARS` | `12000` | Max characters of diff sent per file (prevents token-limit errors on huge files) |
| `SKIP_EXTENSIONS` | see source | File extensions/names that are always skipped |
| `SYSTEM_PROMPT` | see source | The instructions given to the AI reviewer |

### Changing the model

Edit `GROQ_MODEL` in `src/index.js`:

```js
const GROQ_MODEL = "llama-3.3-70b-versatile"; // or "mixtral-8x7b-32768", etc.
```

### Changing the review focus

Edit `SYSTEM_PROMPT` to focus on security only, or add your own coding standards:

```js
const SYSTEM_PROMPT = `You are a security-focused code reviewer at Acme Corp.
Our coding standards: ...`;
```

### Restricting to specific file paths

Add a `paths` filter to the workflow trigger in `code-review.yml`:

```yaml
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/**"
      - "lib/**"
```

---

## Local Testing

```bash
# Install dependencies
npm install

# Set environment variables
export GROQ_API_KEY="your-key-here"
export GITHUB_TOKEN="ghp_..."
export GITHUB_REPOSITORY="owner/repo"
export GITHUB_EVENT_PATH="/path/to/event.json"   # a saved pull_request event payload

node src/index.js
```

---

## Tech Stack

- **[Groq SDK](https://www.npmjs.com/package/groq-sdk)** — fast LLM inference
- **[@octokit/rest](https://www.npmjs.com/package/@octokit/rest)** — GitHub REST API client
- **GitHub Actions** — CI/CD workflow runner

---

## License

MIT
