param([Parameter(Mandatory=$true)][uint32]$BrowserProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BrowserWindows {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Read(uint target) {
    var titles = new List<string>();
    EnumWindows((h,p) => {
      uint pid; GetWindowThreadProcessId(h,out pid);
      if(pid != target) return true;
      var title=new StringBuilder(1024); var name=new StringBuilder(256);
      GetWindowText(h,title,title.Capacity); GetClassName(h,name,name.Capacity);
      // Include invisible desktop browser windows: those can register shell tabs.
      if(name.ToString()=="Chrome_WidgetWin_1" && title.Length>0) titles.Add(title.ToString());
      return true;
    }, IntPtr.Zero);
    return titles.ToArray();
  }
}
'@
ConvertTo-Json -InputObject @([BrowserWindows]::Read($BrowserProcessId)) -Compress
