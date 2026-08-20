# OMP Session Resume Helper

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin for manually recovering OMP sessions after a laptop restart or crash.

It never opens a terminal or starts OMP for you. It saves shell-quoted commands, then shows them later so you can copy each one into the terminal or tab where it belongs.

## Install

```bash
omp plugin install github:klondikemarlen/omp-session-resume-helper
```

Restart OMP after installation.

## Recovery Snapshots

The plugin saves an immutable snapshot when an OMP session starts, exits normally, or `/dump-active-sessions` runs and active sessions are found.

Snapshots live here:

```text
~/.local/state/omp-session-resume-helper/snapshots/
```

New snapshots use only their ISO creation timestamp as the file name, for example `2026-08-10T16:07:07.151Z.txt`. The plugin uses the Linux boot start time to select a pre-reboot snapshot. On its next automatic capture, it renames legacy UUID-named snapshots to the short form without changing their contents. Writes are serialized with a per-user lock and committed with atomic rename, so simultaneous OMP lifecycle events cannot replace or expose a partial snapshot.

Automatic captures with no active sessions create no snapshot. Normal writes retain only the newest 10 snapshots. No cron job, systemd timer, database, or background daemon is required.

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
/show-saved-sessions
```

The command selects the newest snapshot from a prior Linux boot. This protects the pre-crash list when starting the first OMP session after reboot creates a new current-boot snapshot. If there is no prior-boot history, it uses the newest current-boot snapshot.

The command selects the snapshot, runs `cat` on it, and renders the path, command, and saved resume commands as a Bash-output entry in the OMP transcript. Copy each resume command into its own terminal or tab. For a custom snapshot file, provide the same path:

```text
/show-saved-sessions ~/Documents/omp-resume-commands.txt
```

`/show-saved-sessions` does not automatically launch OMP sessions or add the saved commands to the prompt.

## Restore Saved Sessions

Run `/restore-saved-sessions` to display the same portable snapshot. On Linux with a graphical session and an available [Ptyxis](https://gitlab.gnome.org/chergert/ptyxis) executable, it previews one new window per saved session and asks before launching anything. Each Ptyxis window resolves the standard `omp` command using the running OMP session's `PATH`, so its desktop environment does not need to inherit shell configuration.

Everywhere else, it stops after the portable display. Snapshots with commands not written by this plugin also remain displayable but are never launched automatically.

```text
/restore-saved-sessions ~/Documents/omp-resume-commands.txt
```

## Ptyxis and GNOME

Ptyxis can restore terminal tabs when its `restore-session` setting is enabled; on this system it is enabled by default. That restores terminal windows and tabs, not the OMP processes terminated by a reboot. `/restore-saved-sessions` can start new Ptyxis windows for saved OMP sessions when the capability is available, but it does not infer or restore prior window/tab groups.

GNOME and Ubuntu do not provide a general facility for reviving arbitrary terminal child processes after a reboot. Persistent process managers such as `tmux` can preserve a session across a dropped terminal connection, but a full reboot still ends processes unless a separate service restores them.

## Test

```bash
npm test
```
