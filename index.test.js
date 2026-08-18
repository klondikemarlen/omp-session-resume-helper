import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import ompSessionResumeHelper, {
  canRestoreWithPtyxis,
  captureActiveSessions,
  findActiveSessions,
  formatPtyxisRestorePlan,
  formatResumeCommands,
  parseResumeCommands,
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
    cat: async (path) => ({ code: 0, stderr: "", stdout: `${path}\n${recoveryCommands}` }),
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
  ])
  assert.deepEqual(pi.sentMessages, [{
    message: {
      content: "",
      customType: "saved-session-snapshot",
      details: { output: `${recoveryPath}\n${recoveryCommands}`, path: recoveryPath },
      display: true,
    },
    options: { triggerTurn: false },
  }])
})

test("custom dump and show paths stay supported", async () => {
  const commands = new Map()
  const captures = []
  const loadedPaths = []
  const customPath = "/home/marlen/resume commands.txt"
  const notifications = []
  const pi = createPi(commands)
  const context = createContext(notifications)

  registerSessionCommands(pi, {
    capture: async (options) => {
      captures.push(options)
      return { path: customPath, sessionCount: 0 }
    },
    cat: async () => ({ code: 0, stderr: "", stdout: "resume command\n" }),
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

  assert.deepEqual(notifications, [
    {
      message: `Saved 0 active OMP sessions to ${customPath}.`,
      type: "info",
    },
  ])
  assert.deepEqual(pi.sentMessages, [{
    message: {
      content: "",
      customType: "saved-session-snapshot",
      details: { output: "resume command\n", path: customPath },
      display: true,
    },
    options: { triggerTurn: false },
  }])
})

test("showing a saved session reports cat failures", async () => {
  const commands = new Map()
  const notifications = []
  const pi = createPi(commands)
  const snapshotPath = "/home/marlen/.local/state/omp-session-resume-helper/snapshots/recovery.txt"

  registerSessionCommands(pi, {
    cat: async () => ({ code: 1, stderr: "Permission denied\n", stdout: "" }),
    loadRecovery: async () => ({ commands: "resume command\n", path: snapshotPath }),
  })

  await commands.get("show-saved-sessions").handler("", createContext(notifications))

  assert.deepEqual(notifications, [{
    message: `Could not read saved session snapshot at ${snapshotPath}: Permission denied`,
    type: "error",
  }])
  assert.deepEqual(pi.sentMessages, [])
})

test("restore falls back to the portable snapshot when Ptyxis is unavailable", async () => {
  const commands = new Map()
  const notifications = []
  const pi = createPi(commands)
  const recoveryPath = "/home/marlen/.local/state/omp-session-resume-helper/snapshots/recovery.txt"
  const recoveryCommands = "cd '/worktree/project' && omp --resume 'session'\n"

  registerSessionCommands(pi, {
    canRestore: async () => false,
    cat: async () => ({ code: 0, stderr: "", stdout: recoveryCommands }),
    loadRecovery: async () => ({ commands: recoveryCommands, path: recoveryPath }),
    launch: async () => assert.fail("unavailable Ptyxis must not launch"),
  })

  const context = createContext(notifications)
  await commands.get("restore-saved-sessions").handler("", context)

  assert.equal(context.confirmations.length, 0)
  assert.deepEqual(notifications, [])
  assert.equal(pi.sentMessages.length, 1)
})

test("restore previews and launches each valid saved session in a Ptyxis window", async () => {
  const commands = new Map()
  const notifications = []
  const pi = createPi(commands)
  const recoveryPath = "/home/marlen/.local/state/omp-session-resume-helper/snapshots/recovery.txt"
  const recoveryCommands = [
    "cd '/worktree/one' && omp --resume 'first'",
    "cd '/worktree/Marlen'\\''s project' && omp --resume 'second'",
    "",
  ].join("\n")

  registerSessionCommands(pi, {
    canRestore: async () => true,
    cat: async () => ({ code: 0, stderr: "", stdout: recoveryCommands }),
    loadRecovery: async () => ({ commands: recoveryCommands, path: recoveryPath }),
    resolveDirectory: async (directory) => directory,
    ompExecutable: "/opt/omp/bin/omp",
  })

  const context = createContext(notifications)
  await commands.get("restore-saved-sessions").handler("", context)

  assert.deepEqual(context.confirmations, [{
    message: "Ptyxis will open one new window per session:\n- /worktree/one: '/opt/omp/bin/omp' --resume 'first'\n- /worktree/Marlen's project: '/opt/omp/bin/omp' --resume 'second'",
    title: "Restore saved OMP sessions in Ptyxis?",
  }])
  assert.deepEqual(pi.execCalls, [
    {
      args: ["--new-window", "--working-directory", "/worktree/one", "--", "/opt/omp/bin/omp", "--resume", "first"],
      command: "ptyxis",
    },
    {
      args: ["--new-window", "--working-directory", "/worktree/Marlen's project", "--", "/opt/omp/bin/omp", "--resume", "second"],
      command: "ptyxis",
    },
  ])
  assert.deepEqual(notifications, [{
    message: "Opened 2 saved OMP sessions in Ptyxis.",
    type: "info",
  }])
})

test("restore does not launch unrecognized snapshot commands", async () => {
  const commands = new Map()
  const notifications = []
  const pi = createPi(commands)

  registerSessionCommands(pi, {
    canRestore: async () => true,
    cat: async () => ({ code: 0, stderr: "", stdout: "echo unrecognized\n" }),
    launch: async () => assert.fail("unrecognized commands must not launch"),
    loadRecovery: async () => ({ commands: "echo unrecognized\n", path: "/resume.txt" }),
  })

  const context = createContext(notifications)
  await commands.get("restore-saved-sessions").handler("", context)

  assert.equal(context.confirmations.length, 0)
  assert.equal(pi.sentMessages.length, 1)
  assert.deepEqual(notifications, [{
    message: "This snapshot contains commands that cannot be safely restored automatically. Copy its displayed commands into terminals instead.",
    type: "warning",
  }])
})

test("restore reports stale working directories and failed Ptyxis launches", async () => {
  const commands = new Map()
  const notifications = []
  const pi = createPi(commands)
  const recoveryCommands = [
    "cd '/missing' && omp --resume 'missing'",
    "cd '/available' && omp --resume 'failed'",
    "",
  ].join("\n")

  registerSessionCommands(pi, {
    canRestore: async () => true,
    cat: async () => ({ code: 0, stderr: "", stdout: recoveryCommands }),
    launch: async () => ({ code: 1 }),
    loadRecovery: async () => ({ commands: recoveryCommands, path: "/resume.txt" }),
    resolveDirectory: async (directory) => {
      if (directory === "/missing") throw new Error("missing")
      return directory
    },
  })

  await commands.get("restore-saved-sessions").handler("", createContext(notifications))

  assert.deepEqual(notifications, [
    {
      message: "Skipped 1 saved session with missing working directory.",
      type: "warning",
    },
    {
      message: "Opened 0 saved OMP sessions; 1 Ptyxis launch failed.",
      type: "error",
    },
  ])
})

test("Ptyxis recovery requires a Linux graphical session and available Ptyxis", async () => {
  let calls = 0
  const execute = async () => {
    calls += 1
    return { code: 0 }
  }

  assert.equal(await canRestoreWithPtyxis({ environment: { DISPLAY: ":0" }, execute, platform: "darwin" }), false)
  assert.equal(await canRestoreWithPtyxis({ environment: {}, execute, platform: "linux" }), false)
  assert.equal(await canRestoreWithPtyxis({ environment: { WAYLAND_DISPLAY: "wayland-0" }, execute, platform: "linux" }), true)
  assert.equal(calls, 1)
})

test("resume command parsing preserves shell-quoted values", () => {
  const commands = "cd '/worktree/Marlen'\\''s project' && omp --resume 'session'\n"

  assert.deepEqual(parseResumeCommands(commands), [{
    workingDirectory: "/worktree/Marlen's project",
    sessionId: "session",
  }])
  assert.equal(parseResumeCommands("echo unsafe\n"), undefined)
  assert.equal(
    formatPtyxisRestorePlan([{ workingDirectory: "/worktree/project", sessionId: "session" }], "/opt/omp/bin/omp"),
    "Ptyxis will open one new window per session:\n- /worktree/project: '/opt/omp/bin/omp' --resume 'session'",
  )
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

  assert.deepEqual([...commands.keys()].sort(), ["dump-active-sessions", "restore-saved-sessions", "show-saved-sessions"])
  assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"])
})

test("the snapshot renderer labels Bash output without adding prompt content", () => {
  const pi = createPi(new Map())
  const snapshotPath = "/home/marlen/resume commands.txt"

  ompSessionResumeHelper(pi)

  const rendered = pi.messageRenderers.get("saved-session-snapshot")({
    content: "",
    details: { output: "resume command\n", path: snapshotPath },
  }, {}, {
    fg(_color, text) {
      return text
    },
  })

  assert.deepEqual(rendered.children.map((child) => child.text), [
    `Saved session snapshot: ${snapshotPath}`,
    `$ cat '${snapshotPath}'`,
    "resume command\n",
  ])
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
    messageRenderers: new Map(),
    on(name, handler) {
      handlers.set(name, handler)
    },
    pi: {
      Container: class {
        children = []

        addChild(child) {
          this.children.push(child)
        }
      },
      Text: class {
        constructor(text) {
          this.text = text
        }
      },
    },
    execCalls: [],
    async exec(command, args) {
      this.execCalls.push({ args, command })
      return { code: 0, stderr: "", stdout: "" }
    },
    registerCommand(name, options) {
      commands.set(name, options)
    },
    registerMessageRenderer(name, renderer) {
      this.messageRenderers.set(name, renderer)
    },
    sentMessages: [],
    sendMessage(message, options) {
      this.sentMessages.push({ message, options })
    },
    setLabel() {},
  }
}

function createContext(notifications, confirmed = true) {
  const confirmations = []

  return {
    confirmations,
    ui: {
      async confirm(title, message) {
        confirmations.push({ message, title })
        return confirmed
      },
      notify(message, type) {
        notifications.push({ message, type })
      },
    },
  }
}
