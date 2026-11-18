# Next ESLint glob compatibility

The exact `@next/eslint-plugin-next@16.4.6>fast-glob` dependency is aliased to
the already-locked MIT-licensed `tinyglobby@0.2.17`. This preserves root-directory discovery with deeply nested braces.

The pinned plugin uses only `globSync` to discover Next project directories.
Its patch disables tinyglobby's automatic directory expansion as required by the
[migration guide](https://superchupu.dev/tinyglobby/migration), searches from the
filesystem root for consistent Windows/Unix absolute-path handling, and preserves
relative versus absolute result paths. It does not change lint rules.

`apps/web/eslint-root-dirs.test.ts` tests actual patched plugin discovery, including
literal/glob roots, multiple projects, recursion, paths outside the current
directory, and deeply nested braces. It passes on Windows and Linux.
Docker copies both compatibility patches before frozen dependency installation.

The minimatch override uses the current matcher across lint tooling. Its patch
exposes the callable CommonJS function alongside the named exports that newer
callers use. Run the dependency patch tests, lint and both audits when updating
either pin.
