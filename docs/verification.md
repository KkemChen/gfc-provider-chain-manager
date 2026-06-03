# Verification

After saving plugin rules or generating/applying the config, check the real local subscription:

```powershell
rg -n "ID_provider_chain_virtual|链式出口" "C:\Program Files\GUI.for.Clash\data\subscribes.yaml"
Get-Content "C:\Program Files\GUI.for.Clash\data\subscribes\ID_provider_chain_virtual.yaml"
```

Expected:

```text
- id: ID_provider_chain_virtual
  name: 链式出口
  type: File
  path: data/subscribes/ID_provider_chain_virtual.yaml
```

Then check the generated config and mihomo API:

```powershell
rg -n "ID_provider_chain_virtual|链式出口" "C:\Program Files\GUI.for.Clash\data\mihomo\config.yaml"
```

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
