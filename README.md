# OMP Session Resume Helper

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin for manually recovering the OMP sessions that were active before a laptop restart.

It never opens a terminal or starts OMP for you. It saves shell-quoted commands, then shows them later so you can copy each one into the terminal or tab where it belongs.

## Install

```bash
omp plugin install github:klondikemarlen/omp-session-resume-helper
```

Restart OMP after installation.

## Before Restarting Your Laptop

In any running OMP session, run:

```text
/dump-active-sessions
```

The plugin finds currently live interactive OMP terminals and saves commands to:

```text
~/.local/state/omp-session-resume-helper/active-sessions.txt
```

To use another location, pass an absolute path or a path beginning with `~/`:

```text
/dump-active-sessions ~/Documents/omp-resume-commands.txt
```

Worker processes, non-terminal processes, and missing terminal records are ignored. If no active sessions are found, the existing snapshot is preserved.

## After Restarting

Start OMP once, then run:

```text
/restore-active-sessions
```

The plugin opens the saved command list in an editor. Copy each command into its own terminal or tab. For a non-default snapshot, provide the same path:

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
