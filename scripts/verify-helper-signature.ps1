[CmdletBinding()]
param(
  [Parameter()]
  [string]$BinaryPath = (Join-Path $PSScriptRoot "..\public\downloads\SaigeVisionProjectAssistant.ZipFixer.exe"),

  [Parameter()]
  [string]$Sha256Path = "",

  [Parameter()]
  [string]$ExpectedPublisher = $env:SAIGE_HELPER_EXPECTED_PUBLISHER,

  [Parameter()]
  [string]$ExpectedPublisherThumbprint = $env:SAIGE_HELPER_EXPECTED_THUMBPRINT
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Normalize-Thumbprint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  return ($Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
}

$resolvedBinary = (Resolve-Path -LiteralPath $BinaryPath).Path
if ([string]::IsNullOrWhiteSpace($Sha256Path)) {
  $Sha256Path = "$resolvedBinary.sha256"
}
$resolvedSha256 = (Resolve-Path -LiteralPath $Sha256Path).Path

Assert-Condition `
  (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher)) `
  "ExpectedPublisher is required. Stable CI must pin the exact certificate Subject via -ExpectedPublisher or SAIGE_HELPER_EXPECTED_PUBLISHER."

$checksumText = (Get-Content -LiteralPath $resolvedSha256 -Raw).Trim()
$checksumMatch = [regex]::Match(
  $checksumText,
  "\A(?<hash>[0-9A-Fa-f]{64})[ \t]+\*?(?<name>[^\r\n]+)\z",
  [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
)
Assert-Condition $checksumMatch.Success "The .sha256 file must contain exactly one SHA-256 record."

$declaredFileName = $checksumMatch.Groups["name"].Value.Trim()
Assert-Condition `
  ([System.StringComparer]::Ordinal.Equals($declaredFileName, [System.IO.Path]::GetFileName($resolvedBinary))) `
  "The .sha256 record names a different binary."

$expectedHash = $checksumMatch.Groups["hash"].Value.ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $resolvedBinary -Algorithm SHA256).Hash.ToUpperInvariant()
Assert-Condition `
  ([System.StringComparer]::Ordinal.Equals($actualHash, $expectedHash)) `
  "The helper SHA-256 does not match its .sha256 record."

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedBinary
Assert-Condition `
  ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) `
  "Authenticode signature status is '$($signature.Status)'; expected 'Valid'."
Assert-Condition ($null -ne $signature.SignerCertificate) "The helper has no signer certificate."
Assert-Condition ($null -ne $signature.TimeStamperCertificate) "The helper has no trusted timestamp countersignature."

$actualPublisher = $signature.SignerCertificate.Subject.Trim()
Assert-Condition `
  ([System.StringComparer]::OrdinalIgnoreCase.Equals($actualPublisher, $ExpectedPublisher.Trim())) `
  "The signer publisher does not match the pinned ExpectedPublisher."

$codeSigningOid = "1.3.6.1.5.5.7.3.3"
$hasCodeSigningEku = $false
foreach ($extension in $signature.SignerCertificate.Extensions) {
  if ($extension -isnot [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
    continue
  }
  foreach ($oid in $extension.EnhancedKeyUsages) {
    if ($oid.Value -eq $codeSigningOid) {
      $hasCodeSigningEku = $true
      break
    }
  }
}
Assert-Condition $hasCodeSigningEku "The signer certificate does not contain the Code Signing EKU."

if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisherThumbprint)) {
  $expectedThumbprint = Normalize-Thumbprint $ExpectedPublisherThumbprint
  $actualThumbprint = Normalize-Thumbprint $signature.SignerCertificate.Thumbprint
  Assert-Condition `
    ($expectedThumbprint.Length -gt 0 -and [System.StringComparer]::Ordinal.Equals($actualThumbprint, $expectedThumbprint)) `
    "The signer certificate thumbprint does not match the pinned thumbprint."
}

[PSCustomObject]@{
  Binary = $resolvedBinary
  Sha256 = $actualHash
  Publisher = $actualPublisher
  SignerThumbprint = $signature.SignerCertificate.Thumbprint
  TimestampAuthority = $signature.TimeStamperCertificate.Subject
  Status = $signature.Status.ToString()
}
