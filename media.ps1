# blxstncord media helper (started by loader.js only while the "Spotify Controls" plugin is on).
# Talks to the Windows media controls (the same ones behind the volume flyout) for the Spotify desktop app.
#  - every second it prints one JSON line with the current song / state to stdout
#  - commands arrive as small files "media-*.cmd" in -CmdDir (toggle | next | prev | seek:<milliseconds> | shuffle:on|off | repeat:none|track|list | volume:0-100 | mute:on|off)
# No network access. It exits by itself when Discord closes.

param([string]$CmdDir, [int]$ParentPid = 0)

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
# PowerShell cannot cast the COM object to IInputStream itself, so call AsStreamForRead through reflection
$script:asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

# --- await helper for WinRT async operations (works in Windows PowerShell 5.1) ---
# --- Spotify volume through the Windows audio mixer (the per-app slider in the volume flyout) ---
# Windows media controls have no volume, so a tiny C# helper talks to the Core Audio sessions of Spotify.exe.
$volCode = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class BlxVol
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out ISimpleAudioVolume audioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // all audio sessions of Spotify.exe on the default playback device
    private static List<ISimpleAudioVolume> FindSpotify()
    {
        List<ISimpleAudioVolume> list = new List<ISimpleAudioVolume>();
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out dev) != 0 || dev == null) return list;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return list;
        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator se;
        if (mgr.GetSessionEnumerator(out se) != 0 || se == null) return list;
        int n;
        se.GetCount(out n);
        for (int i = 0; i < n; i++)
        {
            IAudioSessionControl c;
            if (se.GetSession(i, out c) != 0 || c == null) continue;
            try
            {
                IAudioSessionControl2 c2 = (IAudioSessionControl2)c;
                uint pid;
                c2.GetProcessId(out pid);
                if (pid == 0) continue;
                string name = Process.GetProcessById((int)pid).ProcessName;
                if (name.IndexOf("spotify", StringComparison.OrdinalIgnoreCase) < 0) continue;
                list.Add((ISimpleAudioVolume)c);
            }
            catch { }
        }
        return list;
    }

    // { volume 0..1, muted 0|1 } or null when Spotify has no audio session (not playing yet)
    public static float[] State()
    {
        List<ISimpleAudioVolume> v = FindSpotify();
        if (v.Count == 0) return null;
        float level;
        bool mute;
        v[0].GetMasterVolume(out level);
        v[0].GetMute(out mute);
        return new float[] { level, mute ? 1f : 0f };
    }

    public static int SetVolume(float level)
    {
        if (level < 0f) level = 0f;
        if (level > 1f) level = 1f;
        Guid g = Guid.Empty;
        int n = 0;
        foreach (ISimpleAudioVolume s in FindSpotify())
        {
            s.SetMasterVolume(level, ref g);
            if (level > 0f) s.SetMute(false, ref g);
            n++;
        }
        return n;
    }

    public static int SetMute(bool mute)
    {
        Guid g = Guid.Empty;
        int n = 0;
        foreach (ISimpleAudioVolume s in FindSpotify()) { s.SetMute(mute, ref g); n++; }
        return n;
    }
}
'@
$script:volOk = $false
$script:volErrLogged = $false
try {
    Add-Type -TypeDefinition $volCode -Language CSharp -ErrorAction Stop
    $script:volOk = $true
} catch { [Console]::Error.WriteLine("vol: cannot compile the volume helper: " + $_.Exception.Message) }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(5000)
    if ($task.IsCompleted) { return $task.Result }
    return $null
}

function Send($o) {
    [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

$mgr = Await ($mgrType::RequestAsync()) $mgrType
if ($null -eq $mgr) {
    Send @{ running = $false; error = "Windows media controls are not available" }
    exit 1
}

function Get-Spotify {
    foreach ($s in $mgr.GetSessions()) {
        if ($s.SourceAppUserModelId -match 'spotify') { return $s }
    }
    return $null
}

# --- album cover as a data: URI ("" when the track has none) ---
# Problems are reported on stderr (loader.js copies them to log.txt as "media helper: art: ...").
$script:artErr = ""
function Get-Art($props) {
    $script:artErr = ""
    $net = $null
    try {
        if ($null -eq $props) { $script:artErr = "no media properties"; return "" }
        if ($null -eq $props.Thumbnail) { $script:artErr = "Spotify exposes no thumbnail"; return "" }
        $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType
        if ($null -eq $stream) { $script:artErr = "OpenReadAsync returned nothing (timeout?)"; return "" }
        $bytes = $null

        # method 1: .NET stream wrapper (via reflection)
        try {
            $net = $script:asStreamForRead.Invoke($null, @($stream))
            $ms = New-Object System.IO.MemoryStream
            $net.CopyTo($ms)
            if ($ms.Length -gt 0) { $bytes = $ms.ToArray() }
        } catch { $script:artErr = "AsStreamForRead failed: " + $_.Exception.Message }

        # method 2: WinRT DataReader
        if ($null -eq $bytes) {
            try {
                $size = [uint32][Windows.Storage.Streams.IRandomAccessStream].GetProperty('Size').GetValue($stream)
                if ($size -gt 0) {
                    $reader = [Activator]::CreateInstance([Windows.Storage.Streams.DataReader], @($stream))
                    $null = Await ($reader.LoadAsync($size)) ([uint32])
                    $buf = New-Object byte[] ([int]$size)
                    $reader.ReadBytes($buf)
                    $bytes = $buf
                    $script:artErr = ""
                } else { $script:artErr += " | stream size is 0" }
            } catch { $script:artErr += " | DataReader failed: " + $_.Exception.Message }
        }

        if ($null -eq $bytes -or $bytes.Length -eq 0) { if (-not $script:artErr) { $script:artErr = "thumbnail stream is empty" }; return "" }
        $mime = "image/jpeg"
        if ($bytes.Length -ge 4 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $mime = "image/png" }
        return ("data:" + $mime + ";base64," + [Convert]::ToBase64String($bytes))
    } catch { $script:artErr = "Get-Art: " + $_.Exception.Message; return "" }
    finally { try { if ($net) { $net.Dispose() } } catch { } }
}

$script:lastKey = ""
$script:artSent = $null
$script:artUntil = [DateTime]::MinValue
$script:artLogged = $false

function Send-Status {
    $s = Get-Spotify
    if ($null -eq $s) {
        $script:lastKey = ""
        Send @{ running = $false }
        return
    }
    $props = Await ($s.TryGetMediaPropertiesAsync()) $propsType
    $pb = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()

    $playing = ($pb.PlaybackStatus.ToString() -eq "Playing")
    # shuffle / repeat state ($null when Spotify does not report it)
    $shuffle = $null
    if ($null -ne $pb.IsShuffleActive) { $shuffle = [bool]$pb.IsShuffleActive }
    # Spotify's volume in the Windows mixer ($null until Spotify has an audio session)
    $vol = $null
    $muted = $null
    if ($script:volOk) {
        try {
            $vs = [BlxVol]::State()
            if ($null -ne $vs) { $vol = [int][math]::Round($vs[0] * 100); $muted = ($vs[1] -ge 0.5) }
        } catch { if (-not $script:volErrLogged) { $script:volErrLogged = $true; [Console]::Error.WriteLine("vol: " + $_.Exception.Message) } }
    }
    $rep = $null
    if ($null -ne $pb.AutoRepeatMode) { $rep = $pb.AutoRepeatMode.ToString().ToLower() }   # none | track | list
    $title = "" + $props.Title
    $artist = "" + $props.Artist
    $album = "" + $props.AlbumTitle
    $key = $title + "|" + $artist + "|" + $album

    $dur = 0.0
    $pos = 0.0
    if ($null -ne $tl) {
        $dur = $tl.EndTime.TotalMilliseconds - $tl.StartTime.TotalMilliseconds
        $pos = $tl.Position.TotalMilliseconds
        if ($playing) { $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalMilliseconds }
        if ($dur -lt 0) { $dur = 0.0 }
        if ($pos -lt 0) { $pos = 0.0 }
        if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
    }

    # the cover often arrives a moment after the title (or later), so keep re-reading it for up to 30 s after a track change
    if ($key -ne $script:lastKey) {
        $script:lastKey = $key
        $script:artSent = $null
        $script:artUntil = (Get-Date).AddSeconds(30)
        $script:artLogged = $false
    }
    $art = $null
    if ((Get-Date) -lt $script:artUntil) {
        $a = Get-Art $props
        if ($a -ne "" -and $a -ne $script:artSent) {
            $script:artSent = $a; $art = $a
            $script:artUntil = (Get-Date).AddSeconds(6)   # Windows may still hand out the previous track's cover first, so look a bit longer
            [Console]::Error.WriteLine("art: ok (" + [math]::Round($a.Length / 1024) + " KB) for " + $title)
        } elseif ($a -eq "" -and -not $script:artLogged -and ((Get-Date) -gt $script:artUntil.AddSeconds(-27))) {
            $script:artLogged = $true
            [Console]::Error.WriteLine("art: none for '" + $title + "': " + $script:artErr)
        }
    }

    Send @{
        running = $true
        playing = $playing
        title   = $title
        artist  = $artist
        album   = $album
        pos     = [math]::Round($pos)
        dur     = [math]::Round($dur)
        key     = $key
        art     = $art
        shuffle = $shuffle
        repeat  = $rep
        volume  = $vol
        muted   = $muted
    }
}

function Run-Command($c) {
    $s = Get-Spotify
    if ($null -eq $s) { return }
    $c = $c.Trim()
    if ($c -eq "toggle") { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
    elseif ($c -eq "next") { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
    elseif ($c -eq "prev") { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    elseif ($c -match '^seek:(\d{1,9})$') {
        $ticks = [int64]$Matches[1] * 10000
        $null = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
    }
    elseif ($c -match '^shuffle:(on|off)$') {
        $ok = Await ($s.TryChangeShuffleActiveAsync(($Matches[1] -eq 'on'))) ([bool])
        if ($ok -ne $true) { [Console]::Error.WriteLine("cmd: Spotify did not accept '" + $c + "'") }
    }
    elseif ($c -match '^repeat:(none|track|list)$') {
        $mode = [Enum]::Parse([Windows.Media.MediaPlaybackAutoRepeatMode], $Matches[1], $true)
        $ok = Await ($s.TryChangeAutoRepeatModeAsync($mode)) ([bool])
        if ($ok -ne $true) { [Console]::Error.WriteLine("cmd: Spotify did not accept '" + $c + "'") }
    }
}

$lastStatus = [DateTime]::MinValue
while ($true) {
    $force = $false
    $pendingVol = $null   # dragging the slider writes many volume:N files, only the last one matters
    foreach ($f in @(Get-ChildItem -Path $CmdDir -Filter 'media-*.cmd' | Sort-Object Name)) {
        $text = Get-Content -Path $f.FullName -Raw
        Remove-Item -Path $f.FullName -Force
        if ($text) {
            $t = $text.Trim()
            if ($t -match '^volume:(\d{1,3})$') { $pendingVol = [int]$Matches[1] }
            elseif ($t -match '^mute:(on|off)$') {
                if ($script:volOk) {
                    try { if ([BlxVol]::SetMute(($Matches[1] -eq 'on')) -eq 0) { [Console]::Error.WriteLine("vol: no Spotify audio session to mute") } }
                    catch { [Console]::Error.WriteLine("vol: mute failed: " + $_.Exception.Message) }
                }
            }
            else { try { Run-Command $text } catch { [Console]::Error.WriteLine("cmd failed: " + $_.Exception.Message) } }
        }
        $force = $true
    }
    if ($null -ne $pendingVol -and $script:volOk) {
        try { if ([BlxVol]::SetVolume([single]([math]::Min(100, $pendingVol) / 100.0)) -eq 0) { [Console]::Error.WriteLine("vol: no Spotify audio session to change") } }
        catch { [Console]::Error.WriteLine("vol: set failed: " + $_.Exception.Message) }
    }
    if ($force) { Start-Sleep -Milliseconds 250 }

    if ($force -or ((Get-Date) - $lastStatus).TotalMilliseconds -ge 1000) {
        $lastStatus = Get-Date
        if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid)) { break }   # Discord is gone
        try { Send-Status } catch { Send @{ running = $false; error = "" + $_ } }
    }
    Start-Sleep -Milliseconds 120
}
