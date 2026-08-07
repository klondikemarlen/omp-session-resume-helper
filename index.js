import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const DEFAULT_AGENT_DIRECTORY = join(homedir(), ".omp", "agent")

export default function ompSessionResumeHelper(pi) {
  pi.setLabel("OMP Session Resume Helper")
  registerSessionCommands(pi)
}

export function registerSessionCommands(pi, dependencies = {}) {
  const findSessions = dependencies.findSessions ?? findActiveSessions
  const saveSnapshot = dependencies.saveSnapshot ?? writeSnapshot
  const loadSnapshot = dependencies.loadSnapshot ?? readSnapshot
  const homeDirectory = dependencies.homeDirectory ?? homedir()

  pi.registerCommand("dump-active-sessions", {
    description: "Save manual OMP resume commands for active sessions",
    handler: async (args, context) => {
      const snapshotPath = resolveSnapshotPath(args, homeDirectory)
      const sessions = await findSessions()

      if (sessions.length === 0) {
        context.ui.notify("No active OMP sessions found; the existing snapshot was not changed.", "warning")
        return
      }

      await saveSnapshot(snapshotPath, formatResumeCommands(sessions))
      context.ui.notify(`Saved ${sessions.length} active OMP session${sessions.length === 1 ? "" : "s"} to ${snapshotPath}.`, "info")
    },
  })

  pi.registerCommand("restore-active-sessions", {
    description: "Show saved OMP resume commands without starting sessions",
    handler: async (args, context) => {
      const snapshotPath = resolveSnapshotPath(args, homeDirectory)

      let snapshot
      try {
        snapshot = await loadSnapshot(snapshotPath)
      } catch (error) {
        if (error?.code === "ENOENT") {
          context.ui.notify(`No active-session snapshot exists at ${snapshotPath}.`, "warning")
          return
        }

        throw error
      }

      if (snapshot.trim() === "") {
        context.ui.notify(`The active-session snapshot at ${snapshotPath} is empty.`, "warning")
        return
      }

      await context.ui.editor("Resume Active OMP Sessions — Copy Commands Manually", snapshot)
    },
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
      const sessionId = getSessionId(record)

      if (!sessionId) {
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
  )).join("\n\n")}\n`
}

export function resolveSnapshotPath(args, homeDirectory = homedir()) {
  const requestedPath = args.trim()

  if (requestedPath === "") {
    return join(homeDirectory, ".local", "state", "omp-session-resume-helper", "active-sessions.txt")
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

function getSessionId(terminalRecord) {
  const sessionFile = terminalRecord.split("\n")[1]
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

async function writeSnapshot(snapshotPath, snapshot) {
  await mkdir(dirname(snapshotPath), { recursive: true })
  await writeFile(snapshotPath, snapshot, { encoding: "utf8", mode: 0o600 })
}

async function readSnapshot(snapshotPath) {
  return readFile(snapshotPath, "utf8")
}
