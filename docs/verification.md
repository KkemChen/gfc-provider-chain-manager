# Verification

After generating and applying the config, check the mihomo API:

```powershell
$secret = '<external-controller secret>'
$data = Invoke-RestMethod -Headers @{Authorization="Bearer $secret"} -Uri 'http://127.0.0.1:20113/proxies'
$data.proxies.'trojan-outlet-15022-vfj00xzy-trojan' | Select-Object name,type,'provider-name','dialer-proxy',alive
```

Expected:

```text
provider-name: ""
dialer-proxy: <front proxy name>
```

If `provider-name` is still the subscription ID and `dialer-proxy` is empty, the strategy group is still selecting provider originals.

