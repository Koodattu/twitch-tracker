# Next ESLint glob compatibility

The exact `@next/eslint-plugin-next@16.3.6>fast-glob` dependency is aliased to
the already-locked MIT-licensed `tinyglobby@0.2.17`. This removes the development-only
`fast-glob → micromatch → braces` chain affected by
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
No patched braces release was published when this change was made.

The pinned plugin uses only `globSync` to discover Next project directories.
Its patch disables tinyglobby's automatic directory expansion as required by the
[migration guide](https://superchupu.dev/tinyglobby/migration), searches from the
filesystem root for consistent Windows/Unix absolute-path handling, and preserves
relative versus absolute result paths. It does not change lint rules.

`apps/web/eslint-root-dirs.test.ts` tests actual patched plugin discovery, including
literal/glob roots, multiple projects, recursion, paths outside the current
directory, and deeply nested braces. It passes on Windows and Linux. Docker copies
the patch before frozen dependency installation; both production and full audits
remain required and pass without ignored advisories.

When upgrading the Next ESLint plugin, recheck its glob dependency. Remove this
version-scoped alias and patch together once upstream no longer requires the
vulnerable chain, and rerun the compatibility tests, lint, both audits and builds.
