// HiveLogic Cowork Agent — Tier-2 remote desktop input injector (Windows prototype).
//
// The browser (presenter side of cowork-markup.js) already owns screen capture,
// the LiveKit transport, and the request/grant/revoke permission handoff. This
// helper receives normalized control events over a loopback WebSocket and injects
// them as real OS input via SendInput, so a remote viewer can drive the WHOLE
// desktop — not just the HiveLogic browser tab.
//
// Capabilities:
//   * Mouse move/click/drag/scroll, Unicode typing, named special keys.
//   * Targeting: "screen" maps clicks to the virtual desktop; "window" maps them
//     to the foreground window's rect (for single-window shares).
//   * Clipboard push: the viewer can paste an image or text INTO this machine —
//     the agent sets the Windows clipboard (PNG + bitmap) and can inject Ctrl+V.
//
// Security model (prototype):
//   * Binds to 127.0.0.1 only (loopback; not reachable off-machine).
//   * A random 6-digit pairing code is shown in the agent window; the browser
//     must present it in its first frame or the connection is dropped.
//   * A system-tray icon (with balloon alerts) makes an active session visible.
//   * Two kill switches the remote viewer cannot defeat: the physical Stop
//     button and a Ctrl+Alt+Esc global hotkey (host's real keyboard only).
//
// Build:  cowork-agent\build.ps1   (compiles with the in-box .NET Framework csc)
//
// No external dependencies, no admin rights, no code signing (prototype).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Drawing;

namespace CoworkAgent
{
    // ---- OS input injection ------------------------------------------------
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public INPUTUNION u; }
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
        const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
        const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800;
        const uint KEYUP = 0x0002, UNICODE = 0x0004;
        const ushort VK_CONTROL = 0x11, VK_V = 0x56;
        const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

        static readonly int CB = Marshal.SizeOf(typeof(INPUT));
        static volatile string _mode = "screen"; // "screen" | "window"

        public static void MakeDpiAware() { try { SetProcessDPIAware(); } catch { } }
        public static void SetTarget(string m) { _mode = (m == "window") ? "window" : "screen"; }

        static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, CB); }

        static INPUT Mouse(int dx, int dy, uint data, uint flags)
        {
            var i = new INPUT { type = INPUT_MOUSE };
            i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
            return i;
        }

        static double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

        // Map normalized [0,1] over the shared surface to SendInput absolute coords
        // (0..65535 across the virtual desktop). In "window" mode the surface is the
        // foreground window; in "screen" mode it is the whole virtual desktop.
        static void MapAbs(double nx, double ny, out int ax, out int ay)
        {
            nx = Clamp01(nx); ny = Clamp01(ny);
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vcx = GetSystemMetrics(SM_CXVIRTUALSCREEN), vcy = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if (vcx <= 0) vcx = 1; if (vcy <= 0) vcy = 1;
            double px, py;
            RECT r;
            IntPtr h = GetForegroundWindow();
            if (_mode == "window" && h != IntPtr.Zero && GetWindowRect(h, out r) && r.Right > r.Left && r.Bottom > r.Top)
            {
                px = r.Left + nx * (r.Right - r.Left);
                py = r.Top + ny * (r.Bottom - r.Top);
            }
            else
            {
                px = vx + nx * vcx;
                py = vy + ny * vcy;
            }
            ax = (int)Math.Round((px - vx) * 65535.0 / Math.Max(1, vcx - 1));
            ay = (int)Math.Round((py - vy) * 65535.0 / Math.Max(1, vcy - 1));
            if (ax < 0) ax = 0; if (ax > 65535) ax = 65535;
            if (ay < 0) ay = 0; if (ay > 65535) ay = 65535;
        }

        public static void MoveTo(double nx, double ny)
        {
            int ax, ay; MapAbs(nx, ny, out ax, out ay);
            Send(Mouse(ax, ay, 0, MOVE | ABSOLUTE | VIRTUALDESK));
        }

        public static void Click(double nx, double ny, string button, bool dbl)
        {
            uint down = LEFTDOWN, up = LEFTUP;
            if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
            else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
            int ax, ay; MapAbs(nx, ny, out ax, out ay);
            Send(Mouse(ax, ay, 0, MOVE | ABSOLUTE | VIRTUALDESK));
            Send(Mouse(ax, ay, 0, down | ABSOLUTE | VIRTUALDESK),
                 Mouse(ax, ay, 0, up | ABSOLUTE | VIRTUALDESK));
            if (dbl)
                Send(Mouse(ax, ay, 0, down | ABSOLUTE | VIRTUALDESK),
                     Mouse(ax, ay, 0, up | ABSOLUTE | VIRTUALDESK));
        }

        public static void Button(double nx, double ny, string button, bool press)
        {
            uint flag = press ? LEFTDOWN : LEFTUP;
            if (button == "right") flag = press ? RIGHTDOWN : RIGHTUP;
            else if (button == "middle") flag = press ? MIDDLEDOWN : MIDDLEUP;
            int ax, ay; MapAbs(nx, ny, out ax, out ay);
            Send(Mouse(ax, ay, 0, flag | ABSOLUTE | VIRTUALDESK));
        }

        public static void Scroll(double nx, double ny, int notches)
        {
            MoveTo(nx, ny);
            Send(Mouse(0, 0, unchecked((uint)(notches * 120)), WHEEL));
        }

        static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var i = new INPUT { type = INPUT_KEYBOARD };
            i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
            return i;
        }

        public static void TypeText(string s)
        {
            foreach (char c in s)
                Send(Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP));
        }

        public static void PressCtrlV()
        {
            Send(Key(VK_CONTROL, 0, 0), Key(VK_V, 0, 0), Key(VK_V, 0, KEYUP), Key(VK_CONTROL, 0, KEYUP));
        }

        // Named special keys -> virtual-key codes.
        static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            {"Enter",0x0D},{"Return",0x0D},{"Backspace",0x08},{"Tab",0x09},{"Escape",0x1B},{"Esc",0x1B},
            {"Delete",0x2E},{"Space",0x20},{"ArrowUp",0x26},{"ArrowDown",0x28},{"ArrowLeft",0x25},{"ArrowRight",0x27},
            {"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22}
        };

        public static bool SpecialKey(string name)
        {
            ushort vk;
            if (!VK.TryGetValue(name, out vk)) return false;
            Send(Key(vk, 0, 0), Key(vk, 0, KEYUP));
            return true;
        }
    }

    // ---- Minimal dependency-free JSON reader for our flat control frames ----
    static class Json
    {
        static readonly Regex Pair = new Regex("\"([^\"]+)\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+(?:\\.\\d+)?|true|false|null)", RegexOptions.Compiled);

        public static Dictionary<string, string> Parse(string s)
        {
            var d = new Dictionary<string, string>();
            foreach (Match m in Pair.Matches(s))
            {
                string v = m.Groups[2].Value;
                if (v.Length >= 2 && v[0] == '"')
                    v = Unescape(v.Substring(1, v.Length - 2));
                d[m.Groups[1].Value] = v;
            }
            return d;
        }

        static string Unescape(string s)
        {
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    char n = s[++i];
                    switch (n)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'u':
                            if (i + 4 < s.Length) { sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; }
                            break;
                        default: sb.Append(n); break;
                    }
                }
                else sb.Append(s[i]);
            }
            return sb.ToString();
        }

        public static double Num(Dictionary<string, string> d, string k, double dflt)
        {
            string v; double r;
            if (d.TryGetValue(k, out v) && double.TryParse(v, NumberStyles.Any, CultureInfo.InvariantCulture, out r)) return r;
            return dflt;
        }
        public static string Str(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) ? v : null; }
        public static bool Bool(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) && v == "true"; }
    }

    // ---- System-tray host (no floating window) -----------------------------
    // A hidden Form that exists only to run the message loop, own the global
    // Ctrl+Alt+Esc hotkey, and be an Invoke target. Everything the user sees is
    // the tray icon (near the clock): pairing code + Stop live in its menu.
    public class TrayHost : Form
    {
        NotifyIcon tray;
        ToolStripMenuItem stopItem;
        string baseTip;
        public event Action StopRequested;
        const int WM_HOTKEY = 0x0312, HK_ID = 0xB00B;

        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);

        public TrayHost()
        {
            baseTip = "HiveLogic Cowork - ready";
            Text = "HiveLogic Cowork Agent";
            ShowInTaskbar = false; WindowState = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.None; Opacity = 0;

            var menu = new ContextMenuStrip();
            var infoItem = new ToolStripMenuItem("HiveLogic Cowork - ready") { Enabled = false };
            stopItem = new ToolStripMenuItem("Stop control") { Enabled = false };
            stopItem.Click += (s, e) => { if (StopRequested != null) StopRequested(); };
            var quitItem = new ToolStripMenuItem("Quit");
            quitItem.Click += (s, e) => { try { tray.Visible = false; } catch { } Application.Exit(); };
            menu.Items.Add(infoItem); menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(stopItem); menu.Items.Add(quitItem);

            tray = new NotifyIcon { Icon = SystemIcons.Application, Text = baseTip, Visible = true, ContextMenuStrip = menu };

            var force = this.Handle; // force handle creation so the hotkey registers
            Load += (s, e) => { try { tray.BalloonTipTitle = "HiveLogic Cowork is running"; tray.BalloonTipText = "You'll get an Allow prompt here when a call asks to control this PC."; tray.ShowBalloonTip(6000); } catch { } };
        }

        protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); } // never show the form

        // Native consent gate: a call is requesting control. Runs on the UI thread
        // (WS thread blocks on Invoke until the presenter answers). Defaults to No.
        public bool AskAllow(string who)
        {
            if (InvokeRequired) return (bool)Invoke(new Func<bool>(() => AskAllow(who)));
            using (var top = new Form { TopMost = true, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Left = -4000, Top = -4000, Width = 1, Height = 1 })
            {
                top.Show(); top.Activate();
                var msg = "Allow " + who + " to control this computer through HiveLogic?\n\n" +
                          "They will be able to move your mouse and type on this PC.\n" +
                          "You can stop at any time with Ctrl+Alt+Esc or the tray icon.";
                var res = MessageBox.Show(top, msg, "HiveLogic Cowork - allow remote control?",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                top.Hide();
                return res == DialogResult.Yes;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            RegisterHotKey(Handle, HK_ID, 0x2 | 0x1, 0x1B); // Ctrl+Alt+Esc kill switch
        }
        protected override void OnHandleDestroyed(EventArgs e) { UnregisterHotKey(Handle, HK_ID); base.OnHandleDestroyed(e); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HK_ID && StopRequested != null) StopRequested();
            base.WndProc(ref m);
        }

        static string Trunc(string s) { return s.Length > 63 ? s.Substring(0, 63) : s; }

        public void SetControlling(string driver)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => SetControlling(driver))); return; }
            if (driver != null)
            {
                tray.Text = Trunc("HiveLogic Cowork - " + driver + " is controlling");
                stopItem.Enabled = true;
                tray.BalloonTipTitle = "Desktop control is ON";
                tray.BalloonTipText = driver + " is controlling this computer. Press Ctrl+Alt+Esc, or tray > Stop control, to end it.";
                try { tray.ShowBalloonTip(5000); } catch { }
            }
            else
            {
                tray.Text = baseTip;
                stopItem.Enabled = false;
            }
        }

        public void Flash(string msg)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => Flash(msg))); return; }
            try { tray.BalloonTipTitle = "HiveLogic Cowork"; tray.BalloonTipText = msg; tray.ShowBalloonTip(4000); } catch { }
        }
    }

    // ---- Loopback WebSocket server (raw TCP; no HttpListener URL-ACL) -------
    class Program
    {
        static TrayHost tray;
        static volatile TcpClient activeClient;
        static volatile bool promptOpen;
        const int PORT = 8766;

        [STAThread]
        static void Main()
        {
            Native.MakeDpiAware();
            tray = new TrayHost();
            tray.StopRequested += StopSession;

            var t = new Thread(Serve) { IsBackground = true };
            t.Start();
            Application.EnableVisualStyles();
            Application.Run(tray);
        }

        static void StopSession()
        {
            var c = activeClient; activeClient = null;
            try { if (c != null) c.Close(); } catch { }
            tray.SetControlling(null);
        }

        static void OnUi(Action a) { try { if (tray != null) tray.Invoke(a); } catch { } }

        static void SetClipboardText(string s)
        {
            OnUi(() => { try { Clipboard.SetText(s); tray.Flash("Driver shared text to your clipboard"); } catch { } });
        }

        static void SetClipboardImage(byte[] png)
        {
            OnUi(() =>
            {
                try
                {
                    var data = new DataObject();
                    using (var ms = new MemoryStream(png)) { var img = Image.FromStream(ms); data.SetData(DataFormats.Bitmap, true, img); }
                    data.SetData("PNG", false, new MemoryStream(png)); // preserves alpha for apps that read PNG
                    Clipboard.SetDataObject(data, true);
                    tray.Flash("Driver shared an image to your clipboard");
                }
                catch { }
            });
        }

        static void Serve()
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, PORT);
                listener.Start();
            }
            catch (Exception ex)
            {
                try { MessageBox.Show("Could not bind 127.0.0.1:" + PORT + "\n" + ex.Message + "\n\nIs another agent already running?", "Cowork Agent"); } catch { }
                return;
            }
            while (true)
            {
                TcpClient client = null;
                try { client = listener.AcceptTcpClient(); }
                catch { break; }
                var ct = new Thread(() => Handle(client)) { IsBackground = true };
                ct.Start();
            }
        }

        static void Handle(TcpClient client)
        {
            try
            {
                var ns = client.GetStream();
                if (!Handshake(ns)) { client.Close(); return; }

                bool authed = false;
                string driver = "A teammate";

                while (true)
                {
                    string msg = ReadMessage(ns);
                    if (msg == null) break;
                    if (msg.Length == 0) continue;
                    var d = Json.Parse(msg);
                    string type = Json.Str(d, "t");
                    if (type == null) continue;

                    if (!authed)
                    {
                        // First frame is a hello. Instead of a typed code, ask the
                        // presenter to approve with a native Allow dialog.
                        if (type == "hello")
                        {
                            string nm = Json.Str(d, "name");
                            if (!string.IsNullOrEmpty(nm)) driver = nm;
                            if (activeClient != null || promptOpen) { SendTextFrame(ns, "{\"t\":\"denied\",\"reason\":\"busy\"}"); break; }
                            promptOpen = true;
                            bool ok;
                            try { ok = tray.AskAllow(driver); } finally { promptOpen = false; }
                            if (ok)
                            {
                                authed = true;
                                activeClient = client;
                                tray.SetControlling(driver);
                                SendTextFrame(ns, "{\"t\":\"ready\"}");
                            }
                            else
                            {
                                SendTextFrame(ns, "{\"t\":\"denied\"}");
                                break;
                            }
                        }
                        else
                        {
                            SendTextFrame(ns, "{\"t\":\"denied\"}");
                            break;
                        }
                        continue;
                    }

                    if (activeClient != client) break; // superseded or stopped
                    Dispatch(type, d);
                }
            }
            catch { }
            finally
            {
                try { client.Close(); } catch { }
                if (activeClient == client) { activeClient = null; tray.SetControlling(null); }
            }
        }

        static void Dispatch(string type, Dictionary<string, string> d)
        {
            double x = Json.Num(d, "x", 0.5), y = Json.Num(d, "y", 0.5);
            switch (type)
            {
                case "move": Native.MoveTo(x, y); break;
                case "click": Native.Click(x, y, Json.Str(d, "button") ?? "left", Json.Bool(d, "double")); break;
                case "down": Native.Button(x, y, Json.Str(d, "button") ?? "left", true); break;
                case "up": Native.Button(x, y, Json.Str(d, "button") ?? "left", false); break;
                case "scroll": Native.Scroll(x, y, (int)Json.Num(d, "dy", 0)); break;
                case "text": { string s = Json.Str(d, "s"); if (s != null) Native.TypeText(s); break; }
                case "key": { string k = Json.Str(d, "key"); if (k != null && !Native.SpecialKey(k) && k.Length == 1) Native.TypeText(k); break; }
                case "target": Native.SetTarget(Json.Str(d, "mode")); break;
                case "clip-text": { string s = Json.Str(d, "s"); if (s != null) { SetClipboardText(s); if (Json.Bool(d, "paste")) { Thread.Sleep(80); Native.PressCtrlV(); } } break; }
                case "clip-image":
                    {
                        string b64 = Json.Str(d, "b64");
                        if (!string.IsNullOrEmpty(b64))
                        {
                            try { byte[] png = Convert.FromBase64String(b64); SetClipboardImage(png); if (Json.Bool(d, "paste")) { Thread.Sleep(150); Native.PressCtrlV(); } }
                            catch { }
                        }
                        break;
                    }
                case "stop": StopSession(); break;
            }
        }

        // ---- WebSocket handshake + framing (RFC 6455) -----------------------
        static bool Handshake(NetworkStream ns)
        {
            var req = ReadHttpHeaders(ns);
            if (req == null) return false;
            var m = Regex.Match(req, "Sec-WebSocket-Key:\\s*(.+)", RegexOptions.IgnoreCase);
            if (!m.Success) return false;
            string key = m.Groups[1].Value.Trim();
            string accept;
            using (var sha1 = SHA1.Create())
                accept = Convert.ToBase64String(sha1.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
            byte[] rb = Encoding.ASCII.GetBytes(resp);
            ns.Write(rb, 0, rb.Length);
            return true;
        }

        static string ReadHttpHeaders(NetworkStream ns)
        {
            var sb = new StringBuilder();
            int b; int last = 0, count = 0;
            while ((b = ns.ReadByte()) != -1)
            {
                sb.Append((char)b);
                if (b == '\n' && last == '\r') { count++; if (count == 2) return sb.ToString(); }
                else if (b != '\r') count = 0;
                last = b;
                if (sb.Length > 8192) return null;
            }
            return null;
        }

        // Reassembles a full WebSocket message across continuation frames — required
        // for multi-MB clipboard images the browser splits into many frames.
        static string ReadMessage(NetworkStream ns)
        {
            var buf = new List<byte>();
            while (true)
            {
                int b1 = ns.ReadByte(); if (b1 < 0) return null;
                int b2 = ns.ReadByte(); if (b2 < 0) return null;
                bool fin = (b1 & 0x80) != 0;
                int opcode = b1 & 0x0F;
                bool masked = (b2 & 0x80) != 0;
                long len = b2 & 0x7F;
                if (len == 126) { len = (ReadByte(ns) << 8) | ReadByte(ns); }
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | (uint)ReadByte(ns); }
                byte[] mask = new byte[4];
                if (masked) for (int i = 0; i < 4; i++) mask[i] = (byte)ReadByte(ns);
                byte[] payload = new byte[len];
                int off = 0; while (off < len) { int r = ns.Read(payload, off, (int)(len - off)); if (r <= 0) return null; off += r; }
                if (masked) for (int i = 0; i < len; i++) payload[i] ^= mask[i & 3];
                if (opcode == 0x8) return null;                 // close
                if (opcode == 0x9 || opcode == 0xA) { if (fin) continue; else continue; } // ping/pong
                buf.AddRange(payload);
                if (fin) break;
            }
            return Encoding.UTF8.GetString(buf.ToArray());
        }

        static int ReadByte(NetworkStream ns) { int b = ns.ReadByte(); if (b < 0) throw new IOException(); return b; }

        static void SendTextFrame(NetworkStream ns, string text)
        {
            byte[] payload = Encoding.UTF8.GetBytes(text);
            var header = new List<byte> { 0x81 };
            if (payload.Length < 126) header.Add((byte)payload.Length);
            else if (payload.Length < 65536) { header.Add(126); header.Add((byte)(payload.Length >> 8)); header.Add((byte)payload.Length); }
            else { header.Add(127); for (int i = 7; i >= 0; i--) header.Add((byte)(payload.Length >> (8 * i))); }
            ns.Write(header.ToArray(), 0, header.Count);
            ns.Write(payload, 0, payload.Length);
        }
    }
}
