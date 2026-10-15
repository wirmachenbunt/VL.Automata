<#
  Packs VL.Automata as a vvvv nuget.

  Run from anywhere:  ./nuget/pack.ps1   (optionally: ./nuget/pack.ps1 -Version 0.2.0)

  It (1) builds Release, (2) refreshes the staged payload under nuget/ (the folder that mirrors the
  final package layout 1:1), (3) regenerates nuget/VL.Automata.vl from the dev VL.Automata.vl —
  rewriting the dev DLL path to the in-package ./lib/<tfm>/ path — (4) regenerates the staged help
  patch from the dev testbed — rewriting its dev ProjectDependency into a NugetDependency on the
  VL.Automata package at the version being packed — and (5) packs the .nupkg into the repo root.

  Only VL.Automata.nuspec and this script are source; everything else under nuget/ is generated
  (see nuget/.gitignore).
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

# 5. Regenerate the staged help patch from the dev testbed, swapping the dev project reference
#    (<ProjectDependency Location="./VL.Automata/VL.Automata.csproj" />) for a package reference at
#    the version being packed, so the bundled example resolves against the installed VL.Automata.
$helpDir = Join-Path $stage 'help'
New-Item -ItemType Directory -Force -Path $helpDir | Out-Null
$help = Get-Content (Join-Path $root 'vvvv_automata_testbed.vl') -Raw
$projDepPattern = '<ProjectDependency\s+Location="\./VL\.Automata/VL\.Automata\.csproj"\s*/>'
$pkgDep = "<NugetDependency Id=`"Au70mata0HelpPkgDep0A`" Location=`"VL.Automata`" Version=`"$pkgVersion`" />"
if ($help -notmatch $projDepPattern) {
    throw "Could not find the dev ProjectDependency in vvvv_automata_testbed.vl - check it still reads Location=`"./VL.Automata/VL.Automata.csproj`"."
}
$help = [regex]::Replace($help, $projDepPattern, $pkgDep)
Set-Content (Join-Path $helpDir 'vvvv_automata_testbed.vl') $help -Encoding UTF8

# 6. Pack into the repo root
dotnet pack $proj -c Release --no-build `
    "-p:NuspecFile=$nuspecPath" `
    "-p:NuspecBasePath=$stage" `
    -o $root

Write-Host "`nDone (v$pkgVersion). Push with:" -ForegroundColor Green
Write-Host "  dotnet nuget push VL.Automata.$pkgVersion.nupkg --source https://api.nuget.org/v3/index.json --api-key YOUR_KEY"
