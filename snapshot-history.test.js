import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  listSnapshots,
  loadRecoverySnapshot,
  migrateLegacySnapshot,
  pruneSnapshots,
  withSnapshotLock,
  writeSnapshot,
} from "./snapshot-history.js"

test("restore selects the newest snapshot from a prior boot", async (testContext) => {
  const historyDirectory = await createHistoryDirectory(testContext)
  const priorBootId = "prior-boot"
  const currentBootId = "current-boot"

  await writeSnapshot("old commands\n", {
    bootId: priorBootId,
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
    historyDirectory,
    snapshotId: "old",
  })
  await writeSnapshot("new commands\n", {
    bootId: priorBootId,
    createdAt: new Date("2026-08-07T11:00:00.000Z"),
    historyDirectory,
    snapshotId: "new",
  })
  await writeSnapshot("current commands\n", {
    bootId: currentBootId,
    createdAt: new Date("2026-08-07T12:00:00.000Z"),
    historyDirectory,
    snapshotId: "current",
  })

  const snapshot = await loadRecoverySnapshot({ bootId: currentBootId, historyDirectory })

  assert.equal(snapshot.commands, "new commands\n")
  assert.equal(snapshot.bootId, priorBootId)
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
  assert.equal(snapshots.at(-1).fileName.includes("_001.txt"), true)
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

  assert.deepEqual(files, ["2026-08-07T10:00:00.000Z_boot_snapshot.txt"])
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
