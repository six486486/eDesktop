param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'set', 'server', 'shortcut')]
  [string]$Mode,
  [string]$Name = '',
  [int]$X = 0,
  [int]$Y = 0
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class DesktopIconInfo
{
    public string Name { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
}

public sealed class DesktopPointerInfo
{
    public int X { get; set; }
    public int Y { get; set; }
    public bool LeftDown { get; set; }
    public bool RightDown { get; set; }
    public bool MiddleDown { get; set; }
}

public sealed class DesktopOrganizerBandInfo
{
    public bool HealthyBefore { get; set; }
    public bool HealthyAfter { get; set; }
    public bool Repaired { get; set; }
    public long IconHost { get; set; }
    public long OrganizerHost { get; set; }
    public long[] Handles { get; set; }
    public long[] RepairedHandles { get; set; }
    public bool Reordered { get; set; }
    public string Reason { get; set; }
}

public sealed class DesktopWindowGeometryInfo
{
    public long Handle { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public int RenderWidth { get; set; }
    public int RenderHeight { get; set; }
    public uint Dpi { get; set; }
    public bool Valid { get; set; }
}

public sealed class DesktopMoveInfo
{
    public string SourcePath { get; set; }
    public string DestinationPath { get; set; }
    public bool IsDirectory { get; set; }
}

public static class DesktopIconNative
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LVITEM
    {
        public uint mask;
        public int iItem;
        public int iSubItem;
        public uint state;
        public uint stateMask;
        public IntPtr pszText;
        public int cchTextMax;
        public int iImage;
        public IntPtr lParam;
        public int iIndent;
        public int iGroupId;
        public uint cColumns;
        public IntPtr puColumns;
        public IntPtr piColFmt;
        public int iGroup;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool EnableWindow(IntPtr hwnd, bool enable);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hwnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern IntPtr BeginDeferWindowPos(int windowCount);

    [DllImport("user32.dll")]
    private static extern IntPtr DeferWindowPos(
        IntPtr deferredPosition,
        IntPtr hwnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern bool EndDeferWindowPos(IntPtr deferredPosition);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool RedrawWindow(IntPtr hwnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint allocationType, uint protection);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(uint eventId, uint flags, string item1, string item2);

    [DllImport("shell32.dll", EntryPoint = "SHChangeNotify")]
    private static extern void SHChangeNotifyPointer(uint eventId, uint flags, IntPtr item1, IntPtr item2);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(
        string path,
        uint fileAttributes,
        ref SHFILEINFO fileInfo,
        uint fileInfoSize,
        uint flags
    );

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHGetFileInfoW")]
    private static extern IntPtr SHGetFileInfoFromPidl(
        IntPtr pidl,
        uint fileAttributes,
        ref SHFILEINFO fileInfo,
        uint fileInfoSize,
        uint flags
    );

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(
        string name,
        IntPtr bindingContext,
        out IntPtr pidl,
        uint attributesIn,
        out uint attributesOut
    );

    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr pointer);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHDefExtractIcon(
        string iconFile,
        int iconIndex,
        uint flags,
        out IntPtr largeIcon,
        out IntPtr smallIcon,
        uint iconSize
    );

    private const uint LVM_FIRST = 0x1000;
    private const uint LVM_GETITEMCOUNT = LVM_FIRST + 4;
    private const uint LVM_GETITEMPOSITION = LVM_FIRST + 16;
    private const uint LVM_GETITEMSTATE = LVM_FIRST + 44;
    private const uint LVM_GETITEMTEXTW = LVM_FIRST + 115;
    private const uint LVM_SETITEMPOSITION32 = LVM_FIRST + 49;
    private const uint PROCESS_ACCESS = 0x0400 | 0x0010 | 0x0020 | 0x0008;
    private const uint MEM_COMMIT = 0x1000;
    private const uint MEM_RESERVE = 0x2000;
    private const uint MEM_RELEASE = 0x8000;
    private const uint PAGE_READWRITE = 0x04;
    private const uint SHCNE_RENAMEITEM = 0x00000001;
    private const uint SHCNE_UPDATEDIR = 0x00001000;
    private const uint SHCNE_RENAMEFOLDER = 0x00020000;
    private const uint SHCNF_PATHW = 0x0005;
    private const uint SHCNF_IDLIST = 0x0000;
    private const uint SHCNF_FLUSH = 0x1000;
    private const uint SHCNE_ASSOCCHANGED = 0x08000000;
    private const uint WM_COMMAND = 0x0111;
    private const int FCIDM_SHVIEW_REFRESH = 0x7103;
    private const uint SHGFI_ICON = 0x00000100;
    private const uint SHGFI_PIDL = 0x00000008;
    private const uint SHGFI_LARGEICON = 0x00000000;
    private const uint LVIS_SELECTED = 0x0002;
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint SMTO_ERRORONEXIT = 0x0020;
    private const uint DESKTOP_MESSAGE_TIMEOUT_MS = 400;
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const int WS_CHILD = 0x40000000;
    private const int WS_POPUP = unchecked((int)0x80000000);
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const uint GW_HWNDNEXT = 2;
    private const uint GW_HWNDPREV = 3;
    private const uint GW_CHILD = 5;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint RDW_INVALIDATE = 0x0001;
    private const uint RDW_UPDATENOW = 0x0100;
    private const uint RDW_ALLCHILDREN = 0x0080;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    private static IntPtr SendDesktopMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        IntPtr result;
        IntPtr delivered = SendMessageTimeout(
            hwnd,
            message,
            wParam,
            lParam,
            SMTO_BLOCK | SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            DESKTOP_MESSAGE_TIMEOUT_MS,
            out result
        );
        if (delivered == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            throw new TimeoutException("Explorer desktop window did not respond (Win32 " + error + ").");
        }
        return result;
    }

    private static IntPtr FindDesktopDefView()
    {
        IntPtr defView = IntPtr.Zero;
        IntPtr progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero) defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero)
        {
            EnumWindows((top, unused) =>
            {
                IntPtr candidate = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (candidate == IntPtr.Zero) return true;
                defView = candidate;
                return false;
            }, IntPtr.Zero);
        }
        return defView;
    }

    private static IntPtr FindListView()
    {
        IntPtr defView = FindDesktopDefView();
        return defView == IntPtr.Zero
            ? IntPtr.Zero
            : FindWindowEx(defView, IntPtr.Zero, "SysListView32", "FolderView");
    }

    private static IntPtr FindDesktopIconHost()
    {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr iconHost = IntPtr.Zero;
        EnumWindows((top, lParam) =>
        {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            {
                iconHost = top;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return iconHost != IntPtr.Zero ? iconHost : progman;
    }

    private static bool OrganizerBandIsHealthy(IntPtr iconHost, IntPtr organizerHost, IntPtr[] handles, out string reason)
    {
        if (iconHost == IntPtr.Zero || !IsWindow(iconHost))
        {
            reason = "desktop-icon-host-missing";
            return false;
        }
        if (organizerHost == IntPtr.Zero || !IsWindow(organizerHost))
        {
            reason = "organizer-host-missing";
            return false;
        }
        bool directDesktopChildren = organizerHost == iconHost;
        if (!directDesktopChildren)
        {
            int organizerHostStyle = GetWindowLong(organizerHost, GWL_STYLE);
            int organizerHostExtendedStyle = GetWindowLong(organizerHost, GWL_EXSTYLE);
            if (
                GetParent(organizerHost) != iconHost
                || (organizerHostStyle & WS_CHILD) == 0
                || (organizerHostStyle & WS_POPUP) != 0
            )
            {
                reason = "organizer-host-parent-drift";
                return false;
            }
            if ((organizerHostExtendedStyle & WS_EX_TRANSPARENT) != 0)
            {
                reason = "organizer-host-transparent";
                return false;
            }
            IntPtr iconView = FindWindowEx(iconHost, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (iconView != IntPtr.Zero)
            {
                bool organizerHostSeen = false;
                IntPtr desktopChild = GetWindow(iconHost, GW_CHILD);
                while (desktopChild != IntPtr.Zero)
                {
                    if (desktopChild == organizerHost) organizerHostSeen = true;
                    if (desktopChild == iconView)
                    {
                        if (!organizerHostSeen)
                        {
                            reason = "organizer-host-order-drift";
                            return false;
                        }
                        break;
                    }
                    desktopChild = GetWindow(desktopChild, GW_HWNDNEXT);
                }
            }
        }

        foreach (IntPtr handle in handles)
        {
            if (handle == IntPtr.Zero || !IsWindow(handle))
            {
                reason = "organizer-window-missing";
                return false;
            }
            if (!IsWindowVisible(handle) || !IsWindowEnabled(handle))
            {
                reason = "organizer-window-hidden-or-disabled";
                return false;
            }
            int extendedStyle = GetWindowLong(handle, GWL_EXSTYLE);
            if ((extendedStyle & WS_EX_TRANSPARENT) != 0)
            {
                reason = "organizer-window-transparent";
                return false;
            }
            if ((extendedStyle & WS_EX_NOACTIVATE) != 0)
            {
                reason = "organizer-window-nonactivating";
                return false;
            }
            int style = GetWindowLong(handle, GWL_STYLE);
            if (GetParent(handle) != organizerHost || (style & WS_CHILD) == 0 || (style & WS_POPUP) != 0)
            {
                reason = "desktop-child-host-drift";
                return false;
            }
        }

        // Do not treat organizer-to-organizer order as a health invariant.
        // Windows/Chromium may legitimately move the focused WS_CHILD within
        // this host before the renderer's pointer-up IPC reaches the main
        // process. Repairing that normal focus order on the next watchdog pass
        // recomposed every transparent sibling and made unrelated organizers
        // flash. Parent/style/visibility remain structural health invariants;
        // organizer order is owned only by the explicit click-overlap path.
        reason = "healthy";
        return true;
    }

    private static IntPtr FindRenderWidgetHost(IntPtr parent)
    {
        IntPtr fallbackRenderWidgetHost = IntPtr.Zero;
        IntPtr activeRenderWidgetHost = IntPtr.Zero;
        EnumChildWindows(parent, (child, unused) =>
        {
            var className = new StringBuilder(256);
            GetClassName(child, className, className.Capacity);
            if (!String.Equals(className.ToString(), "Chrome_RenderWidgetHostHWND", StringComparison.Ordinal)) return true;
            if (fallbackRenderWidgetHost == IntPtr.Zero) fallbackRenderWidgetHost = child;
            if (IsWindowVisible(child) && IsWindowEnabled(child))
            {
                activeRenderWidgetHost = child;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return activeRenderWidgetHost != IntPtr.Zero ? activeRenderWidgetHost : fallbackRenderWidgetHost;
    }

    private static IntPtr ParseWindowHandle(string rawHandle)
    {
        ulong numericHandle;
        if (!UInt64.TryParse(rawHandle, out numericHandle) || numericHandle == 0) return IntPtr.Zero;
        return new IntPtr(unchecked((long)numericHandle));
    }

    private static DesktopWindowGeometryInfo ReadWindowGeometry(IntPtr handle)
    {
        var result = new DesktopWindowGeometryInfo { Handle = handle.ToInt64(), Valid = false };
        if (handle == IntPtr.Zero || !IsWindow(handle)) return result;

        RECT windowRect;
        RECT clientRect;
        if (!GetWindowRect(handle, out windowRect) || !GetClientRect(handle, out clientRect)) return result;
        IntPtr renderChild = FindRenderWidgetHost(handle);
        RECT renderRect = new RECT();
        bool hasRenderRect = renderChild != IntPtr.Zero && GetWindowRect(renderChild, out renderRect);
        result.X = windowRect.Left;
        result.Y = windowRect.Top;
        result.Width = Math.Max(0, windowRect.Right - windowRect.Left);
        result.Height = Math.Max(0, windowRect.Bottom - windowRect.Top);
        result.ClientWidth = Math.Max(0, clientRect.Right - clientRect.Left);
        result.ClientHeight = Math.Max(0, clientRect.Bottom - clientRect.Top);
        result.RenderWidth = hasRenderRect ? Math.Max(0, renderRect.Right - renderRect.Left) : 0;
        result.RenderHeight = hasRenderRect ? Math.Max(0, renderRect.Bottom - renderRect.Top) : 0;
        result.Dpi = GetDpiForWindow(handle);
        result.Valid = result.Dpi > 0;
        return result;
    }

    public static DesktopWindowGeometryInfo[] GetWindowGeometries(string[] rawHandles)
    {
        IntPtr previousContext = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        try
        {
            var results = new List<DesktopWindowGeometryInfo>();
            foreach (string rawHandle in rawHandles ?? new string[0])
            {
                IntPtr handle = ParseWindowHandle(rawHandle);
                if (handle != IntPtr.Zero) results.Add(ReadWindowGeometry(handle));
            }
            return results.ToArray();
        }
        finally
        {
            if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext);
        }
    }

    public static DesktopWindowGeometryInfo ResizeWindowForDpi(string rawHandle, int logicalWidth, int logicalHeight)
    {
        IntPtr previousContext = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        try
        {
            IntPtr handle = ParseWindowHandle(rawHandle);
            if (handle == IntPtr.Zero || !IsWindow(handle)) return ReadWindowGeometry(handle);
            uint dpi = GetDpiForWindow(handle);
            if (dpi == 0) dpi = 96;
            int physicalWidth = Math.Max(1, (int)Math.Round(Math.Max(1, logicalWidth) * dpi / 96.0));
            int physicalHeight = Math.Max(1, (int)Math.Round(Math.Max(1, logicalHeight) * dpi / 96.0));
            SetWindowPos(
                handle,
                IntPtr.Zero,
                0,
                0,
                physicalWidth,
                physicalHeight,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
            );
            IntPtr renderChild = FindRenderWidgetHost(handle);
            RECT renderRect;
            if (
                renderChild != IntPtr.Zero
                && GetWindowRect(renderChild, out renderRect)
                && (
                    Math.Abs((renderRect.Right - renderRect.Left) - physicalWidth) > 4
                    || Math.Abs((renderRect.Bottom - renderRect.Top) - physicalHeight) > 4
                )
            )
            {
                SetWindowPos(
                    renderChild,
                    IntPtr.Zero,
                    0,
                    0,
                    physicalWidth,
                    physicalHeight,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
                );
            }
            RedrawWindow(handle, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
            return ReadWindowGeometry(handle);
        }
        finally
        {
            if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext);
        }
    }

    public static DesktopWindowGeometryInfo SetWindowClientBounds(
        string rawHandle,
        int x,
        int y,
        int width,
        int height
    )
    {
        IntPtr previousContext = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        try
        {
            IntPtr handle = ParseWindowHandle(rawHandle);
            if (handle == IntPtr.Zero || !IsWindow(handle)) return ReadWindowGeometry(handle);
            SetWindowPos(
                handle,
                IntPtr.Zero,
                x,
                y,
                Math.Max(1, width),
                Math.Max(1, height),
                SWP_NOZORDER | SWP_NOACTIVATE
            );
            return ReadWindowGeometry(handle);
        }
        finally
        {
            if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext);
        }
    }

    public static DesktopWindowGeometryInfo StabilizeWindowClientSize(string rawHandle, int physicalWidth, int physicalHeight)
    {
        IntPtr previousContext = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        try
        {
            IntPtr handle = ParseWindowHandle(rawHandle);
            if (handle == IntPtr.Zero || !IsWindow(handle)) return ReadWindowGeometry(handle);
            int safeWidth = Math.Max(1, physicalWidth);
            int safeHeight = Math.Max(1, physicalHeight);
            SetWindowPos(
                handle,
                IntPtr.Zero,
                0,
                0,
                safeWidth,
                safeHeight,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
            );
            IntPtr renderChild = FindRenderWidgetHost(handle);
            if (renderChild == IntPtr.Zero || !IsWindow(renderChild)) return ReadWindowGeometry(handle);
            SetWindowPos(
                renderChild,
                IntPtr.Zero,
                0,
                0,
                safeWidth,
                safeHeight,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
            );
            RedrawWindow(handle, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
            return ReadWindowGeometry(handle);
        }
        finally
        {
            if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext);
        }
    }

    public static DesktopOrganizerBandInfo EnsureOrganizerBand(string rawOrganizerHost, string[] rawHandles)
    {
        IntPtr organizerHost = ParseWindowHandle(rawOrganizerHost);
        var handles = new List<IntPtr>();
        foreach (string rawHandle in rawHandles ?? new string[0])
        {
            ulong numericHandle;
            if (!UInt64.TryParse(rawHandle, out numericHandle) || numericHandle == 0) continue;
            handles.Add(new IntPtr(unchecked((long)numericHandle)));
        }

        IntPtr iconHost = FindDesktopIconHost();
        bool directDesktopChildren = organizerHost == IntPtr.Zero;
        if (directDesktopChildren) organizerHost = iconHost;
        string reason;
        bool healthyBefore = OrganizerBandIsHealthy(iconHost, organizerHost, handles.ToArray(), out reason);
        bool repaired = false;
        bool reordered = false;
        var repairedHandles = new List<long>();

        if (
            !healthyBefore
            && iconHost != IntPtr.Zero
            && IsWindow(iconHost)
            && organizerHost != IntPtr.Zero
            && IsWindow(organizerHost)
            && handles.Count > 0
        )
        {
            bool repairOrganizerOrder = false;
            if (!directDesktopChildren)
            {
                RECT organizerHostRect;
                bool hasOrganizerHostRect = GetWindowRect(organizerHost, out organizerHostRect);
                POINT organizerHostOrigin = new POINT {
                    X = hasOrganizerHostRect ? organizerHostRect.Left : 0,
                    Y = hasOrganizerHostRect ? organizerHostRect.Top : 0,
                };
                if (hasOrganizerHostRect) ScreenToClient(iconHost, ref organizerHostOrigin);
                int organizerHostStyle = GetWindowLong(organizerHost, GWL_STYLE);
                int nextOrganizerHostStyle = (organizerHostStyle | WS_CHILD) & ~WS_POPUP;
                int organizerHostExtendedStyle = GetWindowLong(organizerHost, GWL_EXSTYLE);
                int nextOrganizerHostExtendedStyle = (organizerHostExtendedStyle | WS_EX_NOACTIVATE) & ~WS_EX_TRANSPARENT;
                bool organizerHostStyleChanged = nextOrganizerHostStyle != organizerHostStyle
                    || nextOrganizerHostExtendedStyle != organizerHostExtendedStyle;
                bool organizerHostParentChanged = GetParent(organizerHost) != iconHost;
                bool organizerHostOrderChanged = String.Equals(reason, "organizer-host-order-drift", StringComparison.Ordinal);
                if (nextOrganizerHostStyle != organizerHostStyle) SetWindowLong(organizerHost, GWL_STYLE, nextOrganizerHostStyle);
                if (nextOrganizerHostExtendedStyle != organizerHostExtendedStyle) SetWindowLong(organizerHost, GWL_EXSTYLE, nextOrganizerHostExtendedStyle);
                if (organizerHostParentChanged) SetParent(organizerHost, iconHost);
                if (hasOrganizerHostRect && (organizerHostStyleChanged || organizerHostParentChanged || organizerHostOrderChanged))
                {
                    SetWindowPos(
                        organizerHost,
                        HWND_TOP,
                        organizerHostOrigin.X,
                        organizerHostOrigin.Y,
                        Math.Max(1, organizerHostRect.Right - organizerHostRect.Left),
                        Math.Max(1, organizerHostRect.Bottom - organizerHostRect.Top),
                        SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED
                    );
                }
                else if (organizerHostStyleChanged || organizerHostParentChanged || organizerHostOrderChanged)
                {
                    SetWindowPos(
                        organizerHost,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
                    );
                }
            }

            foreach (IntPtr handle in handles)
            {
                if (handle == IntPtr.Zero || !IsWindow(handle)) continue;
                RECT screenRect;
                bool hasScreenRect = GetWindowRect(handle, out screenRect);
                POINT clientOrigin = new POINT {
                    X = hasScreenRect ? screenRect.Left : 0,
                    Y = hasScreenRect ? screenRect.Top : 0,
                };
                if (hasScreenRect) ScreenToClient(organizerHost, ref clientOrigin);

                int style = GetWindowLong(handle, GWL_STYLE);
                int nextStyle = (style | WS_CHILD) & ~WS_POPUP;
                int extendedStyle = GetWindowLong(handle, GWL_EXSTYLE);
                int nextExtendedStyle = extendedStyle & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT;
                bool styleChanged = nextStyle != style || nextExtendedStyle != extendedStyle;
                bool parentChanged = GetParent(handle) != organizerHost;
                bool visibilityChanged = !IsWindowVisible(handle);
                bool enabledChanged = !IsWindowEnabled(handle);
                if (nextStyle != style) SetWindowLong(handle, GWL_STYLE, nextStyle);
                if (styleChanged) SetWindowLong(handle, GWL_EXSTYLE, nextExtendedStyle);
                if (parentChanged) SetParent(handle, organizerHost);
                if (enabledChanged) EnableWindow(handle, true);
                if (styleChanged || parentChanged || visibilityChanged || enabledChanged)
                {
                    repairedHandles.Add(handle.ToInt64());
                }
                if (hasScreenRect && (styleChanged || parentChanged || visibilityChanged || enabledChanged))
                {
                    uint geometryFlags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
                    if (styleChanged) geometryFlags |= SWP_FRAMECHANGED;
                    SetWindowPos(
                        handle,
                        IntPtr.Zero,
                        clientOrigin.X,
                        clientOrigin.Y,
                        Math.Max(1, screenRect.Right - screenRect.Left),
                        Math.Max(1, screenRect.Bottom - screenRect.Top),
                        geometryFlags
                    );
                }
                else if (styleChanged || parentChanged || visibilityChanged || enabledChanged)
                {
                    uint repairFlags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
                    if (styleChanged) repairFlags |= SWP_FRAMECHANGED;
                    SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, repairFlags);
                }
                if (parentChanged) repairOrganizerOrder = true;
            }

            // Reorder the whole band only when its relative organizer order is
            // genuinely damaged or a child had to be reparented. Style/input
            // recovery for one HWND must not recompose every sibling window.
            if (repairOrganizerOrder)
            {
                reordered = true;
                IntPtr deferred = BeginDeferWindowPos(handles.Count);
                bool deferredValid = deferred != IntPtr.Zero;
                foreach (IntPtr handle in handles)
                {
                    if (handle == IntPtr.Zero || !IsWindow(handle)) continue;
                    if (deferredValid)
                    {
                        deferred = DeferWindowPos(
                            deferred,
                            handle,
                            HWND_TOP,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
                        );
                        deferredValid = deferred != IntPtr.Zero;
                    }
                }
                if (deferredValid) EndDeferWindowPos(deferred);
                else
                {
                    // HWND_TOP is safe here: for WS_CHILD it means only the top
                    // of this host's child list, never the global desktop order.
                    foreach (IntPtr handle in handles)
                    {
                        if (handle != IntPtr.Zero && IsWindow(handle)) SetWindowPos(
                            handle,
                            HWND_TOP,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
                        );
                    }
                }
            }
            repaired = true;
        }

        string finalReason;
        bool healthyAfter = OrganizerBandIsHealthy(iconHost, organizerHost, handles.ToArray(), out finalReason);
        var numericHandles = new long[handles.Count];
        for (int index = 0; index < handles.Count; index += 1) numericHandles[index] = handles[index].ToInt64();
        return new DesktopOrganizerBandInfo
        {
            HealthyBefore = healthyBefore,
            HealthyAfter = healthyAfter,
            Repaired = repaired,
            IconHost = iconHost.ToInt64(),
            OrganizerHost = organizerHost.ToInt64(),
            Handles = numericHandles,
            RepairedHandles = repairedHandles.ToArray(),
            Reordered = reordered,
            Reason = healthyAfter ? reason : finalReason,
        };
    }

    private static byte[] StructureBytes<T>(T value)
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr local = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(value, local, false);
            byte[] bytes = new byte[size];
            Marshal.Copy(local, bytes, 0, size);
            return bytes;
        }
        finally
        {
            Marshal.FreeHGlobal(local);
        }
    }

    private static DesktopIconInfo[] WithDesktopProcess(Func<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, List<DesktopIconInfo>> operation)
    {
        IntPtr listView = FindListView();
        if (listView == IntPtr.Zero) return new DesktopIconInfo[0];
        uint processId;
        GetWindowThreadProcessId(listView, out processId);
        IntPtr process = OpenProcess(PROCESS_ACCESS, false, processId);
        if (process == IntPtr.Zero) return new DesktopIconInfo[0];

        int itemSize = Marshal.SizeOf(typeof(LVITEM));
        int textSize = 1024 * 2;
        int pointSize = Marshal.SizeOf(typeof(POINT));
        IntPtr remoteItem = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)itemSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        IntPtr remoteText = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)textSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        IntPtr remotePoint = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)pointSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        try
        {
            return operation(listView, process, remoteItem, remoteText, remotePoint).ToArray();
        }
        finally
        {
            if (remoteItem != IntPtr.Zero) VirtualFreeEx(process, remoteItem, UIntPtr.Zero, MEM_RELEASE);
            if (remoteText != IntPtr.Zero) VirtualFreeEx(process, remoteText, UIntPtr.Zero, MEM_RELEASE);
            if (remotePoint != IntPtr.Zero) VirtualFreeEx(process, remotePoint, UIntPtr.Zero, MEM_RELEASE);
            CloseHandle(process);
        }
    }

    private static List<DesktopIconInfo> ReadItems(
        IntPtr listView,
        IntPtr process,
        IntPtr remoteItem,
        IntPtr remoteText,
        IntPtr remotePoint
    )
    {
        var results = new List<DesktopIconInfo>();
        int count = SendDesktopMessage(listView, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        for (int index = 0; index < count; index++)
        {
            var item = new LVITEM
            {
                iItem = index,
                iSubItem = 0,
                pszText = remoteText,
                cchTextMax = 1024
            };
            byte[] itemBytes = StructureBytes(item);
            IntPtr ignored;
            WriteProcessMemory(process, remoteItem, itemBytes, itemBytes.Length, out ignored);
            SendDesktopMessage(listView, LVM_GETITEMTEXTW, (IntPtr)index, remoteItem);
            byte[] textBytes = new byte[1024 * 2];
            ReadProcessMemory(process, remoteText, textBytes, textBytes.Length, out ignored);
            string rawName = Encoding.Unicode.GetString(textBytes);
            int terminator = rawName.IndexOf('\0');
            string name = terminator >= 0 ? rawName.Substring(0, terminator) : rawName;

            SendDesktopMessage(listView, LVM_GETITEMPOSITION, (IntPtr)index, remotePoint);
            byte[] pointBytes = new byte[Marshal.SizeOf(typeof(POINT))];
            ReadProcessMemory(process, remotePoint, pointBytes, pointBytes.Length, out ignored);
            int x = BitConverter.ToInt32(pointBytes, 0);
            int y = BitConverter.ToInt32(pointBytes, 4);
            results.Add(new DesktopIconInfo { Name = name, X = x, Y = y });
        }
        return results;
    }

    public static DesktopIconInfo[] GetItems()
    {
        return WithDesktopProcess((listView, process, remoteItem, remoteText, remotePoint) =>
        {
            return ReadItems(listView, process, remoteItem, remoteText, remotePoint);
        });
    }

    public static DesktopIconInfo[] GetSelectedItems()
    {
        return WithDesktopProcess((listView, process, remoteItem, remoteText, remotePoint) =>
        {
            List<DesktopIconInfo> items = ReadItems(listView, process, remoteItem, remoteText, remotePoint);
            var selected = new List<DesktopIconInfo>();
            for (int index = 0; index < items.Count; index++)
            {
                IntPtr state = SendDesktopMessage(listView, LVM_GETITEMSTATE, (IntPtr)index, (IntPtr)LVIS_SELECTED);
                if ((state.ToInt64() & LVIS_SELECTED) != 0) selected.Add(items[index]);
            }
            return selected;
        });
    }

    private static string IconDataFromHandle(IntPtr iconHandle)
    {
        if (iconHandle == IntPtr.Zero) return "";
        try
        {
            using (Icon icon = (Icon)Icon.FromHandle(iconHandle).Clone())
            using (Bitmap bitmap = icon.ToBitmap())
            using (var stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }
        finally
        {
            DestroyIcon(iconHandle);
        }
    }

    public static string GetShellIconData(string itemPath)
    {
        if (string.IsNullOrWhiteSpace(itemPath)) return "";
        var fileInfo = new SHFILEINFO();
        IntPtr result = SHGetFileInfo(
            itemPath,
            0,
            ref fileInfo,
            (uint)Marshal.SizeOf(typeof(SHFILEINFO)),
            SHGFI_ICON | SHGFI_LARGEICON
        );
        return result == IntPtr.Zero ? "" : IconDataFromHandle(fileInfo.hIcon);
    }

    public static string GetResourceIconData(string resourcePath, int resourceIndex)
    {
        if (string.IsNullOrWhiteSpace(resourcePath)) return "";
        IntPtr largeIcon;
        IntPtr smallIcon;
        int result = SHDefExtractIcon(resourcePath, resourceIndex, 0, out largeIcon, out smallIcon, (uint)(32 | (16 << 16)));
        if (smallIcon != IntPtr.Zero) DestroyIcon(smallIcon);
        return result < 0 ? "" : IconDataFromHandle(largeIcon);
    }

    public static string GetShellNamespaceIconData(string clsid)
    {
        if (string.IsNullOrWhiteSpace(clsid)) return "";
        IntPtr pidl;
        uint attributes;
        if (SHParseDisplayName("shell:::" + clsid, IntPtr.Zero, out pidl, 0, out attributes) < 0
            || pidl == IntPtr.Zero) return "";
        try
        {
            var fileInfo = new SHFILEINFO();
            IntPtr result = SHGetFileInfoFromPidl(
                pidl,
                0,
                ref fileInfo,
                (uint)Marshal.SizeOf(typeof(SHFILEINFO)),
                SHGFI_PIDL | SHGFI_ICON | SHGFI_LARGEICON
            );
            return result == IntPtr.Zero ? "" : IconDataFromHandle(fileInfo.hIcon);
        }
        finally
        {
            CoTaskMemFree(pidl);
        }
    }

    public static bool RefreshShellIcons()
    {
        SHChangeNotifyPointer(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, IntPtr.Zero, IntPtr.Zero);
        IntPtr defView = FindDesktopDefView();
        if (defView != IntPtr.Zero)
            SendDesktopMessage(defView, WM_COMMAND, new IntPtr(FCIDM_SHVIEW_REFRESH), IntPtr.Zero);
        return true;
    }

    public static int GetDesktopShellProcessId()
    {
        IntPtr shellWindow = FindWindow("Shell_TrayWnd", null);
        if (shellWindow == IntPtr.Zero) return 0;
        uint processId;
        GetWindowThreadProcessId(shellWindow, out processId);
        return unchecked((int)processId);
    }

    public static bool RestartDesktopShell()
    {
        int previousProcessId = GetDesktopShellProcessId();
        if (previousProcessId <= 0) return false;
        try
        {
            Process shellProcess = Process.GetProcessById(previousProcessId);
            shellProcess.Kill();
            shellProcess.WaitForExit(5000);
            shellProcess.Dispose();
        }
        catch
        {
            return false;
        }

        // AutoRestartShell normally creates the replacement. Start Explorer
        // ourselves only if Windows has not done so, avoiding an extra folder
        // window when the automatic restart was already successful.
        for (int attempt = 0; attempt < 30; attempt++)
        {
            Thread.Sleep(100);
            int currentProcessId = GetDesktopShellProcessId();
            if (currentProcessId > 0 && currentProcessId != previousProcessId) break;
            if (attempt == 14)
            {
                string explorerPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    "explorer.exe"
                );
                Process.Start(explorerPath);
            }
        }

        for (int attempt = 0; attempt < 50; attempt++)
        {
            if (FindListView() != IntPtr.Zero)
            {
                RefreshShellIcons();
                return true;
            }
            Thread.Sleep(100);
        }
        return false;
    }

    public static bool SetItemPosition(string name, int x, int y)
    {
        return SetItemPositions(new[] { new DesktopIconInfo { Name = name, X = x, Y = y } }).Length > 0;
    }

    public static DesktopIconInfo[] SetItemPositions(DesktopIconInfo[] requestedPositions)
    {
        if (requestedPositions == null || requestedPositions.Length == 0) return new DesktopIconInfo[0];
        return WithDesktopProcess((listView, process, remoteItem, remoteText, remotePoint) =>
        {
            List<DesktopIconInfo> items = ReadItems(listView, process, remoteItem, remoteText, remotePoint);
            var indicesByName = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < items.Count; index++)
            {
                if (!indicesByName.ContainsKey(items[index].Name)) indicesByName.Add(items[index].Name, index);
            }

            var positioned = new List<DesktopIconInfo>();
            var positionedIndices = new HashSet<int>();
            foreach (DesktopIconInfo requested in requestedPositions)
            {
                int index;
                if (requested == null
                    || string.IsNullOrWhiteSpace(requested.Name)
                    || !indicesByName.TryGetValue(requested.Name, out index)
                    || positionedIndices.Contains(index)) continue;

                DesktopIconInfo current = items[index];
                bool accepted = current.X == requested.X && current.Y == requested.Y;
                if (!accepted)
                {
                    byte[] pointBytes = StructureBytes(new POINT { X = requested.X, Y = requested.Y });
                    IntPtr ignored;
                    WriteProcessMemory(process, remotePoint, pointBytes, pointBytes.Length, out ignored);
                    accepted = SendDesktopMessage(listView, LVM_SETITEMPOSITION32, (IntPtr)index, remotePoint) != IntPtr.Zero;
                }
                if (!accepted) continue;
                positionedIndices.Add(index);
                positioned.Add(new DesktopIconInfo { Name = current.Name, X = requested.X, Y = requested.Y });
            }
            return positioned;
        });
    }

    public static bool NotifyMove(string sourcePath, string destinationPath, bool isDirectory)
    {
        // Even an unflushed SHChangeNotify can occasionally wait on Explorer. Run it on a
        // background pool thread so the server remains immediately available for list/set.
        ThreadPool.QueueUserWorkItem(unused =>
        {
            uint flags = SHCNF_PATHW;
            SHChangeNotify(isDirectory ? SHCNE_RENAMEFOLDER : SHCNE_RENAMEITEM, flags, sourcePath, destinationPath);

            string sourceDirectory = Path.GetDirectoryName(sourcePath);
            string destinationDirectory = Path.GetDirectoryName(destinationPath);
            if (!string.IsNullOrWhiteSpace(sourceDirectory))
                SHChangeNotify(SHCNE_UPDATEDIR, flags, sourceDirectory, null);
            if (!string.IsNullOrWhiteSpace(destinationDirectory)
                && !string.Equals(sourceDirectory, destinationDirectory, StringComparison.OrdinalIgnoreCase))
                SHChangeNotify(SHCNE_UPDATEDIR, flags, destinationDirectory, null);
        });
        return true;
    }

    public static bool NotifyDirectories(string[] directoryPaths)
    {
        if (directoryPaths == null || directoryPaths.Length == 0) return true;
        string[] paths = directoryPaths;
        ThreadPool.QueueUserWorkItem(unused =>
        {
            var notified = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string directoryPath in paths)
            {
                if (string.IsNullOrWhiteSpace(directoryPath) || !notified.Add(directoryPath)) continue;
                SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, directoryPath, null);
            }
        });
        return true;
    }

    public static bool NotifyMoves(DesktopMoveInfo[] moves)
    {
        if (moves == null || moves.Length == 0) return true;
        DesktopMoveInfo[] queuedMoves = moves;
        ThreadPool.QueueUserWorkItem(unused =>
        {
            var notifiedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (DesktopMoveInfo move in queuedMoves)
            {
                if (move == null
                    || string.IsNullOrWhiteSpace(move.SourcePath)
                    || string.IsNullOrWhiteSpace(move.DestinationPath)) continue;
                SHChangeNotify(
                    move.IsDirectory ? SHCNE_RENAMEFOLDER : SHCNE_RENAMEITEM,
                    SHCNF_PATHW,
                    move.SourcePath,
                    move.DestinationPath
                );
                string sourceDirectory = Path.GetDirectoryName(move.SourcePath);
                string destinationDirectory = Path.GetDirectoryName(move.DestinationPath);
                if (!string.IsNullOrWhiteSpace(sourceDirectory)) notifiedDirectories.Add(sourceDirectory);
                if (!string.IsNullOrWhiteSpace(destinationDirectory)) notifiedDirectories.Add(destinationDirectory);
            }
            foreach (string directoryPath in notifiedDirectories)
            {
                SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, directoryPath, null);
            }
        });
        return true;
    }

    public static bool NotifyMovesAndFlush(DesktopMoveInfo[] moves)
    {
        if (moves == null || moves.Length == 0) return true;
        var notifiedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (DesktopMoveInfo move in moves)
        {
            if (move == null
                || string.IsNullOrWhiteSpace(move.SourcePath)
                || string.IsNullOrWhiteSpace(move.DestinationPath)) continue;
            SHChangeNotify(
                move.IsDirectory ? SHCNE_RENAMEFOLDER : SHCNE_RENAMEITEM,
                SHCNF_PATHW,
                move.SourcePath,
                move.DestinationPath
            );
            string sourceDirectory = Path.GetDirectoryName(move.SourcePath);
            string destinationDirectory = Path.GetDirectoryName(move.DestinationPath);
            if (!string.IsNullOrWhiteSpace(sourceDirectory)) notifiedDirectories.Add(sourceDirectory);
            if (!string.IsNullOrWhiteSpace(destinationDirectory)) notifiedDirectories.Add(destinationDirectory);
        }
        string[] directories = new List<string>(notifiedDirectories).ToArray();
        for (int index = 0; index < directories.Length; index++)
        {
            uint flags = SHCNF_PATHW | (index == directories.Length - 1 ? SHCNF_FLUSH : 0u);
            SHChangeNotify(SHCNE_UPDATEDIR, flags, directories[index], null);
        }
        return true;
    }

    public static DesktopIconInfo GetCursorPosition()
    {
        DesktopPointerInfo pointer = GetPointerState();
        return pointer == null ? null : new DesktopIconInfo { Name = "", X = pointer.X, Y = pointer.Y };
    }

    public static DesktopPointerInfo GetPointerState()
    {
        // PowerShell normally inherits system-DPI awareness (the primary display's scale),
        // while the desktop ListView stores physical coordinates. Switch this call to PMv2
        // so mixed-DPI secondary displays use the same coordinate space as icon positions.
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr listView = FindListView();
        POINT point;
        if (listView == IntPtr.Zero || !GetCursorPos(out point) || !ScreenToClient(listView, ref point)) return null;
        bool leftDown = (GetAsyncKeyState(0x01) & 0x8000) != 0;
        bool rightDown = (GetAsyncKeyState(0x02) & 0x8000) != 0;
        bool middleDown = (GetAsyncKeyState(0x04) & 0x8000) != 0;
        return new DesktopPointerInfo {
            X = point.X,
            Y = point.Y,
            LeftDown = leftDown,
            RightDown = rightDown,
            MiddleDown = middleDown
        };
    }

    public static DesktopPointerInfo GetButtonState()
    {
        return new DesktopPointerInfo {
            X = 0,
            Y = 0,
            LeftDown = (GetAsyncKeyState(0x01) & 0x8000) != 0,
            RightDown = (GetAsyncKeyState(0x02) & 0x8000) != 0,
            MiddleDown = (GetAsyncKeyState(0x04) & 0x8000) != 0
        };
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies ([System.Drawing.Icon].Assembly.Location)

function Get-ShortcutInfo([string]$ShortcutPath, $ShortcutShell) {
  if ([string]::IsNullOrWhiteSpace($ShortcutPath) -or -not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    throw 'Shortcut does not exist.'
  }
  $shortcut = $ShortcutShell.CreateShortcut($ShortcutPath)
  return @{
    targetPath = [string]$shortcut.TargetPath
    iconLocation = [string]$shortcut.IconLocation
    workingDirectory = [string]$shortcut.WorkingDirectory
  }
}

$desktopIconVisibilityKeyPaths = [ordered]@{
  newStartPanel = 'Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel'
  classicStartMenu = 'Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\ClassicStartMenu'
}

function Get-DesktopShellItemVisibility([string]$Clsid) {
  $locations = [ordered]@{}
  foreach ($entry in $desktopIconVisibilityKeyPaths.GetEnumerator()) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($entry.Value)
    try {
      $exists = @($key.GetValueNames()) -contains $Clsid
      $value = if ($exists) { [int]$key.GetValue($Clsid, 0) } else { 0 }
      $locations[$entry.Key] = @{ exists = $exists; value = $value }
    } finally {
      $key.Dispose()
    }
  }
  $primary = $locations.newStartPanel
  return @{
    exists = $primary.exists
    value = $primary.value
    visible = (-not $primary.exists -or $primary.value -eq 0)
    locations = $locations
  }
}

function Set-DesktopShellItemVisibility([string]$Clsid, [bool]$Exists, [int]$Value, $States = $null) {
  foreach ($entry in $desktopIconVisibilityKeyPaths.GetEnumerator()) {
    $state = if ($null -ne $States -and $null -ne $States.($entry.Key)) {
      $States.($entry.Key)
    } elseif ($entry.Key -eq 'newStartPanel') {
      @{ exists = $Exists; value = $Value }
    } else {
      $null
    }
    if ($null -eq $state) { continue }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($entry.Value)
    try {
      if ([bool]$state.exists) {
        $key.SetValue($Clsid, [int]$state.value, [Microsoft.Win32.RegistryValueKind]::DWord)
      } else {
        $key.DeleteValue($Clsid, $false)
      }
    } finally {
      $key.Dispose()
    }
  }
  [DesktopIconNative]::RefreshShellIcons() | Out-Null
  return $true
}

if ($Mode -eq 'server') {
  $shortcutShell = New-Object -ComObject WScript.Shell
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $request = $line | ConvertFrom-Json
      if ($request.command -eq 'list') {
        $result = @([DesktopIconNative]::GetItems())
      } elseif ($request.command -eq 'selected') {
        $result = @([DesktopIconNative]::GetSelectedItems())
      } elseif ($request.command -eq 'icon-data') {
        $result = [DesktopIconNative]::GetShellIconData([string]$request.path)
      } elseif ($request.command -eq 'resource-icon-data') {
        $result = [DesktopIconNative]::GetResourceIconData([string]$request.path, [int]$request.index)
      } elseif ($request.command -eq 'shell-namespace-icon-data') {
        $result = [DesktopIconNative]::GetShellNamespaceIconData([string]$request.clsid)
      } elseif ($request.command -eq 'shell-item-visibility-get') {
        $result = Get-DesktopShellItemVisibility ([string]$request.clsid)
      } elseif ($request.command -eq 'shell-item-visibility-set') {
        $result = Set-DesktopShellItemVisibility ([string]$request.clsid) ([bool]$request.exists) ([int]$request.value) $request.states
      } elseif ($request.command -eq 'desktop-shell-restart') {
        $result = [DesktopIconNative]::RestartDesktopShell()
      } elseif ($request.command -eq 'set') {
        $result = [DesktopIconNative]::SetItemPosition([string]$request.name, [int]$request.x, [int]$request.y)
      } elseif ($request.command -eq 'set-many') {
        $positions = New-Object 'System.Collections.Generic.List[DesktopIconInfo]'
        foreach ($position in @($request.positions)) {
          $entry = New-Object DesktopIconInfo
          $entry.Name = [string]$position.name
          $entry.X = [int]$position.x
          $entry.Y = [int]$position.y
          $positions.Add($entry)
        }
        $result = @([DesktopIconNative]::SetItemPositions($positions.ToArray()))
      } elseif ($request.command -eq 'notify-move') {
        $result = [DesktopIconNative]::NotifyMove(
          [string]$request.sourcePath,
          [string]$request.destinationPath,
          [bool]$request.isDirectory
        )
      } elseif ($request.command -eq 'notify-directories') {
        $result = [DesktopIconNative]::NotifyDirectories(@($request.paths | ForEach-Object { [string]$_ }))
      } elseif ($request.command -eq 'notify-moves' -or $request.command -eq 'notify-moves-flush') {
        $moves = New-Object 'System.Collections.Generic.List[DesktopMoveInfo]'
        foreach ($move in @($request.moves)) {
          $entry = New-Object DesktopMoveInfo
          $entry.SourcePath = [string]$move.sourcePath
          $entry.DestinationPath = [string]$move.destinationPath
          $entry.IsDirectory = [bool]$move.isDirectory
          $moves.Add($entry)
        }
        $result = if ($request.command -eq 'notify-moves-flush') {
          [DesktopIconNative]::NotifyMovesAndFlush($moves.ToArray())
        } else {
          [DesktopIconNative]::NotifyMoves($moves.ToArray())
        }
      } elseif ($request.command -eq 'cursor-position') {
        $result = [DesktopIconNative]::GetCursorPosition()
      } elseif ($request.command -eq 'pointer-state') {
        $result = [DesktopIconNative]::GetPointerState()
      } elseif ($request.command -eq 'button-state') {
        $result = [DesktopIconNative]::GetButtonState()
      } elseif ($request.command -eq 'organizer-band-health') {
        $handles = @($request.hwnds | ForEach-Object { [string]$_ })
        $result = [DesktopIconNative]::EnsureOrganizerBand([string]$request.organizerHostHwnd, $handles)
      } elseif ($request.command -eq 'window-geometries') {
        $handles = @($request.hwnds | ForEach-Object { [string]$_ })
        $result = @([DesktopIconNative]::GetWindowGeometries($handles))
      } elseif ($request.command -eq 'resize-window-for-dpi') {
        $result = [DesktopIconNative]::ResizeWindowForDpi(
          [string]$request.hwnd,
          [int]$request.logicalWidth,
          [int]$request.logicalHeight
        )
      } elseif ($request.command -eq 'set-window-client-bounds') {
        $result = [DesktopIconNative]::SetWindowClientBounds(
          [string]$request.hwnd,
          [int]$request.x,
          [int]$request.y,
          [int]$request.width,
          [int]$request.height
        )
      } elseif ($request.command -eq 'stabilize-window-client-size') {
        $result = [DesktopIconNative]::StabilizeWindowClientSize(
          [string]$request.hwnd,
          [int]$request.physicalWidth,
          [int]$request.physicalHeight
        )
      } elseif ($request.command -eq 'shortcut-info') {
        $result = Get-ShortcutInfo ([string]$request.path) $shortcutShell
      } else {
        throw "Unknown command: $($request.command)"
      }
      $response = @{ id = $request.id; ok = $true; result = $result }
    } catch {
      $response = @{ id = $request.id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
  }
  exit 0
}

if ($Mode -eq 'list') {
  [DesktopIconNative]::GetItems() | ConvertTo-Json -Compress
  exit 0
}

if ($Mode -eq 'shortcut') {
  $shortcutShell = New-Object -ComObject WScript.Shell
  Get-ShortcutInfo $Name $shortcutShell | ConvertTo-Json -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Name)) {
  throw 'Name is required for set mode.'
}

$changed = [DesktopIconNative]::SetItemPosition($Name, $X, $Y)
Write-Output ($changed.ToString().ToLowerInvariant())
if (-not $changed) { exit 2 }
