# HiveLogic Cowork Agent — Tier-2 remote desktop (Windows prototype)

Tier 1 (already live) lets a granted viewer drive the **HiveLogic browser tab** by
replaying clicks/keys as synthetic DOM events. Tier 2 extends that to the **whole
desktop** by pairing a tiny native helper that injects real OS input.

The browser still does everything it already did — screen capture, the LiveKit
transport, and the request → grant → revoke permission handoff. This agent only
receives the *already-permitted* driver actions over a loopback socket and injects
them with `SendInput`.

```
Viewer  ──clicks on shared whole-screen video (normalized x,y)──►  LiveKit data channel
Presenter browser (cowork-markup.js) ──ws://127.0.0.1:8766──►  Cowork Agent ──SendInput──► desktop
```

## Build

No SDK, NuGet, or admin rights — it compiles with the in-box .NET Framework `csc`:

```powershell
powershell -ExecutionPolicy Bypass -File cowork-agent\build.ps1
```

Produces `cowork-agent\CoworkAgent.exe`.

## Use

1. **Presenter** runs `CoworkAgent.exe`. A small always-on-top window appears with
   a 6-digit **pairing code**.
2. Presenter shares their **whole screen** in the HiveVideo call, then clicks the
   new **monitor icon** in the Cowork panel header ("Full desktop control") and
   enters the pairing code.
3. A viewer requests control and the presenter grants it (existing handoff). From
   then on the viewer's clicks/typing/scroll drive the presenter's **entire
   desktop**, not just the browser tab.

## Choosing what to share (whole screen vs. one window)

When the presenter starts a share, the browser's native picker offers **Entire
Screen / Window / Tab** — that already works, no extra step. The agent adapts to
the choice: the browser reads the share's `displaySurface` and sends the agent a
target mode.

- **Entire screen** → clicks map to the desktop. Fully reliable.
- **Single window** → clicks map to the presenter's **foreground window**. Works
  as long as the shared window stays focused; if the presenter clicks away to
  another window, injected clicks follow the new foreground window. For rock-solid
  control, share the whole screen.

## Clipboard push (viewer pastes into the presenter's PC)

While driving, the viewer can **copy an image or text on their own machine and
press Ctrl+V** over the shared view. The image/text is relayed (images are chunked,
since LiveKit data messages are ~15 KB) to the presenter, and the agent sets the
Windows clipboard (PNG + bitmap formats for broad app compatibility) and injects
Ctrl+V so it lands in whatever app the presenter has focused. The presenter sees a
banner confirming what was shared. Requires the agent to be paired (Tier-2); text
is instant, images take a moment to transfer. This is one-way (viewer → presenter)
for now; presenter → viewer is a follow-on.

## Safety model

- **Loopback only** — binds `127.0.0.1:8766`; nothing off-machine can reach it.
- **Pairing code** — the browser must present the code shown in the agent window
  in its first frame, or the connection is refused. Stops any other localhost page
  from silently driving the machine.
- **Always-on-top banner** — turns red and names who is controlling while a session
  is live.
- **Two kill switches the remote viewer cannot press** — the physical **Stop**
  button, and **Ctrl+Alt+Esc** (a global hotkey fired from the host's real
  keyboard). Either ends the session instantly.
- **Off by default** — the presenter must launch the agent and pair it every
  session; closing the window ends all control.

## Coordinate mapping

The viewer's coordinates are normalized `[0,1]` over the shared surface. The agent
maps them with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`:

- **screen mode** — maps across the whole virtual desktop.
- **window mode** — maps into the foreground window's rect (`GetForegroundWindow` +
  `GetWindowRect`), for single-window shares.

The browser selects the mode from the share's `displaySurface`. The agent calls
`SetProcessDPIAware()` so window rects and cursor coords stay consistent on
high-DPI displays.

## Known limits (prototype → productization)

- **Windows only.** macOS needs the same helper over `CGEvent` (separate build).
- **Primary/virtual desktop mapping** is linear; per-monitor selection on
  multi-monitor rigs is a follow-on.
- **Not code-signed / no installer.** SmartScreen will warn on first run. A signed
  installer + auto-update is the productization step.
- **UAC-elevated windows** can't be driven unless the agent itself runs elevated
  (Windows UIPI blocks injecting into higher-integrity processes). The same limit
  applies to pasting into an elevated app.
- **Window-mode control** follows the *foreground* window, not specifically the
  shared one (the browser can't tell the agent which OS window was picked). Keep
  the shared window focused, or share the whole screen.
- **Clipboard push is one-way** (viewer → presenter) and needs the paired agent;
  presenter → viewer is a follow-on. Large images take a moment over the data
  channel (12 MB cap in the bridge).
- Drag latency depends on the LiveKit data-channel round-trip.

## Files

- `CoworkAgent.cs` — the agent (input injection, loopback WebSocket, banner, kill switches).
- `build.ps1` — one-step compile with the in-box `csc`.
- Browser side: `public/hiveconnect/cowork-markup.js` — the `NB` bridge + the
  "Full desktop control" header button (`window.CoworkNative` for automation).
