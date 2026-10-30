# WebView2 SDK files

Microsoft.Web.WebView2 **1.0.4258.31**, from the official NuGet package:
https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31

Included unchanged: `lib/net462/Microsoft.Web.WebView2.Core.dll`, `lib/net462/Microsoft.Web.WebView2.WinForms.dll`, and `runtimes/win-x64/native/WebView2Loader.dll`, plus the original LICENSE.txt and NOTICE.txt. Keep these notices when redistributing. This is the x64 Windows desktop launcher; it requires .NET Framework 4.6.2+ and the Microsoft Edge WebView2 Evergreen Runtime. The runtime itself is not bundled.

The existing launcher HTML/CSS/JS runs inside a WinForms WebView2 control. It does not launch a default browser. No Electron, npm desktop framework or remote UI is required. WebView2 user data stays under the user's LocalAppData/DaFeiYuLauncher, separate from shared project files.
