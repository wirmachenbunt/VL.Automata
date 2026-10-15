<#
  Packs VL.Automata as a vvvv nuget.

  Run from anywhere:  ./nuget/pack.ps1   (optionally: ./nuget/pack.ps1 -Version 0.2.0)

  It (1) builds Release, (2) refreshes the staged payload under nuget/ (the folder that mirrors the
  final package layout 1:1), (3) regenerates nuget/VL.Automata.vl from the dev VL.Automata.vl —
  rewriting the dev DLL path to the in-package ./lib/<tfm>/ path — (4) keeps the bundled help patch's
  package-dependency version in sync with the version being packed — and (5) packs the .nupkg into
  the repo root.

  Source (committed): VL.Automata.nuspec, this script, make-icon.ps1, icon.png and help/ (the example
  patch — it is hand-maintained now that the dev testbed was removed). Everything else under nuget/ is
  generated (see nuget/.gitignore).
#>
param([string]$Version)

$ErrorActionPreference = 'Stop'
$stage = $PSScriptRoot                                   # the nuget/ folder
$root  = Split-Path $stage -Parent                       # project root (vvvvPlugin/)
$proj  = Join-Path $root 'VL.Automata\VL.Automata.csproj'
$tfm   = 'net8.0-windows7.0'
$built = Join-Path $root 'VL.Automata\bin\Release\net8.0-windows'
$devDllPath = './VL.Automata/bin/Release/net8.0-windows/VL.Automata.dll'   # path used in the dev .vl
$libDllPath = "./lib/$tfm/VL.Automata.dll"                                  # path inside the package

# 1. Build Release
dotnet build $proj -c Release

# 2. Refresh staged payload (lib + README)
$libDir = Join-Path $stage "lib\$tfm"
New-Item -ItemType Directory -Force -Path $libDir | Out-Null
Copy-Item (Join-Path $built 'VL.Automata.dll') $libDir -Force
Copy-Item (Join-Path $built 'VL.Automata.xml') $libDir -Force
Copy-Item (Join-Path $root  'README.md')       $stage  -Force

# 3. Optionally bump the version in the nuspec, then read back the version to pack.
$nuspecPath = Join-Path $stage 'VL.Automata.nuspec'
if ($Version) {
    $nuspec = Get-Content $nuspecPath -Raw
    $nuspec = [regex]::Replace($nuspec, '<version>.*?</version>', "<version>$Version</version>")
    Set-Content $nuspecPath $nuspec -Encoding UTF8
}
$nuspecXml = [xml](Get-Content $nuspecPath -Raw)
$pkgVersion = $nuspecXml.package.metadata.version

# 4. Regenerate the package .vl from the dev .vl (only the DLL path differs)
$vl = Get-Content (Join-Path $root 'VL.Automata.vl') -Raw
$vl = $vl.Replace($devDllPath, $libDllPath)
if ($vl -notmatch [regex]::Escape($libDllPath)) {
    throw "Could not rewrite the DLL path in VL.Automata.vl - check its PlatformDependency Location still reads '$devDllPath'."
}
Set-Content (Join-Path $stage 'VL.Automata.vl') $vl -Encoding UTF8

# 5. Keep the bundled help patch's package dependency in sync with the version being packed.
#    The example patch (nuget/help/Reference Automata.vl) is a committed source now that the dev
#    testbed was removed; we only rewrite its VL.Automata dependency version so the bundled example
#    always resolves against the matching published package. Only writes back when it changes.
$helpFile = Join-Path $stage 'help\Reference Automata.vl'
if (Test-Path $helpFile) {
    $help   = Get-Content $helpFile -Raw
    $synced = [regex]::Replace($help,
        '(<NugetDependency\s+Id="Au70mata0HelpPkgDep0A"\s+Location="VL\.Automata"\s+Version=")[^"]*(")',
        "`${1}$pkgVersion`${2}")
    if ($synced -notmatch "Location=`"VL.Automata`" Version=`"$([regex]::Escape($pkgVersion))`"") {
        throw "Could not sync the VL.Automata dependency version in 'help\Reference Automata.vl' - check its NugetDependency line."
    }
    if ($synced -ne $help) { Set-Content $helpFile $synced -Encoding UTF8 }
} else {
    throw "Missing 'nuget\help\Reference Automata.vl' - the bundled example patch is required by the nuspec."
}

# 6. Pack into the repo root
dotnet pack $proj -c Release --no-build `
    "-p:NuspecFile=$nuspecPath" `
    "-p:NuspecBasePath=$stage" `
    -o $root

Write-Host "`nDone (v$pkgVersion). Push with:" -ForegroundColor Green
Write-Host "  dotnet nuget push VL.Automata.$pkgVersion.nupkg --source https://api.nuget.org/v3/index.json --api-key YOUR_KEY"
