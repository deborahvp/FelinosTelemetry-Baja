# Contributing

## Setup

```bash
python -m venv .venv
pip install -e ".[dev]"
pre-commit install
```

## Workflow

- `main` is protected. Work on `feat/…`, `fix/…` or `docs/…` branches and open a pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(io): …`, `fix(dashboard): …`).
- Before committing, everything must pass:

  ```bash
  ruff check . && ruff format --check . && mypy && pytest
  ```

- Add an entry under `[Unreleased]` in `CHANGELOG.md` for user-facing changes.
- Releases are tagged with SemVer (`vX.Y.Z`).

## Conventions

- Code, identifiers, commits and the README in English. Team field guides (`docs/*.es.md`) in Spanish.
- Every user-facing dashboard string must exist in English (default) and Spanish.
- SI units internally (m, s, m/s², rad/s); convert to g, km/h, ft, mph only for display and reports.
- Timestamps are UTC nanoseconds since the Unix epoch, as produced by Sensor Logger.
- Never commit credentials. Use `.env` (from `.env.example`) and `dashboard/config.js` (from `config.example.js`).
- Raw recordings stay out of git (`data/`, `tests/raw/`). Fixtures in `tests/fixtures/` must be small.
