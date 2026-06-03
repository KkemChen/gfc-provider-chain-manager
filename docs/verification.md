# Verification

After generating and applying the config, check the generated config and virtual provider file:

```powershell
rg -n "链式出口|provider-chain-manager" "C:\Program Files\GUI.for.Clash\data\mihomo\config.yaml"
Get-Content "C:\Program Files\GUI.for.Clash\data\third\provider-chain-manager\<profile-id>-virtual.yaml"
```

Expected:

```text
proxy-providers:
  链式出口:
    type: file
    path: ../third/provider-chain-manager/<profile-id>-virtual.yaml
```

Then check the mihomo API:

```powershell
$secret = '<external-controller secret>'
$data = Invoke-RestMethod -Headers @{Authorization="Bearer $secret"} -Uri 'http://127.0.0.1:20113/proxies'
$data.proxies.PSObject.Properties.Name | Where-Object { $_ -like '链式出口 | *' }
$data.proxies.'链式出口 | trojan-outlet-15022-vfj00xzy-trojan | 前置 <front proxy name>' |
  Select-Object name,type,'provider-name','dialer-proxy',alive
```

Expected:

```text
dialer-proxy: <front proxy name>
```

The original outlet node should still exist unchanged. Select the generated `链式出口` virtual subscription in GUI.for.Clash strategy groups.
