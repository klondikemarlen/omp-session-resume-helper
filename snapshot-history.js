import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const MIN_SNAPSHOTS_TO_KEEP = 100

const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 30_000

export function getSnapshotDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, ".local", "state", "omp-session-resume-helper", "snapshots")
}

export function getLegacySnapshotPath(homeDirectory = homedir()) {
  return join(homeDirectory, ".local", "state", "omp-session-resume-helper", "active-sessions.txt")
}

export async function getCurrentBootId(bootIdPath = "/proc/sys/kernel/random/boot_id") {
  return (await readFile(bootIdPath, "utf8")).trim()
}

export async function withSnapshotLock(historyDirectory, bootId, operation) {
  await mkdir(historyDirectory, { recursive: true })

  const lockDirectory = join(historyDirectory, ".lock")
  await acquireLock(lockDirectory, bootId)

  try {
    return await operation()
  } finally {
    await rm(lockDirectory, { force: true, recursive: true })
  }
}

export async function writeSnapshot(commands, options = {}) {
  const historyDirectory = options.historyDirectory ?? getSnapshotDirectory(options.homeDirectory)
  const bootId = options.bootId ?? await getCurrentBootId(options.bootIdPath)
  const createdAt = options.createdAt ?? new Date()
  const snapshotId = options.snapshotId ?? randomUUID()
  const fileName = `${createdAt.toISOString()}_${bootId}_${snapshotId}.txt`
  const snapshotPath = join(historyDirectory, fileName)

  await writeFileAtomically(snapshotPath, commands, snapshotId)
  await pruneSnapshots(historyDirectory, { now: createdAt })

  return { bootId, createdAt, path: snapshotPath }
}

export async function writeCustomSnapshot(snapshotPath, commands, snapshotId = randomUUID()) {
  await writeFileAtomically(snapshotPath, commands, snapshotId)
  return snapshotPath
}

export async function loadRecoverySnapshot(options = {}) {
  const historyDirectory = options.historyDirectory ?? getSnapshotDirectory(options.homeDirectory)
  const bootId = options.bootId ?? await getCurrentBootId(options.bootIdPath)
  const snapshots = await listSnapshots(historyDirectory)
  const priorBootSnapshots = snapshots.filter((snapshot) => snapshot.bootId !== bootId)
  const selectedSnapshot = priorBootSnapshots[0] ?? snapshots[0]

  if (!selectedSnapshot) {
    return undefined
  }

  return {
    ...selectedSnapshot,
    commands: await readFile(selectedSnapshot.path, "utf8"),
  }
}

export async function migrateLegacySnapshot(options = {}) {
  const historyDirectory = options.historyDirectory ?? getSnapshotDirectory(options.homeDirectory)
  const legacySnapshotPath = options.legacySnapshotPath ?? getLegacySnapshotPath(options.homeDirectory)

  if ((await listSnapshots(historyDirectory)).length > 0) {
    return undefined
  }

  try {
    const [commands, legacyStats] = await Promise.all([
      readFile(legacySnapshotPath, "utf8"),
      stat(legacySnapshotPath),
    ])

    return writeSnapshot(commands, {
      historyDirectory,
      bootId: "legacy",
      createdAt: legacyStats.mtime,
    })
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined
    }

    throw error
  }
}

export async function pruneSnapshots(historyDirectory, options = {}) {
  const now = options.now ?? new Date()
  const cutoffTime = now.getTime() - MAX_SNAPSHOT_AGE_MS
  const snapshots = await listSnapshots(historyDirectory)
  const snapshotsToRemove = snapshots.slice(MIN_SNAPSHOTS_TO_KEEP).filter((snapshot) => (
    snapshot.createdAt.getTime() < cutoffTime
  ))

  await Promise.all(snapshotsToRemove.map(({ path }) => rm(path, { force: true })))
}

export async function listSnapshots(historyDirectory) {
  let entries

  try {
    entries = await readdir(historyDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") {
      return []
    }

    throw error
  }

  return entries.flatMap((entry) => {
    if (!entry.isFile()) {
      return []
    }

    const snapshot = parseSnapshotFileName(entry.name)
    return snapshot ? [{ ...snapshot, path: join(historyDirectory, entry.name) }] : []
  }).sort(compareSnapshotsNewestFirst)
}

export function parseSnapshotFileName(fileName) {
  const match = fileName.match(/^([^_]+)_([^_]+)_([^_]+)\.txt$/)

  if (!match) {
    return undefined
  }

  const createdAt = new Date(match[1])
  if (Number.isNaN(createdAt.getTime())) {
    return undefined
  }

  return { bootId: match[2], createdAt, fileName }
}

async function acquireLock(lockDirectory, bootId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockDirectory)
      await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({ bootId, pid: process.pid }))
      return
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error
      }
    }

    if (
      await lockBelongsToAnotherBoot(lockDirectory, bootId)
      || await lockOwnerIsNotRunning(lockDirectory)
      || await isStaleLock(lockDirectory)
    ) {
      await rm(lockDirectory, { force: true, recursive: true })
      continue
    }

    await delay(LOCK_RETRY_MS)
  }

  throw new Error(`Timed out waiting for the snapshot lock at ${lockDirectory}.`)
}

async function lockBelongsToAnotherBoot(lockDirectory, bootId) {
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"))
    return owner.bootId !== bootId
  } catch {
    return false
  }
}

async function lockOwnerIsNotRunning(lockDirectory) {
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"))

    if (!Number.isInteger(owner.pid)) {
      return false
    }

    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error?.code === "ESRCH"
  }
}

async function isStaleLock(lockDirectory) {
  try {
    const lockStats = await stat(lockDirectory)
    return Date.now() - lockStats.mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

async function writeFileAtomically(path, contents, snapshotId) {
  await mkdir(dirname(path), { recursive: true })

  const temporaryPath = join(dirname(path), `.${snapshotId}.tmp`)
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 })
  await rename(temporaryPath, path)
}

function compareSnapshotsNewestFirst(left, right) {
  return right.createdAt.getTime() - left.createdAt.getTime() || right.fileName.localeCompare(left.fileName)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
