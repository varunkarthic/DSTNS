# UI Overlay API (`/ui-api/v1/*`)

The UI Overlay API is an independent visualization layer hosted by the Node.js Fastify server (`ui-engine/server/`) to allow external multi-agent decision systems to render custom vehicles and decision agents atop the DSTNS map.

## Endpoints

### 1. List Overlay Entities (`GET /ui-api/v1/entities`)
Returns all active external visual overlay entities.

### 2. Create Overlay Entity (`POST /ui-api/v1/entities`)
```json
{
  "id": "agent-bus-01",
  "type": "vehicle",
  "node_id": 14,
  "label": "Decision Agent 01",
  "icon": "bus",
  "metadata": {"route": "Downtown Loop"}
}
```

### 3. Move Visual Entity (`POST /ui-api/v1/entities/{id}/move`)
```json
{
  "from_node_id": 14,
  "to_node_id": 28,
  "path_node_ids": [14, 18, 22, 28],
  "duration_ms": 4000
}
```

### 4. Delete Overlay Entity (`DELETE /ui-api/v1/entities/{id}`)
Removes the specified entity from the overlay renderer.
