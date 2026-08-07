import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import ompSessionResumeHelper, {
  captureActiveSessions,
  findActiveSessions,
  formatResumeCommands,
  registerLifecycleSnapshots,
  registerSessionCommands,
  resolveCustomSnapshotPath,
  shellQuote,
} from "./index.js"
import { listSnapshots } from "./snapshot-history.js"

test("findActiveSessions exports plain and absolute OMP processes only", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-session-resume-helper-"))
  testContext.after(() => rm(temporaryDirectory, { force: true, recursive: true }))
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

test("normal shutdown excludes the stopping OMP session", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-session-resume-helper-"))
  testContext.after(() => rm(temporaryDirectory, { force: true, recursive: true }))
  const agentDirectory = join(temporaryDirectory, "agent")
  const processDirectory = join(temporaryDirectory, "proc")
  const workingDirectory = join(temporaryDirectory, "worktree")
  const stoppingSessionId = "019fb989-c2ee-7000-96ea-2a2cce5229b6"

  await mkdir(join(agentDirectory, "terminal-sessions"), { recursive: true })
  await mkdir(join(processDirectory, "100"), { recursive: true })
  await mkdir(workingDirectory)
  await symlink(workingDirectory, join(processDirectory, "100", "cwd"))
  await writeFile(
    join(agentDirectory, "terminal-sessions", "pts-7"),
    `${workingDirectory}\n/sessions/2026-08-07_${stoppingSessionId}.jsonl\n`,
  )

  const sessions = await findActiveSessions({
    agentDirectory,
    excludeSessionId: stoppingSessionId,
    processDirectory,
    listProcesses: async () => [{ pid: "100", terminal: "pts/7", command: "omp" }],
  })

  assert.deepEqual(sessions, [])
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

test("resume commands use adjacent lines", () => {
  assert.equal(
    formatResumeCommands([
      { workingDirectory: "/worktree/one", sessionId: "one" },
      { workingDirectory: "/worktree/two", sessionId: "two" },
    ]),
    "cd '/worktree/one' && omp --resume 'one'\ncd '/worktree/two' && omp --resume 'two'\n",
  )
})

test("dump and show commands keep automatic snapshots manual to use", async () => {
  const commands = new Map()
  const notifications = []
  const captures = []
  const recoveryPath = "/home/marlen/.local/state/omp-session-resume-helper/snapshots/recovery.txt"
  const recoveryCommands = "cd '/worktree/project' && omp --resume '019fb989-c2ee-7000-96ea-2a2cce5229b6'\n"

  const pi = createPi(commands)
  const context = createContext(notifications)

  registerSessionCommands(pi, {
    capture: async (options) => {
      captures.push(options)
      return { path: recoveryPath, sessionCount: 1 }
    },
    homeDirectory: "/home/marlen",
    loadRecovery: async () => ({ commands: recoveryCommands, path: recoveryPath }),
  })

  await commands.get("dump-active-sessions").handler("", context)
  await commands.get("show-saved-sessions").handler("", context)

  assert.deepEqual(captures, [{ homeDirectory: "/home/marlen", outputPath: undefined }])
  assert.deepEqual(notifications, [
    {
      message: `Saved 1 active OMP session to ${recoveryPath}.`,
      type: "info",
    },
    {
      message: recoveryCommands,
      type: "info",
    },
  ])
})

test("custom dump and show paths stay supported", async () => {
  const commands = new Map()
  const captures = []
  const loadedPaths = []
  const customPath = "/home/marlen/resume commands.txt"
  const pi = createPi(commands)
  const context = createContext([])

  registerSessionCommands(pi, {
    capture: async (options) => {
      captures.push(options)
      return { path: customPath, sessionCount: 0 }
    },
    homeDirectory: "/home/marlen",
    loadSnapshot: async (path) => {
      loadedPaths.push(path)
      return "resume command\n"
    },
  })

  await commands.get("dump-active-sessions").handler("~/resume commands.txt", context)
  await commands.get("show-saved-sessions").handler("~/resume commands.txt", context)

  assert.deepEqual(captures, [{ homeDirectory: "/home/marlen", outputPath: customPath }])
  assert.deepEqual(loadedPaths, [customPath])
})

test("custom dumps also preserve an automatic history snapshot", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-session-resume-helper-"))
  testContext.after(() => rm(temporaryDirectory, { force: true, recursive: true }))
  const historyDirectory = join(temporaryDirectory, "snapshots")
  const customPath = join(temporaryDirectory, "resume-commands.txt")

  await captureActiveSessions({
    bootId: "current-boot",
    homeDirectory: temporaryDirectory,
    findSessions: async () => [{
      workingDirectory: "/worktree/project",
      sessionId: "019fb989-c2ee-7000-96ea-2a2cce5229b6",
    }],
    historyDirectory,
    outputPath: customPath,
  })

  const history = await listSnapshots(historyDirectory)

  assert.equal(history.length, 1)
  assert.equal(
    await readFile(customPath, "utf8"),
    "cd '/worktree/project' && omp --resume '019fb989-c2ee-7000-96ea-2a2cce5229b6'\n",
  )
})

test("lifecycle snapshots run at startup and process shutdown", async () => {
  const commands = new Map()
  const handlers = new Map()
  const captures = []
  const pi = createPi(commands, handlers)

  registerLifecycleSnapshots(pi, {
    capture: async (options) => {
      captures.push(options)
    },
  })

  const context = {
    sessionManager: {
      getSessionId() {
        return "019fb989-c2ee-7000-96ea-2a2cce5229b6"
      },
    },
  }
  await handlers.get("session_start")({}, context)
  await handlers.get("session_shutdown")({}, context)

  assert.equal(handlers.has("session_stop"), false)
  assert.deepEqual(captures, [
    { excludeSessionId: undefined },
    { excludeSessionId: "019fb989-c2ee-7000-96ea-2a2cce5229b6" },
  ])
})

test("the plugin registers commands and lifecycle snapshots", () => {
  const commands = new Map()
  const handlers = new Map()

  ompSessionResumeHelper(createPi(commands, handlers))

  assert.deepEqual([...commands.keys()].sort(), ["dump-active-sessions", "show-saved-sessions"])
  assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"])
})

test("custom snapshot paths expand the home directory", () => {
  assert.equal(resolveCustomSnapshotPath("", "/home/marlen"), undefined)
  assert.equal(resolveCustomSnapshotPath("~/resume.txt", "/home/marlen"), "/home/marlen/resume.txt")
})

function createPi(commands, handlers = new Map()) {
  return {
    logger: {
      warn() {},
    },
    on(name, handler) {
      handlers.set(name, handler)
    },
    registerCommand(name, options) {
      commands.set(name, options)
    },
    setLabel() {},
  }
}

function createContext(notifications) {
  return {
    ui: {
      notify(message, type) {
        notifications.push({ message, type })
      },
    },
  }
}
