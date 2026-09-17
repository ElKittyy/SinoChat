[CmdletBinding()]
param(
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$scriptPath = $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $scriptPath)
}
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Add-Failure {
  param([string]$Message)
  $script:failures.Add($Message)
  Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Add-Warning {
  param([string]$Message)
  $script:warnings.Add($Message)
  Write-Host "[AVISO] $Message" -ForegroundColor Yellow
}

function Add-Success {
  param([string]$Message)
  Write-Host "[OK] $Message" -ForegroundColor Green
}

$resolvedRoot = Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop
Set-Location -LiteralPath $resolvedRoot

$requiredFiles = @(
  "package.json",
  "package-lock.json",
  ".env.example",
  "compose.yaml",
  "apps/api/prisma/schema.prisma"
)

foreach ($relativePath in $requiredFiles) {
  if (Test-Path -LiteralPath (Join-Path $resolvedRoot $relativePath)) {
    Add-Success "Existe $relativePath"
  }
  else {
    Add-Failure "Falta $relativePath"
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Add-Failure "Node.js no esta disponible en PATH."
}
else {
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0) {
    Add-Failure "No se pudo ejecutar node --version."
  }
  elseif ($nodeVersion -notmatch '^v24\.') {
    Add-Failure "Se requiere Node 24 LTS; se detecto $nodeVersion."
  }
  else {
    Add-Success "Node $nodeVersion"
  }
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  Add-Failure "npm.cmd no esta disponible en PATH."
}
else {
  $npmVersion = (& npm.cmd --version).Trim()
  if ($LASTEXITCODE -eq 0) {
    Add-Success "npm $npmVersion (npm.cmd)"
  }
  else {
    Add-Failure "No se pudo ejecutar npm.cmd --version."
  }
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCommand) {
  Add-Failure "Docker no esta instalado o no esta en PATH."
}
else {
  $composeVersion = & docker compose version 2>$null
  if ($LASTEXITCODE -ne 0) {
    Add-Failure "Docker Compose v2 no esta disponible o el motor no responde."
  }
  else {
    Add-Success ($composeVersion | Out-String).Trim()
  }
}

$envPath = Join-Path $resolvedRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
  Add-Warning ".env todavia no existe; copiar .env.example sin sobrescribir archivos existentes."
}
else {
  Add-Success ".env existe (sus valores no se muestran)."

  $environmentNames = @{}
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $environmentNames[$matches[1]] = $matches[2]
    }
  }

  $requiredLocalNames = @(
    "NODE_ENV",
    "WEB_ORIGIN",
    "VITE_API_URL",
    "DATABASE_URL",
    "REDIS_URL"
  )
  foreach ($name in $requiredLocalNames) {
    if (-not $environmentNames.ContainsKey($name) -or
        [string]::IsNullOrWhiteSpace($environmentNames[$name])) {
      Add-Failure "$name falta o esta vacio en .env."
    }
  }

  $secretNames = @(
    "PASSWORD_PEPPER",
    "METADATA_HASH_SECRET",
    "INVITATION_ENCRYPTION_KEY",
    "ATTACHMENT_GRANT_SECRET",
    "EVIDENCE_UPLOAD_GRANT_SECRET",
    "DEVICE_BINDING_HMAC_SECRET"
  )
  foreach ($name in $secretNames) {
    if (-not $environmentNames.ContainsKey($name) -or
        [string]::IsNullOrWhiteSpace($environmentNames[$name])) {
      Add-Warning "$name no esta configurado; algunas operaciones no funcionaran y produccion lo rechaza."
    }
  }

  $storageNames = @(
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_REGION",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
    "OBJECT_STORAGE_FORCE_PATH_STYLE",
    "OBJECT_STORAGE_VERSIONING_MODE"
  )
  $missingStorage = @()
  foreach ($name in $storageNames) {
    if (-not $environmentNames.ContainsKey($name) -or
        [string]::IsNullOrWhiteSpace($environmentNames[$name])) {
      $missingStorage += $name
    }
  }
  if ($missingStorage.Count -gt 0) {
    Add-Warning "S3 no esta completo; fotos/evidencia no estaran disponibles. Faltan $($missingStorage -join ', ')."
  }
  else {
    if ($environmentNames["OBJECT_STORAGE_FORCE_PATH_STYLE"] -notin @("true", "false")) {
      Add-Failure "OBJECT_STORAGE_FORCE_PATH_STYLE debe ser true o false."
    }
    if ($environmentNames["OBJECT_STORAGE_VERSIONING_MODE"] -notin @("disabled", "purge-all")) {
      Add-Failure "OBJECT_STORAGE_VERSIONING_MODE debe ser disabled o purge-all."
    }

    $storageUri = $null
    if (-not [Uri]::TryCreate(
        $environmentNames["OBJECT_STORAGE_ENDPOINT"],
        [UriKind]::Absolute,
        [ref]$storageUri
      )) {
      Add-Failure "OBJECT_STORAGE_ENDPOINT no es una URL absoluta valida."
    }
    elseif ($storageUri.Host -in @("127.0.0.1", "localhost")) {
      foreach ($name in @("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD")) {
        if (-not $environmentNames.ContainsKey($name) -or
            [string]::IsNullOrWhiteSpace($environmentNames[$name])) {
          Add-Failure "$name falta para el MinIO local. Ejecutar npm.cmd run local:storage:configure."
        }
      }
      if ($environmentNames["OBJECT_STORAGE_FORCE_PATH_STYLE"] -ne "true") {
        Add-Failure "El MinIO local requiere OBJECT_STORAGE_FORCE_PATH_STYLE=true."
      }
      if ($environmentNames["OBJECT_STORAGE_VERSIONING_MODE"] -ne "purge-all") {
        Add-Failure "El bucket local versionado requiere OBJECT_STORAGE_VERSIONING_MODE=purge-all."
      }
      if ($environmentNames["OBJECT_STORAGE_BUCKET"] -ne "sinochat-ephemeral") {
        Add-Failure "El compose local requiere OBJECT_STORAGE_BUCKET=sinochat-ephemeral."
      }
    }
    Add-Success "Configuracion S3 presente (sus credenciales no se muestran)."
  }
}

Write-Host ""
Write-Host "Resultado: $($failures.Count) error(es), $($warnings.Count) aviso(s)."
if ($failures.Count -gt 0) {
  exit 1
}
exit 0
