param(
    [int]$Port = 8765,
    [string]$AudioDir,
    [string]$AnswerFile,
    [switch]$NoBrowser
)

function Resolve-MaterialsRoot {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $candidate = Get-ChildItem -LiteralPath $desktop -Directory -ErrorAction Stop |
        Where-Object { $_.Name -like "ptecore*" } |
        Select-Object -First 1

    if (-not $candidate) {
        throw "Could not locate the ptecore materials folder on your Desktop."
    }

    return $candidate.FullName
}

if (-not $AudioDir -or -not $AnswerFile) {
    $materialsRoot = Resolve-MaterialsRoot

    if (-not $AudioDir) {
        $defaultAudioDir = Join-Path $materialsRoot "WritingFromDication137YNWAC"
        if (-not (Test-Path -LiteralPath $defaultAudioDir)) {
            throw "Could not find the default audio directory: $defaultAudioDir"
        }
        $AudioDir = $defaultAudioDir
    }

    if (-not $AnswerFile) {
        $answerCandidate = Get-ChildItem -LiteralPath $materialsRoot -File -Filter "PTE_WFD_*.txt" |
            Select-Object -First 1
        if (-not $answerCandidate) {
            throw "Could not find a default PTE_WFD answer file in: $materialsRoot"
        }
        $AnswerFile = $answerCandidate.FullName
    }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $scriptRoot "server.py"

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$launchArgs = @()

if ($pythonCommand) {
    $pythonExecutable = $pythonCommand.Source
    $launchArgs += $serverScript
} else {
    $pyCommand = Get-Command py -ErrorAction SilentlyContinue
    if (-not $pyCommand) {
        throw "Python was not found. Please make sure python or py is available in PATH."
    }
    $pythonExecutable = $pyCommand.Source
    $launchArgs += "-3"
    $launchArgs += $serverScript
}

$launchArgs += "--port"
$launchArgs += $Port
$launchArgs += "--audio-dir"
$launchArgs += $AudioDir
$launchArgs += "--answer-file"
$launchArgs += $AnswerFile

if (-not $NoBrowser) {
    $launchArgs += "--open-browser"
}

Write-Host ""
Write-Host "PTE Core WFD Trainer"
Write-Host "  URL       : http://127.0.0.1:$Port"
Write-Host "  Audio dir : $AudioDir"
Write-Host "  Answers   : $AnswerFile"
Write-Host ""
Write-Host "Press Ctrl+C to stop the server."
Write-Host ""

& $pythonExecutable @launchArgs
