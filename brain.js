// ============================================================================
// AI Auto-Fix — n8n Code node ("brain")
// Mode: Run Once for All Items   |   Language: JavaScript
//
// Receives the failure payload from GitHub Actions, asks Claude to diagnose the
// failure and produce corrected file contents, then creates a branch, commits
// the fix, and opens a Pull Request (never auto-merges — a human reviews it).
//
// Secrets are read from environment variables passed to the n8n container
// (see docker-compose.yml): ANTHROPIC_API_KEY, GH_TOKEN, AUTOFIX_WEBHOOK_SECRET,
// CLAUDE_MODEL (optional, defaults to claude-sonnet-4-6).
// ============================================================================

const item = $input.first().json;
const body = item.body || item;            // webhook puts POST data under .body
const headers = item.headers || {};

// --- 1. Validate the shared secret ----------------------------------------
const expectedSecret = $env.AUTOFIX_WEBHOOK_SECRET;
const providedSecret = headers['x-autofix-secret'];

if (!expectedSecret || providedSecret !== expectedSecret) {
  throw new Error('Rejected: missing or invalid x-autofix-secret header');
}

const { repo, owner, branch: baseBranch, commit_sha, run_url, files, log } = body;

if (!repo || !owner || !files || !log) {
  throw new Error('Rejected: payload missing required fields (repo, owner, files, log)');
}

// --- 2. Build the prompt for Claude ----------------------------------------
const fileBlock = files
  .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
  .join('\n\n');

const userPrompt = `A CI job just failed on branch "${baseBranch}" (commit ${commit_sha}).

Failure log:
${log}

Relevant source files:
${fileBlock}

Diagnose the root cause and call the propose_fix tool with a fix. Return the FULL
corrected content for every file you change (not a diff/patch) — the content will
be written verbatim via the GitHub Contents API. Only include files that actually
need to change. Keep the fix minimal and focused on making the failing test pass.`;

// --- 3. Call Claude, forcing the propose_fix tool ---------------------------
const claudeResp = await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  headers: {
    'content-type': 'application/json',
    'x-api-key': $env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  },
  body: {
    model: $env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [
      {
        name: 'propose_fix',
        description: 'Propose a fix for the failing CI job.',
        input_schema: {
          type: 'object',
          properties: {
            branch_name: { type: 'string', description: 'e.g. autofix/2026-07-29-null-check' },
            pr_title: { type: 'string' },
            pr_body: { type: 'string', description: 'Root cause + what changed, markdown.' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  content: { type: 'string', description: 'Full corrected file contents.' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['branch_name', 'pr_title', 'pr_body', 'files'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'propose_fix' },
  },
  json: true,
});

const toolUse = (claudeResp.content || []).find((b) => b.type === 'tool_use');
if (!toolUse) {
  throw new Error('Claude did not return a propose_fix tool call — nothing to commit.');
}
const fix = toolUse.input;

// --- 4. Create the branch off the base commit -------------------------------
const ghHeaders = {
  authorization: `Bearer ${$env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
};

await this.helpers.httpRequest({
  method: 'POST',
  url: `https://api.github.com/repos/${owner}/${repo}/git/refs`,
  headers: ghHeaders,
  body: { ref: `refs/heads/${fix.branch_name}`, sha: commit_sha },
  json: true,
});

// --- 5. Commit each changed file via the Contents API -----------------------
for (const f of fix.files) {
  // Need the current file's blob sha if it already exists (update vs create).
  let sha;
  try {
    const existing = await this.helpers.httpRequest({
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}/contents/${f.path}`,
      qs: { ref: fix.branch_name },
      headers: ghHeaders,
      json: true,
    });
    sha = existing.sha;
  } catch (e) {
    sha = undefined; // file doesn't exist yet — will be created
  }

  await this.helpers.httpRequest({
    method: 'PUT',
    url: `https://api.github.com/repos/${owner}/${repo}/contents/${f.path}`,
    headers: ghHeaders,
    body: {
      message: `autofix: ${fix.pr_title}`,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      branch: fix.branch_name,
      ...(sha ? { sha } : {}),
    },
    json: true,
  });
}

// --- 6. Open the Pull Request (never auto-merged) ---------------------------
const pr = await this.helpers.httpRequest({
  method: 'POST',
  url: `https://api.github.com/repos/${owner}/${repo}/pulls`,
  headers: ghHeaders,
  body: {
    title: fix.pr_title,
    head: fix.branch_name,
    base: baseBranch,
    body: `${fix.pr_body}\n\n---\n*Opened automatically by AI Auto-Fix from a failing run: ${run_url}*`,
  },
  json: true,
});

// --- 7. Return data for the downstream Notify (SMTP) node -------------------
return [
  {
    json: {
      pr_url: pr.html_url,
      pr_title: fix.pr_title,
      branch_name: fix.branch_name,
      repo: `${owner}/${repo}`,
      run_url,
    },
  },
];
