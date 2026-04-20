const { Octokit } = require("@octokit/rest");
const Groq = require("groq-sdk");
const core = require("@actions/core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// ── Constants ────────────────────────────────────────────────────────────────

const GROQ_MODEL = "llama-3.3-70b-versatile";

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".lock", ".bin", ".exe", ".dll",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

const REVIEW_SYSTEM_PROMPT = `You are a senior security-focused code reviewer. Analyze the provided diff thoroughly.

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
const MAX_FILE_CHARS = 20_000;

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

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n\n[...truncated at ${max} chars...]`;
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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Review mode ───────────────────────────────────────────────────────────────

async function reviewFile(groq, filename, patch) {
  const userMessage = `File: ${filename}\n\n\`\`\`diff\n${truncate(patch, MAX_DIFF_CHARS)}\n\`\`\``;

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
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
    event: verdict,
  });
}

async function runReview(octokit, groq, { owner, repo, prNumber, commitId }) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  console.log(`📂  ${files.length} file(s) changed in this PR.`);

  const reviewable = files.filter((f) => !shouldSkip(f));
  const skipped    = files.length - reviewable.length;

  if (skipped > 0) console.log(`⏭️   Skipping ${skipped} binary/lock/no-diff file(s).`);
  if (reviewable.length === 0) {
    console.log("ℹ️   No reviewable files found. Nothing to post.");
    return;
  }

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
      console.error(`  ✗ Groq error for ${file.filename}: ${err.message}`);
      results.push({ filename: file.filename, feedback: null, verdict: "COMMENT", error: err.message });
    }
  }

  const finalVerdict = overallVerdict(results);

  const lines = [
    `## 🤖 AI Code Review — ${verdictEmoji(finalVerdict)}`,
    "",
    `> Powered by **Groq** (\`${GROQ_MODEL}\`) · Checks: Security · Bugs · Performance · Maintainability`,
    `> 💡 Comment \`/fix\` on this PR to auto-apply all fixes.`,
    "",
    "---",
    "",
  ];

  for (const { filename, feedback, verdict, error } of results) {
    const icon = verdict === "APPROVE" ? "✅" : verdict === "REQUEST_CHANGES" ? "❌" : "💬";
    lines.push(`### ${icon} \`${filename}\``);
    lines.push("");
    lines.push(error ? `> ⚠️ Review skipped — API error: ${error}` : feedback);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(
    `<sub>Reviewed ${reviewable.length} file(s) · ${new Date().toUTCString()} · Overall: **${finalVerdict}**</sub>`
  );

  await postReview(octokit, { owner, repo, prNumber, body: lines.join("\n"), verdict: finalVerdict, commitId });
  console.log(`\n✅  Review posted on PR #${prNumber} — ${finalVerdict}`);
}

// ── Syntax validation ─────────────────────────────────────────────────────────

function validateSyntax(content, filename) {
  const ext = path.extname(filename).toLowerCase();
  const tmpFile = path.join(os.tmpdir(), `ai-fix-${Date.now()}${ext}`);

  try {
    fs.writeFileSync(tmpFile, content, "utf8");

    let result;
    if ([".js", ".mjs", ".cjs"].includes(ext)) {
      result = spawnSync("node", ["--check", tmpFile], { encoding: "utf8", timeout: 10000 });
    } else if (ext === ".py") {
      result = spawnSync("python3", ["-m", "py_compile", tmpFile], { encoding: "utf8", timeout: 10000 });
    } else if (ext === ".rb") {
      result = spawnSync("ruby", ["-c", tmpFile], { encoding: "utf8", timeout: 10000 });
    } else if (ext === ".sh") {
      result = spawnSync("bash", ["-n", tmpFile], { encoding: "utf8", timeout: 10000 });
    } else {
      return { valid: true, skipped: true };
    }

    if (result.status !== 0) {
      const errMsg = (result.stderr || result.stdout || "syntax error").trim();
      return { valid: false, error: errMsg };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── Fix mode ──────────────────────────────────────────────────────────────────

function postProcessCode(content) {
  // Fix most common AI mistake: res.send(<html>) → res.send(`<html>`)
  return content.replace(
    /(\.\w+\s*\()\s*(<[^)]{0,500}>)\s*\)/g,
    (_, call, html) => `${call}\`${html}\`)`
  );
}

async function fixFileWithAI(groq, filename, content, feedback, priorSyntaxError = null) {
  const ext = path.extname(filename).toLowerCase();
  const isJS = [".js", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext);

  let userMessage = `Fix ALL the issues listed below in this file.

File: ${filename}

Current file content:
\`\`\`
${truncate(content, MAX_FILE_CHARS)}
\`\`\`

Issues to fix:
${feedback}
${isJS ? `
CRITICAL JAVASCRIPT SYNTAX RULES — violating these causes a SyntaxError:
- NEVER use JSX syntax. This is plain JavaScript, not React.
- To send HTML in Express: use a template literal → res.send(\`<h1>Hello \${name}</h1>\`)
- NEVER write: res.send(<h1>Hello \${name}</h1>) — angle brackets are NOT valid here
- String concatenation is also valid: res.send('<h1>Hello ' + name + '</h1>')
` : ""}
Return ONLY the complete fixed file content. No explanations, no markdown code fences, no extra text.`;

  if (priorSyntaxError) {
    userMessage += `\n\nYour previous attempt had this syntax error:\n${priorSyntaxError}\nDo NOT repeat the same mistake.`;
  }

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: "You are an expert software engineer. Fix all issues in the provided code. Return ONLY the complete fixed source code — no markdown fences, no explanation, nothing else.",
      },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

async function runFix(octokit, groq, { owner, repo, prNumber, commentId }) {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner, repo, comment_id: commentId, content: "rocket",
    });
  } catch (_) {}

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const commitSha  = pr.head.sha;
  const baseBranch = pr.head.ref;

  const { data: reviews } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: prNumber });
  const botReview = [...reviews].reverse().find((r) => r.body?.includes("🤖 AI Code Review"));

  if (!botReview) {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: "## 🤖 AI Fix\n\nNo AI review found on this PR. Push a commit to trigger a review first.",
    });
    return;
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  // Create new fix branch from the PR head
  const fixBranch = `ai-fix/pr-${prNumber}`;
  try {
    await octokit.rest.git.createRef({
      owner, repo,
      ref: `refs/heads/${fixBranch}`,
      sha: commitSha,
    });
    console.log(`  → Created branch: ${fixBranch}`);
  } catch (err) {
    if (err.status === 422) {
      // Branch already exists — update it to point to current head
      await octokit.rest.git.updateRef({
        owner, repo,
        ref: `heads/${fixBranch}`,
        sha: commitSha,
        force: true,
      });
      console.log(`  → Reset existing branch: ${fixBranch}`);
    } else {
      throw err;
    }
  }

  const fixed = [];
  const failed = [];

  for (const file of files.filter((f) => !shouldSkip(f))) {
    const regex = new RegExp(
      `### [✅❌💬] \`${escapeRegex(file.filename)}\`([\\s\\S]*?)(?=###\\s|<sub>|$)`
    );
    const match = botReview.body?.match(regex);
    const feedback = match?.[1]?.trim();

    if (!feedback || feedback.includes("Review skipped")) continue;

    console.log(`  → Fixing: ${file.filename}`);

    try {
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner, repo, path: file.filename, ref: commitSha,
      });

      const original = Buffer.from(fileData.content, "base64").toString("utf8");
      let fixedContent = postProcessCode(
        await fixFileWithAI(groq, file.filename, original, feedback)
      );

      if (!fixedContent || fixedContent === original) {
        console.log(`    No changes needed for ${file.filename}`);
        continue;
      }

      let check = validateSyntax(fixedContent, file.filename);
      if (!check.valid) {
        console.log(`    ↻ Syntax error — retrying with error feedback...`);
        fixedContent = postProcessCode(
          await fixFileWithAI(groq, file.filename, original, feedback, check.error)
        );
        check = validateSyntax(fixedContent, file.filename);
      }

      if (!check.valid) {
        console.error(`    ✗ Syntax still invalid after retry: ${check.error}`);
        failed.push({ file: file.filename, error: `Syntax check failed after retry: ${check.error}` });
        continue;
      }
      if (!check.skipped) console.log(`    ✓ Syntax check passed`);

      // Commit to the new fix branch
      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo,
        path: file.filename,
        message: `fix(ai): auto-fix security issues in ${file.filename}`,
        content: Buffer.from(fixedContent).toString("base64"),
        sha: fileData.sha,
        branch: fixBranch,
      });

      fixed.push(file.filename);
      console.log(`    ✅ Committed to ${fixBranch}`);
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message}`);
      failed.push({ file: file.filename, error: err.message });
    }
  }

  if (fixed.length === 0) {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: `## 🤖 AI Fix\n\nNo files could be fixed automatically.\n\n${failed.map(({ file, error }) => `- ❌ \`${file}\` — ${error}`).join("\n")}`,
    });
    return;
  }

  // Open a new PR with the fixes
  const fixPrBody = [
    `## 🤖 AI Fix for #${prNumber}`,
    "",
    `Auto-applied fixes based on the AI review of PR #${prNumber}.`,
    "",
    `**Fixed files:**`,
    ...fixed.map((f) => `- ✅ \`${f}\``),
    ...(failed.length > 0 ? ["", "**Could not fix (manual action needed):**", ...failed.map(({ file, error }) => `- ❌ \`${file}\` — ${error}`)] : []),
    "",
    "> Review these changes carefully before merging.",
  ].join("\n");

  const { data: fixPr } = await octokit.rest.pulls.create({
    owner, repo,
    title: `🤖 AI Fix: auto-fix issues from PR #${prNumber}`,
    body: fixPrBody,
    head: fixBranch,
    base: baseBranch,
  });

  // Comment on original PR linking to the fix PR
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: prNumber,
    body: `## 🤖 AI Fix Ready\n\nI've created a new PR with the fixes: **${fixPr.html_url}**\n\nReview and merge it when ready.`,
  });

  console.log(`\n✅  Fix PR created: ${fixPr.html_url}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const groqApiKey  = core.getInput("groq_api_key", { required: true });
  const githubToken = core.getInput("github_token", { required: true });
  const mode        = core.getInput("mode") || "review";
  const githubRepo  = getEnv("GITHUB_REPOSITORY");
  const eventPath   = getEnv("GITHUB_EVENT_PATH");

  const [owner, repo] = githubRepo.split("/");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

  const octokit = new Octokit({ auth: githubToken });
  const groq    = new Groq({ apiKey: groqApiKey });

  if (mode === "fix") {
    const prNumber  = event.issue?.number;
    const commentId = event.comment?.id;
    if (!prNumber) throw new Error("Could not determine PR number from event payload.");
    console.log(`\n🔧  Fixing issues on PR #${prNumber} in ${owner}/${repo}\n`);
    await runFix(octokit, groq, { owner, repo, prNumber, commentId });
  } else {
    const prNumber = event.pull_request?.number;
    const commitId = event.pull_request?.head?.sha;
    if (!prNumber) throw new Error("Could not determine PR number from event payload.");
    console.log(`\n🔍  Reviewing PR #${prNumber} in ${owner}/${repo}\n`);
    await runReview(octokit, groq, { owner, repo, prNumber, commitId });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
