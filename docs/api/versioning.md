# API Versioning Policy

## Versioning Model
- All primary endpoints are versioned under `/api/v1/`.
- Future breaking contract changes will introduce `/api/v2/` without deprecating existing v1 clients prematurely.
- Convenience aliases (`/health`, `/stop`, `/terminate`) map directly to their `/api/v1/` canonical endpoints.
