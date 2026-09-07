# API Errors & Status Codes

All DSTNS API error responses return structured JSON with descriptive error codes and explanation fields:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_TICK_RATE",
    "message": "tick_rate must be greater than 0 and no greater than 10.",
    "field": "tick_rate",
    "received": 0.0
  }
}
```

## Standard HTTP Status Codes
- `200 OK`: Request succeeded.
- `201 Created`: Resource created.
- `202 Accepted`: Simulation or lifecycle action accepted.
- `400 Bad Request`: Malformed JSON or invalid parameter syntax.
- `404 Not Found`: Entity or route not found.
- `409 Conflict`: Action incompatible with current lifecycle state (e.g. start while already running).
- `422 Unprocessable Entity`: Validation failed on value bounds.
- `500 Internal Error`: Unexpected server exception.

## Standard Error Codes

- `INVALID_JSON`: the request body is not valid JSON.
- `MISSING_FIELD`: a required JSON member is absent.
- `INVALID_FIELD_TYPE`: a JSON member cannot be converted to the required type.
- `INVALID_REQUEST`: a syntactically valid value violates request validation.
- `NOT_FOUND`: a requested runtime entity does not exist.
- `LIFECYCLE_CONFLICT`: the action is incompatible with the current simulation state.
- `INTERNAL_ERROR`: an unexpected server failure; ordinary JSON shape errors are never reported with this code.
