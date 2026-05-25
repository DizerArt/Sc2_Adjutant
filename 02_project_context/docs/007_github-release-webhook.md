# GitHub Release Webhook

Trigger phrase: `Сделай Релиз в Гитхаб`

When an agent receives this exact release request, it must execute the release flow below end to end unless a command fails.

## Required Order

1. Inspect the repository state.
   - Run `git status --short`.
   - Identify the latest app version from `02_application/package.json`.
   - Identify the latest Git tag with `git tag --sort=-v:refname`.

2. Choose the next version.
   - Use the next patch version unless the user explicitly requested a specific version.
   - Update `02_application/package.json`.
   - Update `02_application/package-lock.json`.
   - Keep the Git tag format as `vX.Y.Z`.

3. Verify changes before packaging.
   - Run targeted tests for the touched code when practical.
   - Run `npm run typecheck` from `02_application`.
   - Run `npm run build` from `02_application`.

4. Build the Windows installer.
   - Run `npm run dist:win` from `02_application`.
   - Confirm the new artifacts exist under `02_application/release`.
   - Prefer the `.exe` installer artifact for GitHub Releases.

5. Write full release notes.
   - Summarize every user-facing change since the previous tag.
   - Include bug fixes, UI changes, data repair behavior, and packaging/version changes.
   - Mention verification commands that passed.
   - Save the notes to `02_project_context/docs/changelog/release-X.Y.Z.md`.

6. Commit all release changes.
   - Review `git diff --stat`.
   - Stage the intended files with `git add`.
   - Commit with a clear message, for example `Release vX.Y.Z`.

7. Push code and tag.
   - Push the branch to `origin`.
   - Create or move the local tag `vX.Y.Z` to the release commit.
   - Push the tag to `origin`.
   - If a tag with the same name exists locally or remotely, do not overwrite it unless the user explicitly asked to move that tag.

8. Publish GitHub release.
   - Use `gh release create vX.Y.Z`.
   - Attach the new installer artifact from `02_application/release`.
   - Use the saved release notes as the release body.
   - Verify the release URL after publishing.

## Safety Rules

- Never reuse an existing published release tag for a new build unless the user explicitly asks to replace that release.
- Do not silently drop dirty worktree changes. If the user asked for a release, include the current intended changes in the release commit.
- Do not publish if tests, typecheck, build, or installer packaging fails.
- Do not invent release notes. Base them on the actual diff, commits, and files changed.
