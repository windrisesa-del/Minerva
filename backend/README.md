# Minerva data API

This directory contains an isolated FastAPI service backed by a project-local PostgreSQL instance.
It does not replace or modify Pi session storage, and the legacy `~/.pi/minerva/students.json`
file remains intact after migration.

## One-time setup

From PowerShell in `backend`:

```powershell
.\scripts\setup.ps1
```

The setup script downloads the official EDB PostgreSQL 18.6 Windows binary archive into the
git-ignored `.runtime` directory, creates a local-only cluster in `.data/postgres`, installs the
Python dependencies with a project-local uv cache/runtime, creates the schema, and imports the
existing student JSON file when present.

## Start

```powershell
.\scripts\start_data_api.ps1
```

Health is available at <http://127.0.0.1:8000/api/health>. API documentation is available at <http://127.0.0.1:8000/docs>.

For interactive database management, use DBeaver as described in `DATABASE_MANAGER.md`.

## Stop PostgreSQL

```powershell
.\scripts\stop_postgres.ps1
```

## Local-development security boundary

The portable database uses trust authentication and listens only on `127.0.0.1`. This is suitable
for the current single-computer prototype, but it must be replaced with SCRAM credentials, TLS,
role separation, backup encryption, and application authentication before any LAN or school-wide
deployment.
