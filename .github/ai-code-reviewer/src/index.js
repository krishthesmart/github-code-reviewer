const { Octokit } = require("@octokit/rest");
const Groq = require("groq-sdk");
const core = require("@actions/core");
const fs = require("fs");

// ── Constants ────────────────────────────────────────────────────────────────

const GROQ_MODEL = "llama-3.3-70b-versatile";

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".lock", ".bin", ".exe", ".dll",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

const SYSTEM_PROMPT = `You are a senior security-focused code reviewer. Analyze the provided diff thoroughly.

For every issue found, use EXACTLY this format:
**[SEVERITY] Category — Description**
Then a short explanation and fix suggestion on the next line.

Severity levels:
🔴 CRITICAL — exploit risk, data loss, auth bypass, secrets exposed
🟠 HIGH     — security vulnerability, serious bug, data corruption
🟡 MEDIUM   — logic error, missing validation, poor error handling
🟢 LOW      — code smell, minor inefficiency, readability
💡 SUGGESTION — best practice, improvement idea

Categories to check:
**Security (OWASP Top 10 + more):**
- SQL/Command/LDAP/XPath injection
- XSS and output encoding
- Broken authentication, insecure tokens, weak passwords
- Sensitive data exposure (secrets, API keys, PII in logs or code)
- SSRF, path traversal, XXE
- Insecure deserialization
- Broken access control, missing authorization checks
- Security misconfiguration (CORS, headers, verbose errors)
- Known vulnerable dependencies
- Insufficient logging of security events
- Hardcoded credentials or secrets

**Bugs:**
- Logic errors and incorrect conditions
- Null/undefined dereference
- Off-by-one errors
- Race conditions and concurrency issues
- Memory leaks
- Unhandled promise rejections or exceptions
- Edge cases not handled

**Performance:**
- N+1 database queries
- Unnecessary loops or recomputation
- Missing indexes or caching
- Blocking async operations
- Large payload handling

**Maintainability:**
- Dead or unreachable code
- Overly complex logic that should be simplified
- Missing input validation at system boundaries
- Inconsistent error handling patterns
- Functions doing too many things

End your response with one of these exact lines:
VERDICT: APPROVE
VERDICT: REQUEST_CHANGES
VERDICT: COMMENT

Use REQUEST_CHANGES if there are any 🔴 CRITICAL or 🟠 HIGH issues.
Use APPROVE only if the diff looks clean with no significant issues.
Use COMMENT for minor issues only.

If the diff is clean, say so briefly and use VERDICT: APPROVE.
Do not repeat the diff. Be specific and actionable.`;

const MAX_DIFF_CHARS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function shouldSkip(file) {
  if (!file.patch) return true;
  const lower = file.filename.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function truncateDiff(patch) {
  if (patch.length <= MAX_DIFF_CHARS) return patch;
  return (
    patch.slice(0, MAX_DIFF_CHARS) +
    `\n\n[...diff truncated at ${MAX_DIFF_CHARS} chars...]`
  );
}

function parseVerdict(feedback) {
  const match = feedback.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i);
  return match ? match[1].toUpperCase() : "COMMENT";
}

function stripVerdict(feedback) {
  return feedback.replace(/\nVERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/i, "").trim();
}

function overallVerdict(results) {
  if (results.some((r) => r.verdict === "REQUEST_CHANGES")) return "REQUEST_CHANGES";
  if (results.every((r) => r.verdict === "APPROVE")) return "APPROVE";
  return "COMMENT";
}

function verdictEmoji(verdict) {
  if (verdict === "APPROVE") return "✅ APPROVED";
  if (verdict === "REQUEST_CHANGES") return "❌ CHANGES REQUESTED";
  return "💬 COMMENTED";
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
    temperature: 0.1,
    max_tokens: 2048,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "(no response)";
}

async function postReview(octokit, { owner, repo, prNumber, body, verdict, commitId }) {
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitId,
    body,
    event: verdict, // APPROVE | REQUEST_CHANGES | COMMENT
  });
}

async function run() {
  const groqApiKey  = core.getInput("groq_api_key", { required: true });
  const githubToken = core.getInput("github_token", { required: true });
  const githubRepo  = getEnv("GITHUB_REPOSITORY");
  const eventPath   = getEnv("GITHUB_EVENT_PATH");

  const [owner, repo] = githubRepo.split("/");

  const event    = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const prNumber = event.pull_request?.number;
  const commitId = event.pull_request?.head?.sha;
  if (!prNumber) throw new Error("Could not determine PR number from event payload.");

  console.log(`\n🔍  Reviewing PR #${prNumber} in ${owner}/${repo}\n`);

  const octokit = new Octokit({ auth: githubToken });
  const groq    = new Groq({ apiKey: groqApiKey });

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
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

  // ── Review each file ──────────────────────────────────────────────────────
  const results = [];

  for (const file of reviewable) {
    console.log(`  → Reviewing: ${file.filename}`);
    try {
      const raw      = await reviewFile(groq, file.filename, file.patch);
      const verdict  = parseVerdict(raw);
      const feedback = stripVerdict(raw);
      results.push({ filename: file.filename, feedback, verdict, error: null });
      console.log(`    Verdict: ${verdict}`);
    } catch (err) {
      console.error(`  ✗ Groq API error for ${file.filename}: ${err.message}`);
      results.push({ filename: file.filename, feedback: null, verdict: "COMMENT", error: err.message });
    }
  }

  // ── Build consolidated review body ────────────────────────────────────────
  const finalVerdict = overallVerdict(results);

  const lines = [
    `## 🤖 AI Code Review — ${verdictEmoji(finalVerdict)}`,
    "",
    `> Powered by **Groq** (\`${GROQ_MODEL}\`) · Checks: Security · Bugs · Performance · Maintainability`,
    "",
    "---",
    "",
  ];

  for (const { filename, feedback, verdict, error } of results) {
    const icon = verdict === "APPROVE" ? "✅" : verdict === "REQUEST_CHANGES" ? "❌" : "💬";
    lines.push(`### ${icon} \`${filename}\``);
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
    `<sub>Reviewed ${reviewable.length} file(s) · ${new Date().toUTCString()} · Overall: **${finalVerdict}**</sub>`
  );

  const body = lines.join("\n");

  // ── Post as a proper PR review ────────────────────────────────────────────
  await postReview(octokit, { owner, repo, prNumber, body, verdict: finalVerdict, commitId });
  console.log(`\n✅  Review posted on PR #${prNumber} — ${finalVerdict}`);
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
