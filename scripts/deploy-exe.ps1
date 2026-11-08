# 把 Dounai 构建产物落到模块根，使 manifest 的 {module_dir}/dounai.exe 成立。
#
# 为什么需要这一步：
#   - 构建产物默认落在 src-tauri/target/release/（构建中间目录）
#   - 而 manifest 声明的是「模块根下的 dounai.exe」
#   - 两者不衔接时，启动器点击「启动」会报「文件不存在」
#
# 用法：npm run deploy:exe

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src-tauri\target\release\dounai.exe'
$dst = Join-Path $root 'dounai.exe'

if (-not (Test-Path $src)) {
    Write-Host "构建产物不存在：$src" -ForegroundColor Red
    Write-Host "请先运行：npm run build:exe" -ForegroundColor Yellow
    exit 1
}

Copy-Item $src $dst -Force
$item = Get-Item $dst
Write-Host ("已部署到模块根：{0}（{1:N2} MB）" -f $dst, ($item.Length / 1MB)) -ForegroundColor Green
