# CI/CD

The CLI is CI-friendly by design: no prompts when stdin isn't a terminal,
`--json` for clean machine output, and a bundled control plane so previews need
no external accounts.

## GitHub Actions: preview deploys on PRs

This repo ships a working workflow (`.github/workflows/preview.yml`) that:

1. starts `deploy server` on the runner,
2. deploys the PR branch with `deploy preview --json`,
3. comments the preview URL on the PR.

Adapt it for your repo (the CLI needs to be installed — `npm i -g @mayan1124/deploy-cli`
or `npm i -D @mayan1124/deploy-cli` and use `npx deploy`):

```yaml
name: Preview deploy
on: { pull_request: {} }
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @mayan1124/deploy-cli
      - name: Start control plane
        run: deploy server --port 8787 &
      - name: Login
        run: DEPLOY_CONFIG_DIR=$RUNNER_TEMP/dc deploy login --server http://localhost:8787
      - name: Preview deploy
        id: deploy
        run: |
          cd examples/sample-site
          DEPLOY_CONFIG_DIR=$RUNNER_TEMP/dc deploy preview --no-build --json > preview.json
          echo "url=$(node -e "console.log(require('./preview.json').url)")" >> "$GITHUB_OUTPUT"
      - name: Comment URL
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 **Preview:** ${{ steps.deploy.outputs.url }}`,
            });
```

## Deploying to Netlify/Vercel from CI

Store the token as a secret and pass it with flags (never prompts):

```bash
deploy login --provider netlify --token "$NETLIFY_AUTH_TOKEN"
deploy up --provider netlify --site my-site --no-build --json
```

`--json` keeps stdout pure JSON — parse it with `jq .url` or any JSON tool.

## Notes

- `--no-build` is handy in CI when the build ran in an earlier step/job.
- `DEPLOY_CONFIG_DIR=$RUNNER_TEMP/dc` keeps credentials out of the workspace.
- `deploy watch` is for local development, not CI — use a single `deploy up`.
- Netlify's API rate limits (3 deploys/min, 100/day) apply to CI too.
