---
name: pi-test
description: >
  Test pi package TUI components using pilotty for PTY-based terminal automation.
  Use when the user wants to test, verify, or validate TUI components built with
  pi-tui in their pi package — interactive selectors, overlays, dialogs, custom
  editors, status indicators, or any ctx.ui.custom() output. Also use when the user
  says "test the TUI", "verify the UI renders", "check my component", "run pilotty",
  "test my extension's UI", or asks about TUI testing strategies for pi packages.
  Do not use for unit testing non-TUI code, linting, type checking, or testing
  tools that only return text without rendering a TUI.
compatibility: Requires pilotty (npm install -g pilotty). macOS or Linux. No Windows support.
allowed-tools: Bash read edit write
---

# Pi Package TUI Testing with Pilotty

This skill guides you through testing TUI components built with `@earendil-works/pi-tui` inside a pi package. Pilotty provides PTY-based terminal automation — it spawns terminal applications in background sessions, captures screen state as structured data, and sends keyboard/mouse input programmatically.

## Why Pilotty for Pi TUI Testing

Pi TUI components render inside the pi terminal application. They use ANSI escape codes, theme colors, and interactive keyboard handling. Standard test runners can't see the rendered output because there's no real terminal. Pilotty solves this by:

- Spawning pi in a real PTY (with a full VT100 terminal emulator)
- Capturing screen state as structured JSON (text, cursor, elements, content hash)
- Sending keyboard input (Tab, Enter, arrows, text typing, key sequences)
- Waiting for screen changes instead of guessing sleep durations

This gives you a fully automated way to verify that your components render correctly, respond to input, and update on state changes — the things that are impossible to test with `pi -p` print mode.

## Prerequisites

Before testing, confirm pilotty is installed:

```bash
which pilotty
```

If not installed, install via npm:

```bash
npm install -g pilotty
```

Pilotty is a Rust binary distributed as a native npm package. It requires macOS or Linux (no Windows support).

Also confirm the package loads without errors:

```bash
npm run typecheck && npm run lint
```

## Core Testing Workflow

Every TUI test follows the same pattern:

1. **Spawn pi** with the package loaded in a pilotty PTY session
2. **Wait for readiness** — pi shows a prompt or status line when loaded
3. **Trigger the TUI** — invoke a slash command or tool that renders your component
4. **Capture a snapshot** — verify the rendered output
5. **Interact** — send keyboard input to exercise the component
6. **Verify again** — snapshot after interaction to confirm state changed correctly
7. **Clean up** — kill the session

### Step 1: Spawn pi in a pilotty session

```bash
pilotty spawn --name tui-test --cwd /path/to/package -- pi -ne -e . --no-session
```

Key flags:
- `--name tui-test` — named session for targeting with `-s tui-test`
- `--cwd /path/to/package` — run in the package directory so `-e .` works
- `-ne` — no globally installed extensions (avoids interference)
- `-e .` — load only this package's extensions
- `--no-session` — fresh session, no session file

Always use `-ne` with `-e .` to isolate the package under test. Other extensions (like pi-mcp-adapter) can interfere with TUI rendering.

### Step 2: Wait for pi to be ready

```bash
pilotty wait-for -s tui-test "[Skills]" -t 10000
```

Pi shows a startup info screen with `[Skills]`, `[Prompts]`, `[Extensions]`, `[Themes]` sections when ready. Wait for any of these strings. The timeout of 10 seconds accounts for startup time.

Alternatively, use a short sleep which is more reliable across pi versions:

```bash
sleep 3
pilotty snapshot -s tui-test --format text | head -2
```

If you see the skills list, pi is ready.

### Step 3: Trigger the TUI component

For slash commands, type the command:

```bash
HASH=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
pilotty type -s tui-test "/pick"
pilotty key -s tui-test Enter
pilotty snapshot -s tui-test --await-change "$HASH" --settle 100
```

For tool-triggered TUIs, type a prompt that invokes the tool:

```bash
HASH=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
pilotty type -s tui-test "Call the settings tool"
pilotty key -s tui-test Enter
pilotty snapshot -s tui-test --await-change "$HASH" --settle 500
```

Use `--settle` with a value of 100-500ms for pi's TUI rendering. The TUI renders quickly once the command executes.

### Step 4: Capture and verify the snapshot

```bash
pilotty snapshot -s tui-test
```

This returns structured JSON:

```json
{
  "snapshot_id": 42,
  "size": { "cols": 80, "rows": 24 },
  "cursor": { "row": 5, "col": 10, "visible": true },
  "text": "full screen text content",
  "elements": [
    { "kind": "button", "row": 1, "col": 9, "width": 4, "text": "[OK]", "confidence": 0.8 }
  ],
  "content_hash": 12345678901234567890
}
```

For readable output during debugging:

```bash
pilotty snapshot -s tui-test --format text
```

### Step 5: Interact with the component

```bash
# Navigate with arrow keys
pilotty key -s tui-test Down
pilotty key -s tui-test Up

# Select an item
pilotty key -s tui-test Enter

# Type text into an input field
pilotty type -s tui-test "search query"

# Tab between elements
pilotty key -s tui-test Tab

# Cancel / close
pilotty key -s tui-test Escape
```

Always capture a hash before interaction and use `--await-change` after to wait for the screen to update:

```bash
HASH=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
pilotty key -s tui-test Down
pilotty snapshot -s tui-test --await-change "$HASH" --settle 50
```

This avoids race conditions — no manual sleep guessing needed.

### Step 6: Clean up

```bash
pilotty kill -s tui-test
```

Or stop the entire daemon:

```bash
pilotty stop
```

## Testing Common Pi TUI Patterns

Read `references/TEST_PATTERNS.md` for detailed test scripts covering the most common pi TUI component patterns:

1. **SelectList dialogs** — verify items render, navigate, select
2. **Overlays** — verify overlay appears and dismisses
3. **SettingsList toggles** — verify toggle state changes
4. **Custom editors** — verify mode switching and input handling
5. **Widgets** — verify content appears above/below editor
6. **BorderedLoader** — verify spinner appears during async work

## Snapshot Verification Strategies

### Text content verification

Extract the `text` field and search for expected strings:

```bash
pilotty snapshot -s tui-test | jq -r '.text' | grep -q "Pick an Option"
```

### Element verification

Check for detected UI elements (buttons, inputs, toggles):

```bash
pilotty snapshot -s tui-test | jq '.elements[] | select(.kind == "button")'
```

Element detection is best-effort — pilotty detects common patterns like `[OK]`, `<Cancel>`, `[x]`, `[ ]`. For components with custom styling, rely on text content verification instead.

### Content hash for change detection

Use `content_hash` to verify that an action actually changed the screen:

```bash
HASH1=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
pilotty key -s tui-test Down
pilotty snapshot -s tui-test --await-change "$HASH1" --settle 50
HASH2=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
# If HASH1 != HASH2, the screen changed
```

### Plain text format for visual debugging

When you need to see what the TUI looks like (including cursor position shown as `▌`):

```bash
pilotty snapshot -s tui-test --format text
```

## Key Mapping for Pi TUI

Pi's TUI components use these key interactions:

| Action | Key | pilotty command |
|--------|-----|-----------------|
| Navigate list | ↑/↓ | `pilotty key Up` / `pilotty key Down` |
| Select item | Enter | `pilotty key Enter` |
| Cancel/close | Escape | `pilotty key Escape` |
| Tab between items | Tab | `pilotty key Tab` |
| Search in SelectList | Type text | `pilotty type "query"` |
| Scroll | Page Up/Down | `pilotty key PageUp` / `pilotty key PageDown` |
| Toggle setting | Enter | `pilotty key Enter` |
| Abort pi | Ctrl+C | `pilotty key Ctrl+C` |

## Testing Multiple Components

When testing multiple slash commands or TUI flows, you can reuse a single session:

```bash
# Test command A
pilotty type -s tui-test "/command-a"
pilotty key -s tui-test Enter
# ... verify and dismiss ...
pilotty key -s tui-test Escape

# Test command B
pilotty type -s tui-test "/command-b"
pilotty key -s tui-test Enter
# ... verify ...
```

Alternatively, spawn fresh sessions for test isolation:

```bash
pilotty kill -s tui-test
pilotty spawn --name tui-test --cwd /path/to/package -- pi -ne -e . --no-session
pilotty wait-for -s tui-test "[Skills]" -t 10000
```

## Important: Don't Send Enter Without a TUI Open

Pi treats Enter as "submit prompt" when the editor is focused. If you send `pilotty key Enter` before a TUI component is displayed, pi will process whatever is in the editor as a prompt — which can trigger the agent and disrupt your test session.

Only send Enter after confirming a TUI is visible via snapshot. For commands, prefer typing the full command and sending Enter once:

```bash
# Good: type command + Enter (pi processes the slash command)
pilotty type -s tui-test "/my-command"
pilotty key -s tui-test Enter

# Bad: sending random Enter keys before the TUI appears
pilotty key -s tui-test Enter  # This submits an empty prompt!
```

If you accidentally trigger the agent, wait for it to finish:

```bash
HASH=$(pilotty snapshot -s tui-test | jq -r '.content_hash')
pilotty snapshot -s tui-test --await-change "$HASH" --settle 3000 -t 60000
```

## Snapshot Text vs Styled Elements

The snapshot `text` field contains screen content with ANSI escape codes stripped. This means ANSI-styled UI elements may not appear as expected in the text output. For example, pi's editor prompt `[ ]` uses styling and may show as empty space in the text field.

For verifying styled elements, use these alternatives:

- **Cursor position** — Check `.cursor` in the JSON snapshot for row, col, and visibility
- **Element detection** — Check `.elements` array for detected buttons, inputs, toggles
- **Text format** — Use `--format text` for visual debugging with cursor indicator `▌`

## Troubleshooting

### Pi doesn't start in the PTY

Increase the wait timeout. Pi startup takes longer in a PTY:

```bash
pilotty wait-for -s tui-test "[Skills]" -t 20000
```

### TUI doesn't appear after typing a command

Pi might still be processing. Use `--await-change` with a longer settle time:

```bash
pilotty snapshot -s tui-test --await-change "$HASH" --settle 500 -t 10000
```

### Snapshot shows the wrong screen

The TUI might not have finished rendering. Always wait for the content hash to change after an action. Check with text format:

```bash
pilotty snapshot -s tui-test --format text
```

### Session not found

Sessions are cleaned up automatically when the child process exits. If pi crashed or was killed, the session is gone. List active sessions:

```bash
pilotty list-sessions
```

### ANSI escape codes in snapshot text

The `text` field contains the visible text content with ANSI codes stripped. If you see garbled output, the component might be emitting raw escape sequences that pilotty's VT100 emulator doesn't fully handle. Report edge cases to the pilotty project.

## Reference Files

- `references/TEST_PATTERNS.md` — Ready-to-use test scripts for common pi TUI component patterns
