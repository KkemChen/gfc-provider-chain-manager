# Verification

After generating and applying the config, check the mihomo API:

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

The original outlet node should still exist unchanged. Select the generated `链式出口 | ...` node in GUI.for.Clash strategy groups.
