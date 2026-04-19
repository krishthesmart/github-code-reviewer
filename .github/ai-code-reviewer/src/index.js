const { Octokit } = require("@octokit/rest");
const Groq = require("groq-sdk");

// ── Constants ────────────────────────────────────────────────────────────────

const GROQ_MODEL = "llama-3.3-70b-versatile";

// Files that are almost never worth reviewing
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".lock", ".bin", ".exe", ".dll",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

const SYSTEM_PROMPT = `You are an expert code reviewer. Review the following code diff and provide feedback on:
- Bugs and logic errors
- Security vulnerabilities
- Code style and readability
- Performance issues

Be concise, specific, and actionable. Format your response as a bulleted list.
If the diff looks good with no issues, say so briefly. Do not repeat the diff back.`;

// Max characters of diff to send per file (avoids token limit errors)
const MAX_DIFF_CHARS = 12_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Returns true when a file should be skipped (binary, lock file, no patch).
 */
function shouldSkip(file) {
  if (!file.patch) return true; // binary or renamed with no diff

  const lower = file.filename.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Truncates a diff string so we never blow past the model's context window.
 */
function truncateDiff(patch) {
  if (patch.length <= MAX_DIFF_CHARS) return patch;
  return (
    patch.slice(0, MAX_DIFF_CHARS) +
    `\n\n[...diff truncated at ${MAX_DIFF_CHARS} chars to fit context window...]`
  );
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function reviewFile(groq, filename, patch) {
  const userMessage = `File: ${filename}\n\n\`\`\`diff\n${truncateDiff(patch)}\n\`\`\``;

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2, // lower = more deterministic / less hallucination
    max_tokens: 1024,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no response)";
}

async function postComment(octokit, { owner, repo, prNumber, body }) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

async function run() {
  // ── Environment ────────────────────────────────────────────────────────────
  const groqApiKey   = getEnv("GROQ_API_KEY");
  const githubToken  = getEnv("GITHUB_TOKEN");
  const githubRepo   = getEnv("GITHUB_REPOSITORY");        // "owner/repo"
  const eventPath    = getEnv("GITHUB_EVENT_PATH");

  // Parse owner/repo
  const [owner, repo] = githubRepo.split("/");

  // Parse PR number from the GitHub Actions event payload
  const event = require(eventPath);
  const prNumber = event.pull_request?.number;
  if (!prNumber) throw new Error("Could not determine PR number from event payload.");

  console.log(`\n🔍  Reviewing PR #${prNumber} in ${owner}/${repo}\n`);

  // ── Clients ────────────────────────────────────────────────────────────────
  const octokit = new Octokit({ auth: githubToken });
  const groq    = new Groq({ apiKey: groqApiKey });

  // ── Fetch changed files ────────────────────────────────────────────────────
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100, // max allowed by GitHub API
  });

  console.log(`📂  ${files.length} file(s) changed in this PR.`);

  const reviewable = files.filter((f) => !shouldSkip(f));
  const skipped    = files.length - reviewable.length;

  if (skipped > 0) {
    console.log(`⏭️   Skipping ${skipped} binary/lock/no-diff file(s).`);
  }

  if (reviewable.length === 0) {
    console.log("ℹ️   No reviewable files found. Nothing to post.");
    return;
  }

  // ── Review each file & collect results ────────────────────────────────────
  const results = [];

  for (const file of reviewable) {
    console.log(`  → Reviewing: ${file.filename}`);
    try {
      const feedback = await reviewFile(groq, file.filename, file.patch);
      results.push({ filename: file.filename, feedback, error: null });
    } catch (err) {
      console.error(`  ✗ Groq API error for ${file.filename}: ${err.message}`);
      results.push({ filename: file.filename, feedback: null, error: err.message });
    }
  }

  // ── Build a single consolidated comment ───────────────────────────────────
  const lines = [
    "## 🤖 AI Code Review",
    "",
    `> Powered by **Groq** (\`${GROQ_MODEL}\`) — review generated automatically on every PR.`,
    "",
    "---",
    "",
  ];

  for (const { filename, feedback, error } of results) {
    lines.push(`### 📄 \`${filename}\``);
    lines.push("");
    if (error) {
      lines.push(`> ⚠️ Review skipped — API error: ${error}`);
    } else {
      lines.push(feedback);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(
    `<sub>Reviewed ${reviewable.length} file(s) · ${new Date().toUTCString()}</sub>`
  );

  const body = lines.join("\n");

  // ── Post comment ──────────────────────────────────────────────────────────
  await postComment(octokit, { owner, repo, prNumber, body });
  console.log(`\n✅  Review posted as a comment on PR #${prNumber}.`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
# reviewed
