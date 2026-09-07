#!/usr/bin/env node

/**
 * DSTNS Operator CLI
 *
 * Presentation layer powered by @poppinss/cliui.
 * The C++ DSTNS server remains the simulation authority.
 */

import { cliui } from '@poppinss/cliui'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const OPERATOR_DIR = path.dirname(__filename)
const ROOT = path.resolve(OPERATOR_DIR, '..')

const CONFIG = path.join(ROOT, 'config', 'defaults.json')
const LOGS = path.join(ROOT, 'logs')
const BUILD = path.join(ROOT, 'build')
const SERVER = path.join(BUILD, 'dstns_server')
const EXPORT_TOOL = path.join(BUILD, 'dstns_scenario_export')
const UI_ENGINE = path.join(ROOT, 'ui-engine')
const UI_DIST = path.join(UI_ENGINE, 'dist')
const VERSION = '1.1.0'

const ui = cliui()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

let managedServer = null
let managedServerPort = null
let shuttingDown = false

class CommandError extends Error {
  constructor(command, code, stdout, stderr) {
    super(`Command failed with exit code ${code}: ${command}`)
    this.name = 'CommandError'
    this.command = command
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

function clearScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H')
  }
}

function trimText(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function tailText(value, lines = 14) {
  return String(value ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

function banner() {
  ui.sticker()
    .add(`${ui.colors.cyan('DSTNS')}  ${ui.colors.dim(`v${VERSION}`)}`)
    .add('Deterministic Simulated Environment')
    .add(ui.colors.dim('Operator Console · C++ simulation authority'))
    .add(ui.colors.dim('Developed by Varun Karthic'))
    .render()
}

async function prompt(label, fallback = '') {
  const suffix = fallback === '' ? '' : ` ${ui.colors.dim(`[${fallback}]`)}`
  const answer = await rl.question(`${ui.colors.cyan(label)}${suffix}: `)
  const value = answer.trim()
  return value || fallback
}

async function pressEnter() {
  if (!process.stdin.isTTY) return
  await rl.question(ui.colors.dim('\nPress Enter to continue…'))
}

async function loadConfig() {
  const cfg = JSON.parse(await readFile(CONFIG, 'utf8'))
  validateConfig(cfg)
  return cfg
}

function validateConfig(cfg) {
  const duration = Number(cfg?.playback?.duration_seconds)
  const tick = Number(cfg?.playback?.tick_rate)
  const port = Number(cfg?.api?.port)

  if (!Number.isInteger(duration) || duration < 60 || duration > 3600) {
    throw new Error('playback.duration_seconds must be an integer in [60, 3600]')
  }
  if (!Number.isFinite(tick) || tick <= 0 || tick > 100) {
    throw new Error('playback.tick_rate must be in (0, 100]')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('api.port must be an integer in [1, 65535]')
  }
  if (!cfg?.api?.host) {
    throw new Error('api.host must be configured')
  }
}

function runCommand(command, args = [], options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    onOutput = null,
    inherit = false,
    maxBuffer = 500_000,
  } = options

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })

    if (inherit) {
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve({ code, stdout: '', stderr: '' })
        else reject(new CommandError([command, ...args].join(' '), code ?? -1, '', ''))
      })
      return
    }

    let stdout = ''
    let stderr = ''

    const append = (stream, chunk) => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout = (stdout + text).slice(-maxBuffer)
      else stderr = (stderr + text).slice(-maxBuffer)

      if (onOutput) {
        const lastLine = text.split(/\r?\n/).filter(Boolean).at(-1)
        if (lastLine) onOutput(trimText(lastLine, 80), stream)
      }
    }

    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr })
      else reject(new CommandError([command, ...args].join(' '), code ?? -1, stdout, stderr))
    })
  })
}

function canConnect(port, host = '127.0.0.1', timeout = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function findAvailablePort(startPort, host = '127.0.0.1') {
  for (let port = startPort; port < 65535; port += 1) {
    if (!(await canConnect(port, host))) return port
  }
  throw new Error('No available network ports found')
}

async function apiCall(port, endpoint, method = 'GET', payload = undefined, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })

    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { message: text }
    }

    return { code: response.status, body }
  } catch (error) {
    return { code: 500, body: { error: error?.message ?? String(error) } }
  } finally {
    clearTimeout(timer)
  }
}

async function checkDstnsHealth(port) {
  const { code, body } = await apiCall(port, '/health', 'GET', undefined, 1000)
  if (code !== 200) return null
  if (body?.product === 'DSTNS' || body?.service === 'dstns') return body
  return null
}

async function waitHealth(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy (exit ${child.exitCode})`)
    }

    const health = await checkDstnsHealth(port)
    if (health) return health
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`Server did not become healthy on port ${port} within ${timeoutMs / 1000}s`)
}

async function build({ forceUi = false } = {}) {
  await mkdir(BUILD, { recursive: true })

  const tasks = ui.tasks()
  tasks
    .add('Configure C++ engine', async ({ update }) => {
      const started = Date.now()
      await runCommand('cmake', [
        '-S', ROOT,
        '-B', BUILD,
        '-DCMAKE_BUILD_TYPE=Release',
      ], { onOutput: (line) => update(line) })
      return `Configured in ${formatDuration(Date.now() - started)}`
    })
    .add('Build DSTNS engine', async ({ update }) => {
      const started = Date.now()
      await runCommand('cmake', ['--build', BUILD, '-j4'], {
        onOutput: (line) => update(line),
      })
      return `Built in ${formatDuration(Date.now() - started)}`
    })
    .addIf(!existsSync(path.join(UI_ENGINE, 'node_modules')), 'Install Web UI dependencies', async ({ update }) => {
      const started = Date.now()
      await runCommand('npm', ['install', '--prefix', UI_ENGINE], {
        onOutput: (line) => update(line),
      })
      return `UI dependencies installed in ${formatDuration(Date.now() - started)}`
    })
    .addIf(forceUi || !existsSync(UI_DIST), 'Build Web UI bundle', async ({ update }) => {
      const started = Date.now()
      await runCommand('npm', ['run', 'build', '--prefix', UI_ENGINE], {
        onOutput: (line) => update(line),
      })
      return `UI bundle ready in ${formatDuration(Date.now() - started)}`
    })

  await tasks.run()
  if (tasks.getState() === 'failed') {
    throw tasks.error ?? new Error('Build failed')
  }
}

async function ensureBuild() {
  const missingServer = !existsSync(SERVER)
  const missingUi = !existsSync(UI_DIST)
  if (missingServer || missingUi) {
    ui.logger.info('Build artifacts are incomplete', {
      suffix: [missingServer ? 'server' : null, missingUi ? 'ui' : null].filter(Boolean).join(', '),
    })
    await build({ forceUi: missingUi })
  }
}

function collectChildTail(child) {
  let stdout = ''
  let stderr = ''
  const cap = 100_000

  child.stdout?.on('data', (chunk) => {
    stdout = (stdout + chunk.toString()).slice(-cap)
  })
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-cap)
  })

  return () => ({ stdout, stderr })
}

async function startServer({ replace = false, open: shouldOpen = false } = {}) {
  const cfg = await loadConfig()
  await ensureBuild()
  await mkdir(LOGS, { recursive: true })

  let port = Number(cfg.api.port)
  const host = String(cfg.api.host)

  if (await canConnect(port)) {
    const existing = await checkDstnsHealth(port)
    if (existing) {
      ui.logger.info('Attached to an existing DSTNS server', {
        suffix: `port ${port} · ${existing.lifecycle ?? 'UNKNOWN'}`,
      })
      renderServerCard(port, existing)
      if (shouldOpen) {
        await openBrowser(`http://127.0.0.1:${port}/`)
      }
      return { process: null, port, health: existing, external: true }
    }

    const freePort = await findAvailablePort(port + 1)
    ui.logger.warning(`Configured port ${port} is occupied by another service`, {
      suffix: `using ${freePort}`,
    })
    port = freePort
  }

  const args = ['--host', host, '--port', String(port), '--logs', LOGS]

  if (replace) {
    ui.logger.info('Starting DSTNS server in foreground mode', { suffix: `port ${port}` })
    const result = await runCommand(SERVER, args, { inherit: true })
    return { process: null, port, health: null, external: false, result }
  }

  const loader = ui.logger.await('Starting DSTNS server', { suffix: `127.0.0.1:${port}` })
  loader.start()

  const child = spawn(SERVER, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const getTail = collectChildTail(child)

  try {
    const health = await waitHealth(port, child)
    loader.stop()
    ui.logger.success('DSTNS server is healthy', {
      suffix: `port ${port} · ${health.lifecycle ?? 'READY'}`,
    })
    renderServerCard(port, health)
    if (shouldOpen) {
      await openBrowser(`http://127.0.0.1:${port}/`)
    }
    return { process: child, port, health, external: false, getTail }
  } catch (error) {
    loader.stop()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
    }
    const output = getTail()
    const detail = tailText(output.stderr || output.stdout)
    if (detail) {
      ui.logger.error(new Error(detail))
    }
    throw error
  }
}

function renderServerCard(port, health = {}) {
  const lifecycle = health?.lifecycle ?? 'READY'
  ui.sticker()
    .add(`${ui.colors.green('DSTNS Server')}  ${ui.colors.dim(lifecycle)}`)
    .add('')
    .add(`Web UI       ${ui.colors.cyan(`http://127.0.0.1:${port}/`)}`)
    .add(`Playback API ${ui.colors.cyan(`http://127.0.0.1:${port}/api/v1/playback/status`)}`)
    .add(`System Info  ${ui.colors.cyan(`http://127.0.0.1:${port}/api/v1/system/info`)}`)
    .add(`Health       ${ui.colors.cyan(`http://127.0.0.1:${port}/health`)}`)
    .render()
}

function renderSessionMenu(port) {
  const table = ui.table()
  table
    .fullWidth()
    .head(['Key', 'Action', 'Description'])
    .row(['s', 'Start simulation', 'Auto-seed, SUMO physics, configured duration/tick rate'])
    .row(['p', 'Pause', 'Pause simulation playback'])
    .row(['r', 'Resume', 'Resume simulation playback'])
    .row(['i', 'Status', 'Show current system state'])
    .row(['o', 'Open UI', `Open http://127.0.0.1:${port}/`])
    .row(['x', 'Terminate', 'Terminate the DSTNS server'])
    .row(['q', 'Back', 'Return to the operator dashboard'])
    .render()
}

function flattenObject(value, prefix = '', depth = 0, rows = []) {
  if (rows.length >= 40) return rows

  if (value === null || value === undefined || typeof value !== 'object') {
    rows.push([prefix || 'value', String(value ?? 'null')])
    return rows
  }

  if (Array.isArray(value)) {
    rows.push([prefix || 'value', trimText(JSON.stringify(value), 120)])
    return rows
  }

  for (const [key, child] of Object.entries(value)) {
    const label = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child) && depth < 2) {
      flattenObject(child, label, depth + 1, rows)
    } else {
      rows.push([label, trimText(typeof child === 'string' ? child : JSON.stringify(child), 120)])
    }
    if (rows.length >= 40) break
  }

  return rows
}

function renderJsonTable(title, body) {
  ui.logger.info(title)
  const rows = flattenObject(body)
  const table = ui.table()
  table.fullWidth().head(['Field', 'Value'])
  for (const [key, value] of rows) table.row([key, value])
  table.render()
}

async function openBrowser(url) {
  let command
  let args

  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
    ui.logger.success('Opened DSTNS Web UI', { suffix: url })
  } catch (error) {
    ui.logger.warning('Could not open a browser automatically', { suffix: error.message })
  }
}

async function controlSession(serverProcess, port) {
  const cfg = await loadConfig()
  let firstRender = true

  while (true) {
    if (firstRender) {
      renderSessionMenu(port)
      firstRender = false
    }

    if (serverProcess && serverProcess.exitCode !== null) {
      ui.logger.error(new Error(`Managed server exited with code ${serverProcess.exitCode}`))
      return
    }

    const raw = (await prompt(`dstns:${port}`)).toLowerCase()
    const command = ({
      '1': 's', start: 's', init: 's',
      '2': 'p', pause: 'p',
      '3': 'r', play: 'r', resume: 'r',
      '4': 'i', status: 'i', info: 'i',
      '5': 'x', terminate: 'x', kill: 'x',
      open: 'o', ui: 'o',
      exit: 'q', quit: 'q', return: 'q',
    })[raw] ?? raw

    if (command === 'q') return

    if (command === 'o') {
      await openBrowser(`http://127.0.0.1:${port}/`)
      continue
    }

    if (command === 's') {
      const payload = {
        seed: 'auto',
        playback_duration_seconds: Number(cfg.playback.duration_seconds),
        day: 0,
        tick_rate: Number(cfg.playback.tick_rate),
        modules: {
          traffic: true,
          signals: true,
          buildings: true,
          dws: true,
          flooding: true,
          news: true,
        },
        dws: { frequency: 4 },
      }
      const { code, body } = await apiCall(port, '/api/v1/playback/start', 'POST', payload)
      if (code >= 200 && code < 300) {
        ui.logger.success('Simulation started', {
          suffix: body?.lifecycle ?? `HTTP ${code}`,
        })
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      continue
    }

    if (command === 'p') {
      const { code, body } = await apiCall(port, '/api/v1/playback/pause', 'POST', {})
      if (code >= 200 && code < 300) {
        ui.logger.success('Simulation paused', { suffix: body?.lifecycle ?? `HTTP ${code}` })
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      continue
    }

    if (command === 'r') {
      const { code, body } = await apiCall(port, '/api/v1/playback/play', 'POST', {})
      if (code >= 200 && code < 300) {
        ui.logger.success('Simulation resumed', { suffix: body?.lifecycle ?? `HTTP ${code}` })
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      continue
    }

    if (command === 'i') {
      const { code, body } = await apiCall(port, '/api/v1/system/status')
      if (code >= 200 && code < 300) renderJsonTable('DSTNS system status', body)
      else ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      continue
    }

    if (command === 'x') {
      const confirmation = (await prompt('Type TERMINATE to stop the server')).toUpperCase()
      if (confirmation !== 'TERMINATE') {
        ui.logger.info('Termination cancelled')
        continue
      }

      const { code, body } = await apiCall(port, '/terminate', 'POST', {})
      if (code >= 200 && code < 300) {
        ui.logger.success(body?.message ?? 'Server termination requested')
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      return
    }

    ui.logger.warning('Unknown session command', { suffix: raw || '(empty)' })
    renderSessionMenu(port)
  }
}

async function queryRuntimeDb(tableName) {
  const allowed = new Set(['api_log', 'event_log', 'lifecycle_log'])
  if (!allowed.has(tableName)) throw new Error('Unsupported runtime log table')

  const db = path.join(LOGS, 'runtime.db')
  if (!existsSync(db)) return null

  const script = [
    'import json, sqlite3, sys',
    'db, table = sys.argv[1], sys.argv[2]',
    'con = sqlite3.connect(db)',
    'cur = con.execute(f"SELECT * FROM {table} ORDER BY id DESC LIMIT 100")',
    'cols = [d[0] for d in cur.description]',
    'rows = cur.fetchall()',
    'con.close()',
    'print(json.dumps({"columns": cols, "rows": list(reversed(rows))}, default=str))',
  ].join('; ')

  const result = await runCommand('python3', ['-c', script, db, tableName], { cwd: ROOT })
  return JSON.parse(result.stdout)
}

function renderLogTable(columns, rows) {
  if (!rows.length) {
    ui.logger.info('No log records found')
    return
  }

  const preferredNames = ['id', 'timestamp', 'time', 'created_at', 'level', 'method', 'path', 'event', 'lifecycle', 'message', 'status']
  const selected = []

  for (const name of preferredNames) {
    const index = columns.indexOf(name)
    if (index !== -1 && !selected.includes(index)) selected.push(index)
    if (selected.length >= 5) break
  }
  for (let index = 0; index < columns.length && selected.length < 5; index += 1) {
    if (!selected.includes(index)) selected.push(index)
  }

  const table = ui.table()
  table.fullWidth().head(selected.map((index) => columns[index]))
  for (const row of rows) {
    table.row(selected.map((index) => trimText(row[index], 72)))
  }
  table.render()
}

async function viewLogs(topic = '') {
  let choice = topic.toLowerCase()
  if (!choice) {
    const table = ui.table()
    table
      .head(['Key', 'Log'])
      .row(['1', 'system'])
      .row(['2', 'api'])
      .row(['3', 'event'])
      .row(['4', 'playback'])
      .row(['q', 'return'])
      .render()
    choice = (await prompt('Log source')).toLowerCase()
  }

  choice = ({ '1': 'system', '2': 'api', '3': 'event', '4': 'playback' })[choice] ?? choice
  if (['q', 'quit', 'return', ''].includes(choice)) return

  if (choice === 'system') {
    const file = path.join(LOGS, 'system.log')
    if (!existsSync(file)) {
      ui.logger.info('No system log yet')
      return
    }

    const content = await readFile(file, 'utf8')
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-100)
    ui.logger.info(`System log · last ${lines.length} lines`)
    for (const line of lines) {
      ui.logger.info(trimText(line, 160), { prefix: '%time%' })
    }
    return
  }

  const mapping = {
    api: 'api_log',
    event: 'event_log',
    playback: 'lifecycle_log',
  }
  const tableName = mapping[choice]
  if (!tableName) {
    ui.logger.warning('Unknown log source', { suffix: choice })
    return
  }

  const data = await queryRuntimeDb(tableName)
  if (!data) {
    ui.logger.info('No runtime database yet')
    return
  }
  renderLogTable(data.columns, data.rows)
}

async function editConfig() {
  const cfg = await loadConfig()

  const table = ui.table()
  table
    .fullWidth()
    .head(['Setting', 'Current', 'Allowed'])
    .row(['playback.duration_seconds', String(cfg.playback.duration_seconds), '60–3600 seconds'])
    .row(['playback.tick_rate', String(cfg.playback.tick_rate), '> 0 and ≤ 100'])
    .row(['api.host', String(cfg.api.host), 'bind address'])
    .row(['api.port', String(cfg.api.port), '1–65535'])
    .render()

  const duration = await prompt('Playback duration', String(cfg.playback.duration_seconds))
  const tick = await prompt('Tick rate', String(cfg.playback.tick_rate))
  const host = await prompt('API host', String(cfg.api.host))
  const port = await prompt('API port', String(cfg.api.port))

  cfg.playback.duration_seconds = Number(duration)
  cfg.playback.tick_rate = Number(tick)
  cfg.api.host = host
  cfg.api.port = Number(port)
  validateConfig(cfg)

  await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  ui.logger.success('Configuration saved', { suffix: CONFIG })
}

const TESTS = {
  unit: [
    {
      title: 'Native C++ unit tests',
      command: 'ctest',
      args: ['--test-dir', BUILD, '--output-on-failure'],
    },
  ],
  ui: [
    {
      title: 'Web UI test suite',
      command: 'npm',
      args: ['test', '--prefix', UI_ENGINE],
    },
  ],
  all: [
    {
      title: 'Configure test build',
      command: 'cmake',
      args: ['-S', ROOT, '-B', BUILD, '-DDSTNS_BUILD_TESTS=ON'],
    },
    {
      title: 'Build test targets',
      command: 'cmake',
      args: ['--build', BUILD, '-j4'],
    },
    {
      title: 'Native C++ test suite',
      command: 'ctest',
      args: ['--test-dir', BUILD, '--output-on-failure'],
    },
    {
      title: 'Web UI test suite',
      command: 'npm',
      args: ['test', '--prefix', UI_ENGINE],
    },
    {
      title: 'Production Web UI build',
      command: 'npm',
      args: ['run', 'build', '--prefix', UI_ENGINE],
    },
    {
      title: 'REST API smoke tests',
      command: 'python3',
      args: [path.join(ROOT, 'tests', 'api', 'api_smoke.py'), '--server', SERVER],
    },
    {
      title: 'SUMO integration smoke tests',
      command: 'bash',
      args: [path.join(ROOT, 'tests', 'integration', 'sumo_smoke.sh')],
    },
    {
      title: 'Replay determinism verification',
      command: path.join(BUILD, 'dstns_replay_verify'),
      args: [],
    },
    {
      title: 'DSTNS benchmark',
      command: path.join(BUILD, 'dstns_benchmark'),
      args: [],
    },
  ],
}

async function runTests(scope = 'all', { verbose = false } = {}) {
  const selected = TESTS[scope] ?? TESTS.all
  const started = Date.now()
  const results = []
  const tasks = ui.tasks({ verbose })

  for (const test of selected) {
    tasks.add(test.title, async ({ update, error }) => {
      const stepStart = Date.now()
      try {
        const result = await runCommand(test.command, test.args, {
          cwd: ROOT,
          onOutput: (line) => update(line),
        })
        const duration = Date.now() - stepStart
        results.push({ name: test.title, status: 'PASS', duration, detail: '' })
        return `Passed · ${formatDuration(duration)}`
      } catch (failure) {
        const duration = Date.now() - stepStart
        const detail = tailText(failure.stderr || failure.stdout || failure.message, 10)
        results.push({ name: test.title, status: 'FAIL', duration, detail })
        return error(trimText(detail || failure.message, 140))
      }
    })
  }

  await tasks.run()

  ui.logger.info('Test summary')
  const summary = ui.table()
  summary.fullWidth().head(['Test', 'Result', 'Duration'])
  for (const result of results) {
    summary.row([
      result.name,
      result.status === 'PASS' ? ui.colors.green(result.status) : ui.colors.red(result.status),
      formatDuration(result.duration),
    ])
  }
  summary.render()

  const failed = results.find((result) => result.status === 'FAIL')
  if (failed?.detail) {
    ui.logger.error(new Error(failed.detail))
  }

  const total = formatDuration(Date.now() - started)
  if (failed || tasks.getState() === 'failed') {
    ui.logger.error(new Error(`Test run failed after ${total}`))
    process.exitCode = 1
    return false
  }

  ui.logger.success(`All ${results.length} test stages passed`, { suffix: total })
  return true
}

async function detectSumo() {
  const candidates = []
  const sumoHome = process.env.SUMO_HOME
  if (sumoHome) candidates.push(path.join(sumoHome, 'bin'))

  candidates.push(
    path.join(os.homedir(), 'sumo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  )

  for (const directory of candidates) {
    const sumo = path.join(directory, 'sumo')
    const netconvert = path.join(directory, 'netconvert')
    if (existsSync(sumo) && existsSync(netconvert)) return { sumo, netconvert }
  }

  const which = async (binary) => {
    try {
      const result = await runCommand('which', [binary], { cwd: ROOT })
      return result.stdout.trim()
    } catch {
      return ''
    }
  }

  const sumo = await which('sumo')
  const netconvert = await which('netconvert')
  if (sumo && netconvert) return { sumo, netconvert }
  return null
}

async function runStandaloneSumo() {
  ui.logger.info('Standalone SUMO microscopic simulation')

  const bins = await detectSumo()
  if (!bins) {
    throw new Error('SUMO binaries (sumo, netconvert) were not found on PATH or under $SUMO_HOME')
  }

  if (!existsSync(EXPORT_TOOL)) await build()

  const exportDir = path.join(ROOT, 'data', 'sumo_live_run')
  await mkdir(exportDir, { recursive: true })

  const tripinfo = path.join(exportDir, 'tripinfo.xml')
  await rm(tripinfo, { force: true })

  const tasks = ui.tasks()
  tasks
    .add('Export deterministic DSTNS scenario', async ({ update }) => {
      const started = Date.now()
      await runCommand(EXPORT_TOOL, ['--export-sumo', exportDir, '--grid', '12x12'], {
        onOutput: (line) => update(line),
      })
      return `Scenario exported · ${formatDuration(Date.now() - started)}`
    })
    .add('Compile SUMO network', async ({ update }) => {
      const started = Date.now()
      await runCommand(bins.netconvert, [
        `--node-files=${path.join(exportDir, 'network.nod.xml')}`,
        `--edge-files=${path.join(exportDir, 'network.edg.xml')}`,
        `--output-file=${path.join(exportDir, 'network.net.xml')}`,
        '--no-warnings=true',
      ], {
        cwd: exportDir,
        onOutput: (line) => update(line),
      })
      return `Network compiled · ${formatDuration(Date.now() - started)}`
    })
    .add('Execute microscopic traffic simulation', async ({ update }) => {
      const started = Date.now()
      await runCommand(bins.sumo, [
        '-c', path.join(exportDir, 'sandbox.sumocfg'),
        '--begin', '0',
        '--end', '3600',
        '--seed', '42',
        `--tripinfo-output=${tripinfo}`,
        '--no-step-log=true',
        '--duration-log.disable=true',
      ], {
        cwd: exportDir,
        onOutput: (line) => update(line),
      })
      return `Simulation complete · ${formatDuration(Date.now() - started)}`
    })

  await tasks.run()
  if (tasks.getState() === 'failed') throw tasks.error ?? new Error('SUMO simulation failed')

  if (existsSync(tripinfo)) {
    const info = await stat(tripinfo)
    const content = await readFile(tripinfo, 'utf8')
    const trips = content.split(/\r?\n/).filter((line) => line.includes('<tripinfo'))

    const table = ui.table()
    table
      .head(['Output', 'Value'])
      .row(['Tripinfo file', tripinfo])
      .row(['File size', formatBytes(info.size)])
      .row(['Microscopic trips', String(trips.length)])
      .render()

    if (trips.length) {
      ui.logger.info('Sample trip telemetry')
      for (const sample of trips.slice(0, 3)) ui.logger.info(trimText(sample.trim(), 160))
    }
  }
}

async function resetRuntime({ confirmed = false } = {}) {
  if (!confirmed && process.stdin.isTTY) {
    const answer = (await prompt('Type RESET to clear runtime state')).toUpperCase()
    if (answer !== 'RESET') {
      ui.logger.info('Reset cancelled')
      return false
    }
  }

  const tasks = ui.tasks()
  tasks
    .add('Clear runtime logs', async () => {
      for (const filename of ['system.log', 'runtime.db', 'runtime.db-wal', 'runtime.db-shm']) {
        await rm(path.join(LOGS, filename), { force: true })
      }
      return 'Logs cleared'
    })
    .add('Reset checkpoints', async () => {
      const dir = path.join(ROOT, 'data', 'checkpoints')
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      return 'Checkpoints reset'
    })
    .add('Reset temporary scenarios', async () => {
      const dir = path.join(ROOT, 'data', 'scenarios')
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      return 'Scenarios reset'
    })
    .add('Reset SUMO live runs', async () => {
      const dir = path.join(ROOT, 'data', 'sumo_live_run')
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      return 'SUMO runs reset'
    })

  await tasks.run()
  if (tasks.getState() === 'failed') throw tasks.error ?? new Error('Reset failed')

  ui.logger.success('Runtime state reset', { suffix: 'OSM cache and configuration preserved' })
  return true
}

function renderHelp() {
  ui.instructions()
    .add(`${ui.colors.cyan('dstns start [--open]')} Launch or attach to the C++ API server (with optional browser open)`)
    .add(`${ui.colors.cyan('dstns ui [action]')}     Manage Web UI: open, dev (Vite hot-reload), build, or install`)
    .add(`${ui.colors.cyan('dstns logs')}            Inspect system/API/event/playback logs`)
    .add(`${ui.colors.cyan('dstns config')}          Validate and edit persisted defaults`)
    .add(`${ui.colors.cyan('dstns test [scope]')}    Run tests: all, unit, or ui`)
    .add(`${ui.colors.cyan('dstns sumo')}            Run a standalone SUMO microscopic simulation`)
    .add(`${ui.colors.cyan('dstns reset')}           Clear ephemeral runtime data`)
    .add(`${ui.colors.cyan('dstns help')}            Display this help`)
    .add(`${ui.colors.cyan('dstns --mode=server')}   Run the C++ server in foreground mode`)
    .render()
}

async function dashboardState() {
  let cfg
  try {
    cfg = await loadConfig()
  } catch (error) {
    return {
      config: ui.colors.red('INVALID'),
      server: ui.colors.red('UNKNOWN'),
      build: existsSync(SERVER) ? 'engine ready' : 'engine missing',
      web: existsSync(UI_DIST) ? 'bundle ready' : 'bundle missing',
      port: '—',
      error: error.message,
    }
  }

  const port = Number(cfg.api.port)
  let server = ui.colors.dim('stopped')
  if (await canConnect(port)) {
    const health = await checkDstnsHealth(port)
    server = health
      ? ui.colors.green(health.lifecycle ?? 'running')
      : ui.colors.yellow('port occupied')
  }

  return {
    config: ui.colors.green('valid'),
    server,
    build: existsSync(SERVER) ? ui.colors.green('ready') : ui.colors.yellow('missing'),
    web: existsSync(UI_DIST) ? ui.colors.green('ready') : ui.colors.yellow('missing'),
    port: String(port),
    error: null,
  }
}

async function renderDashboard() {
  clearScreen()
  banner()
  const state = await dashboardState()

  const status = ui.table()
  status
    .fullWidth()
    .head(['Component', 'State', 'Detail'])
    .row(['C++ engine', state.build, SERVER])
    .row(['Web UI', state.web, UI_DIST])
    .row(['Configuration', state.config, CONFIG])
    .row(['API server', state.server, `configured port ${state.port}`])
    .render()

  if (state.error) ui.logger.error(new Error(state.error))

  const menu = ui.table()
  menu
    .fullWidth()
    .head(['Key', 'Command', 'Description'])
    .row(['1', 'start', 'Launch/attach server and enter simulation controls'])
    .row(['2', 'logs', 'Inspect system, API, event, or playback logs'])
    .row(['3', 'config', 'Edit validated defaults'])
    .row(['4', 'test', 'Run native, API, replay, SUMO, benchmark, and UI tests'])
    .row(['5', 'sumo', 'Run standalone microscopic SUMO execution'])
    .row(['6', 'reset', 'Clear ephemeral runtime state'])
    .row(['7', 'ui', 'Open or manage Web UI (open, dev, build, install)'])
    .row(['8', 'help', 'Show CLI command reference'])
    .row(['9', 'exit', 'Exit operator console'])
    .render()
}

async function menu() {
  const aliases = {
    '1': 'start',
    '2': 'logs',
    '3': 'config',
    '4': 'test',
    '5': 'sumo',
    '6': 'reset',
    '7': 'ui',
    '8': 'help',
    '9': 'exit',
    q: 'exit',
    quit: 'exit',
  }

  while (true) {
    await renderDashboard()
    const raw = (await prompt('dstns')).toLowerCase()
    const action = aliases[raw] ?? raw

    try {
      if (action === 'start') {
        if (managedServer && managedServer.exitCode === null && managedServerPort) {
          ui.logger.info('Using managed DSTNS server', { suffix: `port ${managedServerPort}` })
          await controlSession(managedServer, managedServerPort)
        } else {
          const started = await startServer({ open: true })
          if (started.process) {
            managedServer = started.process
            managedServerPort = started.port
          } else {
            managedServer = null
            managedServerPort = started.port
          }
          await controlSession(started.process, started.port)
        }
      } else if (action === 'logs') {
        await viewLogs()
      } else if (action === 'config') {
        await editConfig()
      } else if (action === 'test') {
        const scope = (await prompt('Scope (all/unit/ui)', 'all')).toLowerCase()
        const verbose = (await prompt('Verbose task output? (y/N)', 'n')).toLowerCase().startsWith('y')
        await runTests(scope, { verbose })
      } else if (action === 'sumo') {
        await runStandaloneSumo()
      } else if (action === 'reset') {
        await resetRuntime()
      } else if (action === 'ui') {
        const choice = (await prompt('UI action: open/dev/build/install', 'open')).toLowerCase()
        if (choice === 'dev') {
          ui.logger.info('Starting Web UI development server (Vite hot-reload)...')
          await runCommand('npm', ['run', 'dev', '--prefix', UI_ENGINE], { inherit: true })
        } else if (choice === 'build') {
          await build({ forceUi: true })
          ui.logger.success('Web UI bundle rebuilt')
        } else if (choice === 'install') {
          await runCommand('npm', ['install', '--prefix', UI_ENGINE], { inherit: true })
          ui.logger.success('Web UI dependencies installed')
        } else {
          const cfg = await loadConfig()
          await openBrowser(`http://127.0.0.1:${Number(cfg.api.port)}/`)
        }
      } else if (action === 'help') {
        renderHelp()
      } else if (action === 'exit') {
        return 0
      } else {
        ui.logger.warning('Unknown command', { suffix: raw || '(empty)' })
      }
    } catch (error) {
      if (error instanceof CommandError) {
        const detail = tailText(error.stderr || error.stdout || error.message)
        ui.logger.error(new Error(detail || error.message))
      } else {
        ui.logger.error(error instanceof Error ? error : new Error(String(error)))
      }
    }

    await pressEnter()
  }
}

function parseArgs(argv) {
  const positional = []
  const options = {
    mode: process.stdin.isTTY ? 'interactive' : null,
    yes: false,
    verbose: false,
    open: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--verbose' || arg === '-v') options.verbose = true
    else if (arg === '--open' || arg === '-o') options.open = true
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg === '--mode' && i + 1 < argv.length) options.mode = argv[++i]
    else positional.push(arg)
  }

  return {
    command: positional[0] ?? null,
    topic: positional[1] ?? null,
    options,
  }
}

async function cleanup() {
  if (shuttingDown) return
  shuttingDown = true

  if (managedServer && managedServer.exitCode === null) {
    managedServer.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (managedServer.exitCode === null) managedServer.kill('SIGKILL')
        resolve()
      }, 1500)
      managedServer.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  rl.close()
}

async function main() {
  const { command, topic, options } = parseArgs(process.argv.slice(2))

  if (command || options.mode === 'server') banner()

  if (options.mode === 'server') {
    await startServer({ replace: true })
    return 0
  }

  if (command === 'start') {
    const started = await startServer({ open: options.open })
    if (started.process) {
      managedServer = started.process
      managedServerPort = started.port
    }
    if (process.stdin.isTTY) await controlSession(started.process, started.port)
    return 0
  }

  if (command === 'ui') {
    const sub = (topic ?? 'open').toLowerCase()
    if (sub === 'build') {
      await build({ forceUi: true })
      ui.logger.success('Web UI bundle rebuilt')
      return 0
    }
    if (sub === 'dev') {
      ui.logger.info('Starting Web UI development server (Vite hot-reload)...')
      await runCommand('npm', ['run', 'dev', '--prefix', UI_ENGINE], { inherit: true })
      return 0
    }
    if (sub === 'install') {
      ui.logger.info('Installing Web UI dependencies...')
      await runCommand('npm', ['install', '--prefix', UI_ENGINE], { inherit: true })
      ui.logger.success('Web UI dependencies installed')
      return 0
    }
    if (sub === 'open') {
      const cfg = await loadConfig()
      await openBrowser(`http://127.0.0.1:${Number(cfg.api.port)}/`)
      return 0
    }
    throw new Error(`Unknown UI action: ${sub}. Available actions: open, dev, build, install`)
  }

  if (command === 'logs') {
    await viewLogs(topic ?? '')
    return 0
  }

  if (command === 'config') {
    await editConfig()
    return 0
  }

  if (command === 'test') {
    const ok = await runTests(topic ?? 'all', { verbose: options.verbose })
    return ok ? 0 : 1
  }

  if (command === 'sumo') {
    await runStandaloneSumo()
    return 0
  }

  if (command === 'reset') {
    await resetRuntime({ confirmed: options.yes })
    return 0
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    renderHelp()
    return 0
  }

  if (command) {
    throw new Error(`Unknown command: ${command}`)
  }

  if (!process.stdin.isTTY) {
    renderHelp()
    return 0
  }

  return menu()
}

process.on('SIGINT', async () => {
  process.stdout.write('\n')
  await cleanup()
  process.exit(130)
})

process.on('SIGTERM', async () => {
  await cleanup()
  process.exit(143)
})

try {
  const code = await main()
  await cleanup()
  process.exitCode = Number(code ?? process.exitCode ?? 0)
} catch (error) {
  ui.logger.error(error instanceof Error ? error : new Error(String(error)))
  await cleanup()
  process.exitCode = 1
}
