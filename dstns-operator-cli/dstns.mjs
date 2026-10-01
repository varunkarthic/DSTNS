#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic


/**
 * DSTNS Operator CLI
 *
 * Modern terminal operator interface powered by @poppinss/cliui.
 * Developed by Varun Karthic · Lead Architect & Developer.
 *
 * Ubuntu Server (Subiquity) style navigation:
 * - Up / Down arrow keys (or k / j) to navigate options
 * - Space to select / mark radio item ([●])
 * - Enter to execute highlighted or selected option
 * - Esc to return or exit
 *
 * The C++ DSTNS server remains the simulation authority.
 */

import { cliui } from '@poppinss/cliui'
import { needsBuild } from './artifacts.mjs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import nodeReadline from 'node:readline'
import readlinePromises from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const OPERATOR_DIR = path.dirname(__filename)
const ROOT = path.resolve(OPERATOR_DIR, '..')

const CONFIG = path.join(ROOT, 'config', 'defaults.json')
const LOGS = process.env.DSTNS_LOGS_DIR ? path.resolve(process.env.DSTNS_LOGS_DIR) : path.join(ROOT, 'logs')
const ACTIVE_SERVER = path.join(LOGS, 'launcher.json')
const BUILD = path.join(ROOT, 'build')
const SERVER = path.join(BUILD, 'dstns_server')
const EXPORT_TOOL = path.join(BUILD, 'dstns_scenario_export')
const UI_ENGINE = path.join(ROOT, 'ui-engine')
const UI_DIST = path.join(UI_ENGINE, 'dist')
const VERSION = '2.0.0'

const ui = cliui()

let managedServer = null
let managedServerPort = null
let shuttingDown = false
let previousRenderedLines = 0

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
    previousRenderedLines = 0
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

function getOsInfo() {
  const p = os.platform()
  const name = p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p === 'win32' ? 'Windows' : p
  const release = os.release()
  const arch = os.arch()
  const cores = os.cpus().length
  const memGb = (os.totalmem() / (1024 ** 3)).toFixed(1)
  const isCompatible = (p === 'darwin' || p === 'linux') && (arch === 'arm64' || arch === 'x64')
  return { name, release, arch, cores, memGb, isCompatible }
}

const WORDMARK = [
  '  ██████  ███████ ████████ ███    ██ ███████',
  '  ██   ██ ██         ██    ████   ██ ██     ',
  '  ██   ██ ███████    ██    ██ ██  ██ ███████',
  '  ██   ██      ██    ██    ██  ██ ██      ██',
  '  ██████  ███████    ██    ██   ████ ███████',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Licence notice shown at every start, as AGPL section 5 expects of an
 *  interactive program. Kept to four lines so it informs without nagging. */
function licenceNotice() {
  return [
    `${ui.colors.dim('Copyright (C) 2026')} ${ui.colors.bold('Varun Karthic')}`,
    ui.colors.dim('Licence AGPL-3.0-or-later — this is free software, and you are'),
    ui.colors.dim('welcome to redistribute it under certain conditions; see LICENSE.'),
    ui.colors.dim('Comes with ABSOLUTELY NO WARRANTY. Map data © OpenStreetMap (ODbL).'),
  ]
}

async function runSplashScreen(options = {}) {
  clearScreen()

  // Wordmark reveals a line at a time: a short, deliberate boot rather than a
  // wall of text appearing at once.
  process.stdout.write('\n')
  for (const line of WORDMARK) {
    process.stdout.write(`${ui.colors.cyan(line)}\n`)
    if (process.stdout.isTTY) await sleep(45)
  }
  process.stdout.write(
    `${ui.colors.dim('  Deterministic Spatiotemporal Transport Network Simulator')}  ${ui.colors.bold(ui.colors.cyan(`v${VERSION}`))}\n\n`,
  )
  for (const line of licenceNotice()) process.stdout.write(`  ${line}\n`)
  process.stdout.write('\n')

  process.stdout.write(`  ${ui.colors.bold(ui.colors.cyan('SYSTEM VERIFICATION'))}\n`)
  process.stdout.write(ui.colors.dim('  ──────────────────────────────────────────────────────────────────────────\n'))

  const { preflight, OK, WARN } = await import('./preflight.mjs')
  const summary = await preflight(ROOT, {
    suites: !options?.skipTests,
    onResult: (r) => {
      const icon =
        r.level === OK ? ui.colors.green('✔') : r.level === WARN ? ui.colors.yellow('⚠') : ui.colors.red('✖')
      const name = ui.colors.bold(r.name.padEnd(24))
      const detail = r.level === OK ? ui.colors.dim(r.detail) : ui.colors.yellow(r.detail)
      process.stdout.write(`  ${icon}  ${name} ${detail}\n`)
      if (r.hint) process.stdout.write(`     ${ui.colors.dim(r.hint)}\n`)
    },
  })

  process.stdout.write(ui.colors.dim('  ──────────────────────────────────────────────────────────────────────────\n'))
  if (!summary.ok) {
    // A failed check means the system cannot be trusted to run. Say exactly
    // what failed and stop, rather than starting and failing later in a way
    // that looks like a simulation bug.
    process.stdout.write(`  ${ui.colors.red('●')}  ${ui.colors.bold('Verification failed.')} DSTNS will not start.\n\n`)
    for (const f of summary.failures)
      process.stdout.write(`     ${ui.colors.red('✖')} ${f.name}: ${f.detail}\n`)
    process.stdout.write('\n')
    throw new Error('Startup verification failed')
  }
  const warned = summary.warnings.length
  process.stdout.write(
    `  ${ui.colors.green('●')}  ${ui.colors.bold('System verified.')} ` +
      ui.colors.dim(
        `${summary.results.length} checks passed${warned ? `, ${warned} with warnings` : ''}. Launching operator console…`,
      ) +
      '\n\n',
  )
  await sleep(450)
  clearScreen()
}

function banner() {
  ui.sticker()
    .add(`${ui.colors.bold(ui.colors.cyan('DSTNS OPERATOR CONSOLE'))}  ${ui.colors.dim(`v${VERSION}`)}`)
    .add(`Developed by ${ui.colors.bold(ui.colors.green('Varun Karthic'))} · C++ Simulation Authority`)
    .add(ui.colors.dim('Microscopic traffic physics · Automated deterministic weather · Live Web UI'))
    .render()
}

/**
 * Flicker-Free Interactive Menu Selector (Ubuntu Server / Subiquity Style).
 *
 * Navigation:
 * - Up / Down arrow keys (or k / j): move cursor (❯)
 * - Space: mark radio selection ([●])
 * - Enter: execute selected / highlighted option
 * - Esc: return to previous menu or exit
 * - Ctrl+C: cleanly terminate
 */
async function selectMenu({
  title = '',
  items = [],
  initialIndex = 0,
  allowCancel = true,
  cancelId = 'back',
  beforeRender = null,
}) {
  if (!process.stdin.isTTY || items.length === 0) {
    return items[initialIndex] ?? items[0] ?? null
  }

  clearScreen()

  let cursorIndex = Math.max(0, Math.min(initialIndex, items.length - 1))
  let selectedIndex = cursorIndex

  const render = async () => {
    const lines = []

    // A fixed-width frame, like a system installer: the panel does not reflow
    // as the highlight moves, so only the selected row ever changes.
    const width = Math.min(Math.max(process.stdout.columns || 92, 76), 100)
    const inner = width - 4
    const fit = (s, n) => {
      // Measure without ANSI, so colouring never changes the column count.
      const plain = s.replace(/\x1b\[[0-9;]*m/g, '')
      if (plain.length <= n) return s + ' '.repeat(n - plain.length)
      return s.slice(0, Math.max(0, s.length - (plain.length - n) - 1)) + '…'
    }
    const top = ui.colors.dim(`  ┌${'─'.repeat(width - 2)}┐`)
    const sep = ui.colors.dim(`  ├${'─'.repeat(width - 2)}┤`)
    const bottom = ui.colors.dim(`  └${'─'.repeat(width - 2)}┘`)
    const bar = (content) => `  ${ui.colors.dim('│')} ${fit(content, inner)} ${ui.colors.dim('│')}`

    if (beforeRender) {
      const header = await beforeRender({ cursorIndex, selectedIndex })
      if (header) lines.push(header)
    }

    lines.push(top)
    lines.push(bar(ui.colors.bold(ui.colors.cyan(title || 'DSTNS OPERATOR'))))
    lines.push(sep)

    const labelWidth = Math.min(
      34,
      items.reduce((max, it) => Math.max(max, it.label.length), 0) + 2,
    )

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const isFocused = i === cursorIndex
      const isSelected = i === selectedIndex

      const mark = isSelected ? ui.colors.green('(•)') : ui.colors.dim('( )')
      const label = fit(item.label, labelWidth)
      const desc = item.description ?? ''
      const body = `${mark} ${label} ${ui.colors.dim(desc)}`

      if (isFocused) {
        // The whole row inverts, so the cursor is unmissable at a glance.
        const plain = `${isSelected ? '(•)' : '( )'} ${label} ${desc}`
        lines.push(
          `  ${ui.colors.dim('│')} ${ui.colors.inverse(fit(plain, inner))} ${ui.colors.dim('│')}`,
        )
      } else {
        lines.push(bar(body))
      }
    }

    lines.push(sep)
    const exitLabel = cancelId === 'exit' ? 'Exit' : 'Back'
    lines.push(
      bar(
        `${ui.colors.cyan('↑↓')} Move   ${ui.colors.cyan('Space')} Select   ` +
        `${ui.colors.cyan('Enter')} Confirm   ${ui.colors.dim('Esc')} ${exitLabel}`,
      ),
    )
    lines.push(bottom)

    // In-place line rewriting with \x1b[H and \x1b[K to guarantee ZERO screen flashing
    const flattened = lines.join('\n').split('\n')
    let output = '\x1b[H' + flattened.map((l) => l + '\x1b[K').join('\n')
    if (flattened.length < previousRenderedLines) {
      output += '\x1b[J'
    }
    previousRenderedLines = flattened.length

    process.stdout.write(output)
  }

  process.stdout.write('\x1b[?25l') // hide terminal cursor
  nodeReadline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  await render()

  return new Promise((resolve) => {
    const finish = (result) => {
      process.stdin.removeListener('keypress', onKeypress)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\x1b[?25h') // restore cursor
      resolve(result)
    }

    const onKeypress = async (str, key) => {
      if (key?.ctrl && key?.name === 'c') {
        finish(null)
        await cleanup()
        process.stdout.write('\n')
        process.exit(130)
      }

      if (key?.name === 'up' || key?.name === 'k') {
        cursorIndex = (cursorIndex - 1 + items.length) % items.length
        await render()
        return
      }

      if (key?.name === 'down' || key?.name === 'j') {
        cursorIndex = (cursorIndex + 1) % items.length
        await render()
        return
      }

      if (key?.name === 'space' || str === ' ') {
        selectedIndex = cursorIndex
        await render()
        return
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        // ALWAYS execute the option marked with [●] (selectedIndex)
        const chosen = items[selectedIndex] ?? items[cursorIndex]
        finish(chosen)
        return
      }

      if (allowCancel && (key?.name === 'escape' || key?.name === 'q' || str === 'q')) {
        const cancelItem = items.find((it) => it.id === cancelId || it.id === 'back' || it.id === 'exit')
        finish(cancelItem ?? { id: cancelId, label: 'Cancel' })
      }
    }

    process.stdin.on('keypress', onKeypress)
  })
}

async function promptText(label, fallback = '') {
  if (!process.stdin.isTTY) return fallback
  process.stdout.write('\x1b[?25h')
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = fallback === '' ? '' : ` ${ui.colors.dim(`[default: ${fallback}]`)}`
    const answer = await rl.question(`  ${ui.colors.cyan(label)}${suffix}: `)
    const val = answer.trim()
    return val || fallback
  } finally {
    rl.close()
  }
}

async function pressEnter() {
  if (!process.stdin.isTTY) return
  process.stdout.write(ui.colors.dim('\n  Press Enter, Space, or Esc to continue… '))
  return new Promise((resolve) => {
    nodeReadline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()

    const onKey = (str, key) => {
      if (key?.ctrl && key?.name === 'c') {
        process.stdin.removeListener('keypress', onKey)
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdout.write('\n')
        cleanup().then(() => process.exit(130))
        return
      }
      if (
        key?.name === 'return' ||
        key?.name === 'enter' ||
        key?.name === 'space' ||
        key?.name === 'escape' ||
        key?.name === 'q' ||
        str === ' ' ||
        str === 'q'
      ) {
        process.stdin.removeListener('keypress', onKey)
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdout.write('\n')
        resolve()
      }
    }

    process.stdin.on('keypress', onKey)
  })
}

// The engine refuses anything faster (kMaxTickRate in include/dstns/model.hpp);
// checking against the same bound here fails a bad config before a run starts.
const MAX_TICK_RATE = 5

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
  if (!Number.isFinite(tick) || tick <= 0 || tick > MAX_TICK_RATE) {
    throw new Error(`playback.tick_rate must be in (0, ${MAX_TICK_RATE}]`)
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

async function apiCall(port, endpoint, method = 'GET', payload = undefined, timeoutMs = 120000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-DSTNS-Operator': process.env.DSTNS_OPERATOR_TOKEN || await readFile(path.join(LOGS, 'operator.token'), 'utf8').then(s => s.trim()).catch(() => '') },
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

async function waitHealth(port, childProcess, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childProcess && childProcess.exitCode !== null) {
      throw new Error(`Server process exited unexpectedly with code ${childProcess.exitCode}`)
    }
    const health = await checkDstnsHealth(port)
    if (health) return health
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Server did not become healthy within ${timeoutMs / 1000}s on port ${port}`)
}

function collectChildTail(child) {
  let stdout = ''
  let stderr = ''
  const max = 32_000

  child.stdout?.on('data', (chunk) => {
    stdout = (stdout + chunk.toString()).slice(-max)
  })
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-max)
  })

  return () => ({ stdout, stderr })
}

async function build({ forceCmake = false, forceUi = false } = {}) {
  const tasks = ui.tasks()

  const nativeStamp = path.join(BUILD, '.launcher-source')
  const uiStamp = path.join(UI_DIST, '.launcher-source')
  const nativeState = existsSync(path.join(ROOT,'src')) ? await needsBuild(ROOT,['CMakeLists.txt','src','include','apps/dstns_server'],SERVER,nativeStamp) : null
  const uiState = existsSync(path.join(UI_ENGINE,'src')) ? await needsBuild(ROOT,['ui-engine/src','ui-engine/public','ui-engine/package.json','ui-engine/package-lock.json','ui-engine/index.html','ui-engine/vite.config.ts','ui-engine/tsconfig.json'],path.join(UI_DIST,'index.html'),uiStamp) : null
  const needCmake = forceCmake || !existsSync(SERVER) || nativeState?.needed
  const uiModules = path.join(UI_ENGINE, 'node_modules')
  const needUiBuild = forceUi || !existsSync(path.join(UI_DIST,'index.html')) || uiState?.needed
  const needUiInstall = needUiBuild && !existsSync(uiModules)

  if (needCmake) {
    tasks.add('Configure CMake build tree', async ({ update }) => {
      const started = Date.now()
      await runCommand('cmake', ['-S', ROOT, '-B', BUILD, '-DDSTNS_BUILD_TESTS=ON', '-DCMAKE_BUILD_TYPE=Release'], {
        onOutput: (line) => update(line),
      })
      return `Configured · ${formatDuration(Date.now() - started)}`
    })

    tasks.add('Compile C++ simulation engine', async ({ update }) => {
      const started = Date.now()
      await runCommand('cmake', ['--build', BUILD, '-j4'], {
        onOutput: (line) => update(line),
      })
      if (nativeState) await writeFile(nativeStamp,nativeState.fingerprint)
      return `Compiled · ${formatDuration(Date.now() - started)}`
    })
  }

  if (needUiInstall) {
    tasks.add('Install Web UI dependencies', async ({ update }) => {
      const started = Date.now()
      await runCommand('npm', ['ci', '--prefix', UI_ENGINE], {
        onOutput: (line) => update(line),
      })
      return `Installed · ${formatDuration(Date.now() - started)}`
    })
  }

  if (needUiBuild) {
    tasks.add('Build production Web UI bundle', async ({ update }) => {
      const started = Date.now()
      await runCommand('npm', ['run', 'build', '--prefix', UI_ENGINE], {
        onOutput: (line) => update(line),
      })
      if (uiState) await writeFile(uiStamp,uiState.fingerprint)
      return `Bundle built · ${formatDuration(Date.now() - started)}`
    })
  }

  if (!needCmake && !needUiInstall && !needUiBuild) {
    ui.logger.success('Environment verified', { suffix: 'all artifacts ready' })
    return
  }

  await tasks.run()
  if (tasks.getState() === 'failed') {
    throw tasks.error ?? new Error('Build steps failed')
  }
}

async function startServer({ replace = false, open = false } = {}) {
  const cfg = await loadConfig()
  let port = Number(process.env.DSTNS_API_PORT || cfg.api.port)
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid DSTNS_API_PORT")
  if (!process.env.DSTNS_API_PORT) {
    const previous=await readFile(ACTIVE_SERVER,'utf8').then(JSON.parse).catch(()=>null)
    if(previous?.port && (await checkDstnsHealth(previous.port))?.observer_ui_version==='observer-v2')port=previous.port
  }
  const host = cfg.api.host || '127.0.0.1' 

  await mkdir(LOGS, { recursive: true })
  await build()

  const shouldOpen = Boolean(open)

  if (await canConnect(port, host)) {
    const existing = await checkDstnsHealth(port)
    if (existing?.observer_ui_version === 'observer-v2') {
      await writeFile(ACTIVE_SERVER,JSON.stringify({port,observer_ui_version:'observer-v2'}))
      ui.logger.info('Attached to existing healthy DSTNS server', {
        suffix: `port ${port} · ${existing.lifecycle ?? 'READY'}`,
      })
      renderServerCard(port, existing)
      if (shouldOpen) {
        await openBrowser(`http://127.0.0.1:${port}/`)
      }
      return { process: null, port, health: existing, external: true }
    }

    const freePort = await findAvailablePort(port + 1)
    ui.logger.warning(`Port ${port} is serving ${existing ? 'an older DSTNS version' : 'another service'}`, {
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
    await writeFile(ACTIVE_SERVER,JSON.stringify({port,observer_ui_version:'observer-v2'}))
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
  table.head(['Field', 'Value'])
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
    await new Promise((resolve,reject)=>{
      const child=spawn(command,args,{stdio:'ignore'});
      child.once('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error(`Browser opener exited ${code}`)));
    });
    ui.logger.success('Opened DSTNS Web UI', {suffix:url});
  } catch(error) {ui.logger.warning('Open this URL in your browser', {suffix:url});}

}

const SESSION_ITEMS = [
  { id: 'start', label: 'Start Simulation', description: 'Initialize seed, traffic physics, and start playback' },
  { id: 'pause', label: 'Pause Simulation', description: 'Freeze simulation clock and hold vehicle states' },
  { id: 'resume', label: 'Resume Simulation', description: 'Resume playback loop and active incidents' },
  { id: 'status', label: 'Inspect System Status', description: 'Query /api/v1/system/status live telemetry' },
  { id: 'open', label: 'Open Web UI in Browser', description: 'Launch Web UI in default browser' },
  { id: 'terminate', label: 'Terminate Server', description: 'Gracefully stop the background C++ server' },
  { id: 'back', label: 'Return to Dashboard', description: 'Leave server running and return to main menu' },
]

async function controlSession(serverProcess, port) {
  let lastSessionIndex = 0

  while (true) {
    if (serverProcess && serverProcess.exitCode !== null) {
      ui.logger.error(new Error(`Managed server exited with code ${serverProcess.exitCode}`))
      return
    }

    const choice = await selectMenu({
      title: 'ACTIVE SERVER CONTROLS',
      items: SESSION_ITEMS,
      initialIndex: lastSessionIndex,
      allowCancel: true,
      cancelId: 'back',
      beforeRender: async () => {
        const state = await dashboardState()
        return renderTelemetry(state)
      },
    })

    if (!choice || choice.id === 'back') return

    lastSessionIndex = SESSION_ITEMS.findIndex((it) => it.id === choice.id)
    if (lastSessionIndex === -1) lastSessionIndex = 0

    if (choice.id === 'open') {
      await openBrowser(`http://127.0.0.1:${port}/`)
      await pressEnter()
      continue
    }

    if (choice.id === 'start') {
      try {await startRun(port, await runConfig({}));}
      catch(error){ui.logger.error(error);}
      await pressEnter()
      continue
    }

    if (choice.id === 'pause') {
      const { code, body } = await apiCall(port, '/api/v1/playback/pause', 'POST', {})
      if (code >= 200 && code < 300) {
        ui.logger.success('Simulation paused', { suffix: body?.lifecycle ?? `HTTP ${code}` })
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      await pressEnter()
      continue
    }

    if (choice.id === 'resume') {
      const { code, body } = await apiCall(port, '/api/v1/playback/play', 'POST', {})
      if (code >= 200 && code < 300) {
        ui.logger.success('Simulation resumed', { suffix: body?.lifecycle ?? `HTTP ${code}` })
      } else {
        ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      }
      await pressEnter()
      continue
    }

    if (choice.id === 'status') {
      const { code, body } = await apiCall(port, '/api/v1/system/status')
      if (code >= 200 && code < 300) renderJsonTable('DSTNS system status', body)
      else ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
      await pressEnter()
      continue
    }

    if (choice.id === 'terminate') {
      const confirmItems = [
        { id: 'cancel', label: 'Cancel', description: 'Keep the DSTNS server running' },
        { id: 'confirm', label: 'Confirm Termination', description: 'Send shutdown signal to C++ server process' },
      ]
      const confirmed = await selectMenu({
        title: 'SERVER TERMINATION CONFIRMATION',
        items: confirmItems,
        allowCancel: true,
        cancelId: 'cancel',
        beforeRender: async () => {
          const state = await dashboardState()
          return `${renderTelemetry(state)}  ${ui.colors.yellow('Are you sure you want to shut down the C++ DSTNS server?')}\n`
        },
      })

      if (confirmed?.id === 'confirm') {
        const { code, body } = await apiCall(port, '/terminate', 'POST', {})
        if (code >= 200 && code < 300) {
          ui.logger.success(body?.message ?? 'Server termination requested')
        } else {
          ui.logger.error(new Error(body?.error ?? body?.message ?? `HTTP ${code}`))
        }
        await pressEnter()
        return
      }
      ui.logger.info('Termination cancelled')
    }
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
  table.head(selected.map((index) => columns[index]))
  for (const row of rows) {
    table.row(selected.map((index) => trimText(row[index], 72)))
  }
  table.render()
}

const LOG_ITEMS = [
  { id: 'system', label: 'System Log (system.log)', description: 'Stream latest entries from logs/system.log' },
  { id: 'api', label: 'REST API Log (SQLite)', description: 'Query api_log: endpoints, response codes, latencies' },
  { id: 'event', label: 'Simulation Event Log (SQLite)', description: 'Query event_log: weather, incidents, triggers' },
  { id: 'playback', label: 'Playback Lifecycle Log', description: 'Query lifecycle_log: state transition history' },
  { id: 'back', label: 'Return to Main Menu', description: 'Go back to operator dashboard' },
]

async function viewLogs(topic = '') {
  let choice = topic.toLowerCase()

  if (!choice) {
    const selected = await selectMenu({
      title: 'LOG INSPECTOR',
      items: LOG_ITEMS,
      allowCancel: true,
      cancelId: 'back',
      beforeRender: async () => {
        const state = await dashboardState()
        return `${renderTelemetry(state)}  ${ui.colors.dim('Select a log source to inspect runtime activity.')}\n`
      },
    })
    if (!selected || selected.id === 'back') return false
    choice = selected.id
  }

  if (choice === 'system') {
    const file = path.join(LOGS, 'system.log')
    if (!existsSync(file)) {
      ui.logger.info('No system log yet')
      return true
    }

    const content = await readFile(file, 'utf8')
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-100)
    ui.logger.info(`System log · last ${lines.length} lines`)
    for (const line of lines) {
      ui.logger.info(trimText(line, 160), { prefix: '%time%' })
    }
    return true
  }

  const mapping = {
    api: 'api_log',
    event: 'event_log',
    playback: 'lifecycle_log',
  }
  const tableName = mapping[choice]
  if (!tableName) {
    ui.logger.warning('Unknown log source', { suffix: choice })
    return true
  }

  const data = await queryRuntimeDb(tableName)
  if (!data) {
    ui.logger.info('No runtime database yet')
    return true
  }
  renderLogTable(data.columns, data.rows)
  return true
}

async function editConfig() {
  while (true) {
    const cfg = await loadConfig()
    const CONFIG_ITEMS = [
      { id: 'duration', label: `Playback Duration (${cfg.playback.duration_seconds}s)`, description: 'Configured duration in seconds [60–3600]' },
      { id: 'tick', label: `Playback rate (${cfg.playback.tick_rate}×)`, description: `Playback multiplier (0, ${MAX_TICK_RATE}]` },
      { id: 'host', label: `API Host (${cfg.api.host})`, description: 'Bind network interface (e.g. 127.0.0.1)' },
      { id: 'port', label: `API Port (${cfg.api.port})`, description: 'Network listening port [1–65535]' },
      { id: 'back', label: 'Done (Return to Dashboard)', description: 'Finish configuring and return to main menu' },
    ]

    const choice = await selectMenu({
      title: 'CONFIGURATION MANAGER',
      items: CONFIG_ITEMS,
      allowCancel: true,
      cancelId: 'back',
      beforeRender: async () => {
        const state = await dashboardState()
        const c = ui.colors
        const lines = [
          renderTelemetry(state),
          `  ${c.bold(c.cyan('CURRENT SETTINGS'))}`,
          c.dim('  ──────────────────────────────────────────────────────────────────────────'),
          `  ●  ${c.bold('Duration  ')} ${String(cfg.playback.duration_seconds).padEnd(10)} ${c.dim('seconds per simulation cycle [60–3600]')}`,
          `  ●  ${c.bold('Tick Rate ')} ${String(cfg.playback.tick_rate).padEnd(10)} ${c.dim(`playback multiplier (0, ${MAX_TICK_RATE}]`)}`,
          `  ●  ${c.bold('API Host  ')} ${String(cfg.api.host).padEnd(10)} ${c.dim('listening address')}`,
          `  ●  ${c.bold('API Port  ')} ${String(cfg.api.port).padEnd(10)} ${c.dim('REST API port [1–65535]')}`,
          c.dim('  ──────────────────────────────────────────────────────────────────────────'),
          '',
          `  ${c.dim('Select a parameter to modify its value, or choose Done to return.')}\n`,
        ]
        return lines.join('\n')
      },
    })

    if (!choice || choice.id === 'back') return

    if (choice.id === 'duration') {
      const val = await promptText('Enter new playback duration (seconds)', String(cfg.playback.duration_seconds))
      const num = Number(val)
      if (Number.isInteger(num) && num >= 60 && num <= 3600) {
        cfg.playback.duration_seconds = num
        await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
        ui.logger.success('Playback duration updated', { suffix: `${num}s` })
      } else {
        ui.logger.error(new Error('Invalid duration: must be an integer between 60 and 3600'))
      }
      await pressEnter()
    } else if (choice.id === 'tick') {
      const val = await promptText('Enter playback multiplier', String(cfg.playback.tick_rate))
      const num = Number(val)
      if (Number.isFinite(num) && num > 0 && num <= MAX_TICK_RATE) {
        cfg.playback.tick_rate = num
        await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
        ui.logger.success('Tick rate updated', { suffix: `${num}×` })
      } else {
        ui.logger.error(new Error(`Invalid tick rate: must be in (0, ${MAX_TICK_RATE}]`))
      }
      await pressEnter()
    } else if (choice.id === 'host') {
      const val = await promptText('Enter API host', String(cfg.api.host))
      if (val.trim()) {
        cfg.api.host = val.trim()
        await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
        ui.logger.success('API host updated', { suffix: cfg.api.host })
      }
      await pressEnter()
    } else if (choice.id === 'port') {
      const val = await promptText('Enter API port', String(cfg.api.port))
      const num = Number(val)
      if (Number.isInteger(num) && num >= 1 && num <= 65535) {
        cfg.api.port = num
        await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
        ui.logger.success('API port updated', { suffix: `port ${num}` })
      } else {
        ui.logger.error(new Error('Invalid port: must be an integer between 1 and 65535'))
      }
      await pressEnter()
    }
  }
}

const TESTS = {
  all: [
    {
      title: 'Configure test build tree',
      command: 'cmake',
      args: ['-S', ROOT, '-B', BUILD, '-DDSTNS_BUILD_TESTS=ON'],
    },
    {
      title: 'Build test binaries and C++ engine',
      command: 'cmake',
      args: ['--build', BUILD, '-j4'],
    },
    {
      title: 'Native C++ Unit & Invariant Test Suite',
      command: 'ctest',
      args: ['--test-dir', BUILD, '--output-on-failure'],
    },
    {
      title: 'Deterministic Replay & Seed Verification',
      command: path.join(BUILD, 'dstns_replay_verify'),
      args: [],
    },
    {
      title: 'Simulation Performance Benchmark',
      command: path.join(BUILD, 'dstns_benchmark'),
      args: [],
    },
    {
      title: 'REST API Comprehensive Smoke & Lifecycle Suite',
      command: 'python3',
      args: [path.join(ROOT, 'tests', 'api', 'api_smoke.py'), '--server', SERVER],
    },
    {
      title: 'SUMO Microscopic Integration Suite',
      command: 'bash',
      args: [path.join(ROOT, 'tests', 'integration', 'sumo_smoke.sh')],
    },
    {
      title: 'Web UI Vitest & Component Suite',
      command: 'npm',
      args: ['test', '--prefix', UI_ENGINE],
    },
    {
      title: 'Production Web UI Bundle Compilation',
      command: 'npm',
      args: ['run', 'build', '--prefix', UI_ENGINE],
    },
  ],
  unit: [
    {
      title: 'Native C++ test suite (Unit, Property, Replay, Perf)',
      command: 'ctest',
      args: ['--test-dir', BUILD, '--output-on-failure'],
    },
  ],
  api: [
    {
      title: 'REST API End-to-End Test Suite (82+ assertions verified)',
      command: 'python3',
      args: [path.join(ROOT, 'tests', 'api', 'api_smoke.py'), '--server', SERVER],
    },
  ],
  replay: [
    {
      title: 'Replay determinism & avalanche diffusion verification',
      command: path.join(BUILD, 'dstns_replay_verify'),
      args: [],
    },
  ],
  benchmark: [
    {
      title: 'Simulation routing throughput and snapshot benchmark',
      command: path.join(BUILD, 'dstns_benchmark'),
      args: [],
    },
  ],
  sumo: [
    {
      title: 'SUMO microscopic simulation & network compilation',
      command: 'bash',
      args: [path.join(ROOT, 'tests', 'integration', 'sumo_smoke.sh')],
    },
  ],
  ui: [
    {
      title: 'Web UI Vitest component and router tests',
      command: 'npm',
      args: ['test', '--prefix', UI_ENGINE],
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
        await runCommand(test.command, test.args, {
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
  summary.head(['Test Stage', 'Result', 'Duration'])
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
      .row(['Tripinfo file', path.relative(ROOT, tripinfo)])
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
    const resetItems = [
      { id: 'cancel', label: 'Cancel', description: 'Keep all databases, logs, and checkpoints intact' },
      { id: 'confirm', label: 'Confirm Reset', description: 'Purge runtime.db, system.log, scenarios & checkpoints' },
    ]
    const choice = await selectMenu({
      title: 'RESET RUNTIME STATE CONFIRMATION',
      items: resetItems,
      allowCancel: true,
      cancelId: 'cancel',
      beforeRender: async () => {
        const state = await dashboardState()
        return `${renderTelemetry(state)}  ${ui.colors.yellow('This will delete ephemeral logs, SQLite databases, scenarios, and checkpoints.')}\n`
      },
    })
    if (choice?.id !== 'confirm') {
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
    .add(`${ui.colors.cyan('dstns [start] [--no-open]')} Build current code, load real OSM and open the observer`)
    .add(`${ui.colors.cyan('dstns ui [action]')}     Manage Web UI: open, dev (Vite hot-reload), build, or install`)
    .add(`${ui.colors.cyan('dstns logs')}            Inspect system/API/event/playback logs`)
    .add(`${ui.colors.cyan('dstns config')}          Validate and edit persisted defaults`)
    .add(`${ui.colors.cyan('dstns test [scope]')}    Run tests: all, unit, api, replay, benchmark, sumo, or ui`)
    .add(`${ui.colors.cyan('dstns sumo')}            Run a standalone SUMO microscopic simulation`)
    .add(`${ui.colors.cyan('dstns reset')}           Clear ephemeral runtime data`)
    .add(`${ui.colors.cyan('dstns console')}         Open the interactive operator dashboard`)
    .add(`${ui.colors.cyan('dstns help')}            Display this help`)
    .add(`${ui.colors.cyan('dstns --mode=server')}   Run the C++ server in foreground mode`)
    .render()
}

async function dashboardState() {
  const osInfo = getOsInfo()

  let cfg
  let configStatus = 'invalid'
  let configDetail = `${path.relative(ROOT, CONFIG)} (missing or corrupt)`

  try {
    cfg = await loadConfig()
    configStatus = 'valid'
    configDetail = `${path.relative(ROOT, CONFIG)} (port ${cfg.api.port} · ${cfg.api.host})`
  } catch (error) {
    configStatus = 'invalid'
    configDetail = `${path.relative(ROOT, CONFIG)} · ${error.message}`
  }

  const port = cfg ? Number(cfg.api.port) : 8080
  let serverStatus = 'stopped'
  let serverDetail = `http://127.0.0.1:${port}/ (offline · configured port ${port})`

  if (await canConnect(port)) {
    const health = await checkDstnsHealth(port)
    if (health) {
      const lc = (health.lifecycle ?? 'READY').toUpperCase()
      if (['RUNNING', 'PLAY', 'ACTIVE'].includes(lc)) serverStatus = 'running'
      else if (['IDLE', 'PAUSED', 'STANDBY', 'INIT'].includes(lc)) serverStatus = 'idle'
      else serverStatus = 'ready'
      serverDetail = `http://127.0.0.1:${port}/ · lifecycle: ${lc} · health: READY`
    } else {
      serverStatus = 'occupied'
      serverDetail = `port ${port} in use by another process`
    }
  }

  const buildOk = existsSync(SERVER)
  const webOk = existsSync(UI_DIST)
  const dbOk = existsSync(path.join(LOGS, 'runtime.db'))

  return {
    osStatus: osInfo.isCompatible ? 'ready' : 'warning',
    osDetail: `${osInfo.name} ${osInfo.release} ${osInfo.arch} (${osInfo.cores} cores, ${osInfo.memGb} GB RAM)`,
    buildStatus: buildOk ? 'ready' : 'missing',
    buildDetail: `${path.relative(ROOT, SERVER)} (${buildOk ? 'C++20 Release · deterministic' : 'missing binary'})`,
    webStatus: webOk ? 'ready' : 'missing',
    webDetail: `${path.relative(ROOT, UI_DIST)} (${webOk ? 'production observer · Canvas/Vite' : 'unbuilt bundle'})`,
    configStatus,
    configDetail,
    serverStatus,
    serverDetail,
    simStatus: 'active',
    simDetail: '10 Hz · 3600s cycle · Blake3-128 cryptographic sub-seed · 4 incident slots',
    dbStatus: dbOk ? 'ready' : 'idle',
    dbDetail: `${path.relative(ROOT, path.join(LOGS, 'runtime.db'))} (SQLite WAL · api_log, event_log)`,
    port,
  }
}

function renderTelemetry(state) {
  const c = ui.colors

  const bullet = (status) => {
    const s = String(status ?? '').toLowerCase()
    if (['running', 'ready', 'valid', 'pass', 'ok', 'active'].includes(s)) {
      return c.green('●')
    }
    if (['idle', 'paused', 'standby', 'init', 'warning', 'occupied'].includes(s)) {
      return c.yellow('●')
    }
    return c.red('●')
  }

  const badge = (status) => {
    const s = String(status ?? '').toUpperCase()
    if (['RUNNING', 'READY', 'VALID', 'PASS', 'ACTIVE'].includes(s)) {
      return c.green(s.padEnd(10))
    }
    if (['IDLE', 'PAUSED', 'STANDBY', 'INIT', 'OCCUPIED', 'WARNING'].includes(s)) {
      return c.yellow(s.padEnd(10))
    }
    return c.red(s.padEnd(10))
  }

  const lines = [
    `  ${c.bold(c.cyan('SYSTEM & SIMULATION TELEMETRY'))}`,
    c.dim('  ──────────────────────────────────────────────────────────────────────────'),
    `  ${bullet(state.osStatus)}  ${c.bold('Platform Host  ')} ${badge(state.osStatus)} ${c.dim(state.osDetail)}`,
    `  ${bullet(state.buildStatus)}  ${c.bold('C++ Core Engine')} ${badge(state.buildStatus)} ${c.dim(state.buildDetail)}`,
    `  ${bullet(state.webStatus)}  ${c.bold('Web UI Engine  ')} ${badge(state.webStatus)} ${c.dim(state.webDetail)}`,
    `  ${bullet(state.configStatus)}  ${c.bold('Configuration  ')} ${badge(state.configStatus)} ${c.dim(state.configDetail)}`,
    `  ${bullet(state.serverStatus)}  ${c.bold('API Server     ')} ${badge(state.serverStatus)} ${c.dim(state.serverDetail)}`,
    `  ${bullet(state.simStatus)}  ${c.bold('Simulation Hub ')} ${badge(state.simStatus)} ${c.dim(state.simDetail)}`,
    `  ${bullet(state.dbStatus)}  ${c.bold('Telemetry DB   ')} ${badge(state.dbStatus)} ${c.dim(state.dbDetail)}`,
    c.dim('  ──────────────────────────────────────────────────────────────────────────'),
    '',
  ]
  return lines.join('\n')
}

const MENU_ITEMS = [
  { id: 'start', label: 'Launch & Control Simulation', description: 'Start C++ server, physics loop & open Web UI' },
  { id: 'logs', label: 'Inspect System Logs', description: 'View event log, API requests, and SQLite DB' },
  { id: 'config', label: 'Configuration Manager', description: 'Inspect and edit playback & network defaults' },
  { id: 'test', label: 'Run Verification Suite', description: 'Execute native C++, REST API, SUMO & UI tests' },
  { id: 'sumo', label: 'Standalone SUMO Execution', description: 'Microscopic traffic simulation (sandbox.sumocfg)' },
  { id: 'reset', label: 'Reset Runtime State', description: 'Clear ephemeral SQLite DB, logs & scenarios' },
  { id: 'ui', label: 'Web UI Manager', description: 'Open browser, Vite dev server, build, or install' },
  { id: 'help', label: 'Command Reference', description: 'Display CLI command syntax and flags' },
  { id: 'exit', label: 'Exit Operator Console', description: 'Shut down managed services and terminate' },
]

async function menu() {
  let lastIndex = 0

  while (true) {
    const choice = await selectMenu({
      title: 'OPERATOR ACTIONS',
      items: MENU_ITEMS,
      initialIndex: lastIndex,
      allowCancel: true,
      cancelId: 'exit',
      beforeRender: async () => {
        const state = await dashboardState()
        return renderTelemetry(state)
      },
    })

    if (!choice || choice.id === 'exit') {
      return 0
    }

    lastIndex = MENU_ITEMS.findIndex((it) => it.id === choice.id)
    if (lastIndex === -1) lastIndex = 0

    try {
      if (choice.id === 'start') {
        const started = await launchSimulation({open:true});
        await controlSession(started.process, started.port);
      } else if (choice.id === 'logs') {
        const didShow = await viewLogs()
        if (didShow) await pressEnter()
      } else if (choice.id === 'config') {
        await editConfig()
      } else if (choice.id === 'test') {
        const testOptions = [
          { id: 'all', label: 'All Verification Suites (9 Stages)', description: 'Complete test suite (C++, API, SUMO, Replay, Benchmarks, UI)' },
          { id: 'unit', label: 'Native C++ Unit & Invariant Tests', description: 'CTest suite: unit, property, replay & performance' },
          { id: 'api', label: 'REST API Comprehensive Test Suite', description: 'Exhaustive API smoke tests (82+ assertions verified)' },
          { id: 'replay', label: 'Deterministic Replay Verification', description: 'Seed avalanche, state hashing & bit-level reproducibility' },
          { id: 'benchmark', label: 'Simulation Performance Benchmark', description: 'Routing throughput & dynamic snapshot benchmark' },
          { id: 'sumo', label: 'SUMO Microscopic Integration', description: 'Network compilation & microscopic trip simulation' },
          { id: 'ui', label: 'Web UI Vitest & Component Suite', description: 'Frontend component, router, and state tests' },
          { id: 'back', label: 'Return to Main Menu', description: 'Go back to operator dashboard' },
        ]
        const testChoice = await selectMenu({
          title: 'VERIFICATION SUITE SELECTOR',
          items: testOptions,
          allowCancel: true,
          cancelId: 'back',
          beforeRender: async () => {
            const state = await dashboardState()
            return `${renderTelemetry(state)}  ${ui.colors.dim('Select which verification suite to execute.')}\n`
          },
        })
        if (testChoice && testChoice.id !== 'back') {
          clearScreen()
          await runTests(testChoice.id)
          await pressEnter()
        }
      } else if (choice.id === 'sumo') {
        clearScreen()
        await runStandaloneSumo()
        await pressEnter()
      } else if (choice.id === 'reset') {
        const didReset = await resetRuntime()
        if (didReset) await pressEnter()
      } else if (choice.id === 'ui') {
        const cfg = await loadConfig()
        const uiOptions = [
          { id: 'open', label: 'Open Web UI in Browser', description: `Launch http://127.0.0.1:${cfg.api.port}/` },
          { id: 'dev', label: 'Vite Development Server', description: 'Start hot-reloading dev server in ui-engine' },
          { id: 'build', label: 'Build Production Bundle', description: 'Compile optimized assets into ui-engine/dist' },
          { id: 'install', label: 'Install UI Dependencies', description: 'Run npm install in ui-engine directory' },
          { id: 'back', label: 'Return to Main Menu', description: 'Go back to operator dashboard' },
        ]
        const uiChoice = await selectMenu({
          title: 'WEB UI MANAGER',
          items: uiOptions,
          allowCancel: true,
          cancelId: 'back',
          beforeRender: async () => {
            const state = await dashboardState()
            return `${renderTelemetry(state)}  ${ui.colors.dim('Manage Web UI frontend assets, dev server, and packages.')}\n`
          },
        })
        if (uiChoice && uiChoice.id !== 'back') {
          if (uiChoice.id === 'dev') {
            ui.logger.info('Starting Web UI development server (Vite hot-reload)...')
            await runCommand('npm', ['run', 'dev', '--prefix', UI_ENGINE], { inherit: true })
          } else if (uiChoice.id === 'build') {
            await build({ forceUi: true })
            ui.logger.success('Web UI bundle rebuilt')
            await pressEnter()
          } else if (uiChoice.id === 'install') {
            await runCommand('npm', ['install', '--prefix', UI_ENGINE], { inherit: true })
            ui.logger.success('Web UI dependencies installed')
            await pressEnter()
          } else if (uiChoice.id === 'open') {
            await openBrowser(`http://127.0.0.1:${await activePort()}/`)
            await pressEnter()
          }
        }
      } else if (choice.id === 'help') {
        clearScreen()
        renderHelp()
        await pressEnter()
      }
    } catch (error) {
      if (error instanceof CommandError) {
        const detail = tailText(error.stderr || error.stdout || error.message)
        ui.logger.error(new Error(detail || error.message))
      } else {
        ui.logger.error(error instanceof Error ? error : new Error(String(error)))
      }
      await pressEnter()
    }
  }
}

function seedStore(action, data) {
  const result = spawnSync('python3', [path.join(OPERATOR_DIR, 'seeds.py'), action], { input: JSON.stringify(data), encoding: 'utf8', cwd: ROOT })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Saved seed database unavailable')
  return JSON.parse(result.stdout)
}

async function runConfig(options) {
  if (options.seed && options['saved-seed']) throw new Error('--seed and --saved-seed are mutually exclusive')
  let config
  if (options['saved-seed']) config = seedStore('use', { id: options['saved-seed'] }).config
  else {
    const defaults = await loadConfig()
    // The seed is a number, and the run is named by that number end to end:
    // what is typed here is what the interface shows and what reproduces the
    // world. A generated seed is 64 bits, so it stays short enough to read
    // back off the screen and retype.
    let seed = options.seed
    if (seed) {
      if (!/^(?:0x[0-9a-fA-F]{1,32}|[0-9]{1,39})$/.test(seed)) throw new Error('Seed must be a decimal integer or 0x hexadecimal, within 128 bits')
      const n = BigInt(seed); if (n < 0n || n >= (1n << 128n)) throw new Error('Seed exceeds 128 bits')
      seed = n.toString(10)
    } else seed = BigInt('0x' + randomBytes(8).toString('hex')).toString(10)
    // "auto" lets the seed choose a real city district, which the core
    // downloads from OpenStreetMap on demand and caches by seed-derived name.
    // An explicit --osm-file (or map.osm_file in config) still pins a file.
    const source = options['osm-file'] || defaults.map.osm_file || 'auto'
    const map = { osm_file: source === 'auto' ? 'auto' : path.resolve(ROOT, source), max_nodes: defaults.map.max_nodes }
    if (defaults.map.tile_radius_m) map.tile_radius_m = defaults.map.tile_radius_m
    if (defaults.map.cache_dir) map.cache_dir = defaults.map.cache_dir
    config = { seed, day: defaults.day ?? 0, playback_duration_seconds: defaults.playback.duration_seconds, tick_rate: defaults.playback.tick_rate, map, modules:defaults.modules, dws:defaults.dws, map_selection_version: 'urban-crfg-v3' }
  }
  if (options['osm-file']) config.map.osm_file = path.resolve(ROOT, options['osm-file'])
  if (config.map.osm_file !== 'auto' && !existsSync(config.map.osm_file)) throw new Error('OSM data unavailable; provide --osm-file PATH')
  if (options['day-type']) config.day = options['day-type'] === 'weekend' ? 1 : 0
  for (const [arg,key,min,max] of [['duration','playback_duration_seconds',60,3600],['speed','tick_rate',0.01,MAX_TICK_RATE],['max-nodes','max_nodes',2,50000]]) {
    if (!options[arg]) continue
    const v = Number(options[arg]); if (!Number.isFinite(v) || v < min || v > max || (arg !== 'speed' && !Number.isInteger(v))) throw new Error(`--${arg} must be in [${min},${max}]`)
    if (arg === 'max-nodes') config.map.max_nodes=v; else config[key]=v
  }
  if (typeof config.tick_rate !== 'number' || !Number.isFinite(config.tick_rate) || config.tick_rate <= 0 || config.tick_rate > MAX_TICK_RATE) throw new Error(`tick_rate must be in (0, ${MAX_TICK_RATE}]`)
  return config
}

const mib = (n) => (n / (1024 * 1024)).toFixed(1)

/**
 * One rewritten line showing download progress. Overpass sends Content-Length
 * only sometimes, so the bar is determinate when it can be and sweeps a band
 * otherwise — inventing a percentage from an unknown total would be a lie.
 */
function drawBar(label, done, total, sweep, width = 28) {
  if (!process.stdout.isTTY) return
  const known = total > 0 && done <= total
  let bar
  let right
  if (known) {
    const ratio = done / total
    const filled = Math.round(ratio * width)
    bar = ui.colors.cyan('█'.repeat(filled)) + ui.colors.dim('░'.repeat(width - filled))
    right = `${String(Math.round(ratio * 100)).padStart(3)}%  ${mib(done)}/${mib(total)} MiB`
  } else {
    const band = 6
    const head = sweep % (width + band)
    bar = Array.from({ length: width }, (_, i) =>
      i >= head - band && i < head ? ui.colors.cyan('█') : ui.colors.dim('░'),
    ).join('')
    right = `${mib(done)} MiB`
  }
  process.stdout.write(`\r  ${ui.colors.dim(label.padEnd(24))} ${bar}  ${ui.colors.dim(right)}   `)
}

/**
 * Follow a map download while the blocking start request is in flight.
 * Returns a stop function. Progress is observational: if the endpoint is
 * unavailable the start still proceeds, just without a bar.
 */
function followMapDownload(port) {
  let stopped = false
  let drew = false
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let tick = 0
  const poll = async () => {
    while (!stopped) {
      try {
        const res = await apiCall(port, '/api/v1/system/map-status')
        const status = res.body?.data
        if (status?.active) {
          drew = true
          const where = status.city ? `${status.city}` : 'map'
          if (status.phase === 'download') {
            drawBar(`${spinner[tick % spinner.length]} Downloading ${where}`, status.bytes, status.total, tick++)
          } else {
            const phase = status.phase === 'parse' ? 'Validating' : 'Contacting Overpass'
            process.stdout.write(
              `\r  ${ui.colors.dim(`${spinner[tick++ % spinner.length]} ${phase} ${where}`.padEnd(52))}   `,
            )
          }
        }
      } catch {
        // The server is busy compiling; try again shortly.
      }
      await sleep(180)
    }
    if (drew && process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(78) + '\r')
  }
  void poll()
  return () => {
    stopped = true
  }
}

/** Resolve once the observer page has been served, or when the wait runs out. */
async function waitForObserver(port, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const r = await apiCall(port, '/api/v1/system/observer').catch(() => null)
    if (r?.body?.data?.loaded) return true
    await sleep(150)
  }
  return false
}

/** Maps already on disk, newest first, as `--osm-file` arguments. */
async function cachedMaps() {
  const cfg = await loadConfig().catch(() => null)
  const dir = path.resolve(ROOT, cfg?.map?.cache_dir || 'data/maps')
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.osm.xml'))
    return names.map((n) => path.relative(ROOT, path.join(dir, n)))
  } catch {
    return []
  }
}

/**
 * A map download failure ends the run, because substituting another city would
 * break the correspondence between a seed and the place it denotes. Say what
 * can be done instead: fix the network, point at another Overpass, or run one
 * of the districts already on disk.
 */
async function mapRecoveryLines() {
  const cached = await cachedMaps()
  const lines = [
    'The seed could not be resolved to a district, and no other city is substituted for it.',
    'Check the network, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS to a reachable Overpass instance.',
  ]
  if (cached.length) {
    lines.push(`Already downloaded: ${cached.slice(0, 4).join(', ')}${cached.length > 4 ? `, and ${cached.length - 4} more` : ''}.`)
    lines.push(`Run one of them offline with: ./launcher start --osm-file ${cached[0]}`)
  }
  return lines
}

let mapRecovery = []

function withMapRecovery(message) {
  return [message, ...mapRecovery].join('\n  ')
}

async function startRun(port,payload) {
  mapRecovery = payload.map.osm_file === 'auto' ? await mapRecoveryLines() : []
  const onDemand = payload.map.osm_file === 'auto'
  ui.logger.info(
    onDemand ? 'Resolving the seed to a city district' : 'Loading real OpenStreetMap district',
    {suffix: onDemand ? 'downloading from OpenStreetMap if not already cached' : payload.map.osm_file},
  )
  const stopFollowing = onDemand ? followMapDownload(port) : () => {}
  let result
  try {
    // All configured mirrors may take longer than a normal API request.
    result = await apiCall(port,'/api/v1/playback/start','POST',payload)
    if(result.code===202){
      const deadline=Date.now()+30*60*1000
      while(Date.now()<deadline){
        const status=await apiCall(port,'/api/v1/playback/status')
        const lifecycle=status.body?.data?.lifecycle
        if(['RUNNING','PAUSED','READY'].includes(lifecycle))break
        if(lifecycle==='IDLE' && status.body?.data?.preparation_error)
          return {code:503,body:{error:{code:'MAP_FETCH_FAILED',message:status.body.data.preparation_error}}}
        if(lifecycle==='ERROR')break
        await sleep(180)
      }
    }
  } finally {
    stopFollowing()
  }
  if(result.code!==202){
    const message = result.body?.error?.message || `Startup failed: HTTP ${result.code}`
    throw new Error(result.body?.error?.code === 'MAP_FETCH_FAILED' ? withMapRecovery(message) : message)
  }
  const topology=await apiCall(port,'/api/v1/view/topology')
  const map=topology.body?.data
  if(topology.code!==200 || map?.source!=='OpenStreetMap' || !map.nodes?.length || !map.edges?.length)throw new Error('The server did not load a usable real OSM network.')
  const where=map.location?.city
    ? `${map.location.city}, ${map.location.country} · ${map.location.anchor_lat.toFixed(4)}, ${map.location.anchor_lon.toFixed(4)}`
    : null
  if(where)ui.logger.info('District',{suffix:`${where}${map.location.downloaded?' (downloaded)':' (cached)'}`})
  ui.logger.success(`Simulation running · ${payload.seed} · ${payload.day===1?'weekend':'weekday'}`,{suffix:`${map.nodes.length.toLocaleString()} road nodes · ${map.features.length.toLocaleString()} buildings/POIs`})
}
async function launchSimulation(options) {
  let payload=await runConfig(options)
  if(options['save-seed'])payload=seedStore('save',{id:options['save-seed'],description:options.description,config:payload}).config
  const started=await startServer()
  if(started.process){managedServer=started.process;managedServerPort=started.port;endSessionWhenCoreExits(started.process)}
  else if(started.external)endSessionWhenExternalCoreStops(started.port)
  const explicitRun=['seed','saved-seed','save-seed','day-type','osm-file','max-nodes','duration','speed'].some(key=>options[key]!==undefined)
  const url=`http://127.0.0.1:${started.port}/`
  const observing=['RUNNING','PAUSED'].includes(started.health?.lifecycle) && !explicitRun
  // The interface comes up first and narrates the rest: world selection, the
  // map, generation and initialization all happen with the observer watching,
  // rather than behind a terminal spinner on a blank browser tab.
  if(options.open && !observing){
    await openBrowser(url)
    // Wait for the page to actually load before asking for a world, so the
    // whole sequence (selection, download, generation, initialization) is
    // watched in the interface rather than happening behind a blank tab.
    const waited = await waitForObserver(started.port, 12000)
    ui.logger.info(waited ? 'Observer open' : 'Observer opening', {
      suffix: `${url} · preparing the world`,
    })
  }
  if(observing) {
    const current=await apiCall(started.port,'/api/v1/view/topology')
    if(current.body?.data?.source!=='OpenStreetMap')throw new Error('The active server is running a synthetic fixture. Stop that run before launching an OSM simulation.')
    ui.logger.info('Observing the existing real OSM simulation')
  } else await startRun(started.port,payload)
  ui.logger.info('Observer ready', {suffix:url})
  if(options.open && observing)await openBrowser(url)
  return started
}
async function activePort() {
  const saved=await readFile(ACTIVE_SERVER,'utf8').then(JSON.parse).catch(()=>null)
  const cfg=await loadConfig()
  const ports=[managedServerPort,saved?.port,Number(process.env.DSTNS_API_PORT || cfg.api.port)].filter(Boolean)
  for(const port of ports)if((await checkDstnsHealth(port))?.observer_ui_version==='observer-v2')return port
  throw new Error('No current observer server is running. Use ./launcher start first.')
}

function parseArgs(argv) {
  const positional = []
  const options = {
    mode: null,
    yes: false,
    verbose: false,
    open: process.platform === 'darwin' || process.platform === 'win32' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
    noSplash: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--verbose' || arg === '-v') options.verbose = true
    else if (arg === '--open' || arg === '-o') options.open = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--help' || arg === '-h') positional.push('help')
    else if (arg === '--version' || arg === '-V') positional.push('version')
    else if (arg === '--license' || arg === '--licence') positional.push('license')
    else if (arg === '--no-splash') options.noSplash = true
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg === '--mode' && i + 1 < argv.length) options.mode = argv[++i]
    else if (['--seed','--saved-seed','--save-seed','--day-type','--osm-file','--max-nodes','--duration','--speed','--description'].includes(arg)) {
      if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg.slice(2)] = argv[++i]
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }

  return {
    command: positional[0] ?? (options.mode ? null : 'start'),
    topic: positional[1] ?? null,
    id: positional[2] ?? null,
    options,
  }
}

/**
 * Follow a managed core process and end the whole session when it exits.
 *
 * Terminating from the observer is meant to end the session, not just the
 * server: the console was otherwise left sitting in a menu, still holding the
 * terminal, while the thing it was controlling had gone. Watching for the exit
 * closes the console too, so one action ends one session.
 */
function endSessionWhenCoreExits(child) {
  if (!child || child.exitCode !== null) return
  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    const deliberate = code === 0 || signal === 'SIGTERM'
    process.stdout.write('\n')
    if (deliberate) ui.logger.info('Simulation core stopped. Ending session.')
    else ui.logger.error(new Error(`Simulation core exited unexpectedly (code ${code ?? signal}).`))
    // The core is already gone, so cleanup only has the terminal to restore.
    void cleanup().then(() => process.exit(deliberate ? 0 : 1))
  })
}

/**
 * The same for a core this console did not start.
 *
 * There is no child to watch, so health is polled instead. Several consecutive
 * failures are required: one missed probe during a heavy compile is not a
 * terminated session.
 */
function endSessionWhenExternalCoreStops(port) {
  let misses = 0
  const timer = setInterval(async () => {
    if (shuttingDown) {
      clearInterval(timer)
      return
    }
    const health = await checkDstnsHealth(port)
    misses = health ? 0 : misses + 1
    if (misses < 3) return
    clearInterval(timer)
    process.stdout.write('\n')
    ui.logger.info('Simulation core stopped. Ending session.')
    void cleanup().then(() => process.exit(0))
  }, 1500)
  // Never hold the event loop open on this alone.
  timer.unref?.()
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

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdin.pause()
  process.stdout.write('\x1b[?25h') // restore cursor
}

async function main() {
  const { command, topic, id, options } = parseArgs(process.argv.slice(2))
  if (options['day-type'] && !['weekday','weekend'].includes(options['day-type'])) throw new Error('--day-type must be weekday or weekend')
  if (command === 'seeds') {
    if (!['save','list','inspect','delete'].includes(topic)) throw new Error('Usage: dstns seeds save|list|inspect|delete [ID]')
    const result = seedStore(topic, { id, description: options.description, ...(topic === 'save' ? { config: await runConfig(options) } : {}) })
    console.log(JSON.stringify(result, null, 2)); return 0
  }

  if (options.mode === 'server') {
    await startServer({ replace: true })
    return 0
  }

  if (command === 'start') {
    const started = await launchSimulation(options)
    if (process.stdin.isTTY) await controlSession(started.process, started.port)
    else if (started.process)
      // Non-interactive: follow the core, and report its fate as our own.
      return await new Promise((resolve) =>
        started.process.once('exit', (code, signal) =>
          resolve(code === 0 || signal === 'SIGTERM' ? 0 : 1),
        ),
      )
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
      await openBrowser(`http://127.0.0.1:${await activePort()}/`)
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

  if (command === 'version') {
    process.stdout.write(`DSTNS ${VERSION}\n`)
    for (const line of licenceNotice()) process.stdout.write(`${line}\n`)
    return 0
  }

  if (command === 'license') {
    // Print the licence itself when it ships alongside; otherwise say where it is.
    const licensePath = path.join(ROOT, 'LICENSE')
    if (existsSync(licensePath)) process.stdout.write(readFileSync(licensePath, 'utf8'))
    else process.stdout.write('GNU Affero General Public License v3 or later — https://www.gnu.org/licenses/agpl-3.0.html\n')
    return 0
  }

  if (command && command !== 'console') {
    throw new Error(`Unknown command: ${command}`)
  }

  if (!process.stdin.isTTY) {
    renderHelp()
    return 0
  }

  if (!options.noSplash) {
    await runSplashScreen()
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
