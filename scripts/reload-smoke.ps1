#requires -Version 5.1
<#
.SYNOPSIS
热重载回归脚本（P2-7）

.DESCRIPTION
连续执行插件热重载，并做以下检查：
1) 每次重载接口是否成功
2) 重载后状态接口是否可用
3) （可选）插件监听器/定时器数量是否持续增长
4) （可选）业务探针接口是否仍可访问
5) 汇总 PluginManager 日志中的失败关键词
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AccountId,

    [Parameter(Mandatory = $true)]
    [string]$PluginPath,

    [string]$PluginName = "",
    [string]$BaseUrl = "http://127.0.0.1:8888",
    [int]$Iterations = 10,
    [int]$DelayMs = 500,
    [int]$TimeoutSec = 15,
    [int]$AllowedGrowth = 0,
    [string]$ProbePath = "",
    [string]$Token = "",
    [switch]$TryLogin,
    [string]$Password = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-ApiHeaders {
    param([string]$AuthToken, [string]$AccountIdValue)
    $headers = @{
        "x-account-id" = $AccountIdValue
    }
    if (-not [string]::IsNullOrWhiteSpace($AuthToken)) {
        $headers["Authorization"] = "Bearer $AuthToken"
    }
    return $headers
}

function Invoke-JsonApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("GET", "POST", "DELETE")] [string]$Method,
        [Parameter(Mandatory = $true)] [string]$Url,
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [int]$Timeout = 15
    )

    try {
        if ($null -eq $Body) {
            return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -TimeoutSec $Timeout
        }
        $json = $Body | ConvertTo-Json -Depth 8
        return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec $Timeout
    } catch {
        $detail = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $detail = "$detail | $($_.ErrorDetails.Message)"
        }
        throw "接口请求失败: [$Method] $Url => $detail"
    }
}

function Get-PluginDiagnostics {
    param(
        [string]$Base,
        [string]$Id,
        [string]$Name,
        [hashtable]$Headers,
        [int]$Timeout
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }
    $url = "${Base}/api/accounts/${Id}/plugins/${Name}/diagnostics"
    $resp = Invoke-JsonApi -Method GET -Url $url -Headers $Headers -Timeout $Timeout
    if ($resp.code -ne 0) {
        throw "获取插件诊断失败: $($resp.message)"
    }
    return $resp.data
}

function Assert-DiagnosticsStable {
    param(
        [object]$Baseline,
        [object]$Current,
        [int]$Growth,
        [int]$Iteration
    )

    if ($null -eq $Baseline -or $null -eq $Current) {
        return
    }

    $checks = @(
        @{ Name = "listenerCount"; Base = [int]$Baseline.listenerCount; Curr = [int]$Current.listenerCount },
        @{ Name = "timeoutCount"; Base = [int]$Baseline.timeoutCount; Curr = [int]$Current.timeoutCount },
        @{ Name = "intervalCount"; Base = [int]$Baseline.intervalCount; Curr = [int]$Current.intervalCount }
    )

    foreach ($c in $checks) {
        $delta = $c.Curr - $c.Base
        if ($delta -gt $Growth) {
            throw "第 $Iteration 次重载后，$($c.Name) 从 $($c.Base) 增长到 $($c.Curr)，超过允许增量 $Growth"
        }
    }
}

if ($TryLogin.IsPresent -and [string]::IsNullOrWhiteSpace($Token)) {
    if ([string]::IsNullOrWhiteSpace($Password)) {
        throw "TryLogin 已启用，但未提供 Password"
    }
    $loginUrl = "${BaseUrl}/api/login"
    $loginResp = Invoke-JsonApi -Method POST -Url $loginUrl -Body @{ password = $Password } -Timeout $TimeoutSec
    if ($loginResp.code -ne 0 -or [string]::IsNullOrWhiteSpace($loginResp.data.token)) {
        throw "登录失败，无法获取 token"
    }
    $Token = [string]$loginResp.data.token
    Write-Host "登录成功，已获取临时 token。"
}

$headers = New-ApiHeaders -AuthToken $Token -AccountIdValue $AccountId
$baseDiag = Get-PluginDiagnostics -Base $BaseUrl -Id $AccountId -Name $PluginName -Headers $headers -Timeout $TimeoutSec
if ($baseDiag) {
    Write-Host ("基线诊断: listener={0}, timeout={1}, interval={2}" -f $baseDiag.listenerCount, $baseDiag.timeoutCount, $baseDiag.intervalCount)
}

$results = New-Object System.Collections.Generic.List[object]
$failed = $false

for ($i = 1; $i -le $Iterations; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $row = [ordered]@{
        Iteration = $i
        ReloadOk = $false
        StatusOk = $false
        ProbeOk = $false
        DiagOk = $false
        DurationMs = 0
        Error = ""
    }

    try {
        $reloadUrl = "${BaseUrl}/api/accounts/${AccountId}/reload"
        $reloadResp = Invoke-JsonApi -Method POST -Url $reloadUrl -Headers $headers -Body @{ pluginPath = $PluginPath } -Timeout $TimeoutSec
        if ($reloadResp.code -ne 0) {
            throw "重载接口返回失败: $($reloadResp.message)"
        }
        $row.ReloadOk = $true

        $statusUrl = "${BaseUrl}/api/accounts/${AccountId}/status"
        $statusResp = Invoke-JsonApi -Method GET -Url $statusUrl -Headers $headers -Timeout $TimeoutSec
        if ($statusResp.code -ne 0) {
            throw "状态接口返回失败: $($statusResp.message)"
        }
        $row.StatusOk = $true

        $diag = Get-PluginDiagnostics -Base $BaseUrl -Id $AccountId -Name $PluginName -Headers $headers -Timeout $TimeoutSec
        if ($diag) {
            Assert-DiagnosticsStable -Baseline $baseDiag -Current $diag -Growth $AllowedGrowth -Iteration $i
            $row.DiagOk = $true
        } else {
            $row.DiagOk = $true
        }

        if (-not [string]::IsNullOrWhiteSpace($ProbePath)) {
            $probeUrl = "${BaseUrl}${ProbePath}"
            $probeResp = Invoke-JsonApi -Method GET -Url $probeUrl -Headers $headers -Timeout $TimeoutSec
            if ($probeResp.code -ne 0) {
                throw "探针接口返回失败: $($probeResp.message)"
            }
            $row.ProbeOk = $true
        } else {
            $row.ProbeOk = $true
        }
    } catch {
        $failed = $true
        $row.Error = $_.Exception.Message
    } finally {
        $sw.Stop()
        $row.DurationMs = [int]$sw.ElapsedMilliseconds
        $results.Add([pscustomobject]$row)
        Start-Sleep -Milliseconds $DelayMs
    }
}

$logUrl = ('{0}/api/accounts/{1}/logs?tag=PluginManager&limit=1000' -f $BaseUrl, $AccountId)
$logResp = Invoke-JsonApi -Method GET -Url $logUrl -Headers $headers -Timeout $TimeoutSec
$logs = @()
if ($logResp.code -eq 0 -and $logResp.data) {
    $logs = @($logResp.data)
}

$errorKeywords = @(
    "热重载失败",
    "回滚启用失败",
    "旧插件停用失败",
    "定时器清理失败",
    "MaxListenersExceededWarning"
)

$hitLogs = @()
foreach ($item in $logs) {
    $msg = [string]$item.message
    foreach ($k in $errorKeywords) {
        if ($msg -like "*$k*") {
            $hitLogs += $item
            break
        }
    }
}

Write-Host ""
Write-Host "=== 热重载回归结果 ==="
$results | Format-Table -AutoSize
Write-Host ""
Write-Host ("总次数: {0}, 失败次数: {1}" -f $Iterations, (($results | Where-Object { -not $_.ReloadOk -or -not $_.StatusOk -or -not $_.DiagOk -or -not $_.ProbeOk }).Count))
Write-Host ("命中错误关键词日志数: {0}" -f $hitLogs.Count)

if ($hitLogs.Count -gt 0) {
    Write-Host "最近命中日志（最多 5 条）:"
    $hitLogs | Select-Object -Last 5 | ForEach-Object {
        Write-Host ("- [{0}] {1}" -f $_.level, $_.message)
    }
}

$strictFailures = $results | Where-Object {
    -not $_.ReloadOk -or -not $_.StatusOk -or -not $_.DiagOk -or -not $_.ProbeOk
}

if ($failed -or $strictFailures.Count -gt 0 -or $hitLogs.Count -gt 0) {
    Write-Error "回归检查失败，请根据表格和日志排查。"
    exit 1
}

Write-Host "回归检查通过。"
exit 0
