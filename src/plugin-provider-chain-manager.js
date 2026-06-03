const PATH = 'data/third/provider-chain-manager'
const LEGACY_PATH = 'data/third/proxy-chain-manager'
const PLUGIN_ID = 'gfc-provider-chain-manager'
const VIRTUAL_SUBSCRIBE_BASE_ID = 'ID_provider_chain_virtual'
const VIRTUAL_PROVIDER_NAME = '链式出口'

const DEFAULT_OPTIONS = {
  attachVirtualProvider: true,
}

/* Trigger: on::generate */
const onGenerate = async (config, profile) => {
  const subscribesStore = Plugins.useSubscribesStore()
  const state = await loadState(profile.id)
  const options = { ...DEFAULT_OPTIONS, ...(state.options || {}) }
  const context = await collectContext(config, profile, subscribesStore)
  const activeRules = normalizeRules(state).filter((rule) => rule.enabled !== false)

  await createVirtualSubscription(config, context, activeRules, options, subscribesStore)

  return config
}

async function createVirtualSubscription(config, context, rules, options, subscribesStore) {
  const { chainProxies, affectedProviderIds } = buildChainProxies(config, context, rules)
  const descriptor = await writeVirtualSubscribe(chainProxies, subscribesStore)
  cleanupVirtualProviderReferences(config)

  if (chainProxies.length === 0) {
    return
  }

  config['proxy-providers'] = config['proxy-providers'] || {}
  config['proxy-providers'][descriptor.id] = {
    type: 'file',
    path: `../subscribes/${descriptor.id}.yaml`,
  }
  ensureProxyServerNameserver(config)

  if (options.attachVirtualProvider) {
    attachVirtualProviderToGroups(config, affectedProviderIds, descriptor.id)
  }
}

function buildChainProxies(config, context, rules) {
  const localProxies = Array.isArray(config.proxies) ? Plugins.deepClone(config.proxies) : []
  const sourceProxies = [...localProxies, ...context.providerProxies]
  const usedNames = new Set(sourceProxies.map((proxy) => proxy?.name).filter(Boolean))
  const chainProxies = []
  const affectedProviderIds = new Set()

  for (const rule of rules) {
    const targetName = context.idToName[rule.targetId]
    const viaName = context.idToName[rule.viaId]
    if (!targetName || !viaName || targetName === viaName) continue

    const sourceProxy = sourceProxies.find((proxy) => proxy?.name === targetName)
    if (!sourceProxy) continue

    const chainProxy = Plugins.deepClone(sourceProxy)
    const chainName = makeChainProxyName(targetName, viaName, usedNames)
    chainProxy.name = chainName
    chainProxy['dialer-proxy'] = viaName

    chainProxies.push(chainProxy)
    usedNames.add(chainName)
    context.chainNameByTargetId[rule.targetId] = chainName
    context.chainNameByTargetName[targetName] = chainName

    const sourceProviderId = context.providerIdByNodeName[targetName]
    if (sourceProviderId) affectedProviderIds.add(sourceProviderId)
  }

  return { chainProxies, affectedProviderIds }
}

async function writeVirtualSubscribe(chainProxies, subscribesStore) {
  const raw = await Plugins.ReadFile('data/subscribes.yaml').catch(() => '[]')
  const subscribes = Plugins.YAML.parse(raw || '[]') || []
  const descriptor = resolveVirtualSubscribeDescriptor(subscribes, subscribesStore)
  const entry = makeVirtualSubscribeEntry(chainProxies, descriptor)
  const index = subscribes.findIndex((sub) => sub?.id === descriptor.id)

  await Plugins.WriteFile(descriptor.path, Plugins.YAML.stringify({ proxies: chainProxies }))

  if (index >= 0) {
    subscribes[index] = { ...subscribes[index], ...entry }
  } else {
    subscribes.push(entry)
  }

  await Plugins.WriteFile('data/subscribes.yaml', Plugins.YAML.stringify(subscribes))
  refreshVirtualSubscribeStore(subscribesStore, entry)
  return descriptor
}

function refreshVirtualSubscribeStore(subscribesStore, entry) {
  if (!subscribesStore || !Array.isArray(subscribesStore.subscribes)) return

  const currentIndex = subscribesStore.subscribes.findIndex((sub) => sub?.id === entry.id)
  if (currentIndex >= 0) {
    const next = subscribesStore.subscribes.slice()
    next.splice(currentIndex, 1, { ...next[currentIndex], ...entry })
    subscribesStore.subscribes = next
    return
  }

  subscribesStore.subscribes = [...subscribesStore.subscribes, entry]
}

function resolveVirtualSubscribeDescriptor(subscribes, subscribesStore) {
  const storeSubscribes = Array.isArray(subscribesStore?.subscribes) ? subscribesStore.subscribes : []
  const allSubscribes = [...subscribes, ...storeSubscribes]
  const managed = allSubscribes.find(isManagedVirtualSubscribe)
  if (managed?.id) return makeVirtualSubscribeDescriptor(managed.id)

  const usedIds = new Set(allSubscribes.map((sub) => sub?.id).filter(Boolean))
  if (!usedIds.has(VIRTUAL_SUBSCRIBE_BASE_ID)) return makeVirtualSubscribeDescriptor(VIRTUAL_SUBSCRIBE_BASE_ID)

  let index = 2
  while (usedIds.has(`${VIRTUAL_SUBSCRIBE_BASE_ID}_${index}`)) index += 1
  return makeVirtualSubscribeDescriptor(`${VIRTUAL_SUBSCRIBE_BASE_ID}_${index}`)
}

function isManagedVirtualSubscribe(sub) {
  if (!sub) return false
  if (sub.managedBy === PLUGIN_ID) return true
  if (sub['x-provider-chain-manager']?.managedBy === PLUGIN_ID) return true

  return sub.id === VIRTUAL_SUBSCRIBE_BASE_ID
    && sub.name === VIRTUAL_PROVIDER_NAME
    && sub.path === makeVirtualSubscribePath(VIRTUAL_SUBSCRIBE_BASE_ID)
}

function makeVirtualSubscribeDescriptor(id) {
  return {
    id,
    name: VIRTUAL_PROVIDER_NAME,
    path: makeVirtualSubscribePath(id),
  }
}

function makeVirtualSubscribePath(id) {
  return `data/subscribes/${id}.yaml`
}

function makeVirtualSubscribeEntry(chainProxies, descriptor) {
  return {
    id: descriptor.id,
    name: descriptor.name,
    managedBy: PLUGIN_ID,
    'x-provider-chain-manager': {
      managedBy: PLUGIN_ID,
      managed: true,
      version: 1,
    },
    useInternal: false,
    upload: 0,
    download: 0,
    total: 0,
    expire: null,
    updateTime: Date.now(),
    type: 'File',
    url: '',
    website: '',
    path: descriptor.path,
    include: '',
    exclude: '',
    includeProtocol: '',
    excludeProtocol: '',
    proxyPrefix: '',
    disabled: false,
    inSecure: false,
    requestMethod: 'GET',
    requestTimeout: 15,
    header: { request: {}, response: {} },
    script: `const onSubscribe = async (proxies, subscription) => {\n  return { proxies, subscription }\n}`,
    proxies: chainProxies.map((proxy, index) => ({
      id: `ID_chain_${index + 1}`,
      name: proxy.name,
      type: proxy.type,
    })),
  }
}

async function collectContext(config, profile, subscribesStore) {
  const idToName = {}
  const nameToId = {}
  const providerProxies = []
  const providerNodes = {}
  const providerIdByNodeName = {}
  const inlinedProviderIds = new Set()
  const chainNameByTargetId = {}
  const chainNameByTargetName = {}
  const sections = []

  addKnown(idToName, nameToId, 'DIRECT', 'DIRECT')
  addKnown(idToName, nameToId, 'REJECT', 'REJECT')
  addKnown(idToName, nameToId, 'REJECT-DROP', 'REJECT-DROP')

  for (const group of profile.proxyGroupsConfig || []) {
    if (!group?.id || !group?.name) continue
    addKnown(idToName, nameToId, group.id, group.name)
  }

  const providers = config['proxy-providers'] || {}
  for (const providerId of Object.keys(providers)) {
    const sub = subscribesStore.getSubscribeById(providerId)
    if (!sub) continue

    const metaNodes = Array.isArray(sub.proxies) ? sub.proxies : []
    for (const proxy of metaNodes) {
      if (!proxy?.id || !proxy?.name) continue
      addKnown(idToName, nameToId, proxy.id, proxy.name)
    }

    const content = await Plugins.ReadFile(sub.path).catch(() => '{"proxies":[]}')
    const parsed = Plugins.YAML.parse(content || '{"proxies":[]}')
    const nodes = Array.isArray(parsed?.proxies) ? Plugins.deepClone(parsed.proxies) : []

    providerNodes[providerId] = nodes
    providerProxies.push(...nodes)
    for (const node of nodes) {
      if (node?.name) providerIdByNodeName[node.name] = providerId
    }
    sections.push({ id: providerId, name: sub.name, type: 'provider', nodes: metaNodes })
  }

  return { idToName, nameToId, providerProxies, providerNodes, providerIdByNodeName, inlinedProviderIds, chainNameByTargetId, chainNameByTargetName, sections }
}

function addKnown(idToName, nameToId, id, name) {
  if (!id || !name) return
  idToName[id] = name
  nameToId[name] = id
}

function attachVirtualProviderToGroups(config, affectedProviderIds, providerId) {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []
  if (groups.length === 0) return

  let attached = false
  for (const group of groups) {
    if (!Array.isArray(group.use)) group.use = []
    const usesAffectedProvider = group.use.some((usedProviderId) => affectedProviderIds.has(usedProviderId))
    if (usesAffectedProvider) {
      group.use = uniqueNames([...group.use, providerId])
      attached = true
    }
  }

  if (attached) return
  for (const group of groups) {
    if (!['select', 'url-test', 'fallback', 'load-balance'].includes(group.type)) continue
    if (!Array.isArray(group.use)) group.use = []
    group.use = uniqueNames([...group.use, providerId])
  }
}

function makeChainProxyName(targetName, viaName, usedNames) {
  const base = `链式出口 | ${targetName} | 前置 ${viaName}`
  if (!usedNames.has(base)) return base

  let index = 2
  while (usedNames.has(`${base} #${index}`)) index += 1
  return `${base} #${index}`
}

function cleanupVirtualProviderReferences(config) {
  if (config['proxy-providers']) {
    for (const providerId of Object.keys(config['proxy-providers'])) {
      if (isVirtualProviderId(providerId)) delete config['proxy-providers'][providerId]
    }
  }

  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []
  for (const group of groups) {
    if (!Array.isArray(group.use)) continue
    group.use = group.use.filter((providerId) => !isVirtualProviderId(providerId))
  }
}

function isVirtualProviderId(providerId) {
  return providerId === VIRTUAL_SUBSCRIBE_BASE_ID
    || String(providerId || '').startsWith(`${VIRTUAL_SUBSCRIBE_BASE_ID}_`)
}

function ensureProxyServerNameserver(config) {
  if (Array.isArray(config['proxy-server-nameserver']) && config['proxy-server-nameserver'].length > 0) return

  config['proxy-server-nameserver'] = [
    'https://223.5.5.5/dns-query',
    'https://1.1.1.1/dns-query',
  ]
}

function uniqueNames(names) {
  const seen = new Set()
  const result = []

  for (const name of names) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }

  return result
}

async function loadState(profileId) {
  const primary = `${PATH}/${profileId}.json`
  const legacy = `${LEGACY_PATH}/${profileId}.json`
  const raw = await Plugins.ReadFile(primary)
    .catch(() => Plugins.ReadFile(legacy))
    .catch(() => '{}')

  const parsed = JSON.parse(raw || '{}')
  if (Array.isArray(parsed.rules) || parsed.options) return parsed

  return {
    options: {},
    rules: Object.entries(parsed)
      .filter(([, viaId]) => !!viaId)
      .map(([targetId, viaId]) => ({ targetId, viaId, enabled: true, note: '' })),
  }
}

function normalizeRules(state) {
  if (Array.isArray(state.rules)) {
    return state.rules.filter((rule) => rule?.targetId && rule?.viaId)
  }

  return []
}

async function saveState(profileId, state) {
  const filePath = `${PATH}/${profileId}.json`
  await Plugins.WriteFile(filePath, JSON.stringify(state, null, 2))
}

/* Trigger: on::manual */
const onRun = async () => {
  const profilesStore = Plugins.useProfilesStore()
  if (!profilesStore.profiles.length) throw '请先创建一个配置'

  const profile = profilesStore.profiles.length === 1
    ? profilesStore.profiles[0]
    : await Plugins.picker.single(
      '请选择一个配置',
      profilesStore.profiles.map((item) => ({ label: item.name, value: item })),
      [profilesStore.profiles[0]]
    )

  await showUI(profile)
}

async function showUI(profile) {
  const { h, computed, ref } = Vue
  const subscribesStore = Plugins.useSubscribesStore()
  const config = await Plugins.generateConfig(Plugins.deepClone(profile))
  const context = await collectContext(config, profile, subscribesStore)
  const loaded = await loadState(profile.id)

  const options = ref({ ...DEFAULT_OPTIONS, ...(loaded.options || {}) })
  const rules = ref(normalizeRules(loaded))
  const draftTargetId = ref('')
  const draftViaId = ref('')
  const query = ref('')
  const pickMode = ref('target')
  const showAdvanced = ref(false)

  const nodeOptions = computed(() => {
    return context.sections
      .flatMap((section) => section.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type || section.type,
        section: section.name,
      })))
      .filter((node) => node.id && node.name)
  })

  const filteredSections = computed(() => {
    const text = query.value.trim().toLowerCase()
    return context.sections.map((section) => ({
      ...section,
      nodes: section.nodes.filter((node) => !text || `${node.name} ${node.type || ''}`.toLowerCase().includes(text)),
    })).filter((section) => section.nodes.length > 0)
  })

  const ruleViews = computed(() => rules.value.map((rule) => {
    const targetName = context.idToName[rule.targetId] || rule.targetId
    const viaName = context.idToName[rule.viaId] || rule.viaId
    const chainName = makeChainProxyName(targetName, viaName, new Set(Object.values(context.idToName)))
    return {
      ...rule,
      targetName,
      viaName,
      chainName,
      preview: `本地 -> ${viaName} -> ${targetName} -> 目标网站`,
      invalid: rule.targetId === rule.viaId || !context.idToName[rule.targetId] || !context.idToName[rule.viaId],
    }
  }))

  const selectedTargetName = computed(() => context.idToName[draftTargetId.value] || '')
  const selectedViaName = computed(() => context.idToName[draftViaId.value] || '')
  const enabledRuleCount = computed(() => rules.value.filter((rule) => rule.enabled !== false).length)

  const component = {
    template: `
      <div class="pb-8 pr-8" style="display: grid; grid-template-columns: minmax(300px, 0.95fr) minmax(0, 1.05fr); gap: 16px; height: 76vh; max-height: 720px; overflow: hidden; font-family: system-ui, -apple-system, sans-serif;">
        <!-- LEFT COLUMN: NODE PICKER -->
        <section style="display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 12px;">
          <div style="background: var(--background-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px; flex-shrink: 0;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <div style="font-weight: bold; font-size: 16px;">选择节点</div>
                <div style="font-size: 12px; opacity: 0.6; margin-top: 2px;">先选出口节点，再选前置节点</div>
              </div>
              <div style="font-size: 12px; padding: 4px 8px; border-radius: 4px; background: rgba(22, 119, 255, 0.1); color: #1677ff; font-weight: bold;">
                已启用 {{ enabledRuleCount }}
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: rgba(128, 128, 128, 0.08); padding: 3px; border-radius: 6px; border: 1px solid var(--border-color);">
              <button :style="tabButtonStyle(pickMode === 'target')" @click="pickMode = 'target'">选择出口</button>
              <button :style="tabButtonStyle(pickMode === 'via')" @click="pickMode = 'via'">选择前置</button>
            </div>

            <input v-model="query" 
                   :placeholder="pickMode === 'target' ? '搜索出口节点，如 trojan / hy2 / 香港' : '搜索前置节点，如 anytls / 专线' " 
                   :style="inputStyle"
                   @focus="inputFocused = true"
                   @blur="inputFocused = false" />
          </div>

          <div style="background: var(--background-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; flex: 1; min-height: 0; display: flex; flex-direction: column;">
            <div style="flex: 1; overflow-y: auto; padding-right: 4px;">
              <div v-for="section in filteredSections" :key="section.name" style="margin-bottom: 12px;">
                <div style="font-size: 11px; opacity: 0.5; font-weight: bold; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">{{ section.name }}</div>
                <div style="display: grid; gap: 6px;">
                  <button v-for="node in section.nodes" :key="node.id" :style="nodeRowStyle(node.id === draftTargetId || node.id === draftViaId)" @click="chooseNode(node.id)">
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: bold; font-size: 13px;">{{ node.name }}</span>
                    <span style="opacity: 0.5; font-size: 11px; flex-shrink: 0; text-transform: uppercase;">{{ node.type || section.type }}</span>
                  </button>
                </div>
              </div>
              <div v-if="filteredSections.length === 0" style="font-size: 13px; opacity: 0.6; text-align: center; padding: 20px 0;">没有匹配的节点。</div>
            </div>
          </div>
        </section>

        <!-- RIGHT COLUMN: PREVIEW & CONFIGURED CHAINS -->
        <section style="display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 12px;">
          <!-- RIGHT TOP: VERTICAL ROUTE PREVIEW -->
          <div style="background: var(--background-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px; flex-shrink: 0;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div style="font-weight: bold; font-size: 15px;">链路预览</div>
              <Button type="primary" style="height: 28px; padding: 0 12px; font-size: 12px;" @click="addRule">保存链路</Button>
            </div>
            <div style="border: 1px solid var(--border-color); border-radius: 8px; background: rgba(128, 128, 128, 0.02); padding: 12px 14px;">
              <div style="position: relative; display: flex; flex-direction: column; gap: 8px; padding-left: 12px;">
                <div style="position: absolute; left: 4px; top: 12px; bottom: 12px; width: 2px; background: var(--border-color); opacity: 0.7; z-index: 1;"></div>
                
                <!-- Step 1: Start -->
                <div style="position: relative; display: flex; gap: 12px; align-items: flex-start; z-index: 2;">
                  <div style="width: 10px; height: 10px; border-radius: 50%; background: var(--border-color); border: 2px solid var(--background-color); margin-top: 5px; flex-shrink: 0;"></div>
                  <div style="min-width: 0;">
                    <span style="font-size: 11px; opacity: 0.5; display: block; line-height: 1.2;">起点</span>
                    <span style="font-size: 13px; font-weight: bold;">本机</span>
                  </div>
                </div>

                <!-- Step 2: Via Node -->
                <div @click="pickMode = 'via'" :style="timelineStepStyle(pickMode === 'via', !selectedViaName)">
                  <div :style="timelineDotStyle(pickMode === 'via', !selectedViaName)"></div>
                  <div style="min-width: 0; flex: 1;">
                    <span style="font-size: 11px; opacity: 0.5; display: block; line-height: 1.2;">前置节点</span>
                    <span :style="timelineValueStyle(!selectedViaName)">{{ selectedViaName || '未选择 (点击此处或左侧列表)' }}</span>
                  </div>
                </div>

                <!-- Step 3: Target Node -->
                <div @click="pickMode = 'target'" :style="timelineStepStyle(pickMode === 'target', !selectedTargetName)">
                  <div :style="timelineDotStyle(pickMode === 'target', !selectedTargetName)"></div>
                  <div style="min-width: 0; flex: 1;">
                    <span style="font-size: 11px; opacity: 0.5; display: block; line-height: 1.2;">最终出口</span>
                    <span :style="timelineValueStyle(!selectedTargetName)">{{ selectedTargetName || '未选择 (点击此处或左侧列表)' }}</span>
                  </div>
                </div>

                <!-- Step 4: Destination -->
                <div style="position: relative; display: flex; gap: 12px; align-items: flex-start; z-index: 2;">
                  <div style="width: 10px; height: 10px; border-radius: 50%; background: var(--border-color); border: 2px solid var(--background-color); margin-top: 5px; flex-shrink: 0;"></div>
                  <div style="min-width: 0;">
                    <span style="font-size: 11px; opacity: 0.5; display: block; line-height: 1.2;">目标</span>
                    <span style="font-size: 13px; font-weight: bold;">目标网站</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- RIGHT BOTTOM: CONFIGURED CHAINS -->
          <div style="background: var(--background-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; flex: 1; min-height: 0; display: flex; flex-direction: column;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-shrink: 0;">
              <div style="font-weight: bold; font-size: 15px;">已配置链路</div>
              <div style="font-size: 12px; opacity: 0.6;">{{ ruleViews.length }} 条</div>
            </div>

            <div v-if="ruleViews.length === 0" style="border: 1px dashed var(--border-color); border-radius: 8px; padding: 24px; text-align: center; font-size: 13px; opacity: 0.5; flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
              <span>暂无配置。请选择出口和前置后点击“保存链路”生成。</span>
            </div>

            <div v-if="ruleViews.length > 0" style="flex: 1; overflow-y: auto; padding-right: 4px;">
              <div v-for="(rule, index) in ruleViews" :key="rule.targetId" :style="ruleRowStyle(rule)">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                  <div style="min-width: 0; flex: 1;">
                    <div style="display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 13px;">
                      <span style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 140px; color: #1677ff;">{{ rule.viaName }}</span>
                      <span style="opacity: 0.4; flex-shrink: 0; font-size: 11px;">➔</span>
                      <span style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 140px;">{{ rule.targetName }}</span>
                    </div>
                    <div style="font-size: 11px; opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">
                      {{ rule.chainName }}
                    </div>
                    <div v-if="rule.invalid" style="font-size: 11px; color: #d4380d; margin-top: 2px; font-weight: 500;">⚠ 规则失效：节点不存在</div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; user-select: none;">
                      <input type="checkbox" v-model="rule.enabled" @change="syncEnabled(index, rule.enabled)" style="cursor: pointer; margin: 0;" />
                      <span>启用</span>
                    </label>
                    <div style="display: flex; gap: 4px;">
                      <Button size="small" style="height: 24px; padding: 0 8px; font-size: 11px;" @click="editRule(rule)">编辑</Button>
                      <Button size="small" style="height: 24px; padding: 0 8px; font-size: 11px; color: #d4380d; border-color: rgba(212,56,13,0.15);" @click="removeRule(index)">删除</Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ADVANCED SETTINGS -->
          <div style="background: var(--background-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px; flex-shrink: 0;">
            <div @click="showAdvanced = !showAdvanced" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
              <div style="font-weight: bold; font-size: 13px; opacity: 0.85;">高级生成选项</div>
              <div style="font-size: 11px; opacity: 0.6;">{{ showAdvanced ? '收起 ▴' : '展开 ▾' }}</div>
            </div>
            <div v-if="showAdvanced" style="display: flex; flex-direction: column; gap: 8px; font-size: 12px; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 8px;">
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; opacity: 0.85;">
                <input type="checkbox" v-model="options.attachVirtualProvider" style="cursor: pointer; margin: 0;" />
                <span>自动把“链式出口”本地订阅挂到相关策略组</span>
              </label>
            </div>
          </div>
        </section>
      </div>`,
    setup() {
      const inputFocused = ref(false)
      const inputStyle = computed(() => ({
        width: '100%',
        boxSizing: 'border-box',
        height: '34px',
        padding: '0 12px',
        border: `1px solid ${inputFocused.value ? '#1677ff' : 'var(--border-color)'}`,
        borderRadius: '6px',
        background: 'rgba(128, 128, 128, 0.04)',
        color: 'inherit',
        outline: 'none',
        boxShadow: inputFocused.value ? '0 0 0 2px rgba(22, 119, 255, 0.15)' : 'none',
        transition: 'all 0.2s ease',
      }))

      function tabButtonStyle(active) {
        return {
          border: 'none',
          padding: '6px 12px',
          borderRadius: '4px',
          background: active ? 'var(--background-color)' : 'transparent',
          color: active ? 'inherit' : 'rgba(128, 128, 128, 0.7)',
          fontWeight: active ? 'bold' : 'normal',
          cursor: 'pointer',
          textAlign: 'center',
          fontSize: '12px',
          transition: 'all 0.2s ease',
          boxShadow: active ? '0 1px 3px rgba(0,0,0,0.05)' : 'none',
        }
      }

      function timelineStepStyle(active, empty) {
        return {
          position: 'relative',
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-start',
          zIndex: 2,
          cursor: 'pointer',
          padding: '6px 8px',
          borderRadius: '6px',
          border: `1px solid ${active ? '#1677ff' : 'transparent'}`,
          background: active ? 'rgba(22, 119, 255, 0.06)' : 'transparent',
          transition: 'all 0.2s ease',
        }
      }

      function timelineDotStyle(active, empty) {
        return {
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: active ? '#1677ff' : (empty ? '#d4380d' : '#52c41a'),
          border: '2px solid var(--background-color)',
          marginTop: '6px',
          flexShrink: 0,
          boxShadow: active ? '0 0 0 3px rgba(22, 119, 255, 0.15)' : 'none',
          transition: 'all 0.2s ease',
        }
      }

      function timelineValueStyle(empty) {
        return {
          fontSize: '13px',
          fontWeight: 'bold',
          color: empty ? '#1677ff' : 'inherit',
          lineHeight: 1.3,
          display: 'block',
          marginTop: '2px',
        }
      }

      function nodeRowStyle(selected) {
        return {
          width: '100%',
          border: `1px solid ${selected ? '#1677ff' : 'var(--border-color)'}`,
          background: selected ? 'rgba(22, 119, 255, 0.08)' : 'transparent',
          borderRadius: '6px',
          padding: '6px 10px',
          display: 'flex',
          justifyContent: 'space-between',
          gap: '8px',
          alignItems: 'center',
          textAlign: 'left',
          color: 'inherit',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }
      }

      function ruleRowStyle(rule) {
        return {
          border: `1px solid ${rule.invalid ? '#d4380d' : 'var(--border-color)'}`,
          borderRadius: '6px',
          padding: '8px 10px',
          marginBottom: '8px',
          opacity: rule.enabled === false ? 0.6 : 1,
          background: rule.invalid ? 'rgba(212, 56, 13, 0.04)' : 'rgba(128, 128, 128, 0.01)',
          transition: 'all 0.2s ease',
        }
      }

      function chooseNode(id) {
        if (pickMode.value === 'target') {
          draftTargetId.value = id
          if (!draftViaId.value) pickMode.value = 'via'
          return
        }
        draftViaId.value = id
      }

      function addRule() {
        if (!draftTargetId.value || !draftViaId.value) {
          Plugins.message.info('请选择目标节点和前置节点')
          return
        }
        if (draftTargetId.value === draftViaId.value) {
          Plugins.message.info('目标节点不能使用自己作为前置节点')
          return
        }

        const existing = rules.value.find((rule) => rule.targetId === draftTargetId.value)
        if (existing) {
          existing.viaId = draftViaId.value
          existing.enabled = true
        } else {
          rules.value.push({ targetId: draftTargetId.value, viaId: draftViaId.value, enabled: true, note: '' })
        }
      }

      function editRule(rule) {
        draftTargetId.value = rule.targetId
        draftViaId.value = rule.viaId
        pickMode.value = 'target'
      }

      function removeRule(index) {
        rules.value.splice(index, 1)
      }

      function syncEnabled(index, enabled) {
        rules.value[index].enabled = enabled
      }

      return {
        options,
        rules,
        ruleViews,
        nodeOptions,
        filteredSections,
        selectedTargetName,
        selectedViaName,
        enabledRuleCount,
        draftTargetId,
        draftViaId,
        query,
        pickMode,
        showAdvanced,
        inputFocused,
        inputStyle,
        tabButtonStyle,
        timelineStepStyle,
        timelineDotStyle,
        timelineValueStyle,
        nodeRowStyle,
        ruleRowStyle,
        chooseNode,
        addRule,
        editRule,
        removeRule,
        syncEnabled,
      }
    },
  }

  const modal = Plugins.modal(
    {
      title: 'Provider 链式代理管理',
      width: '92',
      height: '92',
      async onOk() {
        const activeRules = rules.value.filter((rule) => rule.enabled !== false)
        const { chainProxies } = buildChainProxies(config, context, activeRules)
        await writeVirtualSubscribe(chainProxies, subscribesStore)
        await saveState(profile.id, {
          version: 1,
          options: options.value,
          rules: rules.value,
        })
        Plugins.message.success('已保存，并刷新“链式出口”本地订阅')
      },
      afterClose() {
        modal.destroy()
      },
    },
    { default: () => h(component) }
  )
  modal.open()
}
