import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import ompSessionResumeHelper, {
  findActiveSessions,
  formatResumeCommands,
  registerSessionCommands,
  resolveSnapshotPath,
  shellQuote,
} from "./index.js"

test("findActiveSessions exports plain and absolute OMP processes only", async () => {

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-session-resume-helper-"))
  const agentDirectory = join(temporaryDirectory, "agent")
  const processDirectory = join(temporaryDirectory, "proc")
  const workingDirectory = join(temporaryDirectory, "active worktree")
  const sessionId = "019fb989-c2ee-7000-96ea-2a2cce5229b6"

  await mkdir(join(agentDirectory, "terminal-sessions"), { recursive: true })
  await mkdir(join(processDirectory, "100"), { recursive: true })
  await mkdir(join(processDirectory, "103"), { recursive: true })
  await mkdir(workingDirectory)
  await symlink(workingDirectory, join(processDirectory, "100", "cwd"))
  await symlink(workingDirectory, join(processDirectory, "103", "cwd"))
  await writeFile(
    join(agentDirectory, "terminal-sessions", "pts-7"),
    `${workingDirectory}\n/sessions/2026-08-07_${sessionId}.jsonl\n`,
  )
  await writeFile(
    join(agentDirectory, "terminal-sessions", "pts-10"),
    `${workingDirectory}\n/sessions/2026-08-07_019fb981-7adc-7000-a991-935c9a97acea.jsonl\n`,
  )

  const sessions = await findActiveSessions({
    agentDirectory,
    processDirectory,
    listProcesses: async () => [
      { pid: "100", terminal: "pts/7", command: "omp" },
      { pid: "101", terminal: "pts/8", command: "omp __omp_worker_tiny_inference" },
      { pid: "102", terminal: "pts/9", command: "bash" },
      { pid: "103", terminal: "pts/10", command: "/usr/local/bin/omp" },
      { pid: "104", terminal: "?", command: "omp" },
    ],
  })

  assert.deepEqual(sessions, [
    { workingDirectory, sessionId },
    {
      workingDirectory,
      sessionId: "019fb981-7adc-7000-a991-935c9a97acea",
    },
  ])
})

test("resume commands quote paths and session IDs for Bash", () => {
  assert.equal(shellQuote("/worktree/Marlen's project"), "'/worktree/Marlen'\\''s project'")
  assert.equal(
    formatResumeCommands([
      {
        workingDirectory: "/worktree/Marlen's project",
        sessionId: "019fb989-c2ee-7000-96ea-2a2cce5229b6",
      },
    ]),
    "cd '/worktree/Marlen'\\''s project' && omp --resume '019fb989-c2ee-7000-96ea-2a2cce5229b6'\n",
  )
})

test("dump and restore commands save and display commands without launching sessions", async () => {
  const commands = new Map()
  const notifications = []
  const editors = []
  const snapshotPath = "/home/marlen/.local/state/omp-session-resume-helper/active-sessions.txt"
  let savedPath
  let savedSnapshot

  const pi = {
    setLabel() {},
    registerCommand(name, options) {
      commands.set(name, options)
    },
  }
  const context = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type })
      },
      async editor(title, contents) {
        editors.push({ title, contents })
      },
    },
  }

  registerSessionCommands(pi, {
    homeDirectory: "/home/marlen",
    findSessions: async () => [
      {
        workingDirectory: "/worktree/project",
        sessionId: "019fb989-c2ee-7000-96ea-2a2cce5229b6",
      },
    ],
    saveSnapshot: async (path, snapshot) => {
      savedPath = path
      savedSnapshot = snapshot
    },
    loadSnapshot: async (path) => {
      assert.equal(path, snapshotPath)
      return savedSnapshot
    },
  })

  await commands.get("dump-active-sessions").handler("", context)
  await commands.get("restore-active-sessions").handler("", context)

  assert.equal(savedPath, snapshotPath)
  assert.equal(savedSnapshot, "cd '/worktree/project' && omp --resume '019fb989-c2ee-7000-96ea-2a2cce5229b6'\n")
  assert.deepEqual(notifications, [{
    message: `Saved 1 active OMP session to ${snapshotPath}.`,
    type: "info",
  }])
  assert.deepEqual(editors, [{
    title: "Resume Active OMP Sessions — Copy Commands Manually",
    contents: savedSnapshot,
  }])
})

test("restore reports a missing snapshot instead of starting a session", async () => {
  const commands = new Map()
  const notifications = []

  ompSessionResumeHelper({
    setLabel() {},
    registerCommand(name, options) {
      commands.set(name, options)
    },
  })

  const context = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type })
      },
      async editor() {
        assert.fail("missing snapshots must not open an editor")
      },
    },
  }

  await commands.get("restore-active-sessions").handler("/missing-snapshot", context)

  assert.deepEqual(notifications, [{
    message: "No active-session snapshot exists at /missing-snapshot.",
    type: "warning",
  }])
})

test("snapshot paths use the home-state directory by default", () => {
  assert.equal(
    resolveSnapshotPath("", "/home/marlen"),
    "/home/marlen/.local/state/omp-session-resume-helper/active-sessions.txt",
  )
  assert.equal(resolveSnapshotPath("~/resume.txt", "/home/marlen"), "/home/marlen/resume.txt")
})
