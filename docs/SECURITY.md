# Security Architecture

## Principles
1. **No Docker Socket Mounting**: The application container never mounts `/var/run/docker.sock`, preventing container breakout.
2. **Graceful Internal Termination**: The `/api/v1/system/terminate` endpoint performs clean process exit without requiring root host capabilities.
3. **Transport Security**: External client traffic is terminated with TLS/HTTPS at the gateway (`dstns-gateway`).
4. **Input Sanitization**: Numeric inputs for rate scaling and coordinates are strictly clamped to finite valid ranges, preventing divide-by-zero or NaN injection.
