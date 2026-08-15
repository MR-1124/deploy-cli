# Publishing to npm

The package is publish-ready: `bin`, `files`, `exports`, `engines`, LICENSE,
and keywords are configured in `package.json`.

## Before publishing

1. Update `version` in `package.json` (semver).
2. Run the full test suite:

```bash
npm test
```

3. Inspect the tarball:

```bash
npm pack
# deploy-cli-0.3.0.tgz
tar -tzf deploy-cli-0.3.0.tgz
```

The package contains only `cli.js`, `lib/`, `docs/`, `README.md`, and
`LICENSE` — no tests, examples, site, or local storage.

4. Install the tarball into a clean prefix and smoke-test the binary:

```bash
npm install -g ./deploy-cli-0.3.0.tgz --prefix "$HOME/.deploy-test"
"$HOME/.deploy-test/bin/deploy" --version
"$HOME/.deploy-test/bin/deploy" --help
```

5. Dry run:

```bash
npm publish --dry-run
```

## Publishing

```bash
npm publish
```

- Requires npm credentials (`npm login`) and ownership of the `deploy-cli`
  name. If the name is taken on the registry, publish under your own scope,
  e.g. `@yourname/deploy-cli` (update `name` in package.json and the bin key
  stays `deploy`).
- First publish: `npm publish --access public` if the package is scoped.
- After publishing, install from the registry and verify:

```bash
npm install -g deploy-cli
deploy --version
deploy --help
```

## Versioning

- Patch for fixes, minor for features, major for breaking changes.
- The interactive UI, new providers, `--json`, and `deploy doctor` shipped in 0.3.0.

## Housekeeping before release

- Update the `repository` URL in package.json to the real repo.
- Remove any placeholder links in `site/` (the website footer points at the
  repo).
- Update the version shown in the website and README.
