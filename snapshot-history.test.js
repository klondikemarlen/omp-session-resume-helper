import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  listSnapshots,
  loadRecoverySnapshot,
  migrateLegacySnapshot,
  migrateLegacySnapshots,
  pruneSnapshots,
  withSnapshotLock,
  writeSnapshot,
} from "./snapshot-history.js"

test("restore selects the newest timestamp snapshot from a prior boot", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)

  await writeSnapshot("old commands\n", {
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
    historyDirectory,
  })
  await writeSnapshot("new commands\n", {
    createdAt: new Date("2026-08-07T11:00:00.000Z"),
    historyDirectory,
  })
  await writeSnapshot("current commands\n", {
    createdAt: new Date("2026-08-07T12:00:00.000Z"),
    historyDirectory,
  })
  await writeSnapshot("", {
    createdAt: new Date("2026-08-07T11:15:00.000Z"),
    historyDirectory,
  })

  const snapshot = await loadRecoverySnapshot({
    bootId: "current-boot",
    bootStartedAt: new Date("2026-08-07T11:30:00.000Z"),
    historyDirectory,
  })

  assert.equal(snapshot.commands, "new commands\n")
})

test("pruning keeps the newest 100 expired snapshots", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const firstSnapshotTime = new Date("2026-06-01T00:00:00.000Z")

  for (let index = 0; index < 101; index += 1) {
    await writeSnapshot(`snapshot ${index}\n`, {
      bootId: "prior-boot",
      createdAt: new Date(firstSnapshotTime.getTime() + index * 1000),
      historyDirectory,
      snapshotId: String(index).padStart(3, "0"),
    })
  }

  await pruneSnapshots(historyDirectory, { now: new Date("2026-08-07T00:00:00.000Z") })
  const snapshots = await listSnapshots(historyDirectory)

  assert.equal(snapshots.length, 100)
  assert.equal(snapshots.at(-1).fileName, "2026-06-01T00:00:01.000Z.txt")
})

test("snapshot writes leave only complete files", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)

  await writeSnapshot("resume command\n", {
    bootId: "boot",
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
    historyDirectory,
    snapshotId: "snapshot",
  })

  const files = await readdir(historyDirectory)

  assert.deepEqual(files, ["2026-08-07T10:00:00.000Z.txt"])
})

test("restore reads legacy UUID-named snapshots", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const priorSnapshot = join(historyDirectory, "2026-08-07T10:00:00.000Z_prior-boot_snapshot.txt")
  const currentSnapshot = join(historyDirectory, "2026-08-07T12:00:00.000Z_current-boot_snapshot.txt")

  await mkdir(historyDirectory)

  await Promise.all([
    writeFile(priorSnapshot, "prior commands\n"),
    writeFile(currentSnapshot, "current commands\n"),
  ])

  const snapshot = await loadRecoverySnapshot({
    bootId: "current-boot",
    bootStartedAt: new Date("2026-08-07T11:30:00.000Z"),
    historyDirectory,
  })

  assert.equal(snapshot.commands, "prior commands\n")
})

test("migration renames UUID snapshots without changing commands", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const legacySnapshot = join(historyDirectory, "2026-08-07T10:00:00.000Z_prior-boot_snapshot.txt")

  await mkdir(historyDirectory)
  await writeFile(legacySnapshot, "resume command\n")
  await migrateLegacySnapshots(historyDirectory)

  const snapshotPath = join(historyDirectory, "2026-08-07T10:00:00.000Z.txt")

  assert.deepEqual(await readdir(historyDirectory), ["2026-08-07T10:00:00.000Z.txt"])
  assert.equal(await readFile(snapshotPath, "utf8"), "resume command\n")
})

test("restore returns an empty snapshot only when no commands exist", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)

  await writeSnapshot("", {
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
    historyDirectory,
  })

  const snapshot = await loadRecoverySnapshot({
    bootId: "current-boot",
    bootStartedAt: new Date("2026-08-07T11:00:00.000Z"),
    historyDirectory,
  })

  assert.equal(snapshot.commands, "")
})

test("snapshot locks serialize concurrent captures", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const order = []
  let releaseFirstCapture
  const firstCaptureReleased = new Promise((resolve) => {
    releaseFirstCapture = resolve
  })

  const firstCapture = withSnapshotLock(historyDirectory, "boot", async () => {
    order.push("first started")
    await firstCaptureReleased
    order.push("first finished")
  })
  await waitFor(() => order.length === 1)

  const secondCapture = withSnapshotLock(historyDirectory, "boot", async () => {
    order.push("second started")
  })

  releaseFirstCapture()
  await Promise.all([firstCapture, secondCapture])

  assert.deepEqual(order, ["first started", "first finished", "second started"])
})

test("the original single snapshot migrates into history once", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const legacySnapshotPath = join(historyDirectory, "..", "active-sessions.txt")
  const legacyCommands = "cd '/worktree' && omp --resume 'session'\n"

  await writeFile(legacySnapshotPath, legacyCommands)

  const migratedSnapshot = await migrateLegacySnapshot({ historyDirectory, legacySnapshotPath })
  const duplicateMigration = await migrateLegacySnapshot({ historyDirectory, legacySnapshotPath })

  assert.equal((await listSnapshots(historyDirectory)).length, 1)
  assert.equal(migratedSnapshot.bootId, "legacy")
  assert.equal(duplicateMigration, undefined)
})

async function createHistoryDirectory(testContext) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-session-resume-helper-"))
  testContext.after(() => rm(temporaryDirectory, { force: true, recursive: true }))
  return join(temporaryDirectory, "snapshots")
}


async function waitFor(condition) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error("Timed out waiting for the first snapshot capture.")
}
