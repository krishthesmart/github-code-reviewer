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

const SEVERITY_EMOJI = {
  CRITICAL:   "🔴",
  HIGH:       "🟠",
  MEDIUM:     "🟡",
  LOW:        "🟢",
  SUGGESTION: "💡",
};

const REVIEW_SYSTEM_PROMPT = `You are a senior security-focused code reviewer. Analyze the provided diff.

Respond with ONLY valid JSON in this exact format (no other text):
{
  "verdict": "REQUEST_CHANGES",
  "summary": "One paragraph overall assessment.",
  "issues": [
    {
      "line": 42,
      "severity": "CRITICAL",
      "category": "Security",
      "title": "Short title of the issue",
      "body": "Explanation of the problem and how to fix it in markdown."
    }
  ]
}

verdict rules:
- "REQUEST_CHANGES" if any CRITICAL or HIGH issues exist
- "APPROVE" if the diff looks clean with no significant issues
- "COMMENT" for minor/suggestion-only issues

severity values: CRITICAL, HIGH, MEDIUM, LOW, SUGGESTION
category values: Security, Bug, Performance, Maintainability

line: the line number in the NEW file where the issue appears (from the + lines in the diff).
      Use null if the issue is not tied to a specific line.

Security checks (OWASP Top 10 + more):
- SQL/Command/LDAP injection, XSS, SSRF, path traversal, XXE
- Broken auth, insecure tokens, weak passwords
- Hardcoded secrets, API keys, PII in logs
- Broken access control, missing auth checks
- Security misconfiguration, verbose errors
- Known vulnerable dependencies

Also check: bugs, logic errors, null dereference, race conditions, memory leaks,
unhandled exceptions, performance issues, dead code, missing input validation.

Return ONLY the JSON. No markdown fences, no explanation outside the JSON.`;

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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseReviewJSON(raw) {
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract JSON object from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

function countBySeverity(issues) {
  return issues.reduce((acc, i) => {
    acc[i.severity] = (acc[i.severity] || 0) + 1;
    return acc;
  }, {});
}

function verdictEmoji(verdict) {
  if (verdict === "APPROVE") return "✅ APPROVED";
  if (verdict === "REQUEST_CHANGES") return "❌ CHANGES REQUESTED";
  return "💬 COMMENTED";
}

function overallVerdict(results) {
  if (results.some((r) => r.verdict === "REQUEST_CHANGES")) return "REQUEST_CHANGES";
  if (results.every((r) => r.verdict === "APPROVE")) return "APPROVE";
  return "COMMENT";
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
      return { valid: false, error: (result.stderr || result.stdout || "syntax error").trim() };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
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
  return completion.choices[0]?.message?.content?.trim() ?? "{}";
}

async function dismissStaleReviews(octokit, { owner, repo, prNumber }) {
  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: prNumber });
    const stale = reviews.filter(
      (r) => r.user?.login === "github-actions[bot]" && r.state === "CHANGES_REQUESTED"
    );
    for (const review of stale) {
      await octokit.rest.pulls.dismissReview({
        owner, repo, pull_number: prNumber,
        review_id: review.id,
        message: "Superseded by new review.",
      });
    }
  } catch (_) {}
}

async function postReview(octokit, { owner, repo, prNumber, body, verdict, commitId, inlineComments }) {
  try {
    await octokit.rest.pulls.createReview({
      owner, repo,
      pull_number: prNumber,
      commit_id: commitId,
      body,
      event: verdict,
      comments: inlineComments,
    });
  } catch (err) {
    if (err.message?.includes("own pull request")) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    } else {
      throw err;
    }
  }
}

async function runReview(octokit, groq, { owner, repo, prNumber, commitId }) {
  await dismissStaleReviews(octokit, { owner, repo, prNumber });

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  console.log(`📂  ${files.length} file(s) changed.`);

  const reviewable = files.filter((f) => !shouldSkip(f));
  if (reviewable.length === 0) {
    console.log("ℹ️   No reviewable files.");
    return;
  }

  const results = [];

  for (const file of reviewable) {
    console.log(`  → Reviewing: ${file.filename}`);
    try {
      const raw    = await reviewFile(groq, file.filename, file.patch);
      const parsed = parseReviewJSON(raw);

      if (!parsed) {
        console.warn(`    Could not parse JSON response for ${file.filename}`);
        results.push({ filename: file.filename, verdict: "COMMENT", issues: [], summary: raw, error: null });
        continue;
      }

      results.push({
        filename: file.filename,
        verdict:  parsed.verdict || "COMMENT",
        issues:   parsed.issues  || [],
        summary:  parsed.summary || "",
        error:    null,
      });
      console.log(`    Verdict: ${parsed.verdict} — ${parsed.issues?.length ?? 0} issue(s)`);
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      results.push({ filename: file.filename, verdict: "COMMENT", issues: [], summary: null, error: err.message });
    }
  }

  const finalVerdict = overallVerdict(results);

  // ── Build inline comments ────────────────────────────────────────────────
  const inlineComments = [];
  for (const { filename, issues } of results) {
    for (const issue of issues) {
      if (!issue.line) continue;
      const emoji = SEVERITY_EMOJI[issue.severity] ?? "•";
      inlineComments.push({
        path: filename,
        line: issue.line,
        side: "RIGHT",
        body: `${emoji} **${issue.severity} ${issue.category} — ${issue.title}**\n\n${issue.body}`,
      });
    }
  }

  // ── Build summary review body ────────────────────────────────────────────
  const allIssues = results.flatMap((r) => r.issues);
  const counts    = countBySeverity(allIssues);

  const summaryLines = [
    `## 🤖 AI Code Review — ${verdictEmoji(finalVerdict)}`,
    "",
    `> Powered by **Groq** (\`${GROQ_MODEL}\`) · Checks: Security · Bugs · Performance · Maintainability`,
    `> 💡 Comment \`/fix\` to auto-apply fixes · \`/review\` to re-run review`,
    "",
  ];

  if (allIssues.length > 0) {
    summaryLines.push("**Issue summary:**");
    for (const [sev, emoji] of Object.entries(SEVERITY_EMOJI)) {
      if (counts[sev]) summaryLines.push(`${emoji} ${counts[sev]}x ${sev}`);
    }
    summaryLines.push("");
  }

  summaryLines.push("---", "");

  for (const { filename, issues, summary, error } of results) {
    const icon = issues.some((i) => ["CRITICAL","HIGH"].includes(i.severity)) ? "❌"
               : issues.length === 0 ? "✅" : "💬";
    summaryLines.push(`### ${icon} \`${filename}\``);
    summaryLines.push("");
    if (error) {
      summaryLines.push(`> ⚠️ Review skipped — API error: ${error}`);
    } else if (issues.length === 0) {
      summaryLines.push(summary || "No issues found. Looks good! ✅");
    } else {
      if (summary) summaryLines.push(`> ${summary}`, "");
      for (const issue of issues) {
        const emoji = SEVERITY_EMOJI[issue.severity] ?? "•";
        summaryLines.push(`**${emoji} ${issue.severity} ${issue.category} — ${issue.title}**`);
        summaryLines.push(issue.body);
        summaryLines.push("");
      }
    }
    summaryLines.push("---", "");
  }

  summaryLines.push(
    `<sub>Reviewed ${reviewable.length} file(s) · ${allIssues.length} issue(s) · ${new Date().toUTCString()}</sub>`
  );

  // Post inline comments with the review; fall back silently if any line is invalid
  const safeInline = [];
  for (const c of inlineComments) {
    safeInline.push(c);
  }

  await postReview(octokit, {
    owner, repo, prNumber,
    body: summaryLines.join("\n"),
    verdict: finalVerdict,
    commitId,
    inlineComments: safeInline,
  });

  console.log(`\n✅  Review posted — ${finalVerdict} · ${allIssues.length} issue(s) · ${inlineComments.length} inline comment(s)`);
}

// ── Fix mode ──────────────────────────────────────────────────────────────────

function postProcessCode(content) {
  return content.replace(
    /(\.\w+\s*\()\s*(<[^)]{0,500}>)\s*\)/g,
    (_, call, html) => `${call}\`${html}\`)`
  );
}

async function fixFileWithAI(groq, filename, content, feedback, priorSyntaxError = null) {
  const ext  = path.extname(filename).toLowerCase();
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
CRITICAL JAVASCRIPT SYNTAX RULES:
- NEVER use JSX syntax. This is plain JavaScript, not React.
- To send HTML in Express use template literals: res.send(\`<h1>Hello \${name}</h1>\`)
- NEVER write: res.send(<h1>...</h1>) — this is a SyntaxError
` : ""}
Return ONLY the complete fixed file content. No explanations, no markdown fences.`;

  if (priorSyntaxError) {
    userMessage += `\n\nPrevious attempt had this syntax error — do NOT repeat it:\n${priorSyntaxError}`;
  }

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: "You are an expert software engineer. Fix all issues in the provided code. Return ONLY the complete fixed source code — no markdown fences, no explanation, nothing else." },
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
      body: "## 🤖 AI Fix\n\nNo AI review found. Push a commit to trigger a review first.",
    });
    return;
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  // Create (or reset) the fix branch
  const fixBranch = `ai-fix/pr-${prNumber}`;
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${fixBranch}`, sha: commitSha });
    console.log(`  → Created branch: ${fixBranch}`);
  } catch (err) {
    if (err.status === 422) {
      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${fixBranch}`, sha: commitSha, force: true });
      console.log(`  → Reset branch: ${fixBranch}`);
    } else throw err;
  }

  const fixed  = [];
  const failed = [];

  for (const file of files.filter((f) => !shouldSkip(f))) {
    const regex = new RegExp(
      `### [✅❌💬] \`${escapeRegex(file.filename)}\`([\\s\\S]*?)(?=###\\s|<sub>|$)`
    );
    const match    = botReview.body?.match(regex);
    const feedback = match?.[1]?.trim();

    if (!feedback || feedback.includes("Review skipped")) continue;

    console.log(`  → Fixing: ${file.filename}`);
    try {
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner, repo, path: file.filename, ref: commitSha,
      });

      const original     = Buffer.from(fileData.content, "base64").toString("utf8");
      let   fixedContent = postProcessCode(await fixFileWithAI(groq, file.filename, original, feedback));

      if (!fixedContent || fixedContent === original) {
        console.log(`    No changes for ${file.filename}`);
        continue;
      }

      let check = validateSyntax(fixedContent, file.filename);
      if (!check.valid) {
        console.log(`    ↻ Syntax error — retrying...`);
        fixedContent = postProcessCode(await fixFileWithAI(groq, file.filename, original, feedback, check.error));
        check = validateSyntax(fixedContent, file.filename);
      }

      if (!check.valid) {
        console.error(`    ✗ Syntax still invalid: ${check.error}`);
        failed.push({ file: file.filename, error: `Syntax check failed after retry: ${check.error}` });
        continue;
      }
      if (!check.skipped) console.log(`    ✓ Syntax OK`);

      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo,
        path: file.filename,
        message: `fix(ai): auto-fix issues in ${file.filename}`,
        content: Buffer.from(fixedContent).toString("base64"),
        sha: fileData.sha,
        branch: fixBranch,
      });

      fixed.push(file.filename);
      console.log(`    ✅ Committed`);
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

  const fixPrBody = [
    `## 🤖 AI Fix for #${prNumber}`,
    "",
    `Auto-applied fixes based on the AI review of PR #${prNumber}.`,
    "",
    "**Fixed:**",
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

  await octokit.rest.issues.createComment({
    owner, repo, issue_number: prNumber,
    body: `## 🤖 AI Fix Ready\n\nCreated fix PR: **${fixPr.html_url}**\n\nReview and merge when ready.`,
  });

  console.log(`\n✅  Fix PR: ${fixPr.html_url}`);
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
    console.log(`\n🔧  Fixing PR #${prNumber} in ${owner}/${repo}\n`);
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
