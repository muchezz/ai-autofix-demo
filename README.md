# AI Auto-Fix — GitHub Actions → n8n → Claude → Pull Request

When a GitHub Actions job fails, it POSTs the failing logs to a self-hosted
**n8n** webhook. n8n hands them to **Claude**, which diagnoses the failure and
returns corrected file contents. n8n commits the fix to a new branch and opens a
**Pull Request** (never auto-merges), then emails you over SMTP.

```
GitHub Actions (fails)
        │  POST logs + source  (x-autofix-secret header)
        ▼
   n8n webhook  ──►  Claude (/v1/messages, tool use)  ──►  GitHub API: branch + commit + PR
        │
        ▼
   SMTP email notification
```

Only **n8n** is self-hosted (on your own EC2). GitHub.com and GitHub Actions are
hosted and free. Nothing here touches work infrastructure.

---

## What's in here

| Path | Purpose |
|------|---------|
| `docker-compose.yml` | n8n + Postgres + Caddy (auto-HTTPS) for EC2 |
| `Caddyfile` | Reverse proxy + TLS for your domain |
| `.env.example` | All secrets/config — copy to `.env` |
| `n8n/workflow.json` | Importable n8n flow (Webhook → brain → Email) |
| `n8n/brain.js` | The Code node logic — paste into the Code node (n8n can't import files) |
| `app/` | Demo Express service with a deliberate bug + failing test |
| `.github/workflows/ci.yml` | Runs tests; on failure, fires the webhook |

---

## Prerequisites

- A domain you control (point an A record at the EC2 public IP).
- An EC2 instance in **your personal AWS account** (t3.small is comfortable; t3.micro works for light use). Ubuntu 22.04/24.04.
- An Anthropic API key.
- A GitHub repo where you'll push this code.

---

## 1. Launch and prep the EC2 box

Security group inbound rules:

| Port | Source | Why |
|------|--------|-----|
| 22 | your IP only | SSH |
| 80 | 0.0.0.0/0 | Caddy HTTP-01 TLS challenge |
| 443 | 0.0.0.0/0 | n8n over HTTPS (GitHub must reach it) |

Point DNS: create an **A record** for `autofix.yourdomain.com` → the instance's public IP.

Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 2. Deploy n8n

```bash
git clone <your-repo-url> ai-autofix && cd ai-autofix
cp .env.example .env
nano .env        # fill in EVERY value (see below)
docker compose up -d
docker compose logs -f caddy   # wait for the cert to be issued
```

Open `https://autofix.yourdomain.com` and create your n8n owner account.

### Filling in `.env`

| Var | Value |
|-----|-------|
| `N8N_HOST` | `autofix.yourdomain.com` |
| `POSTGRES_PASSWORD` | any strong string |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 24` |
| `ANTHROPIC_API_KEY` | your key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` (use a stronger model for harder fixes) |
| `GH_TOKEN` | fine-grained PAT, **Contents: Read/Write** + **Pull requests: Read/Write** on the target repo |
| `AUTOFIX_WEBHOOK_SECRET` | `openssl rand -hex 16` (also goes in GitHub Secrets) |
| `AUTOFIX_FROM_EMAIL` / `AUTOFIX_TO_EMAIL` | sender / your inbox |

## 3. Configure n8n

1. **Import the workflow:** top-right menu → *Import from File* → `n8n/workflow.json`.
2. **Paste the brain:** open the "Brain (Claude + GitHub)" Code node and replace the
   placeholder with the full contents of `n8n/brain.js`.
3. **Create the SMTP credential:** *Credentials → New → SMTP*. Use a transactional
   provider (Brevo, Mailgun, SES SMTP, etc.). Then open the **Notify (SMTP)** node and
   select that credential.
4. **Activate** the workflow (toggle, top-right). Activation is what exposes the
   **production** webhook URL: `https://autofix.yourdomain.com/webhook/ai-autofix`
   (the `/webhook-test/...` URL only works while you click *Listen for test event*).

> The Code node reads `ANTHROPIC_API_KEY`, `GH_TOKEN`, and `AUTOFIX_WEBHOOK_SECRET`
> from the container environment, so they're already wired by `.env` — no separate
> n8n credential needed for those.

## 4. Push the code and set GitHub Secrets

```bash
git add . && git commit -m "AI Auto-Fix" && git push
```

In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `N8N_WEBHOOK_URL` | `https://autofix.yourdomain.com/webhook/ai-autofix` |
| `AUTOFIX_WEBHOOK_SECRET` | same value as in `.env` |

## 5. Trigger it

The repo ships with a deliberate bug: `add(2, '3')` returns `'23'` instead of `5`,
and `app/server.test.js` asserts it should be `5`. So the very first push fails CI,
which fires the webhook.

Watch it run: **Actions** tab shows the red job → within a few seconds the
**Pull requests** tab shows a new PR titled by Claude, with the root cause in the
body. You also get an email. Review the diff and merge — the loop never merges for you.

To re-trigger anytime: make any commit that breaks a test, or re-run the **CI**
workflow manually via `workflow_dispatch` after reintroducing a bug.

## Design notes

- **Full file contents, not diffs.** Unified diffs are fragile to apply
  programmatically; full-file replacement via the GitHub Contents API is far more
  reliable. Enforced by forcing the single `propose_fix` tool so Claude must return
  structured JSON.
- **Opens a PR, never merges.** The human gate stays. Keep branch protection on `main`.
- No open ports beyond 22/80/443, no domain-less mode — n8n needs a real HTTPS
  endpoint GitHub can reach.

## Troubleshooting

- **No PR appears:** open the n8n **Executions** tab — the failed execution shows the
  exact error (bad PAT scope, branch already exists, Claude returned no change).
- **GitHub `422` creating the ref:** the branch already exists from a prior run; delete it or let Claude pick a new `branch_name`.
- **Webhook 404:** the workflow isn't **active**, or you used the `/webhook-test/` URL.
- **Email not sent but PR created:** the SMTP credential isn't selected on the Notify node.
# ai-autofix-demo
