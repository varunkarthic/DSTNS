import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * Startup verification.
 *
 * Every check answers one question: is this install actually able to run a
 * simulation right now? They are ordered cheapest first, and each one reports
 * what it found rather than just pass or fail, so a failure tells the operator
 * what to do instead of only that something is wrong.
 *
 * Severity:
 *   fail - the system cannot run; startup stops.
 *   warn - degraded but usable; startup continues and says what is reduced.
 *   ok   - verified.
 *
 * The suites are included deliberately. They are the fast ones (a few seconds
 * in total), and running them at startup is what makes "the system is good to
 * go" a statement about this machine rather than about CI.
 */

export const OK = 'ok'
export const WARN = 'warn'
export const FAIL = 'fail'

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    try {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: -1, out, ms: Date.now() - started, timedOut: true })
      }, options.timeout ?? 120_000)
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, out, ms: Date.now() - started, timedOut: false })
      })
      child.once('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -1, out: String(e.message), ms: Date.now() - started, timedOut: false })
      })
    } catch (e) {
      resolve({ code: -1, out: String(e.message), ms: Date.now() - started, timedOut: false })
    }
  })

const portFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })

/** Build the check list. `root` is the repository root. */
export function checks(root, options = {}) {
  const suites = options.suites !== false
  const server = path.join(root, 'build', 'dstns_server')
  const dist = path.join(root, 'ui-engine', 'dist')

  const list = [
    {
      name: 'Host platform',
      run: async () => {
        const supported = ['darwin', 'linux'].includes(os.platform())
        const gb = (os.totalmem() / 1024 ** 3).toFixed(1)
        return {
          level: supported ? OK : WARN,
          detail: `${os.platform()} ${os.release()} · ${os.arch()} · ${os.cpus().length} cores · ${gb} GB`,
          hint: supported ? '' : 'Only macOS and Linux are exercised.',
        }
      },
    },
    {
      name: 'Node runtime',
      run: async () => {
        const major = Number(process.versions.node.split('.')[0])
        return {
          level: major >= 20 ? OK : FAIL,
          detail: `Node ${process.versions.node}`,
          hint: major >= 20 ? '' : 'Node 20 or newer is required.',
        }
      },
    },
    {
      name: 'Python 3',
      run: async () => {
        // The map fetcher runs under Python; without it no seed can resolve.
        const r = await run('python3', ['--version'], { timeout: 8000 })
        return {
          level: r.code === 0 ? OK : FAIL,
          detail: r.code === 0 ? r.out.trim() : 'python3 not found on PATH',
          hint: r.code === 0 ? '' : 'Required to download map extracts from OpenStreetMap.',
        }
      },
    },
    {
      name: 'Licence',
      run: async () => {
        const licence = path.join(root, 'LICENSE')
        if (!existsSync(licence)) {
          return {
            level: WARN,
            detail: 'LICENSE is missing',
            hint: 'DSTNS is distributed under AGPL-3.0-or-later; the licence text should ship with it.',
          }
        }
        const text = readFileSync(licence, 'utf8')
        const agpl = text.includes('GNU AFFERO GENERAL PUBLIC LICENSE')
        return {
          level: agpl ? OK : WARN,
          detail: agpl ? 'AGPL-3.0-or-later' : 'LICENSE present but is not the AGPL text',
        }
      },
    },
    {
      name: 'Runtime configuration',
      run: async () => {
        const problems = []
        for (const file of ['config/defaults.json', 'config/ui-config.json']) {
          const full = path.join(root, file)
          if (!existsSync(full)) {
            problems.push(`${file} missing`)
            continue
          }
          try {
            JSON.parse(readFileSync(full, 'utf8'))
          } catch (e) {
            problems.push(`${file}: ${e.message}`)
          }
        }
        return {
          level: problems.length ? FAIL : OK,
          detail: problems.length ? problems.join('; ') : 'defaults.json and ui-config.json parse',
          hint: problems.length ? 'Fix or restore the configuration before starting.' : '',
        }
      },
    },
    {
      name: 'Map fetcher',
      run: async () => {
        const script = path.join(root, 'scripts', 'fetch_osm.py')
        if (!existsSync(script))
          return { level: FAIL, detail: 'scripts/fetch_osm.py missing', hint: 'Seeds cannot resolve to a city without it.' }
        // Compile it, so a syntax error is caught here and not mid-download.
        const r = await run('python3', ['-m', 'py_compile', script], { timeout: 15000 })
        return {
          level: r.code === 0 ? OK : FAIL,
          detail: r.code === 0 ? 'scripts/fetch_osm.py compiles' : r.out.trim().slice(0, 120),
        }
      },
    },
    {
      name: 'Map cache',
      run: async () => {
        const dir = path.join(root, 'data', 'maps')
        const probe = path.join(dir, `.preflight-${process.pid}`)
        try {
          writeFileSync(probe, 'x')
          unlinkSync(probe)
        } catch (e) {
          return { level: FAIL, detail: `data/maps is not writable: ${e.code ?? e.message}` }
        }
        let bytes = 0
        let count = 0
        try {
          const { readdirSync } = await import('node:fs')
          for (const name of readdirSync(dir)) {
            if (!name.endsWith('.osm.xml')) continue
            count += 1
            bytes += statSync(path.join(dir, name)).size
          }
        } catch {
          /* An empty or absent cache is fine; it fills on demand. */
        }
        return {
          level: OK,
          detail: count
            ? `${count} cached extract${count === 1 ? '' : 's'} · ${(bytes / 1024 ** 2).toFixed(0)} MiB`
            : 'empty (extracts download on demand)',
        }
      },
    },
    {
      name: 'Simulation core',
      run: async () => {
        if (!existsSync(server))
          return { level: WARN, detail: 'build/dstns_server missing', hint: 'It will be compiled on start.' }
        const r = await run(server, ['--version'], { timeout: 10000 })
        return {
          level: r.code === 0 ? OK : WARN,
          detail: r.code === 0 ? r.out.split('\n')[0].trim() : 'binary present but did not report a version',
        }
      },
    },
    {
      name: 'Observer bundle',
      run: async () => {
        if (!existsSync(dist))
          return { level: WARN, detail: 'ui-engine/dist missing', hint: 'It will be built on start.' }
        // A bundle older than its sources is the classic "why is my change not
        // showing" failure; say so rather than serving stale assets silently.
        const { readdirSync } = await import('node:fs')
        const built = statSync(dist).mtimeMs
        let newest = 0
        const srcDir = path.join(root, 'ui-engine', 'src')
        const walk = (dir) => {
          for (const name of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, name.name)
            if (name.isDirectory()) walk(full)
            else newest = Math.max(newest, statSync(full).mtimeMs)
          }
        }
        try {
          walk(srcDir)
        } catch {
          /* Sources unavailable; nothing to compare against. */
        }
        const stale = newest > built
        return {
          level: stale ? WARN : OK,
          detail: stale ? 'bundle is older than src/' : 'bundle is current',
          hint: stale ? 'It will be rebuilt on start.' : '',
        }
      },
    },
    {
      name: 'API port',
      run: async () => {
        const port = Number(process.env.DSTNS_API_PORT || 8090)
        const free = await portFree(port)
        return {
          level: OK,
          detail: free ? `${port} available` : `${port} already in use`,
          hint: free ? '' : 'An existing run will be reused or another port chosen.',
        }
      },
    },
  ]

  if (suites) {
    list.push(
      {
        name: 'Core test suites',
        run: async () => {
          if (!existsSync(path.join(root, 'build', 'CTestTestfile.cmake')))
            return { level: WARN, detail: 'not configured; skipped', hint: 'Run cmake -S . -B build to enable.' }
          const r = await run('ctest', ['--test-dir', 'build', '--output-on-failure'], {
            cwd: root,
            timeout: 300_000,
          })
          // ctest prints "100% tests passed out of 7" when nothing failed, and
          // "N% tests passed, M tests failed out of T" when something did.
          const clean = r.out.match(/(\d+)% tests passed out of (\d+)/)
          const dirty = r.out.match(/(\d+)% tests passed,\s*(\d+) tests failed out of (\d+)/)
          const total = dirty ? dirty[3] : clean ? clean[2] : '?'
          const failed = dirty ? Number(dirty[2]) : r.code === 0 ? 0 : 1
          return {
            level: failed === 0 && r.code === 0 ? OK : FAIL,
            detail:
              failed === 0 && r.code === 0
                ? `${total}/${total} suites passed in ${(r.ms / 1000).toFixed(1)}s`
                : `${failed} suite(s) failed`,
            hint: failed ? 'The core is not behaving as specified; do not rely on this run.' : '',
          }
        },
      },
      {
        name: 'Observer test suites',
        run: async () => {
          const uiDir = path.join(root, 'ui-engine')
          if (!existsSync(path.join(uiDir, 'node_modules')))
            return { level: WARN, detail: 'dependencies not installed; skipped' }
          const r = await run('npx', ['vitest', 'run'], {
            cwd: uiDir,
            timeout: 300_000,
            env: { CI: '1' },
          })
          const match = r.out.match(/Tests\s+(\d+)\s+passed/)
          const failedMatch = r.out.match(/(\d+)\s+failed/)
          const passed = match ? match[1] : '?'
          return {
            level: r.code === 0 ? OK : FAIL,
            detail:
              r.code === 0
                ? `${passed}/${passed} tests passed in ${(r.ms / 1000).toFixed(1)}s`
                : `${failedMatch ? failedMatch[1] : 'some'} test(s) failed`,
            hint: r.code === 0 ? '' : 'The interface is not behaving as specified.',
          }
        },
      },
    )
  }

  return list
}

/**
 * Run every check in order, reporting progress through `onResult`.
 * Returns a summary; `ok` is false only when something genuinely blocks a run.
 */
export async function preflight(root, { onResult, suites = true } = {}) {
  const results = []
  for (const check of checks(root, { suites })) {
    let result
    try {
      result = await check.run()
    } catch (e) {
      result = { level: FAIL, detail: `check threw: ${e.message}` }
    }
    const entry = { name: check.name, ...result }
    results.push(entry)
    onResult?.(entry)
  }
  return {
    ok: !results.some((r) => r.level === FAIL),
    failures: results.filter((r) => r.level === FAIL),
    warnings: results.filter((r) => r.level === WARN),
    results,
  }
}
