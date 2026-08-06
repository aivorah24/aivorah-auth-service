# Working rules

## Branch protection
Private repo on GitHub Free — branch protection rules exist but are **not
enforced** (GitHub limitation on private repos without a paid plan). Follow it
manually:
- Never push directly to `main`
- Always: new branch → change → PR → merge
- One PR per endpoint/change, not one big branch for everything

## PR discipline
- Use the PR template checklist every time
- Run `npm test` locally and confirm it passes before merging - no CI yet
