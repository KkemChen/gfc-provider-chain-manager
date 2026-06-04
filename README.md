# GFC Provider Chain Manager

GUI.for.Clash / GUI.for.Cores plugin for creating a friendly virtual chained-proxy subscription from nodes imported through `proxy-providers`.

This is a redesigned provider-aware chain manager, not a copy of the existing card-click chain plugin. It treats chain configuration as explicit rules:

```text
outlet node -> front node
```

which generates:

```yaml
链式出口 | target-node | 前置 front-node:
  dialer-proxy: front-node
```

Runtime path:

```text
local -> front-node -> target-node -> website
```

The existing chain-manager pattern mutates or copies provider nodes into `proxies`, which makes it unclear whether users are selecting the original node or the chained node. This plugin fixes that by:

- loading provider nodes from subscription files;
- creating new chained nodes by stable GUI proxy IDs, without mutating the original nodes;
- automatically creating and maintaining a real local subscription named `链式出口`;
- writing generated nodes to `data/subscribes/ID_provider_chain_virtual.yaml`;
- attaching that subscription to related strategy groups.
- showing rule previews and invalid-rule warnings in the UI.

## Official Plugin Shape

GUI.for.Cores plugins are single JavaScript files registered by metadata in the GUI plugin list.

Common fields:

- `name`, `version`, `description`, `tags`
- `path`: plugin JS path under `data/plugins`
- `triggers`: for this plugin, `on::manual`, `on::generate`, and `on::subscribe`
- `context.profiles`: exposes the manual UI entry

The plugin source exports trigger functions by defining:

- `onGenerate(config, profile)`
- `onSubscribe(proxies, subscription)`
- `onRun()`
- `onInstall()`

The plugin also self-repairs its own registration when it is run manually. If GUI.for.Clash adds the HTTP plugin with only `on::manual`, the plugin rewrites `data/plugins.yaml` through the GUI plugin API and patches the in-memory plugin store so generation hooks are registered.

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

The manual UI is designed as a chain editor instead of a raw mapping table:

- left side: pick the final outlet node and the front node from a searchable node list;
- top path preview: `local -> front node -> outlet node -> website`;
- right side: enabled chain rules as readable cards;
- generated nodes are grouped under the real local subscription `链式出口`;
- generated node names are short country-flag labels such as `🇸🇬 HY2 ← A2·AT`;
- advanced generation behavior is collapsed by default.

The storage format is:

```json
{
  "version": 1,
  "options": {
    "attachVirtualProvider": true
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

For a source group like:

```yaml
proxy-groups:
  - name: openai
    use:
      - ID_8l1u8mi5
```

the generated config becomes:

```yaml
proxy-providers:
  ID_provider_chain_virtual:
    type: file
    path: ../subscribes/ID_provider_chain_virtual.yaml

proxy-groups:
  - name: openai
    use:
      - ID_8l1u8mi5
      - ID_provider_chain_virtual
```

The plugin also maintains the real GUI subscription entry in `data/subscribes.yaml`:

```yaml
- id: ID_provider_chain_virtual
  name: 链式出口
  type: File
  path: data/subscribes/ID_provider_chain_virtual.yaml
```

The local subscription file contains:

```yaml
proxies:
  - name: 链式出口 | node-a | 前置 front-proxy
    dialer-proxy: front-proxy
```

## Chain Direction

If you want `Trojan` to be the final outlet and `AnyTLS` to be the front proxy, configure:

```text
Trojan -> AnyTLS
```

This generates:

```yaml
链式出口 | trojan-node | 前置 anytls-node:
  dialer-proxy: anytls-node
```

Runtime path:

```text
local -> anytls-node -> trojan-node -> target
```
