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
# mayan1124-deploy-cli-0.3.0.tgz (scoped packages omit the @)
tar -tzf mayan1124-deploy-cli-0.3.0.tgz
```

The package contains only `cli.js`, `lib/`, `docs/`, `README.md`, and
`LICENSE` — no tests, examples, site, or local storage.

4. Install the tarball into a clean prefix and smoke-test the binary:

```bash
npm install -g ./mayan1124-deploy-cli-0.3.0.tgz --prefix "$HOME/.deploy-test"
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

- Requires npm credentials (`npm login`) and ownership of the scope. This
  package publishes as `@mayan1124/deploy-cli` because the unscoped
  `deploy-cli` name is already taken on the registry; the bin key stays
  `deploy`.
- First publish of a scoped package: `npm publish --access public`.
- After publishing, install from the registry and verify:

```bash
npm install -g @mayan1124/deploy-cli
deploy --version
deploy --help
```

## Versioning

- Patch for fixes, minor for features, major for breaking changes.
- The interactive UI, new providers, `--json`, and `deploy doctor` shipped in 0.3.0.

## Housekeeping before release

- Update the `repository` URL in package.json to the real repo
  (already done: `git+https://github.com/MR-1124/deploy-cli.git`).
- Remove any placeholder links in `site/` (the website footer points at the
  repo).
- Update the version shown in the website and README.
