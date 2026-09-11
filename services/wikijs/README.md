# Minerva Wiki.js service

Wiki.js stores teacher-authored knowledge-point pages. Student identities, mastery levels, grading evidence, and observation history stay in Minerva PostgreSQL.

## Local setup

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\services\wikijs\ensure.ps1
```

Open `http://127.0.0.1:3002/` and complete the Wiki.js setup wizard. In Wiki.js Administration → API Access, create a read-only key with `read:pages`. Save only the token text to the ignored file `services/wikijs/api-token.txt`; the normal Minerva launcher reads it when FastAPI starts.

Environment variables can be used instead:

```powershell
$env:WIKIJS_URL = "http://127.0.0.1:3002"
$env:WIKIJS_PUBLIC_URL = "http://127.0.0.1:3002"
$env:WIKIJS_API_TOKEN = "<read-only token>"
```

Until the token exists, the Student Center graph still renders every knowledge point and mastery level from Minerva. Its status reads `Wiki 待配置`; no student identity, score, answer, grading evidence, or observation is sent to Wiki.js.

Knowledge pages can be matched to Minerva knowledge points by any of these conventions:

- page title equals `knowledge_name`
- final page path segment equals `knowledge_id`
- page has a tag in the form `minerva:<knowledge_id>`

Wiki.js page links create knowledge-to-knowledge edges. Minerva always creates the student-to-knowledge mastery edges itself.

## Runtime layout

- Wiki.js: `http://127.0.0.1:3002/`
- Minerva aggregation API: `GET /api/wiki/knowledge-graph/{student_id}` on FastAPI port 8000
- Browser proxy: `GET /api/wiki/knowledge-graph?studentId=...` on Next.js port 30141
- PostgreSQL database: `minerva_wiki`, separate from the `minerva` database

Use `services/wikijs/stop.ps1` to stop the local Wiki.js process. For production, run the pinned Wiki.js release in its own service/container and keep the same server-side API contract.
