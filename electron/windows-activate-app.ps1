param(
  [string]$ExecutablePath = '',
  [Int32]$ProcessId = 0,
  [UInt64]$WindowHandle = 0,
  [Int32]$TimeoutMs = 6000
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class AppActivationNative
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    private const uint GW_OWNER = 4;
    private const int SW_SHOW = 5;
    private const int SW_RESTORE = 9;

    public static IntPtr FindWindowForProcess(uint expectedProcessId)
    {
        IntPtr titledWindow = IntPtr.Zero;
        IntPtr fallbackWindow = IntPtr.Zero;
        EnumWindows((hwnd, lParam) =>
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId != expectedProcessId || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero)
            {
                return true;
            }
            if (fallbackWindow == IntPtr.Zero) fallbackWindow = hwnd;
            if (GetWindowTextLength(hwnd) > 0)
            {
                titledWindow = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return titledWindow != IntPtr.Zero ? titledWindow : fallbackWindow;
    }

    public static bool Activate(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignored);
        uint currentThread = GetCurrentThreadId();
        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread
            && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            // ShowWindowAsync and cross-thread foreground activation can be
            // acknowledged one message-pump turn later. Keep the input queues
            // attached while waiting instead of treating the first immediate
            // GetForegroundWindow read as a permanent failure.
            for (int attempt = 0; attempt < 8; attempt++)
            {
                ShowWindowAsync(hwnd, IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                if (GetForegroundWindow() == hwnd) return true;
                System.Threading.Thread.Sleep(40);
            }
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
        return GetForegroundWindow() == hwnd;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

if ($WindowHandle -gt 0) {
  $window = [IntPtr]::new([Int64]$WindowHandle)
  $activated = [AppActivationNative]::Activate($window)
  Write-Output ('activated={0} pid={1} hwnd={2}' -f $activated, $ProcessId, $WindowHandle)
  exit $(if ($activated) { 0 } else { 2 })
}

$resolvedExecutable = if ($ExecutablePath) {
  [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ExecutablePath))
} else {
  ''
}
$processName = if ($resolvedExecutable) {
  [System.IO.Path]::GetFileNameWithoutExtension($resolvedExecutable)
} else {
  ''
}
$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(250, $TimeoutMs))

do {
  $candidates = if ($ProcessId -gt 0) {
    @(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
  } elseif ($processName) {
    @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
      try { [System.IO.Path]::GetFullPath($_.Path) -ieq $resolvedExecutable } catch { $false }
    } | Sort-Object StartTime -Descending)
  } else {
    @()
  }

  foreach ($candidate in $candidates) {
    $candidate.Refresh()
    $window = [AppActivationNative]::FindWindowForProcess([UInt32]$candidate.Id)
    if ($window -eq [IntPtr]::Zero) { continue }
    $activated = [AppActivationNative]::Activate($window)
    Write-Output ('activated={0} pid={1} hwnd={2}' -f $activated, $candidate.Id, $window.ToInt64())
    exit $(if ($activated) { 0 } else { 2 })
  }
  Start-Sleep -Milliseconds 80
} while ([DateTime]::UtcNow -lt $deadline)

Write-Output ('activated=False pid=0 hwnd=0 reason=no-window requested-pid={0} executable={1}' -f $ProcessId, $resolvedExecutable)
exit 3
