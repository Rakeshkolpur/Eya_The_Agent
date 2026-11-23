param(
  # A word that is in the path of Eya's processes: the install folder when installed (...\Eya\Eya.exe), or the project folder when run from source.
  [string]$Match = 'Eya',
  [int]$Seconds = 20,
  [string]$Label = 'Eya, idle'
)
<#
  How much memory and processor Eya uses while she is sitting idle (the bubble showing, nothing being asked), by kind of process.
  Start Eya, wait a minute for her speech model to load, then run:   npm run perf:idle

  Budget (what a change must not break):
    idle processor   under 3% of ONE core, in total          (measured 0.2-0.7% on a Core i3 laptop)
    idle memory      under 1,000 MB at Balanced/Full, under 800 MB at Light   (measured 1,388 MB / 684 MB — Balanced is over because
                     graphics acceleration costs ~700 MB there; see Settings -> Performance. The processor budget is the one that must hold.)
  A CSS animation loop anywhere in the page breaks the processor budget badly (65-130% of a core), which is why tests/motion.test.ts
  forbids them.
#>
$procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('electron.exe', 'Eya.exe')) -and ($_.ExecutablePath -match $Match -or $_.CommandLine -match $Match) }
if (-not $procs) { Write-Error "No Eya processes found matching '$Match'. Start Eya first."; exit 2 }
$kind = @{}
foreach ($p in $procs) {
  $t = if ($p.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }
  if ($t -eq 'utility' -and $p.CommandLine -match '--utility-sub-type=([\w\.]+)') { $t = 'utility:' + $Matches[1] }
  $kind[$p.ProcessId] = $t
}
$before = @{}
foreach ($id in $kind.Keys) { $g = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($g) { $before[$id] = $g.TotalProcessorTime.TotalSeconds } }
Start-Sleep -Seconds $Seconds
$rows = @{}; $ws = 0; $cpu = 0
foreach ($id in $kind.Keys) {
  $g = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $g) { continue }
  $k = $kind[$id]
  $c = $g.TotalProcessorTime.TotalSeconds - $before[$id]
  if (-not $rows.ContainsKey($k)) { $rows[$k] = @{ n = 0; ws = 0; cpu = 0 } }
  $rows[$k].n += 1; $rows[$k].ws += $g.WorkingSet64; $rows[$k].cpu += $c
  $ws += $g.WorkingSet64; $cpu += $c
}
$logical = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
"== $Label"
foreach ($k in ($rows.Keys | Sort-Object)) { '  {0,-36} x{1}  {2,7:N0} MB   cpu {3,5:N1}% of a core' -f $k, $rows[$k].n, ($rows[$k].ws / 1MB), ($rows[$k].cpu / $Seconds * 100) }
$cpuPct = $cpu / $Seconds * 100
'  {0,-36}      {1,7:N0} MB   cpu {2,5:N1}% of a core  ({3:N1}% of this PC)' -f 'TOTAL', ($ws / 1MB), $cpuPct, ($cpuPct / $logical)
if ($cpuPct -gt 3) { Write-Warning ('Over the idle processor budget (3% of a core): {0:N1}%. Is something animating or polling?' -f $cpuPct); exit 1 }
"  within the idle processor budget"
