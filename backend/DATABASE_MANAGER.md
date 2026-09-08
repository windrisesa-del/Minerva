# Minerva database manager

Minerva uses the portable DBeaver Community edition as its local PostgreSQL management UI.

## Open it

Double-click `启动 Minerva 数据管理器.bat` in the parent workspace folder. The launcher starts the existing PostgreSQL service and opens the saved `Minerva PostgreSQL` connection.

Connection details:

- Host: `127.0.0.1`
- Port: `5432`
- Database: `minerva`
- Role: `minerva_manager`
- Schema: `public`

The manager role can read and edit rows in Minerva business tables. It cannot create databases, create roles, or act as a PostgreSQL superuser. DBeaver uses manual transactions for this connection, so review changes before committing them.

Useful tables include `students`, `classrooms`, `assignments`, `questions`, `submissions`, `answer_attempts`, `grading_results`, `student_observations`, and `audit_logs`.

## Reinstall the portable runtime

The application and workspace are intentionally stored under ignored `.runtime` and `.data` directories. If the runtime is removed, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File backend\scripts\install_dbeaver.ps1
```

Then initialize the restricted role once:

```powershell
backend\.runtime\pgsql\bin\psql.exe -h 127.0.0.1 -p 5432 -U minerva -d minerva -f backend\scripts\setup_dbeaver.sql
```
