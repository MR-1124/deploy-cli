# Install

## Requirements

- **Node.js >= 18** (the CLI uses built-in `fetch`, no other dependencies).
- An npm registry you can install from.

## From npm (recommended)

```bash
npm install -g deploy-cli
```

Then verify:

```bash
deploy --version
deploy --help
```

## From this repository (development)

```bash
npm link        # makes a global `deploy` command pointing at this checkout
npm test        # run the full test suite first
```

## Without a global install

You can always run the CLI directly from the repo:

```bash
node cli.js up
```

## Update

```bash
npm update -g deploy-cli
```

## First run

```bash
deploy login
```

- In a terminal you'll be asked which provider and (for host providers) your
  token — typed into a **masked prompt** so it never shows on screen.
- Tokens are stored in `~/.deploy-cli/config.json` (mode 0600). Override the
  location with `DEPLOY_CONFIG_DIR` — useful in CI and sandboxes.
- You can skip the prompts by passing flags: `deploy login --provider netlify --token <PAT>`.
