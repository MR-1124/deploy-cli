# Interactive UI

`deploy` is a real CLI with a terminal UI: a menu, prompts, and masked token
entry — all with zero dependencies. It's also CI-safe: every prompt degrades to
a flag or a numbered input when stdin isn't a terminal.

## The menu

Running bare `deploy` in a terminal shows:

```
  ██████╗ ███████╗██████╗ ██╗      ██████╗ ██╗   ██╗
  ██╔══██╗██╔════╝██╔══██╗██║     ██╔═══██╗╚██╗ ██╔╝
  ...

? What would you like to do?            (↑/↓ to move, Enter to pick)
  › Deploy now
    Preview deploy
    Login
    List deploys
    Rollback
    Status
    Watch
    Diff
    Quit
```

Pick an action with the arrow keys and Enter. Choosing **Rollback** lists the
project's deploys and lets you pick the target with the same picker.

## Prompts

| Where | Prompt | Input |
|---|---|---|
| `deploy` (bare) | Menu | Arrow keys |
| `deploy login` (no flags) | Which provider? then token | Picker + **masked** text |
| `deploy up` (no provider set) | Which provider? | Picker |
| `deploy rollback` (no id) | Which deploy? | Picker |

Token entry is masked on a real terminal — you see `********`, never the value.

## Piped / non-TTY behavior

When stdout or stdin isn't a terminal (CI, scripts, pipes), prompts switch to
numbered input:

```
Which provider?
  > 1. local
    2. netlify
    3. vercel
    4. cloudflare
    5. s3
Enter choice [1]: 2
```

and text prompts read a plain line. Prefer flags in scripts:

```bash
deploy login --provider netlify --token "$NETLIFY_TOKEN"
deploy up --provider netlify --json
```

The environment variable `DEPLOY_FORCE_TTY=1` forces the interactive path (used
by the test suite) — handy for local experimentation.

## Why this design

- **Zero dependencies** — no inquirer/prompts install; the UI is ~150 lines of
  readline.
- **CI-safe by construction** — a script can never hang on a prompt: no TTY,
  no prompt, or a numbered fallback.
- **Masked secrets** — tokens never echo on a real terminal.
