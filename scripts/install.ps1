# 把 @ptfm/dsh-github 装进本机 DSH（Windows）。
#
# 做三件事，全部幂等：
#   1. 把插件复制到 $DSH_HOME/plugins/dsh-github（或 --From <本地目录> 直接用本地 checkout）；
#   2. 在目标 profile 的 package.json 里登记 link: 依赖与 bundle；
#   3. 安装依赖并在 node_modules/@ptfm 下建好链接。
#
# 用法：
#   pwsh -File scripts/install.ps1                      # 装进当前 DSH_PROFILE（默认 desktop）
#   pwsh -File scripts/install.ps1 -Profile web         # 指定 profile
#   pwsh -File scripts/install.ps1 -From ..\.dsh-github  # 用本地目录而不是复制
#
# 卸载：把 profile 的 package.json 里 @ptfm/dsh-github 从 dependencies 与
# dsh.profile.bundles 删除，重跑一次 pnpm install 即可。

[CmdletBinding()]
param(
  [string]$Profile,
  [string]$From,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "• $m" }
function Ok($m) { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 跑在 .NET Framework 上，没有 [IO.Path]::GetRelativePath
# （那是 .NET Core 才有的），所以自己算一个。
function Get-RelativePath([string]$BaseDir, [string]$TargetDir) {
  $base = (Resolve-Path $BaseDir).Path.TrimEnd('\', '/')
  $target = (Resolve-Path $TargetDir).Path.TrimEnd('\', '/')
  $baseParts = @($base -split '[\\/]')
  $targetParts = @($target -split '[\\/]')
  $common = 0
  while ($common -lt $baseParts.Count -and $common -lt $targetParts.Count -and $baseParts[$common] -ieq $targetParts[$common]) {
    $common++
  }
  $up = @()
  for ($i = $common; $i -lt $baseParts.Count; $i++) { $up += '..' }
  $down = @()
  if ($common -lt $targetParts.Count) { $down = @($targetParts[$common..($targetParts.Count - 1)]) }
  return (@($up) + @($down) -join '/')
}

$PluginName = '@ptfm/dsh-github'
$RepoSlug = 'w32394045-dotcom/dsh-github'

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not (Test-Path $DshHome)) { Die "找不到 DSH home：$DshHome。请先安装并运行一次 DeepSeek Harness。" }

$ProfileName = if ($Profile) { $Profile } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
if (-not (Test-Path $ProfileDir)) { Die "找不到 profile 目录：$ProfileDir" }

# 解析依赖位置：本机自带 node/pnpm 优先，避免要求用户预装。
$RuntimeRoot = Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies'
$BundledNode = Join-Path $RuntimeRoot 'node\bin\node.exe'
$BundledPnpm = Join-Path $RuntimeRoot 'pnpm\bin\pnpm.cjs'
$Node = if (Test-Path $BundledNode) { $BundledNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { Die "找不到 node：既没有 dsh 自带的，也没有 PATH 里的。" }

function Invoke-Pnpm([string]$InDirectory, [string[]]$PnpmArguments) {
  # 用 Start-Process 显式指定**子进程的工作目录**，而不是 Push-Location 或 pnpm --dir：
  # 某些宿主（例如 DSH 自己的 shell 工具）会把 pwsh 的 cwd 固定成用户主目录，
  # 于是 pnpm 会去那儿找 package.json，报 NO_PKG_MANIFEST 或 ENOENT。
  # 参数名刻意不叫 `WorkingDir`：否则 `-WorkingDirectory` 会被 PowerShell 按前缀
  # 绑定到这个函数自己的参数上，而不是 Start-Process 的。
  $stamp = [Guid]::NewGuid().ToString('N').Substring(0, 6)
  $tempOut = Join-Path $env:TEMP "dsh-github-pnpm-out-$stamp.log"
  $tempErr = Join-Path $env:TEMP "dsh-github-pnpm-err-$stamp.log"
  if ((Test-Path $BundledPnpm) -and (Test-Path $BundledNode)) {
    $exe = $BundledNode
    $exeArgs = @($BundledPnpm) + $PnpmArguments
  } else {
    $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
    if (-not $pnpm) { Die "找不到 pnpm：既没有 dsh 自带的 $BundledPnpm，也没有 PATH 里的。" }
    if ($pnpm -match '\.(cmd|bat)$') {
      $exe = $env:ComSpec
      $exeArgs = @('/c', $pnpm) + $PnpmArguments
    } else {
      $exe = $pnpm
      $exeArgs = $PnpmArguments
    }
  }
  $proc = Start-Process -FilePath $exe -ArgumentList $exeArgs -WorkingDirectory $InDirectory `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr
  foreach ($file in @($tempOut, $tempErr)) {
    if (Test-Path $file) {
      # 按 UTF-8 显式读：pnpm 的输出里有 box-drawing 字符，用默认编码会变成乱码。
      [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8) | ForEach-Object { Write-Host $_ }
      Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
  }
  if ($proc.ExitCode -ne 0) { Die "pnpm $($PnpmArguments -join ' ') 失败（exit $($proc.ExitCode)）" }
}

# ── 1. 落地插件源码 ─────────────────────────────────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot
if ($From) {
  $PluginDir = (Resolve-Path $From).Path
  Info "使用本地插件目录：$PluginDir"
} else {
  $PluginDir = Join-Path $DshHome 'plugins\dsh-github'
  if ((Test-Path (Join-Path $PluginDir 'lib\index.js')) -and -not $Force) {
    Info "已存在插件目录，跳过下载：$PluginDir（要覆盖请加 -Force）"
  } else {
    # 优先用当前 checkout（如果脚本就是在仓库里跑的），否则从 GitHub 下载 zip。
    if (Test-Path (Join-Path $RepoRoot 'lib\index.js')) {
      Info "从当前 checkout 复制：$RepoRoot"
      if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PluginDir) | Out-Null
      Copy-Item $RepoRoot $PluginDir -Recurse -Force
      Remove-Item (Join-Path $PluginDir '.git') -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Info "从 GitHub 下载：$RepoSlug"
      $zip = Join-Path $env:TEMP ("dsh-github-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.zip')
      Invoke-WebRequest -Uri "https://codeload.github.com/$RepoSlug/zip/refs/heads/main" -OutFile $zip
      $extract = Join-Path $env:TEMP ("dsh-github-unzip-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
      Expand-Archive -Path $zip -DestinationPath $extract -Force
      Remove-Item $zip -Force
      $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
      if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PluginDir) | Out-Null
      Move-Item $inner.FullName $PluginDir
      Remove-Item $extract -Recurse -Force
    }
  }
}
if (-not (Test-Path (Join-Path $PluginDir 'lib\index.js'))) { Die "插件目录里没有 lib\index.js：$PluginDir" }
Ok "插件源码就绪：$PluginDir"

# ── 2. 登记到 profile ───────────────────────────────────────────
$ManifestPath = Join-Path $ProfileDir 'package.json'
$ManifestText = Get-Content $ManifestPath -Raw
$Manifest = $ManifestText | ConvertFrom-Json

# link: 用相对路径（相对于 profile 目录），保证换机器、换用户名都不用改。
$Relative = Get-RelativePath -BaseDir $ProfileDir -TargetDir $PluginDir
$LinkSpec = 'link:' + $Relative

if (-not $Manifest.dependencies) { $Manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
if (-not $Manifest.dependencies.PSObject.Properties[$PluginName]) {
  $Manifest.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $LinkSpec
  Info "dependencies += $PluginName → $LinkSpec"
} elseif ($Force) {
  $Manifest.dependencies.PSObject.Properties[$PluginName].Value = $LinkSpec
  Info "dependencies 已更新 → $LinkSpec"
} else {
  Info "dependencies 里已有 $PluginName，保持不变"
}

$bundles = @($Manifest.dsh.profile.bundles)
if ($bundles -notcontains $PluginName) {
  $Manifest.dsh.profile.bundles = @($bundles + $PluginName)
  Info "bundles += $PluginName"
} else {
  Info "bundles 里已有 $PluginName，保持不变"
}

# 写回：保持 4 空格缩进与末尾换行，避免把用户文件改成另一种风格。
$json = $Manifest | ConvertTo-Json -Depth 10
$json = $json -replace "`r`n", "`n"
Set-Content -Path $ManifestPath -Value $json -Encoding UTF8
Ok "已更新 $ManifestPath"

# ── 3. 安装依赖 ─────────────────────────────────────────────────
Info "在 profile 里安装依赖…"
Invoke-Pnpm -InDirectory $ProfileDir -PnpmArguments @('install')

$Linked = Join-Path $ProfileDir "node_modules\@ptfm\dsh-github"
if (Test-Path $Linked) { Ok "链接已建立：$Linked" } else { Warn "没找到 $Linked，请检查上面的 pnpm 输出" }

Write-Host ""
Ok "安装完成。"
Write-Host "  下一步：打开 DSH → 设置 → GitHub → 粘贴 Personal Access Token 登录（或用 OAuth 设备流）。"
Write-Host "  如果插件没有立刻出现，重启一次 DeepSeek Harness。"
Write-Host "  卸载：从 profile 的 package.json 里删掉 dependencies 与 dsh.profile.bundles 中的 $PluginName，重跑 pnpm install。"
