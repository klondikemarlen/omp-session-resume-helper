import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"

import {
  getCurrentBootId,
  getSnapshotDirectory,
  loadRecoverySnapshot,
  migrateLegacySnapshot,
  migrateLegacySnapshots,
  withSnapshotLock,
  writeCustomSnapshot,
  writeSnapshot,
} from "./snapshot-history.js"

const execFileAsync = promisify(execFile)
const DEFAULT_AGENT_DIRECTORY = join(homedir(), ".omp", "agent")

export default function ompSessionResumeHelper(pi) {
  pi.setLabel("OMP Session Resume Helper")
  registerSessionSnapshotRenderer(pi)
  registerSessionCommands(pi)
  registerLifecycleSnapshots(pi)
}

export function registerLifecycleSnapshots(pi, dependencies = {}) {
  const capture = dependencies.capture ?? captureActiveSessions

  pi.on("session_start", async (_event, context) => {
    await persistLifecycleSnapshot(pi, capture, context)
  })
  pi.on("session_shutdown", async (_event, context) => {
    await persistLifecycleSnapshot(pi, capture, context, getContextSessionId(context))
  })
}

export function registerSessionCommands(pi, dependencies = {}) {
  const capture = dependencies.capture ?? captureActiveSessions
  const loadRecovery = dependencies.loadRecovery ?? loadRecoverySnapshot
  const loadSnapshot = dependencies.loadSnapshot ?? readCustomSnapshot
  const homeDirectory = dependencies.homeDirectory ?? homedir()
  const cat = dependencies.cat ?? ((snapshotPath) => pi.exec("cat", [snapshotPath]))

  pi.registerCommand("dump-active-sessions", {
    description: "Save manual OMP resume commands for active sessions",
    handler: async (args, context) => {
      const outputPath = resolveCustomSnapshotPath(args, homeDirectory)
      const snapshot = await capture({ homeDirectory, outputPath })
      const sessionDescription = snapshot.sessionCount === 1 ? "1 active OMP session" : `${snapshot.sessionCount} active OMP sessions`

      context.ui.notify(`Saved ${sessionDescription} to ${snapshot.path}.`, "info")
    },
  })

  pi.registerCommand("show-saved-sessions", {
    description: "Show a saved OMP session snapshot as command output without starting sessions",
    handler: async (args, context) => {
      const outputPath = resolveCustomSnapshotPath(args, homeDirectory)
      const snapshot = outputPath
        ? { commands: await loadSnapshot(outputPath), path: outputPath }
        : await loadRecovery({ homeDirectory })

      if (!snapshot) {
        context.ui.notify("No active-session snapshots exist yet.", "warning")
        return
      }

      if (snapshot.commands.trim() === "") {
        context.ui.notify(`The newest recovery snapshot at ${snapshot.path} has no active OMP sessions.`, "warning")
        return
      }

      const result = await cat(snapshot.path)

      if (result.code !== 0) {
        context.ui.notify(`Could not read saved session snapshot at ${snapshot.path}: ${result.stderr.trim() || `cat exited with ${result.code}.`}`, "error")
        return
      }

      pi.sendMessage({
        content: "",
        customType: "saved-session-snapshot",
        details: { output: result.stdout, path: snapshot.path },
        display: true,
      }, { triggerTurn: false })
    },
  })
}

function registerSessionSnapshotRenderer(pi) {
  pi.registerMessageRenderer("saved-session-snapshot", (message, _options, theme) => {
    const { output, path } = message.details ?? {}

    if (typeof output !== "string" || typeof path !== "string") {
      return undefined
    }

    const container = new pi.pi.Container()
    container.addChild(new pi.pi.Text(`Saved session snapshot: ${path}`, 0, 0))
    container.addChild(new pi.pi.Text(theme.fg("success", `$ cat ${shellQuote(path)}`), 0, 0))
    container.addChild(new pi.pi.Text(output, 0, 0))
    return container
  })
}

export async function captureActiveSessions(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir()
  const historyDirectory = options.historyDirectory ?? getSnapshotDirectory(homeDirectory)
  const bootId = options.bootId ?? await getCurrentBootId(options.bootIdPath)
  const findSessions = options.findSessions ?? findActiveSessions

  return withSnapshotLock(historyDirectory, bootId, async () => {
    await migrateLegacySnapshot({ historyDirectory, homeDirectory })

    await migrateLegacySnapshots(historyDirectory)

    const sessions = await findSessions({ excludeSessionId: options.excludeSessionId })
    const commands = formatResumeCommands(sessions)

    const snapshot = await writeSnapshot(commands, { bootId, historyDirectory })

    if (options.outputPath) {
      await writeCustomSnapshot(options.outputPath, commands)
    }

    return {
      path: options.outputPath ?? snapshot.path,
      sessionCount: sessions.length,
    }
  })
}

export async function findActiveSessions(options = {}) {
  const agentDirectory = options.agentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? DEFAULT_AGENT_DIRECTORY
  const processDirectory = options.processDirectory ?? "/proc"
  const listProcesses = options.listProcesses ?? listProcessesFromSystem
  const processes = await listProcesses()
  const activeProcesses = processes.filter(isInteractiveOmpProcess)

  const sessions = await Promise.all(activeProcesses.map(async (process) => {
    const terminalRecord = join(agentDirectory, "terminal-sessions", process.terminal.replace("/", "-"))

    try {
      const [record, workingDirectory] = await Promise.all([
        readFile(terminalRecord, "utf8"),
        realpath(join(processDirectory, process.pid, "cwd")),
      ])
      const sessionId = getSessionIdFromPath(record.split("\n")[1])

      if (!sessionId || sessionId === options.excludeSessionId) {
        return undefined
      }

      return { workingDirectory, sessionId }
    } catch {
      return undefined
    }
  }))

  return sessions.filter((session) => session !== undefined)
}

export function formatResumeCommands(sessions) {
  if (sessions.length === 0) {
    return ""
  }

  return `${sessions.map(({ workingDirectory, sessionId }) => (
    `cd ${shellQuote(workingDirectory)} && omp --resume ${shellQuote(sessionId)}`
  )).join("\n")}\n`
}

export function resolveCustomSnapshotPath(args, homeDirectory = homedir()) {
  const requestedPath = args.trim()

  if (requestedPath === "") {
    return undefined
  }

  if (requestedPath === "~") {
    return homeDirectory
  }

  if (requestedPath.startsWith("~/")) {
    return join(homeDirectory, requestedPath.slice(2))
  }

  return requestedPath
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function persistLifecycleSnapshot(pi, capture, context, excludeSessionId) {
  try {
    await capture({ excludeSessionId })
  } catch (error) {
    pi.logger?.warn(`Could not save active OMP session history: ${error.message}`)
  }
}

function getContextSessionId(context) {
  const sessionId = context.sessionManager?.getSessionId?.()

  if (typeof sessionId === "string" && sessionId !== "") {
    return sessionId
  }

  return getSessionIdFromPath(context.sessionManager?.sessionFile)
}

function getSessionIdFromPath(sessionFile) {
  const match = sessionFile && basename(sessionFile).match(/_([^_]+)\.jsonl$/)
  return match?.[1]
}

function isInteractiveOmpProcess(process) {
  if (!process.terminal.startsWith("pts/")) {
    return false
  }

  if (/(?:^|\s)__omp_worker_/.test(process.command)) {
    return false
  }

  const executable = process.command.split(/\s+/, 1)[0]
  return executable === "omp" || executable.endsWith("/omp")
}

async function listProcessesFromSystem() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,tty=,args="])

  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/)

    if (!match) {
      return []
    }

    return [{ pid: match[1], terminal: match[2], command: match[3] }]
  })
}

async function readCustomSnapshot(snapshotPath) {
  return readFile(snapshotPath, "utf8")
}
