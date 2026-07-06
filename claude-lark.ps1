# 启动带 Lark channel 的 Claude Code。
# 封装了 channel 实验特性所需的一长串参数，见记忆 lark-channel-requires-dev-flag。
#
# 用法:  .\claude-lark.ps1                 # 在此目录直接跑
#         pwsh C:\projects\claude-lark-channel\claude-lark.ps1   # 任意位置
# 任何额外参数都会原样透传给 claude，例如:  .\claude-lark.ps1 --resume

$ErrorActionPreference = 'Stop'

$PluginDir = 'C:\projects\claude-lark-channel'
$Channel   = 'plugin:lark@inline'

Write-Host "🚀 启动 Claude Code + Lark channel ($Channel)..." -ForegroundColor Cyan
Write-Host "   插件目录: $PluginDir" -ForegroundColor DarkGray
Write-Host "   启动后请留意 banner 下方灰字确认 channel 已注册。" -ForegroundColor DarkGray

# $args 把用户额外传的参数透传给 claude
claude --plugin-dir $PluginDir --dangerously-load-development-channels $Channel @args
