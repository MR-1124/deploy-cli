# DevCLI Setup & Secrets Guide

A complete reference for setting up prerequisites, generating provider tokens, saving local credentials, configuring GitHub repository secrets, and running verification tests.

---

## Step 1: Install prerequisites

```powershell
# Node.js (if not already installed)
winget install OpenJS.NodeJS.LTS

# GitHub CLI (for setting repository secrets)
winget install GitHub.cli
gh auth login
```

---

## Step 2: Clone and set up the repo

```powershell
git clone https://github.com/MR-1124/deploy-cli.git
cd deploy-cli
npm install
```

---

## Step 3: Get your tokens

### Netlify
1. Go to [Netlify Personal Access Tokens](https://app.netlify.com/user/applications#personal-access-tokens).
2. Click **New access token** → name it `deploy-cli` → **Generate token** → copy it.

### Vercel
1. Go to [Vercel Account Tokens](https://vercel.com/account/tokens).
2. Click **Create** → name it `deploy-cli` → copy it.
3. Also grab your **Team ID** from https://vercel.com/dashboard → Settings → General → Team ID (if using a team).

### Cloudflare
1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Custom token**.
2. Permission: `Cloudflare Pages` → `Edit`.
3. Account Resources: Include → **All accounts**.
4. Zone Resources: default (`All zones`).
5. Create → copy token.
6. Account ID: located in the right sidebar of any dashboard page, or via:
   ```bash
   curl -s "https://api.cloudflare.com/client/v4/accounts" -H "Authorization: Bearer <TOKEN>"
   ```
   Copy the `id` field from your account in the response.

### AWS S3
1. IAM → Users → Create user (e.g. `deploy-cli`) → Attach inline policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-BUCKET" }
     ]
   }
   ```
2. User → Security credentials → Create access key → copy **Access key ID** + **Secret access key**.
3. S3 → Create bucket → note the **region** (e.g. `us-east-1`).
4. Bucket → Permissions → Block public access → uncheck all → Save.
5. Bucket policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::YOUR-BUCKET/*" }]
   }
   ```

---

## Step 4: Save credentials locally

```powershell
# Netlify
node cli.js login --provider netlify --token <YOUR_NETLIFY_TOKEN>

# Vercel (without or with team)
node cli.js login --provider vercel --token <YOUR_VERCEL_TOKEN>
node cli.js login --provider vercel --token <YOUR_VERCEL_TOKEN> --team <TEAM_ID>

# Cloudflare
node cli.js login --provider cloudflare --token <YOUR_CF_TOKEN> --account <YOUR_ACCOUNT_ID>

# S3
node cli.js login --provider s3 --access-key <AK> --secret-key <SK> --bucket <BUCKET_NAME> --region us-east-1
```

Verify everything:
```powershell
node cli.js doctor
```

---

## Step 5: Set GitHub repo secrets

```powershell
# If not already authenticated:
gh auth login

# One by one (each prompts for the value — paste, don't type):
gh secret set NPM_TOKEN -R MR-1124/deploy-cli
gh secret set NETLIFY_AUTH_TOKEN -R MR-1124/deploy-cli
gh secret set VERCEL_TOKEN -R MR-1124/deploy-cli
gh secret set CLOUDFLARE_API_TOKEN -R MR-1124/deploy-cli
gh secret set CLOUDFLARE_ACCOUNT_ID -R MR-1124/deploy-cli
gh secret set AWS_ACCESS_KEY_ID -R MR-1124/deploy-cli
gh secret set AWS_SECRET_ACCESS_KEY -R MR-1124/deploy-cli
gh secret set SMOKE_S3_BUCKET -R MR-1124/deploy-cli
gh secret set AWS_REGION -R MR-1124/deploy-cli
```

---

## Step 6: Verify everything works

```powershell
# Local smoke test (uses saved credentials from deploy login)
npm run smoke

# Full health check
node cli.js doctor
```

---

## Token Reference

| Provider | Env var (GitHub Actions) | Also via `deploy login` |
|---|---|---|
| Netlify | `NETLIFY_AUTH_TOKEN` | `--provider netlify --token` |
| Vercel | `VERCEL_TOKEN` | `--provider vercel --token` |
| Cloudflare | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `--provider cloudflare --token --account` |
| AWS | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `SMOKE_S3_BUCKET` + `AWS_REGION` | `--provider s3 --access-key --secret-key --bucket --region` |
| npm | `NPM_TOKEN` | manual: `npm config set //registry.npmjs.org/:_authToken=<token>` |

> [!NOTE]
> `deploy login` commands save to `~/.deploy-cli/config.json`, so after a reset you only run them once and every future `npm run smoke` or `deploy up` works from any shell.
