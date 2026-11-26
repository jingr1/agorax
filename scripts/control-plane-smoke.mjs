import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ControlPlaneStateStore } from '../src/server/control-plane-state.ts'

const root = mkdtempSync(join(tmpdir(), 'agorax-control-smoke-'))
const envFile = join(root, '.env')
writeFileSync(envFile, '# Isolated control-plane smoke environment\n')
const hermesHome = join(root, 'hermes')
mkdirSync(hermesHome, { recursive: true })
const dbPath = join(hermesHome, 'collab.db')
const store = new ControlPlaneStateStore(dbPath)
const intent = { epoch: 7, holds: { developer: { at: 123, byMessageId: 'human-stop' } } }
store.write('room-runner', 'fixture-room', intent)
const lease = store.claim({ namespace: 'dispatch', key: 'fixture-assignment', groupId: 'fixture-mission', owner: 'previous-instance', globalLimit: 10, groupLimit: 10, ttlMs: 1, now: Date.now() - 60000 })
assert(lease)
let child

async function start() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  child = spawn(process.execPath, ['server-entry.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AGORAX_ENV_FILE: envFile, HOST: '127.0.0.1', PORT: String(port),
      HERMES_HOME: hermesHome,
      AGORAX_MISSION_SQLITE_SOT: '1', HERMES_PASSWORD: '', CLAUDE_PASSWORD: '',
      HERMES_API_URL: 'http://127.0.0.1:9', HERMES_GATEWAY_POOL: 'off',
      AGORAX_MANAGED_AGENT_URL: 'http://127.0.0.1:9', AGORAX_AUTO_START_AGENT: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 15000)
    child.stderr.on('data', (data) => { logs += String(data) })
    child.stdout.on('data', (data) => {
      logs += String(data)
      if (logs.includes('Agorax running at')) { clearTimeout(timer); resolve() }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Startup exit ${code}: ${logs}`)) })
  })
  const response = await fetch(`http://127.0.0.1:${port}/api/missions`, { signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).missions, [])
  return port
}

async function stop() {
  const exiting = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child?.kill('SIGKILL'), 10000)
  try {
    const [code] = await exiting
    assert.equal(code, 0)
  } finally { clearTimeout(timer); child = undefined }
}

try {
  await start()
  await stop()
  assert.deepEqual(store.read('room-runner', 'fixture-room'), intent)
  assert.equal(store.leases('dispatch')[0]?.token, lease.token)
  await start()
  await stop()
  assert.deepEqual(store.read('room-runner', 'fixture-room'), intent)
  assert.equal(store.leases('dispatch').length, 1)
  assert.equal(store.leases('dispatch')[0]?.token, lease.token)
  console.log('Control-plane smoke: HTTP ready, graceful stop, restart preserved stop intent and unresolved execution without redispatch')
} finally {
  if (child) { const exiting = once(child, 'exit'); child.kill('SIGKILL'); await exiting }
  rmSync(root, { recursive: true, force: true })
}