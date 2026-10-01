# Clean GitHub Images

Removes image versions belonging to closed pull requests and older untagged
versions. Add `tag-pattern` to also clean older tagged versions in the same run.

For example:

```yaml
- uses: AdeAttwood/CleanGithubImages@0.x
  with:
    org: Gl2Tech
    package: fleetobserver-web
    token: ${{ secrets.GHCR_TOKEN }}
    tag-pattern: '^run-[0-9]+$'
    pr-pattern: '^pr-([0-9]+)$'
    keep: '10'
```

`tag-pattern` is an optional JavaScript regular expression. `pr-pattern` is a
JavaScript regular expression defaulting to `^pr-([0-9]+)$`. Its first capture
group must contain the numeric PR number. For example, `^preview-([0-9]+)-image$`
recognizes `preview-42-image` as PR 42. A matching tag without a valid numeric
capture fails cleanup before any versions are deleted.
Open PR tags are always protected, even if they also match `tag-pattern`.

`keep` defaults to 10 and must be a non-negative integer. It applies separately
to eligible pattern-matching versions and untagged versions, ordered by creation
date, newest first. Zero retains no versions in either group. Closed-PR-only
versions are deleted regardless of `keep`.

GitHub deletes whole versions, not individual tags. A version is deleted only
when every tag is eligible for cleanup. Versions with other tags (such as `main`
or release tags) are protected and do not count toward `keep`. A version with
both closed-PR and pattern-matching tags follows pattern retention. Multiple
matching tags on the same version count as one version.
Retention does not check which images are currently deployed.

The token needs permission to read the repository's PRs and read and delete
the package versions.

## Development

```sh
yarn install --frozen-lockfile
yarn tsc --noEmit
yarn build
yarn test
```
