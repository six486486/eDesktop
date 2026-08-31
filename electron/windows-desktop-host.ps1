param(
  [Parameter(Mandatory = $true)]
  [UInt64]$Hwnd,
  [switch]$NoActivate,
  [switch]$DesktopChild,
  [UInt64]$ParentHwnd = 0,
  [switch]$InspectOnly,
  [UInt64]$CompareHwnd = 0,
  [Int32]$ClickClientX = -1,
  [Int32]$ClickClientY = -1,
  [Int32]$ClickCount = 0,
  [Int32]$DragStartClientX = -1,
  [Int32]$DragStartClientY = -1,
  [Int32]$DragEndClientX = -1,
  [Int32]$DragEndClientY = -1,
  [Int32]$DragSteps = 12,
  [Int32]$InputHealthClientX = -1,
  [Int32]$InputHealthClientY = -1,
  [Int32]$ShapeClientX = -1,
  [Int32]$ShapeClientY = -1,
  [Int32]$HoverClientX = -1,
  [Int32]$HoverClientY = -1,
  [Int32]$DirectClickClientX = -1,
  [Int32]$DirectClickClientY = -1,
  [Int32]$DirectClickCount = 0,
  [Int32]$DirectDragStartClientX = -1,
  [Int32]$DirectDragStartClientY = -1,
  [Int32]$DirectDragEndClientX = -1,
  [Int32]$DirectDragEndClientY = -1,
  [Int32]$DirectDragSteps = 12,
  [Int32]$SetClientX = -1,
  [Int32]$SetClientY = -1,
  [Int32]$SetClientWidth = -1,
  [Int32]$SetClientHeight = -1,
  [Double]$ClientScale = 1.0,
  [switch]$DisplaceOrganizerBand
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class DesktopHostNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    public delegate bool EnumChildWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumChildWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    public const uint GA_ROOT = 2;

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hwnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("gdi32.dll")]
    public static extern bool PtInRegion(IntPtr region, int x, int y);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr value);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const int WS_CHILD = 0x40000000;
    public const int WS_POPUP = unchecked((int)0x80000000);
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const uint SMTO_NORMAL = 0x0000;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint RDW_INVALIDATE = 0x0001;
    public const uint RDW_UPDATENOW = 0x0100;
    public const uint RDW_ALLCHILDREN = 0x0080;
    public const int SW_SHOW = 5;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint CWP_SKIPINVISIBLE = 0x0001;
    public const uint CWP_SKIPDISABLED = 0x0002;
    public const uint CWP_SKIPTRANSPARENT = 0x0004;
    public const uint GW_HWNDFIRST = 0;
    public const uint GW_HWNDNEXT = 2;
    public const uint GW_HWNDPREV = 3;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public static bool IsWindowAbove(IntPtr candidate, IntPtr reference)
    {
        if (candidate == IntPtr.Zero || reference == IntPtr.Zero || candidate == reference)
        {
            return false;
        }

        IntPtr current = reference;
        for (int index = 0; index < 4096; index++)
        {
            current = GetWindow(current, GW_HWNDPREV);
            if (current == IntPtr.Zero) return false;
            if (current == candidate) return true;
        }
        return false;
    }

    public static IntPtr FindRenderWidgetHost(IntPtr parent)
    {
        IntPtr fallbackRenderWidgetHost = IntPtr.Zero;
        IntPtr activeRenderWidgetHost = IntPtr.Zero;
        EnumChildWindows(parent, (child, lParam) =>
        {
            var className = new System.Text.StringBuilder(256);
            GetClassName(child, className, className.Capacity);
            if (String.Equals(className.ToString(), "Chrome_RenderWidgetHostHWND", StringComparison.Ordinal))
            {
                if (fallbackRenderWidgetHost == IntPtr.Zero) fallbackRenderWidgetHost = child;
                if (IsWindowVisible(child) && IsWindowEnabled(child))
                {
                    activeRenderWidgetHost = child;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return activeRenderWidgetHost != IntPtr.Zero ? activeRenderWidgetHost : fallbackRenderWidgetHost;
    }

    public static IntPtr HitTestDescendant(IntPtr root, POINT screenPoint)
    {
        IntPtr current = root;
        for (int index = 0; index < 64; index++)
        {
            POINT clientPoint = screenPoint;
            if (!ScreenToClient(current, ref clientPoint)) return current;
            IntPtr child = ChildWindowFromPointEx(
                current,
                clientPoint,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
            if (child == IntPtr.Zero || child == current) return current;
            current = child;
        }
        return current;
    }

    public static IntPtr FindDesktopIconHost()
    {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr result;
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, SMTO_NORMAL, 1000, out result);

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
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$window = [IntPtr]::new([Int64]$Hwnd)
# Every coordinate handled below crosses a process boundary between eDesktop
# and Explorer. PowerShell is otherwise only system-DPI aware, so Windows can
# virtualize GetWindowRect/ScreenToClient/SetWindowPos with different scale
# factors when the primary display changes. That double conversion displaced
# a desktop-child host while leaving its Chromium children visually composed
# outside the parent's hit-test rectangle. Keep the complete native operation
# in one physical, per-monitor-aware coordinate space.
[void][DesktopHostNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))

# Renderer event coordinates are CSS DIPs, while ClientToScreen expects
# physical client pixels in a PMv2 helper. Organizer HWNDs inherit Explorer's
# primary DPI after SetParent even when Chromium is rendering for a differently
# scaled monitor, so use the renderer's target display scale explicitly.
if ($ClientScale -gt 0 -and [Math]::Abs($ClientScale - 1.0) -gt 0.001) {
  foreach ($name in @(
    'HoverClientX', 'HoverClientY',
    'InputHealthClientX', 'InputHealthClientY',
    'DragStartClientX', 'DragStartClientY', 'DragEndClientX', 'DragEndClientY',
    'ClickClientX', 'ClickClientY',
    'DirectClickClientX', 'DirectClickClientY',
    'DirectDragStartClientX', 'DirectDragStartClientY', 'DirectDragEndClientX', 'DirectDragEndClientY'
  )) {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value -ge 0) {
      Set-Variable -Name $name -Value ([Math]::Round($value * $ClientScale))
    }
  }
}

if ($SetClientX -ge 0 -or $SetClientY -ge 0 -or $SetClientWidth -ge 0 -or $SetClientHeight -ge 0) {
  if ($SetClientX -lt 0 -or $SetClientY -lt 0 -or $SetClientWidth -le 0 -or $SetClientHeight -le 0) {
    throw 'A complete positive parent-client rectangle is required.'
  }
  $flags = [DesktopHostNative]::SWP_NOZORDER -bor [DesktopHostNative]::SWP_NOACTIVATE -bor [DesktopHostNative]::SWP_SHOWWINDOW -bor [DesktopHostNative]::SWP_FRAMECHANGED
  if (-not [DesktopHostNative]::SetWindowPos($window, [IntPtr]::Zero, $SetClientX, $SetClientY, $SetClientWidth, $SetClientHeight, $flags)) {
    throw 'Unable to set the parent-client rectangle.'
  }
  $actualRect = New-Object DesktopHostNative+RECT
  [void][DesktopHostNative]::GetWindowRect($window, [ref]$actualRect)
  Write-Output ('client-bounds hwnd={0} requested={1},{2},{3},{4} actual-screen={5},{6},{7},{8}' -f $window.ToInt64(), $SetClientX, $SetClientY, $SetClientWidth, $SetClientHeight, $actualRect.Left, $actualRect.Top, $actualRect.Right, $actualRect.Bottom)
  exit 0
}

if ($DisplaceOrganizerBand) {
  $hostWindow = [DesktopHostNative]::FindDesktopIconHost()
  if ($hostWindow -eq [IntPtr]::Zero) {
    throw 'Windows desktop icon host was not found.'
  }
  $flags = [DesktopHostNative]::SWP_NOMOVE -bor [DesktopHostNative]::SWP_NOSIZE -bor [DesktopHostNative]::SWP_NOACTIVATE
  $insertAfter = if ([DesktopHostNative]::GetParent($window) -eq $hostWindow) {
    # A real desktop child can only be displaced inside Progman's child list.
    # This remains below every normal top-level application.
    [DesktopHostNative]::HWND_BOTTOM
  } else {
    [DesktopHostNative]::HWND_TOP
  }
  [void][DesktopHostNative]::SetWindowPos($window, $insertAfter, 0, 0, 0, 0, $flags)
  Write-Output ('displaced-organizer-band hwnd={0} icon-host={1}' -f $window.ToInt64(), $hostWindow.ToInt64())
  exit 0
}

if ($ShapeClientX -ge 0 -or $ShapeClientY -ge 0) {
  if ($ShapeClientX -lt 0 -or $ShapeClientY -lt 0) {
    throw 'Both shape client coordinates must be non-negative.'
  }
  $shapeRegion = [DesktopHostNative]::CreateRectRgn(0, 0, 0, 0)
  if ($shapeRegion -eq [IntPtr]::Zero) { throw 'Unable to allocate a window region.' }
  try {
    $regionType = [DesktopHostNative]::GetWindowRgn($window, $shapeRegion)
    $inside = [DesktopHostNative]::PtInRegion($shapeRegion, $ShapeClientX, $ShapeClientY)
    Write-Output ('shape-point client-x={0} client-y={1} inside={2} region-type={3} hwnd={4}' -f $ShapeClientX, $ShapeClientY, $inside, $regionType, $window.ToInt64())
  } finally {
    [void][DesktopHostNative]::DeleteObject($shapeRegion)
  }
  exit 0
}

if ($HoverClientX -ge 0 -or $HoverClientY -ge 0) {
  if ($HoverClientX -lt 0 -or $HoverClientY -lt 0) {
    throw 'Both hover client coordinates must be non-negative.'
  }
  $hoverPoint = New-Object DesktopHostNative+POINT
  $hoverPoint.X = $HoverClientX
  $hoverPoint.Y = $HoverClientY
  if (-not [DesktopHostNative]::ClientToScreen($window, [ref]$hoverPoint)) {
    throw 'Unable to convert the hover point to screen coordinates.'
  }
  [void][DesktopHostNative]::SetCursorPos($hoverPoint.X, $hoverPoint.Y)
  Start-Sleep -Milliseconds 120
  $hoverWindow = [DesktopHostNative]::WindowFromPoint($hoverPoint)
  $hoverRoot = [DesktopHostNative]::GetAncestor($hoverWindow, [DesktopHostNative]::GA_ROOT)
  Write-Output ('hovered screen-x={0} screen-y={1} hit-hwnd={2} hit-root={3} target-hwnd={4}' -f $hoverPoint.X, $hoverPoint.Y, $hoverWindow.ToInt64(), $hoverRoot.ToInt64(), $window.ToInt64())
  exit 0
}

if ($InputHealthClientX -ge 0 -or $InputHealthClientY -ge 0) {
  if ($InputHealthClientX -lt 0 -or $InputHealthClientY -lt 0) {
    throw 'Both input health client coordinates must be non-negative.'
  }
  $screenPoint = New-Object DesktopHostNative+POINT
  $screenPoint.X = $InputHealthClientX
  $screenPoint.Y = $InputHealthClientY
  if (-not [DesktopHostNative]::ClientToScreen($window, [ref]$screenPoint)) {
    throw 'Unable to convert the input health point to screen coordinates.'
  }
  $renderChild = [DesktopHostNative]::FindRenderWidgetHost($window)
  $hitWindow = [DesktopHostNative]::HitTestDescendant($window, $screenPoint)
  $hitClassName = New-Object System.Text.StringBuilder 256
  [void][DesktopHostNative]::GetClassName($hitWindow, $hitClassName, $hitClassName.Capacity)
  $renderStyle = if ($renderChild -eq [IntPtr]::Zero) { 0 } else { [DesktopHostNative]::GetWindowLong($renderChild, [DesktopHostNative]::GWL_EXSTYLE) }
  $windowStyle = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_EXSTYLE)
  $renderTransparent = ($renderStyle -band [DesktopHostNative]::WS_EX_TRANSPARENT) -ne 0
  $windowTransparent = ($windowStyle -band [DesktopHostNative]::WS_EX_TRANSPARENT) -ne 0
  $windowVisible = [DesktopHostNative]::IsWindowVisible($window)
  $windowEnabled = [DesktopHostNative]::IsWindowEnabled($window)
  $renderVisible = $renderChild -ne [IntPtr]::Zero -and [DesktopHostNative]::IsWindowVisible($renderChild)
  $renderEnabled = $renderChild -ne [IntPtr]::Zero -and [DesktopHostNative]::IsWindowEnabled($renderChild)
  Write-Output ('input-health hit-hwnd={0} hit-class={1} window-hwnd={2} window-visible={3} window-enabled={4} window-transparent={5} render-child={6} render-visible={7} render-enabled={8} render-transparent={9}' -f $hitWindow.ToInt64(), $hitClassName.ToString(), $window.ToInt64(), $windowVisible, $windowEnabled, $windowTransparent, $renderChild.ToInt64(), $renderVisible, $renderEnabled, $renderTransparent)
  exit 0
}

if ($DirectClickClientX -ge 0 -or $DirectClickClientY -ge 0 -or $DirectClickCount -gt 0) {
  if ($DirectClickClientX -lt 0 -or $DirectClickClientY -lt 0 -or $DirectClickCount -le 0) {
    throw 'Direct click coordinates and count must be valid.'
  }
  $packedPoint = (($DirectClickClientY -band 0xFFFF) -shl 16) -bor ($DirectClickClientX -band 0xFFFF)
  $lParam = [IntPtr]::new([Int64]$packedPoint)
  for ($index = 0; $index -lt $DirectClickCount; $index += 1) {
    [void][DesktopHostNative]::PostMessage($window, 0x0200, [IntPtr]::Zero, $lParam)
    [void][DesktopHostNative]::PostMessage($window, 0x0201, [IntPtr]::new(1), $lParam)
    Start-Sleep -Milliseconds 20
    [void][DesktopHostNative]::PostMessage($window, 0x0202, [IntPtr]::Zero, $lParam)
    Start-Sleep -Milliseconds 45
  }
  Write-Output ('direct-click count={0} client-x={1} client-y={2} hwnd={3}' -f $DirectClickCount, $DirectClickClientX, $DirectClickClientY, $window.ToInt64())
  exit 0
}

if ($DirectDragStartClientX -ge 0 -or $DirectDragStartClientY -ge 0 -or $DirectDragEndClientX -ge 0 -or $DirectDragEndClientY -ge 0) {
  if ($DirectDragStartClientX -lt 0 -or $DirectDragStartClientY -lt 0 -or $DirectDragEndClientX -lt 0 -or $DirectDragEndClientY -lt 0) {
    throw 'All direct drag client coordinates must be non-negative.'
  }
  $startPacked = (($DirectDragStartClientY -band 0xFFFF) -shl 16) -bor ($DirectDragStartClientX -band 0xFFFF)
  [void][DesktopHostNative]::PostMessage($window, 0x0200, [IntPtr]::Zero, [IntPtr]::new([Int64]$startPacked))
  [void][DesktopHostNative]::PostMessage($window, 0x0201, [IntPtr]::new(1), [IntPtr]::new([Int64]$startPacked))
  $stepCount = [Math]::Max(2, $DirectDragSteps)
  for ($index = 1; $index -le $stepCount; $index += 1) {
    $progress = $index / [double]$stepCount
    $x = [Math]::Round($DirectDragStartClientX + ($DirectDragEndClientX - $DirectDragStartClientX) * $progress)
    $y = [Math]::Round($DirectDragStartClientY + ($DirectDragEndClientY - $DirectDragStartClientY) * $progress)
    $packed = (($y -band 0xFFFF) -shl 16) -bor ($x -band 0xFFFF)
    [void][DesktopHostNative]::PostMessage($window, 0x0200, [IntPtr]::new(1), [IntPtr]::new([Int64]$packed))
    Start-Sleep -Milliseconds 15
  }
  $endPacked = (($DirectDragEndClientY -band 0xFFFF) -shl 16) -bor ($DirectDragEndClientX -band 0xFFFF)
  [void][DesktopHostNative]::PostMessage($window, 0x0202, [IntPtr]::Zero, [IntPtr]::new([Int64]$endPacked))
  Write-Output ('direct-drag start-x={0} start-y={1} end-x={2} end-y={3} steps={4} hwnd={5}' -f $DirectDragStartClientX, $DirectDragStartClientY, $DirectDragEndClientX, $DirectDragEndClientY, $stepCount, $window.ToInt64())
  exit 0
}

if ($DragStartClientX -ge 0 -or $DragStartClientY -ge 0 -or $DragEndClientX -ge 0 -or $DragEndClientY -ge 0) {
  if ($DragStartClientX -lt 0 -or $DragStartClientY -lt 0 -or $DragEndClientX -lt 0 -or $DragEndClientY -lt 0) {
    throw 'All drag client coordinates must be non-negative.'
  }
  $startPoint = New-Object DesktopHostNative+POINT
  $startPoint.X = $DragStartClientX
  $startPoint.Y = $DragStartClientY
  $endPoint = New-Object DesktopHostNative+POINT
  $endPoint.X = $DragEndClientX
  $endPoint.Y = $DragEndClientY
  if (-not [DesktopHostNative]::ClientToScreen($window, [ref]$startPoint) -or -not [DesktopHostNative]::ClientToScreen($window, [ref]$endPoint)) {
    throw 'Unable to convert the drag points to screen coordinates.'
  }
  $renderChild = [DesktopHostNative]::FindRenderWidgetHost($window)
  [void][DesktopHostNative]::SetCursorPos($startPoint.X, $startPoint.Y)
  Start-Sleep -Milliseconds 80
  $hitWindow = [DesktopHostNative]::WindowFromPoint($startPoint)
  $hitClassName = New-Object System.Text.StringBuilder 256
  [void][DesktopHostNative]::GetClassName($hitWindow, $hitClassName, $hitClassName.Capacity)
  [DesktopHostNative]::mouse_event([DesktopHostNative]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  $stepCount = [Math]::Max(2, $DragSteps)
  for ($index = 1; $index -le $stepCount; $index += 1) {
    $progress = $index / [double]$stepCount
    $x = [Math]::Round($startPoint.X + ($endPoint.X - $startPoint.X) * $progress)
    $y = [Math]::Round($startPoint.Y + ($endPoint.Y - $startPoint.Y) * $progress)
    [void][DesktopHostNative]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 20
  }
  [DesktopHostNative]::mouse_event([DesktopHostNative]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  Write-Output ('dragged start-x={0} start-y={1} end-x={2} end-y={3} hit-hwnd={4} hit-class={5} render-child={6}' -f $startPoint.X, $startPoint.Y, $endPoint.X, $endPoint.Y, $hitWindow.ToInt64(), $hitClassName.ToString(), $renderChild.ToInt64())
  exit 0
}

if ($ClickCount -gt 0) {
  if ($ClickClientX -lt 0 -or $ClickClientY -lt 0) {
    throw 'ClickClientX and ClickClientY must be non-negative.'
  }
  $point = New-Object DesktopHostNative+POINT
  $point.X = $ClickClientX
  $point.Y = $ClickClientY
  if (-not [DesktopHostNative]::ClientToScreen($window, [ref]$point)) {
    throw 'Unable to convert the click point to screen coordinates.'
  }
  $renderChild = [DesktopHostNative]::FindRenderWidgetHost($window)
  [void][DesktopHostNative]::SetCursorPos($point.X, $point.Y)
  Start-Sleep -Milliseconds 80
  $hitWindow = [DesktopHostNative]::WindowFromPoint($point)
  $hitRoot = [DesktopHostNative]::GetAncestor($hitWindow, [DesktopHostNative]::GA_ROOT)
  $hitClassName = New-Object System.Text.StringBuilder 256
  [void][DesktopHostNative]::GetClassName($hitWindow, $hitClassName, $hitClassName.Capacity)
  $hitParent = [DesktopHostNative]::GetParent($hitWindow)
  for ($index = 0; $index -lt $ClickCount; $index += 1) {
    [DesktopHostNative]::mouse_event([DesktopHostNative]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [DesktopHostNative]::mouse_event([DesktopHostNative]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
  }
  Write-Output ('clicked count={0} screen-x={1} screen-y={2} hit-hwnd={3} hit-root={4} hit-class={5} hit-parent={6} render-child={7}' -f $ClickCount, $point.X, $point.Y, $hitWindow.ToInt64(), $hitRoot.ToInt64(), $hitClassName.ToString(), $hitParent.ToInt64(), $renderChild.ToInt64())
  exit 0
}

if ($InspectOnly) {
  $compareWindow = [IntPtr]::new([Int64]$CompareHwnd)
  $compareAbove = [DesktopHostNative]::IsWindowAbove($compareWindow, $window)
  $windowAboveCompare = [DesktopHostNative]::IsWindowAbove($window, $compareWindow)
  $actualExtendedStyle = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_EXSTYLE)
  $actualNoActivate = ($actualExtendedStyle -band [DesktopHostNative]::WS_EX_NOACTIVATE) -ne 0
  $actualTransparent = ($actualExtendedStyle -band [DesktopHostNative]::WS_EX_TRANSPARENT) -ne 0
  [UInt32]$windowProcessId = 0
  $windowThreadId = [DesktopHostNative]::GetWindowThreadProcessId($window, [ref]$windowProcessId)
  $threadInfo = New-Object DesktopHostNative+GUITHREADINFO
  $threadInfo.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($threadInfo)
  [void][DesktopHostNative]::GetGUIThreadInfo($windowThreadId, [ref]$threadInfo)
  $actualParent = [DesktopHostNative]::GetParent($window)
  $actualRoot = [DesktopHostNative]::GetAncestor($window, [DesktopHostNative]::GA_ROOT)
  Write-Output ('inspect compare-above={0} window-above-compare={1} no-activate={2} transparent={3} parent={4} root={5} thread={6} active={7} focus={8} capture={9} move-size={10}' -f $compareAbove, $windowAboveCompare, $actualNoActivate, $actualTransparent, $actualParent.ToInt64(), $actualRoot.ToInt64(), $windowThreadId, $threadInfo.hwndActive.ToInt64(), $threadInfo.hwndFocus.ToInt64(), $threadInfo.hwndCapture.ToInt64(), $threadInfo.hwndMoveSize.ToInt64())
  exit 0
}

$hostWindow = [DesktopHostNative]::FindDesktopIconHost()
if ($hostWindow -eq [IntPtr]::Zero) {
  throw 'Windows desktop host was not found.'
}
$targetParent = if ($DesktopChild -and $ParentHwnd -ne 0) {
  [IntPtr]::new([Int64]$ParentHwnd)
} else {
  $hostWindow
}
if ($DesktopChild -and $targetParent -eq [IntPtr]::Zero) {
  throw 'Desktop child parent was not found.'
}

$styleChanged = $false
$windowRect = New-Object DesktopHostNative+RECT
if (-not [DesktopHostNative]::GetWindowRect($window, [ref]$windowRect)) {
  throw 'Desktop widget bounds could not be read.'
}

if ($DesktopChild) {
  # Preserve the current screen-space rectangle while crossing the process DPI
  # boundary into Explorer's desktop host. After SetParent, SetWindowPos uses
  # Progman client coordinates, so translate the captured top-left explicitly.
  $clientOrigin = New-Object DesktopHostNative+POINT
  $clientOrigin.X = $windowRect.Left
  $clientOrigin.Y = $windowRect.Top
  if (-not [DesktopHostNative]::ScreenToClient($targetParent, [ref]$clientOrigin)) {
    throw 'Desktop host coordinate conversion failed.'
  }

  $style = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_STYLE)
  $nextStyle = ($style -bor [DesktopHostNative]::WS_CHILD) -band (-bnot [DesktopHostNative]::WS_POPUP)
  if ($nextStyle -ne $style) {
    [void][DesktopHostNative]::SetWindowLong($window, [DesktopHostNative]::GWL_STYLE, $nextStyle)
    $styleChanged = $true
  }
  if ([DesktopHostNative]::GetParent($window) -ne $targetParent) {
    [void][DesktopHostNative]::SetParent($window, $targetParent)
    $styleChanged = $true
  }
} elseif ([DesktopHostNative]::GetParent($window) -ne [IntPtr]::Zero) {
  [void][DesktopHostNative]::SetParent($window, [IntPtr]::Zero)
  $style = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_STYLE)
  $style = ($style -band (-bnot [DesktopHostNative]::WS_CHILD)) -bor [DesktopHostNative]::WS_POPUP
  [void][DesktopHostNative]::SetWindowLong($window, [DesktopHostNative]::GWL_STYLE, $style)
  $styleChanged = $true
}

  if ($NoActivate) {
    $extendedStyle = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_EXSTYLE)
    $nextExtendedStyle = $extendedStyle -bor [DesktopHostNative]::WS_EX_NOACTIVATE
    if ($nextExtendedStyle -ne $extendedStyle) {
      [void][DesktopHostNative]::SetWindowLong(
        $window,
        [DesktopHostNative]::GWL_EXSTYLE,
        $nextExtendedStyle
      )
      $styleChanged = $true
    }
  } elseif ($DesktopChild) {
    # Interactive organizer children are allowed to activate inside the
    # eDesktop host. Since their entire ancestor chain is below Progman, this
    # cannot promote them over a normal application window.
    $extendedStyle = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_EXSTYLE)
    $nextExtendedStyle = $extendedStyle -band (-bnot [DesktopHostNative]::WS_EX_NOACTIVATE)
    if ($nextExtendedStyle -ne $extendedStyle) {
      [void][DesktopHostNative]::SetWindowLong(
        $window,
        [DesktopHostNative]::GWL_EXSTYLE,
        $nextExtendedStyle
      )
      $styleChanged = $true
    }
  }

$flags = [DesktopHostNative]::SWP_SHOWWINDOW -bor [DesktopHostNative]::SWP_NOACTIVATE
if ($styleChanged) {
  $flags = $flags -bor [DesktopHostNative]::SWP_FRAMECHANGED
}
if ($DesktopChild) {
  [void][DesktopHostNative]::SetWindowPos(
    $window,
    [DesktopHostNative]::HWND_TOP,
    $clientOrigin.X,
    $clientOrigin.Y,
    [Math]::Max(1, $windowRect.Right - $windowRect.Left),
    [Math]::Max(1, $windowRect.Bottom - $windowRect.Top),
    $flags
  )
} else {
  $windowAboveIcons = [DesktopHostNative]::GetWindow($hostWindow, [DesktopHostNative]::GW_HWNDPREV)
  $insertAfter = if ($windowAboveIcons -eq [IntPtr]::Zero) {
    [DesktopHostNative]::HWND_TOP
  } elseif ($windowAboveIcons -eq $window) {
    [DesktopHostNative]::HWND_TOP
  } else {
    $windowAboveIcons
  }
  $topLevelFlags = $flags -bor [DesktopHostNative]::SWP_NOMOVE -bor [DesktopHostNative]::SWP_NOSIZE
  if ($windowAboveIcons -eq $window) {
    $topLevelFlags = $topLevelFlags -bor [DesktopHostNative]::SWP_NOZORDER
  }
  [void][DesktopHostNative]::SetWindowPos(
    $window,
    $insertAfter,
    0,
    0,
    0,
    0,
    $topLevelFlags
  )
}
  [void][DesktopHostNative]::ShowWindow($window, [DesktopHostNative]::SW_SHOW)
  [void][DesktopHostNative]::RedrawWindow(
    $window,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    [DesktopHostNative]::RDW_INVALIDATE -bor [DesktopHostNative]::RDW_UPDATENOW -bor [DesktopHostNative]::RDW_ALLCHILDREN
  )
  $actualParent = [DesktopHostNative]::GetParent($window)
$nextWindow = [DesktopHostNative]::GetWindow($window, [DesktopHostNative]::GW_HWNDNEXT)
$actualExtendedStyle = [DesktopHostNative]::GetWindowLong($window, [DesktopHostNative]::GWL_EXSTYLE)
$actualNoActivate = ($actualExtendedStyle -band [DesktopHostNative]::WS_EX_NOACTIVATE) -ne 0
$placement = if ($DesktopChild) { 'desktop-child' } else { 'desktop-overlay' }
$aboveIcons = if ($DesktopChild) {
  [DesktopHostNative]::GetParent($window) -eq $targetParent
} else {
  $nextWindow -eq $hostWindow
}
Write-Output ('attached hwnd={0} parent={1} icon-host={2} placement={3} above-icons={4} no-activate={5}' -f $window.ToInt64(), $actualParent.ToInt64(), $hostWindow.ToInt64(), $placement, $aboveIcons, $actualNoActivate)
exit 0
