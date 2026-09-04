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
