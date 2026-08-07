# OMP Session Resume Helper

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin for manually recovering OMP sessions after a laptop restart or crash.

It never opens a terminal or starts OMP for you. It saves shell-quoted commands, then shows them later so you can copy each one into the terminal or tab where it belongs.

## Install

```bash
omp plugin install github:klondikemarlen/omp-session-resume-helper
```

Restart OMP after installation.

## Recovery Snapshots

The plugin saves an immutable snapshot when an OMP session starts, exits normally, or runs `/dump-active-sessions`.

Snapshots live here:

```text
~/.local/state/omp-session-resume-helper/snapshots/
```

Each snapshot records the full active-session command list, its Linux boot ID, and its creation time. Writes are serialized with a per-user lock and committed with atomic rename, so simultaneous OMP lifecycle events cannot replace or expose a partial snapshot.

Snapshots older than 30 days are pruned during normal writes, but the newest 100 are always retained. No cron job, systemd timer, database, or background daemon is required.

The first history write migrates the original `active-sessions.txt` snapshot from version 0.1.0, so existing recovery commands remain available.

## Before Restarting Your Laptop

Automatic snapshots already cover each OMP startup and normal shutdown. To add an explicit checkpoint, run this in any OMP session:

```text
/dump-active-sessions
```

To also write a copy at an absolute path or a path beginning with `~/`:

```text
/dump-active-sessions ~/Documents/omp-resume-commands.txt
```

Worker processes, non-terminal processes, and missing terminal records are ignored. A snapshot with no commands means no OMP sessions were active at that point.

## After Restarting

Start OMP once, then run:

```text
/restore-active-sessions
```

The command selects the newest snapshot from a prior Linux boot. This protects the pre-crash list when starting the first OMP session after reboot creates a new current-boot snapshot. If there is no prior-boot history, it uses the newest current-boot snapshot.

The plugin opens the saved command list in an editor. Copy each command into its own terminal or tab. For a custom snapshot file, provide the same path:

```text
/restore-active-sessions ~/Documents/omp-resume-commands.txt
```

`/restore-active-sessions` only displays commands. It does not automatically launch OMP sessions.

## Ptyxis and GNOME

Ptyxis can restore terminal tabs when its `restore-session` setting is enabled; on this system it is enabled by default. That restores terminal windows and tabs, not the OMP processes terminated by a reboot. Use this plugin to recover the OMP sessions themselves after Ptyxis reopens.

GNOME and Ubuntu do not provide a general facility for reviving arbitrary terminal child processes after a reboot. Persistent process managers such as `tmux` can preserve a session across a dropped terminal connection, but a full reboot still ends processes unless a separate service restores them.

## Test

```bash
npm test
```
