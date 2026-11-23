# Play shortcuts (sync first, then launch)

A play shortcut works like a Steam desktop shortcut: opening it syncs the game's
saves with the cloud and only then starts the game.

## How it is triggered

| Trigger | Example | Notes |
| --- | --- | --- |
| URL scheme | `syncsave://launch/<gameId>` | Registered by the installer (`plugins.deep-link` in `tauri.conf.json`) and again for the current user on every start, so dev builds and moved installs work. |
| Desktop file | `<Game name>.url` | Created by **Desktop shortcut** on the game page. Same Internet Shortcut format Steam uses; the icon comes from the game's exe. |
| Command line | `SyncSaveGame.exe --launch <gameId>` | For a hand-made `.lnk`, Playnite, or Steam "Add a Non-Steam Game" (put `--launch <gameId>` in Launch Options). |

**Copy link** on the game page copies the `syncsave://` URL.

`tauri-plugin-single-instance` makes a second start (shortcut, URL, Start menu) hand
its arguments to the running tray app instead of opening another copy. When the app
was not running, it starts with the dashboard hidden in the tray.

## Flow

1. The app opens a small, always-on-top **launcher** window (`#/launch/<gameId>`).
2. The window calls `sync_and_launch_game`, the same command as the ▶ Play button:
   per-game save gate, three-way sync (pull or push), then launch and arm exit tracking.
3. On success the window closes itself. Auto-sync on game exit works as usual.

When sync needs the user, the launcher stops and asks:

| Case | Launcher shows |
| --- | --- |
| `SAVE_CONFLICT` (both sides changed) | **Resolve in app** opens the game page to choose Push/Restore; **Play local save** starts without syncing. Nothing is overwritten. |
| Offline / network or Drive error | **Retry** or **Play without syncing**. |
| `SAVE_BUSY` (an exit sync is still running) | Waits and retries every 3 s for about a minute. |
| `SAVE_PLAYING` | The game is already running. |
| Not signed in | **Open app to sign in**. |
| Exe not set or missing on this device | **Open game settings**. |

## Security

Shortcut input is limited to a game ID (`[A-Za-z0-9_-]`, max 128 chars) that must
exist in the signed-in user's library. A link can only sync and start an executable the
user already configured; browsers ask before opening a `syncsave://` link.
