# 下载 bge-base-zh-v1.5 的 ONNX 副本到 plugin/models/，供离线加载。
#
# 为什么不用 transformers.js 自己下：本机 huggingface.co 直连被污染，
# 镜像 hf-mirror.com 可直连但只有 ~100KB/s，且它的下载器不显示进度。
# 用 curl 直取至少能看到进度、能续。
#
#   pwsh -File scripts/download-model.ps1
#
# 模型是二进制资产（int8 约 110MB），已在 .gitignore 里排除。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'models\bge-base-zh-v1.5'
$base = 'https://hf-mirror.com/Xenova/bge-base-zh-v1.5/resolve/main'

New-Item -ItemType Directory -Force -Path (Join-Path $dir 'onnx') | Out-Null

$files = @(
  @{ Path = 'config.json'; MinBytes = 500 },
  @{ Path = 'tokenizer.json'; MinBytes = 200000 },
  @{ Path = 'tokenizer_config.json'; MinBytes = 100 },
  @{ Path = 'special_tokens_map.json'; MinBytes = 50 },
  @{ Path = 'onnx/model_int8.onnx'; MinBytes = 50MB }
)

foreach ($file in $files) {
  $target = Join-Path $dir $file.Path
  if ((Test-Path $target) -and ((Get-Item $target).Length -ge $file.MinBytes)) {
    Write-Host "skip $($file.Path)（已存在）"
    continue
  }
  Write-Host "fetch $($file.Path)"
  curl.exe -L --fail --retry 3 --retry-delay 2 --max-time 3600 -o $target "$base/$($file.Path)"
  $size = (Get-Item $target).Length
  if ($size -lt $file.MinBytes) {
    throw "$($file.Path) 只下到 $size 字节，小于预期 $($file.MinBytes)"
  }
}

Write-Host "done: $dir"
