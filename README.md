# GFC Provider Chain Manager

GUI.for.Clash / GUI.for.Cores plugin for applying `dialer-proxy` to nodes imported from `proxy-providers`.

This is a redesigned provider-aware chain manager, not a copy of the existing card-click chain plugin. It treats chain configuration as explicit rules:

```text
target node -> front node
```

which generates:

```yaml
target-node:
  dialer-proxy: front-node
```

Runtime path:

```text
local -> front-node -> target-node -> website
```

The existing chain-manager pattern copies provider nodes into `proxies`, but strategy groups that still use `use: [provider-id]` continue selecting provider originals. This plugin fixes that by:

- loading provider nodes from subscription files;
- applying saved `dialer-proxy` mappings by stable GUI proxy IDs;
- inlining provider nodes into strategy-group `proxies`;
- removing inlined providers from `proxy-providers` so mihomo uses the chained local nodes.
- showing rule previews and invalid-rule warnings in the UI.

## Official Plugin Shape

GUI.for.Cores plugins are single JavaScript files registered by metadata in the GUI plugin list.

Common fields:

- `name`, `version`, `description`, `tags`
- `path`: plugin JS path under `data/plugins`
- `triggers`: for this plugin, `on::manual` and `on::generate`
- `context.profiles`: exposes the manual UI entry

The plugin source exports trigger functions by defining:

- `onGenerate(config, profile)`
- `onRun()`

Plugin runtime storage should live under `data/third/<plugin-name>`.

## Install Locally

HTTP plugin URL:

```text
https://raw.githubusercontent.com/KkemChen/gfc-provider-chain-manager/main/src/plugin-provider-chain-manager.js
```

In GUI.for.Clash, add an HTTP plugin with the URL above. The local save path should be:

```text
data/plugins/plugin-provider-chain-manager.js
```

Example plugin metadata is in `examples/plugins-entry.yaml`.

## Install Manually

Copy:

```text
src/plugin-provider-chain-manager.js
```

to:

```text
C:\Program Files\GUI.for.Clash\data\plugins\plugin-provider-chain-manager.js
```

Then add a plugin entry similar to `examples/plugins-entry.yaml` into:

```text
C:\Program Files\GUI.for.Clash\data\plugins.yaml
```

## UI Model

The manual UI has four parts:

- generation behavior: provider inline/remove switches;
- add chain rule: choose a final outlet node and a front node;
- current rules: enable, edit, delete, preview each rule;
- available nodes: searchable node inventory grouped by strategy groups and subscriptions.

The storage format is:

```json
{
  "version": 1,
  "options": {
    "inlineProviders": true,
    "removeInlinedProviders": true,
    "keepUnmappedDialerProxyField": false
  },
  "rules": [
    {
      "targetId": "ID_target",
      "viaId": "ID_front",
      "enabled": true,
      "note": ""
    }
  ]
}
```

It can read legacy `{ "targetId": "viaId" }` mapping files from `data/third/proxy-chain-manager`.

## Behavior

For a group like:

```yaml
proxy-groups:
  - name: openai
    use:
      - ID_8l1u8mi5
```

the generated config becomes:

```yaml
proxies:
  - name: node-a
    dialer-proxy: front-proxy

proxy-groups:
  - name: openai
    proxies:
      - node-a
```

The provider is removed if it was fully inlined.

## Chain Direction

If you want `Trojan` to be the final outlet and `AnyTLS` to be the front proxy, configure:

```text
Trojan -> AnyTLS
```

This generates:

```yaml
trojan-node:
  dialer-proxy: anytls-node
```

Runtime path:

```text
local -> anytls-node -> trojan-node -> target
```
