$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'moyu-' }
if ($procs) {
  foreach ($p in $procs) { Write-Output ("killing PID {0}" -f $p.ProcessId) }
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output "done"
} else {
  Write-Output "no stale headless chrome"
}
