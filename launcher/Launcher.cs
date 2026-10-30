// Build as a Windows GUI executable. No shell, console window, API key or absolute machine path.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class DaFeiYuLauncher
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    internal static uint ActivateMessage;

    internal static Uri SessionUrl(string line)
    {
        const string prefix = "DaFeiYu Launcher: ";
        if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)) return null;
        Uri uri;
        if (!Uri.TryCreate(line.Substring(prefix.Length), UriKind.Absolute, out uri) ||
            uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port < 25600 || uri.Port > 25699 ||
            uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.UserInfo.Length != 0 ||
            !Regex.IsMatch(uri.Fragment, "^#[a-f0-9]{64}$"))
            throw new InvalidDataException("启动器返回的本机会话地址无效。");
        return uri;
    }

    internal static bool SameOrigin(Uri target, Uri home)
    {
        return target != null && target.Scheme == home.Scheme && target.Host == home.Host &&
            target.Port == home.Port && target.UserInfo.Length == 0;
    }
    // Windows argv escaping, including quoted paths ending in a backslash.
    internal static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }

    internal static string ForwardArguments(string[] args)
    {
        List<string> result = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            string item = args[i];
            if (item == "--no-open" || item == "--preview" || item == "--ui-smoke") result.Add(Quote(item));
            else if (item == "--port")
            {
                int port;
                if (++i >= args.Length || !Int32.TryParse(args[i], out port) || port < 25600 || port > 25699)
                    throw new ArgumentException("启动器端口必须在 25600–25699 之间。");
                result.Add(Quote(item)); result.Add(Quote(port.ToString()));
            }
            else throw new ArgumentException("不支持的启动选项。可用 --no-open、--preview、--port。");
        }
        return String.Join(" ", result.ToArray());
    }

    private static string FindNode(string root)
    {
        string selected = Environment.GetEnvironmentVariable("DSH_NODE");
        if (!String.IsNullOrEmpty(selected))
        {
            if (!File.Exists(selected)) throw new FileNotFoundException("DSH_NODE 指向的 Node.js 不存在，请修改此环境变量。");
            return Path.GetFullPath(selected);
        }
        foreach (string candidate in new string[] { Path.Combine(root, "ai-vtuber", "node22", "node.exe"), Path.Combine(root, "node22", "node.exe") })
            if (File.Exists(candidate)) return candidate;
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (String.IsNullOrWhiteSpace(dir)) continue;
            try { string candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe"); if (File.Exists(candidate)) return candidate; }
            catch (ArgumentException) { }
        }
        throw new FileNotFoundException("未找到 Node.js 22+。请保留随附 ai-vtuber\\node22，或安装 Node.js，或设置 DSH_NODE。");
    }

    private static string Redact(string value)
    {
        value = Regex.Replace(value, @"http://127\.0\.0\.1:\d+/#\S+", "[本机会话地址已隐藏]");
        return Regex.Replace(value, @"\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)", "[已隐藏]");
    }

    private static int SelfTest()
    {
        int count = 0;
        Action<bool> check = delegate(bool ok) { if (!ok) throw new Exception("Self-test failed at " + count); count++; };
        check(Quote("") == "\"\"");
        check(Quote("plain") == "\"plain\"");
        check(Quote("含 空格") == "\"含 空格\"");
        check(Quote("a\"b") == "\"a\\\"b\"");
        check(Quote("C:\\folder\\") == "\"C:\\folder\\\\\"");
        check(ForwardArguments(new string[] { "--no-open", "--port", "25674" }) == "\"--no-open\" \"--port\" \"25674\"");
        bool invalid = false; try { ForwardArguments(new string[] { "--port", "25565" }); } catch (ArgumentException) { invalid = true; } check(invalid);
        invalid = false; try { ForwardArguments(new string[] { "--port" }); } catch (ArgumentException) { invalid = true; } check(invalid);
        invalid = false; try { ForwardArguments(new string[] { "--unknown" }); } catch (ArgumentException) { invalid = true; } check(invalid);
        check(!Redact("sk-abcdefghijkl http://127.0.0.1:25673/#private").Contains("private"));
        check(!Redact("sk-abcdefghijkl").Contains("abcdefghijkl"));
        Uri home = SessionUrl("DaFeiYu Launcher: http://127.0.0.1:25673/#" + new string('a', 64));
        check(home.Port == 25673);
        check(SessionUrl("unrelated log") == null);
        foreach (string bad in new string[] { "http://example.com:25673/#", "http://127.0.0.1:25565/#", "http://127.0.0.1:25673/path#", "http://127.0.0.1:25673/?x=1#", "http://user@127.0.0.1:25673/#" })
        {
            invalid = false; try { SessionUrl("DaFeiYu Launcher: " + bad + new string('a', 64)); } catch (InvalidDataException) { invalid = true; } check(invalid);
        }
        check(SameOrigin(new Uri("http://127.0.0.1:25673/app.js"), home));
        check(!SameOrigin(new Uri("http://127.0.0.1:25674/"), home));
        check(!SameOrigin(new Uri("https://example.com/"), home));
        Console.WriteLine("Launcher self-test: " + count + "/" + count + " passed; no service, window or game started.");
        return 0;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool selfTest = args.Length == 1 && args[0] == "--self-test";
        try
        {
            if (selfTest) return SelfTest();
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string client = root;
            string script = Path.Combine(client, "launcher", "server.mjs");
            if (!File.Exists(script)) throw new FileNotFoundException("找不到启动器文件。请把本 EXE 放在新项目根目录，并保留 launcher 文件夹。");
            string forwarded = ForwardArguments(args);
            string key;
            using (SHA256 sha = SHA256.Create()) key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
            ActivateMessage = RegisterWindowMessage("DaFeiYu.Launcher.Activate." + key);
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\DaFeiYu.Launcher." + key, out created))
            {
                if (!created) { PostMessage(new IntPtr(0xffff), ActivateMessage, IntPtr.Zero, IntPtr.Zero); return 0; }
                string vendor = Path.Combine(client, "launcher", "vendor", "webview2");
                AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e) {
                    string name = new AssemblyName(e.Name).Name;
                    if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
                    return Assembly.LoadFrom(Path.Combine(vendor, name + ".dll"));
                };
                if (LoadLibrary(Path.Combine(vendor, "WebView2Loader.dll")) == IntPtr.Zero)
                    throw new FileNotFoundException("缺少 WebView2 组件，请保留 launcher/vendor/webview2 整个目录。");
                RunDesktop(root, client, script, forwarded, key);
                mutex.ReleaseMutex();
                return 0;
            }
        }
        catch (Exception error)
        {
            if (selfTest) Console.Error.WriteLine(error.Message);
            else { Application.EnableVisualStyles(); MessageBox.Show(Redact(error.Message), "大肥鱼启动器", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            return 1;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunDesktop(string root, string client, string script, string forwarded, string key)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new LauncherWindow(FindNode(root), client, script, forwarded, key));
    }

    private sealed class LauncherWindow : Form
    {
        private readonly WebView2 view = new WebView2();
        private readonly Label status = new Label();
        private readonly StringBuilder errors = new StringBuilder();
        private readonly string node, client, script, forwarded, key;
        private Process child;
        private Uri home;
        private bool closing;

        private async Task<Uri> ReadSession()
        {
            string line; int count = 0;
            while ((line = await child.StandardOutput.ReadLineAsync()) != null)
            {
                count++;
                Uri found = SessionUrl(line);
                if (found != null) return found;
                if (errors.Length < 2000) errors.AppendLine(Redact(line));
            }
            string detail = await child.StandardError.ReadToEndAsync();
            child.WaitForExit();
            throw new Exception("本地服务未返回界面地址，退出码 " + child.ExitCode + "，输出行数 " + count + "。\n" + Redact(detail) + errors);
        }

        internal LauncherWindow(string node, string client, string script, string forwarded, string key)
        {
            this.node = node; this.client = client; this.script = script; this.forwarded = forwarded; this.key = key;
            if (forwarded.Contains("--ui-smoke")) { ShowInTaskbar = false; WindowState = FormWindowState.Minimized; Opacity = 0; }
            Text = "大肥鱼 · Minecraft 陪玩"; StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1200, 760); MinimumSize = new Size(960, 640);
            AutoScaleDimensions = new SizeF(96F,96F); AutoScaleMode = AutoScaleMode.Dpi; BackColor = Color.FromArgb(24, 33, 52);
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            view.Dock = DockStyle.Fill; view.Visible = false; Controls.Add(view);
            status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleCenter;
            status.ForeColor = Color.White; status.Font = new Font("Microsoft YaHei UI", 12);
            status.Text = "正在打开大肥鱼启动器…"; Controls.Add(status);
            Shown += async delegate { await Initialize(); };
        }

        protected override void WndProc(ref Message message)
        {
            if ((uint)message.Msg == ActivateMessage)
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Show(); Activate();
            }
            base.WndProc(ref message);
        }

        private async Task Initialize()
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(node, Quote(script) + " --no-open " + forwarded);
                start.WorkingDirectory = client; start.UseShellExecute = false; start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
                child = new Process(); child.StartInfo = start;
                child.Start();
                // Read the pipe itself: a fast reuse process can exit before event-based readers attach.
                Task<Uri> ready = ReadSession();
                if (await Task.WhenAny(ready, Task.Delay(15000)) != ready) throw new TimeoutException("本地启动器服务未在 15 秒内就绪，请重新打开。");
                home = await ready;
                if (IsDisposed) return;
                string profile = Path.Combine(client, "runtime", "launcher", "webview2");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await view.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                view.CoreWebView2.Settings.AreDevToolsEnabled = false;
                view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                    Uri target; e.Cancel = !Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || !SameOrigin(target, home);
                };
                view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                view.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { Uri target; e.State = e.PermissionKind == CoreWebView2PermissionKind.Microphone && Uri.TryCreate(e.Uri, UriKind.Absolute, out target) && SameOrigin(target, home) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny; };
                view.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
                view.CoreWebView2.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                    if (!e.IsSuccess) { view.Visible = false; status.Text = "界面加载失败：" + e.WebErrorStatus + "\n请关闭窗口后重新打开。"; status.Visible = true; }
                    else { status.Visible = false; view.Visible = true; view.Focus(); }
                    if (e.IsSuccess && forwarded.Contains("--ui-smoke")) {
                        for (int i=0;i<30;i++) { if (await view.CoreWebView2.ExecuteScriptAsync("Boolean(window.launcherReady)") == "true") break; await Task.Delay(100); }
                        string proof = await view.CoreWebView2.ExecuteScriptAsync("(()=>{document.querySelector('[data-page=voice]').click();const voiceFields=document.querySelectorAll('#fields input,#fields select').length;document.querySelector('[data-page=models]').click();const keyMasked=document.querySelector('[name=apiKey]').type==='password';document.querySelector('[data-page=prompt]').click();const p=document.querySelector('[name=customPrompt]');p.value='smoke';p.dispatchEvent(new Event('input'));document.querySelector('#fields button.secondary').click();const resetDefault=document.querySelector('[name=customPrompt]').value==='';document.querySelector('[data-page=home]').click();return {ready:Boolean(window.launcherReady),title:document.title,layout:getComputedStyle(document.querySelector('.app-shell')).display,heading:document.querySelector('h1').innerText,status:document.querySelector('#status').innerText,width:innerWidth,contentWidth:document.body.scrollWidth,voiceFields,keyMasked,resetDefault}})()");
                        Directory.CreateDirectory(Path.Combine(client,"runtime","launcher"));
                        File.WriteAllText(Path.Combine(client,"runtime","launcher","native-ui-smoke.json"), proof, Encoding.UTF8);
                        Close();
                    }
                };
                view.CoreWebView2.Navigate(home.AbsoluteUri);
            }
            catch (Exception error)
            {
                if (!IsDisposed) status.Text = "启动器未能打开\n\n" + Redact(error.Message) + "\n\n请确认已安装 Microsoft Edge WebView2 Runtime，并保留完整陪玩目录。";
            }
        }
        protected override async void OnFormClosing(FormClosingEventArgs e)
        {
            if (closing || home == null) { base.OnFormClosing(e); return; }
            e.Cancel = true;
            try {
                var request = System.Net.WebRequest.Create(new Uri(home,"/api/exit"));
                request.Method = "POST"; request.ContentType = "application/json";
                request.Headers[System.Net.HttpRequestHeader.Authorization] = "Bearer " + home.Fragment.Substring(1);
                byte[] body = Encoding.UTF8.GetBytes("{}"); request.ContentLength = body.Length;
                using (var stream = await request.GetRequestStreamAsync()) await stream.WriteAsync(body,0,body.Length);
                using (var response = await request.GetResponseAsync()) { }
                closing = true; Close();
            } catch (Exception error) { status.Text = "安全退出尚未完成，请稍后重试。\n" + Redact(error.Message); status.Visible = true; }
        }
    }
}


