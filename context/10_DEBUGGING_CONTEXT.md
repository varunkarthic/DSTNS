# Debugging Context (10)

## Common Diagnostic Procedures
1. **Inspecting Live Server Logs**:
   ```bash
   python3 launcher.py logs
   ```
2. **Checking SQLite Journal**:
   ```bash
   sqlite3 logs/runtime.db "SELECT * FROM event_log ORDER BY id DESC LIMIT 20;"
   ```
3. **Validating Scenario Hashes**:
   ```bash
   ./build/dstns_replay_verify "0x123456789ABCDEF0"
   ```
4. **Running Sanitizer Build**:
   ```bash
   cmake -S . -B build-asan -DDSTNS_ENABLE_SANITIZERS=ON -DDSTNS_BUILD_TESTS=ON
   cmake --build build-asan
   ctest --test-dir build-asan --output-on-failure
   ```
