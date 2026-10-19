param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path,
  [int]$MaximumAbsolutePhaseErrorUs = 5,
  [int]$MinimumPulseWidthUs = 99,
  [int]$MaximumPulseWidthUs = 101,
  [int]$MinimumRecordsPerRequiredChannel = 300,
  [switch]$RequireHeater
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path
$rows = @(Import-Csv -LiteralPath $resolved)
if ($rows.Count -eq 0) { throw 'Hardware timing CSV contains no pulse records.' }

$required = @(
  'sequence', 'zero_cross_index', 'channel', 'planned_delay_us',
  'actual_delay_us', 'lateness_us', 'pulse_width_us', 'outcome', 'flags'
)
foreach ($column in $required) {
  if (-not $rows[0].PSObject.Properties.Name.Contains($column)) {
    throw "Hardware timing CSV is missing required column: $column"
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
  $phaseError = [int]$row.actual_delay_us - [int]$row.planned_delay_us
  [pscustomobject]@{
    Sequence = [uint32]$row.sequence
    ZeroCross = [uint16]$row.zero_cross_index
    Channel = $row.channel.ToLowerInvariant()
    PlannedUs = [int]$row.planned_delay_us
    ActualUs = [int]$row.actual_delay_us
    PhaseErrorUs = $phaseError
    AbsolutePhaseErrorUs = [Math]::Abs($phaseError)
    PulseWidthUs = [int]$row.pulse_width_us
    Outcome = $row.outcome
  }
}

$emitted = @($normalized | Where-Object Outcome -Like 'emitted*')
$missed = @($normalized | Where-Object Outcome -Like 'missed*')
$unknownChannels = @($normalized | Where-Object Channel -NotIn @('fan', 'heater'))
$phaseFailures = @($emitted | Where-Object AbsolutePhaseErrorUs -GT $MaximumAbsolutePhaseErrorUs)
$invalidDelays = @($emitted | Where-Object { $_.PlannedUs -le 0 -or $_.ActualUs -le 0 })
$widthFailures = @($emitted | Where-Object {
  $_.PulseWidthUs -lt $MinimumPulseWidthUs -or
  $_.PulseWidthUs -gt $MaximumPulseWidthUs
})
$sequenceGaps = 0
for ($index = 1; $index -lt $normalized.Count; ++$index) {
  if ($normalized[$index].Sequence -ne $normalized[$index - 1].Sequence + 1) {
    $sequenceGaps++
  }
}

$requiredChannels = @('fan')
if ($RequireHeater) { $requiredChannels += 'heater' }
$channelFailures = 0
$channelSummaries = @()
foreach ($channelName in @('fan', 'heater')) {
  $channelRows = @($emitted | Where-Object Channel -EQ $channelName)
  $indexGaps = 0
  for ($index = 1; $index -lt $channelRows.Count; ++$index) {
    $expected = [uint16](($channelRows[$index - 1].ZeroCross + 1) -band 0xFFFF)
    if ($channelRows[$index].ZeroCross -ne $expected) { $indexGaps++ }
  }
  $requiredHere = $requiredChannels -contains $channelName
  if ($indexGaps -gt 0 -or
      ($requiredHere -and $channelRows.Count -lt $MinimumRecordsPerRequiredChannel)) {
    $channelFailures++
  }
  if ($channelRows.Count -gt 0 -or $requiredHere) {
    $phaseAbsolute = [double[]]@($channelRows | ForEach-Object AbsolutePhaseErrorUs)
    $widths = [double[]]@($channelRows | ForEach-Object PulseWidthUs)
    $channelSummaries +=
        "$channelName records=$($channelRows.Count) index_gaps=$indexGaps phase_p99_abs_us=$(Percentile $phaseAbsolute 99) width_min_us=$(($widths | Measure-Object -Minimum).Minimum) width_max_us=$(($widths | Measure-Object -Maximum).Maximum)"
  }
}

$result = 'PASS'
if ($missed.Count -gt 0 -or $unknownChannels.Count -gt 0 -or
    $phaseFailures.Count -gt 0 -or $invalidDelays.Count -gt 0 -or
    $widthFailures.Count -gt 0 -or $sequenceGaps -gt 0 -or
    $channelFailures -gt 0) {
  $result = 'FAIL'
}

Write-Output "MCPWM waveform quality: $result"
Write-Output "File: $resolved"
Write-Output "Records: $($normalized.Count); emitted: $($emitted.Count); missed: $($missed.Count); unknown channels: $($unknownChannels.Count); invalid delays: $($invalidDelays.Count); sequence gaps: $sequenceGaps"
foreach ($summary in $channelSummaries) { Write-Output "Channel: $summary" }
Write-Output "Gates: phase <= +/-$MaximumAbsolutePhaseErrorUs us; width $MinimumPulseWidthUs..$MaximumPulseWidthUs us; required records/channel >= $MinimumRecordsPerRequiredChannel; heater required=$RequireHeater"

if ($result -eq 'FAIL') { exit 2 }
exit 0