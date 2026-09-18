# Optional external annotation service

`npm run overlay --prefix ui-engine` runs the independent Node HTTP service on port 4174 (override with `PORT`). Its existing routes are retained:

- `GET /api/v1/ui-overlay/entities`
- `POST /api/v1/ui-overlay/entities` with `type` of `point`, `line`, `polygon` or `label`
- `PUT /api/v1/ui-overlay/entities/{id}` or `/{id}/move`
- `DELETE /api/v1/ui-overlay/entities/{id}`
- `GET /api/v1/ui-overlay/stream` for SSE changes

Entities live in memory and do not mutate the C++ simulation. This service is separate from the production server; the production map does not automatically consume these annotations. Earlier documentation described unimplemented `/ui-api/v1` routes and vehicle animation; those were not actual contracts.
