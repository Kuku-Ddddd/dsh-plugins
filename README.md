# DSH plugin index

This repository publishes a [DeepSeek Harness](https://github.com/deepseek-ai) plugin index.

Add this URL in DSH: **Plugins** → enable **Custom plugin indexes** (under Experimental plugins) → **Discover** → **Add index source**:

```
https://YOUR-USERNAME.github.io/dsh-plugins/index.json
```

## Contents

- `index.json` — the market index (format 1)
- `icon.svg` — index icon
- `dsh-task-artifact-folder/` — the plugin package

## Plugins

### Task artifact folder

Creates a same-named folder at the workspace root for every new task and stages that task's artifacts into it.
Renaming the task renames the folder. A folder is never moved onto an existing file or non-empty directory.

Configuration lives in `~/.dsh/task-artifact-folder/config.json` (hot-read, no restart needed).