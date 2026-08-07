# OMP Session Resume Export

Export copyable resume commands for currently live interactive [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions.

## Usage

Run the command directly or save its output:

```bash
bin/omp-active-sessions
bin/omp-active-sessions --output ~/omp-active-sessions.txt
```

Example output:

```bash
cd ~/code/icefoganalytics/wrap && omp --resume 019fb989-c2ee-7000-96ea-2a2cce5229b6

cd ~/code/icefoganalytics/wrap-worktrees/wrapx-179 && omp --resume 019fb981-7adc-7000-a991-935c9a97acea
```

The output is a command list. Run each entry in its own terminal or tab; do not run the whole file with `bash`, because the first interactive OMP session will block the remaining commands.

The command reads OMP's local terminal-session records and only exports records whose terminal currently has a live interactive `omp` process. It excludes OMP worker processes and does not restore inactive sessions.

## Test

```bash
test/omp-active-sessions.test.sh
```
