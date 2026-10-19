param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path,
  [int]$MaximumAcceptedLatenessUs = 100
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path
$rows = @(Import-Csv -LiteralPath $resolved)
if ($rows.Count -eq 0) { throw 'Timing CSV contains no pulse records.' }

$required = @(
  'sequence', 'zero_cross_index', 'channel', 'planned_delay_us',
  'actual_delay_us', 'lateness_us', 'pulse_width_us', 'outcome', 'flags'
)
foreach ($column in $required) {
  if (-not $rows[0].PSObject.Properties.Name.Contains($column)) {
    throw "Timing CSV is missing required column: $column"
  }
}

function Percentile([double[]]$Values, [double]$Percent) {
  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling(($Percent / 100.0) * $sorted.Count) - 1
  if ($index -lt 0) { $index = 0 }
  return $sorted[$index]
}

$normalized = foreach ($row in $rows) {
  [pscustomobject]@{
    Sequence = [uint32]$row.sequence
    ZeroCross = [uint16]$row.zero_cross_index
    Channel = $row.channel
    PlannedUs = [int]$row.planned_delay_us
    ActualUs = [int]$row.actual_delay_us
    LatenessUs = [int]$row.lateness_us
    PulseWidthUs = [int]$row.pulse_width_us
    Outcome = $row.outcome
  }
}

$emitted = @($normalized | Where-Object Outcome -Like 'emitted*')
$missed = @($normalized | Where-Object Outcome -Like 'missed*')
$late = @($normalized | Where-Object Outcome -EQ 'emitted_late')
$widthErrors = @($normalized | Where-Object PulseWidthUs -NE 100)
$lateness = [double[]]@($emitted | ForEach-Object LatenessUs)
$maximumLateness = if ($lateness.Count) { [int](($lateness | Measure-Object -Maximum).Maximum) } else { $null }
$meanLateness = if ($lateness.Count) { [Math]::Round(($lateness | Measure-Object -Average).Average, 2) } else { $null }

$result = if ($missed.Count -gt 0 -or $widthErrors.Count -gt 0) {
  'FAIL'
} elseif ($maximumLateness -gt $MaximumAcceptedLatenessUs) {
  'REVIEW'
} else {
  'PASS'
}

Write-Output "Timing quality: $result"
Write-Output "File: $resolved"
Write-Output "Records: $($normalized.Count); emitted: $($emitted.Count); late emitted: $($late.Count); missed: $($missed.Count)"
Write-Output "Lateness us: mean=$meanLateness p50=$(Percentile $lateness 50) p95=$(Percentile $lateness 95) p99=$(Percentile $lateness 99) max=$maximumLateness (gate <= $MaximumAcceptedLatenessUs)"
Write-Output "Pulse-width declarations other than 100 us: $($widthErrors.Count)"
foreach ($channel in @('fan', 'heater')) {
  $channelRows = @($normalized | Where-Object Channel -EQ $channel)
  if ($channelRows.Count -eq 0) { continue }
  $channelEmitted = @($channelRows | Where-Object Outcome -Like 'emitted*')
  $channelMissed = @($channelRows | Where-Object Outcome -Like 'missed*')
  $channelLateness = [double[]]@($channelEmitted | ForEach-Object LatenessUs)
  Write-Output "$channel`: records=$($channelRows.Count) emitted=$($channelEmitted.Count) missed=$($channelMissed.Count) p99_lateness_us=$(Percentile $channelLateness 99) max_lateness_us=$(Percentile $channelLateness 100)"
}

if ($result -eq 'FAIL') { exit 2 }
if ($result -eq 'REVIEW') { exit 1 }
exit 0