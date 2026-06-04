const PATH = 'data/third/provider-chain-manager'
const LEGACY_PATH = 'data/third/proxy-chain-manager'
const PLUGIN_ID = 'gfc-provider-chain-manager'
const VIRTUAL_SUBSCRIBE_BASE_ID = 'ID_provider_chain_virtual'
const VIRTUAL_PROVIDER_NAME = '链式出口'

const DEFAULT_OPTIONS = {
  attachVirtualProvider: true,
}

/* Trigger: on::subscribe */
const onSubscribe = async (proxies, subscription) => {
  const updatedProxies = normalizeSubscribeProxies(proxies)
  await rebuildVirtualSubscriptionAfterSubscribe(subscription, updatedProxies).catch(() => null)
  setTimeout(() => rebuildVirtualSubscriptionAfterSubscribe(subscription).catch(() => null), 1200)
  return proxies
}

/* Trigger: on::generate */
const onGenerate = async (config, profile) => {
  const subscribesStore = Plugins.useSubscribesStore()
  const state = await loadState(profile.id)
  const options = { ...DEFAULT_OPTIONS, ...(state.options || {}) }
  cleanupVirtualProviderReferences(config)
  cleanupVirtualProxyNodes(config)
  const context = await collectContext(config, profile, subscribesStore)
  const activeRules = normalizeRules(state).filter((rule) => rule.enabled !== false)

  await createVirtualSubscription(config, context, activeRules, options, subscribesStore)

  return config
}

async function rebuildVirtualSubscriptionAfterSubscribe(subscription, updatedProxies) {
  if (subscription?.id && isVirtualProviderId(subscription.id)) return

  const profilesStore = Plugins.useProfilesStore()
  const subscribesStore = Plugins.useSubscribesStore()
  const profiles = Array.isArray(profilesStore.profiles) ? profilesStore.profiles : []
  const overrides = subscription?.id && Array.isArray(updatedProxies)
    ? { [subscription.id]: updatedProxies }
    : {}

  for (const profile of profiles) {
    const state = await loadState(profile.id)
    const activeRules = normalizeRules(state).filter((rule) => rule.enabled !== false)
    if (activeRules.length === 0) continue

    const config = await Plugins.generateConfig(Plugins.deepClone(profile))
    cleanupVirtualProviderReferences(config)
    cleanupVirtualProxyNodes(config)
    const context = await collectContext(config, profile, subscribesStore, overrides)
    if (subscription?.id && !isSubscriptionUsedByRules(subscription.id, activeRules, context)) continue

    const { chainProxies } = buildChainProxies(config, context, activeRules)
    if (chainProxies.length === 0) {
      await clearVirtualArtifacts({ subscribesStore })
    } else {
      const descriptor = await writeVirtualSubscribe(chainProxies, subscribesStore)
      await refreshKernelProvider(config, descriptor.id)
    }
  }
}

function isSubscriptionUsedByRules(subscriptionId, rules, context) {
  return rules.some((rule) => {
    const { targetName, viaName } = resolveRuleNames(rule, context)
    return context.providerIdByNodeName[targetName] === subscriptionId
      || context.providerIdByNodeName[viaName] === subscriptionId
  })
}

async function createVirtualSubscription(config, context, rules, options, subscribesStore) {
  const { chainProxies, affectedProviderIds } = buildChainProxies(config, context, rules)
  cleanupVirtualProviderReferences(config)
  cleanupVirtualProxyNodes(config)

  if (chainProxies.length === 0) {
    await clearVirtualArtifacts({ subscribesStore })
    return
  }

  const descriptor = await writeVirtualSubscribe(chainProxies, subscribesStore)
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
  const localProxies = Array.isArray(config.proxies)
    ? Plugins.deepClone(config.proxies).filter((proxy) => !isVirtualChainProxy(proxy))
    : []
  const sourceProxies = [...localProxies, ...context.providerProxies].filter((proxy) => !isVirtualChainProxy(proxy))
  const usedNames = new Set(sourceProxies.map((proxy) => proxy?.name).filter(Boolean))
  const chainProxies = []
  const affectedProviderIds = new Set()

  for (const rule of rules) {
    const { targetName, viaName } = resolveRuleNames(rule, context)
    if (!targetName || !viaName || targetName === viaName) continue
    if (isVirtualChainName(targetName) || isVirtualChainName(viaName)) continue

    const sourceProxy = sourceProxies.find((proxy) => proxy?.name === targetName)
    if (!sourceProxy) continue

    const chainProxy = Plugins.deepClone(sourceProxy)
    const chainName = makeChainProxyName(targetName, viaName, usedNames)
    chainProxy.name = chainName
    chainProxy['dialer-proxy'] = viaName
    if (!isValidChainProxy(chainProxy)) continue

    chainProxies.push(chainProxy)
    usedNames.add(chainName)
    context.chainNameByTargetId[rule.targetId] = chainName
    context.chainNameByTargetName[targetName] = chainName

    const sourceProviderId = context.providerIdByNodeName[targetName]
    if (sourceProviderId) affectedProviderIds.add(sourceProviderId)
  }

  return { chainProxies, affectedProviderIds }
}

function resolveRuleNames(rule, context) {
  return {
    targetName: context.idToName[rule.targetId] || rule.targetName || '',
    viaName: context.idToName[rule.viaId] || rule.viaName || '',
  }
}

async function writeVirtualSubscribe(chainProxies, subscribesStore) {
  const raw = await Plugins.ReadFile('data/subscribes.yaml').catch(() => '[]')
  const subscribes = Plugins.YAML.parse(raw || '[]') || []
  const descriptor = resolveVirtualSubscribeDescriptor(subscribes, subscribesStore)
  const entry = makeVirtualSubscribeEntry(chainProxies, descriptor)
  const cleanedSubscribes = subscribes.filter((sub) => !isVirtualSubscriptionEntry(sub) || sub?.id === descriptor.id)
  const index = cleanedSubscribes.findIndex((sub) => sub?.id === descriptor.id)

  await Plugins.WriteFile(descriptor.path, Plugins.YAML.stringify({ proxies: chainProxies }))

  if (index >= 0) {
    cleanedSubscribes[index] = { ...cleanedSubscribes[index], ...entry }
  } else {
    cleanedSubscribes.push(entry)
  }

  await Plugins.WriteFile('data/subscribes.yaml', Plugins.YAML.stringify(cleanedSubscribes))
  refreshVirtualSubscribeStore(subscribesStore, entry)
  return descriptor
}

function refreshVirtualSubscribeStore(subscribesStore, entry) {
  if (!subscribesStore || !Array.isArray(subscribesStore.subscribes)) return

  const cleaned = subscribesStore.subscribes.filter((sub) => !isVirtualSubscriptionEntry(sub) || sub?.id === entry.id)
  const currentIndex = cleaned.findIndex((sub) => sub?.id === entry.id)
  if (currentIndex >= 0) {
    const next = cleaned.slice()
    next.splice(currentIndex, 1, { ...next[currentIndex], ...entry })
    subscribesStore.subscribes = next
    return
  }

  subscribesStore.subscribes = [...cleaned, entry]
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

async function clearVirtualArtifacts({
  subscribesStore,
  profilesStore,
  profileId,
  clearProfileUses = false,
  cleanupGeneratedConfig = false,
  clearLegacyForProfile = false,
} = {}) {
  const raw = await Plugins.ReadFile('data/subscribes.yaml').catch(() => '[]')
  const subscribes = Plugins.YAML.parse(raw || '[]') || []
  const virtualSubs = subscribes.filter(isVirtualSubscriptionEntry)
  const virtualIds = uniqueNames([
    VIRTUAL_SUBSCRIBE_BASE_ID,
    ...virtualSubs.map((sub) => sub?.id),
    ...Array.from({ length: 10 }, (_, index) => `${VIRTUAL_SUBSCRIBE_BASE_ID}_${index + 2}`),
  ])

  const nextSubscribes = subscribes.filter((sub) => !isVirtualSubscriptionEntry(sub))
  if (nextSubscribes.length !== subscribes.length) {
    await Plugins.WriteFile('data/subscribes.yaml', Plugins.YAML.stringify(nextSubscribes))
  }

  for (const id of virtualIds) {
    await Promise.resolve(Plugins.RemoveFile(makeVirtualSubscribePath(id))).catch(() => null)
  }

  if (subscribesStore && Array.isArray(subscribesStore.subscribes)) {
    subscribesStore.subscribes = subscribesStore.subscribes.filter((sub) => !isVirtualSubscriptionEntry(sub))
  }

  if (clearProfileUses && profilesStore && Array.isArray(profilesStore.profiles)) {
    const profiles = Plugins.deepClone(profilesStore.profiles)
    for (const profile of profiles) cleanupProfileVirtualReferences(profile)
    profilesStore.profiles.splice(0, profilesStore.profiles.length, ...profiles)
    await Plugins.WriteFile('data/profiles.yaml', Plugins.YAML.stringify(profiles))
  }

  if (clearProfileUses) {
    await cleanupProfilesFileVirtualReferences()
  }

  if (cleanupGeneratedConfig) {
    await cleanupGeneratedMihomoConfig({ removeDialerProxy: true })
  }

  if (clearLegacyForProfile && profileId) {
    await Promise.resolve(Plugins.RemoveFile(`${LEGACY_PATH}/${profileId}.json`)).catch(() => null)
  }
}

async function cleanupProfilesFileVirtualReferences() {
  const raw = await Plugins.ReadFile('data/profiles.yaml').catch(() => '')
  if (!raw) return

  const profiles = Plugins.YAML.parse(raw || '[]')
  if (!Array.isArray(profiles)) return

  let changed = false
  for (const profile of profiles) {
    changed = cleanupProfileVirtualReferences(profile) || changed
  }

  if (changed) {
    await Plugins.WriteFile('data/profiles.yaml', Plugins.YAML.stringify(profiles))
  }
}

async function cleanupGeneratedMihomoConfig({ removeDialerProxy = false } = {}) {
  const raw = await Plugins.ReadFile('data/mihomo/config.yaml').catch(() => '')
  if (!raw) return

  const config = Plugins.YAML.parse(raw || '{}')
  if (!config || typeof config !== 'object') return

  const before = JSON.stringify(config)
  cleanupVirtualProviderReferences(config)
  cleanupVirtualProxyNodes(config)
  if (removeDialerProxy) removeDialerProxyFields(config)

  if (JSON.stringify(config) !== before) {
    await Plugins.WriteFile('data/mihomo/config.yaml', Plugins.YAML.stringify(config))
  }
}

function removeDialerProxyFields(config) {
  const proxies = Array.isArray(config.proxies) ? config.proxies : []
  for (const proxy of proxies) {
    if (proxy && typeof proxy === 'object' && Object.prototype.hasOwnProperty.call(proxy, 'dialer-proxy')) {
      delete proxy['dialer-proxy']
    }
  }
}

function cleanupProfileVirtualReferences(profile) {
  let changed = false

  for (const group of profile?.proxyGroupsConfig || []) {
    if (Array.isArray(group.use)) {
      const nextUse = group.use.filter((providerId) => !isVirtualProviderId(providerId))
      if (nextUse.length !== group.use.length) changed = true
      group.use = nextUse
    }

    if (Array.isArray(group.proxies)) {
      const nextProxies = group.proxies.filter((proxy) => !isVirtualProxyRef(proxy))
      if (nextProxies.length !== group.proxies.length) changed = true
      group.proxies = nextProxies
    }
  }

  return changed
}

function isVirtualSubscriptionEntry(sub) {
  if (!sub) return false
  return isVirtualProviderId(sub.id)
    || isManagedVirtualSubscribe(sub)
    || sub.name === VIRTUAL_PROVIDER_NAME
    || String(sub.path || '').startsWith(`data/subscribes/${VIRTUAL_SUBSCRIBE_BASE_ID}`)
}

async function collectContext(config, profile, subscribesStore, providerProxyOverrides = {}) {
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
    if (isVirtualProviderId(providerId)) continue

    const sub = subscribesStore.getSubscribeById(providerId)
    if (!sub) continue
    if (isManagedVirtualSubscribe(sub)) continue

    const overrideNodes = normalizeSubscribeProxies(providerProxyOverrides[providerId])
    const metaNodes = Array.isArray(sub.proxies)
      ? sub.proxies.filter((proxy) => !isVirtualChainProxy(proxy))
      : []
    for (const proxy of metaNodes) {
      if (!proxy?.id || !proxy?.name) continue
      addKnown(idToName, nameToId, proxy.id, proxy.name)
    }

    const nodes = overrideNodes || await readProviderNodes(sub.path)

    providerNodes[providerId] = nodes
    providerProxies.push(...nodes)
    for (const node of nodes) {
      if (node?.name) providerIdByNodeName[node.name] = providerId
    }
    sections.push({ id: providerId, name: sub.name, type: 'provider', nodes: metaNodes })
  }

  return { idToName, nameToId, providerProxies, providerNodes, providerIdByNodeName, inlinedProviderIds, chainNameByTargetId, chainNameByTargetName, sections }
}

async function readProviderNodes(path) {
  const content = await Plugins.ReadFile(path).catch(() => '{"proxies":[]}')
  const parsed = Plugins.YAML.parse(content || '{"proxies":[]}')
  return normalizeSubscribeProxies(parsed?.proxies) || []
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
  const target = compactNodeName(targetName)
  const via = compactNodeName(viaName)
  const viaText = target.country === via.country ? via.route : `${via.emoji} ${via.route}`
  const base = `${target.emoji} ${target.label} ← ${viaText}`
  if (!usedNames.has(base)) return base

  let index = 2
  while (usedNames.has(`${base} #${index}`)) index += 1
  return `${base} #${index}`
}

function isVirtualChainProxy(proxy) {
  return isVirtualChainName(proxy?.name)
}

function isVirtualChainName(name) {
  return typeof name === 'string'
    && (
      name.startsWith(`${VIRTUAL_PROVIDER_NAME} | `)
      || name.startsWith('🔗 ')
      || /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|🌐)\s.+\s←\s.+/u.test(name)
    )
}

function isVirtualProxyRef(proxy) {
  if (typeof proxy === 'string') return isVirtualChainName(proxy)
  return isVirtualChainName(proxy?.name) || isVirtualProviderId(proxy?.id)
}

function normalizeSubscribeProxies(proxies) {
  if (!Array.isArray(proxies)) return null

  const normalized = proxies
    .filter((proxy) => proxy && typeof proxy === 'object' && !proxy.base64 && proxy.name && proxy.type)
    .filter((proxy) => !isVirtualChainProxy(proxy))
    .map((proxy) => Plugins.deepClone(proxy))

  return normalized.length > 0 ? normalized : null
}

function isValidChainProxy(proxy) {
  if (!proxy?.name || !proxy?.type || !proxy?.['dialer-proxy']) return false
  if (['direct', 'reject', 'reject-drop'].includes(String(proxy.type).toLowerCase())) return false
  if (!proxy.server && !['wireguard'].includes(String(proxy.type).toLowerCase())) return false
  return true
}

function compactNodeName(name) {
  const value = String(name || '').trim()
  if (!value) return { emoji: '🌐', country: '', label: 'Node', route: 'Node' }

  const xavierTrojan = value.match(/^trojan-outlet-(\d+)-(.+?)-trojan$/i)
  if (xavierTrojan) return { emoji: '🇸🇬', country: 'SG', label: 'Trojan', route: 'Trojan' }

  const xavierHy2 = value.match(/^kkem-(.+)$/i)
  if (xavierHy2) return { emoji: '🇸🇬', country: 'SG', label: 'HY2', route: 'HY2' }

  const airportNode = value.match(/^(.+?)←([A-Z]\d+)·(?:[\d.]+倍·)?([^#]+)(?:#(.+))?$/)
  if (airportNode) {
    const region = compactRegionName(airportNode[1])
    const protocol = compactProtocolName(airportNode[3])
    const route = [airportNode[2], protocol].filter(Boolean).join('·')
    return { emoji: region.emoji, country: region.country, label: route, route }
  }

  const webshare = value.match(/^Webshare\s+(.+)$/i)
  if (webshare) {
    const region = compactRegionName(webshare[1])
    return { emoji: region.emoji, country: region.country, label: 'Socks', route: 'Socks' }
  }

  const fallback = value
    .replace(/^链式出口\s*\|\s*/u, '')
    .replace(/\s+/g, ' ')
    .slice(0, 12)
  return { emoji: '🌐', country: '', label: fallback, route: fallback }
}

function compactRegionName(name) {
  const regions = [
    ['新加坡', 'SG', '🇸🇬'],
    ['Singapore', 'SG', '🇸🇬'],
    ['美国', 'US', '🇺🇸'],
    ['United States', 'US', '🇺🇸'],
    ['US', 'US', '🇺🇸'],
    ['香港', 'HK', '🇭🇰'],
    ['日本', 'JP', '🇯🇵'],
    ['台湾', 'TW', '🇹🇼'],
    ['澳洲', 'AU', '🇦🇺'],
    ['澳大利亚', 'AU', '🇦🇺'],
    ['Australia', 'AU', '🇦🇺'],
    ['印度', 'IN', '🇮🇳'],
    ['英国', 'UK', '🇬🇧'],
    ['俄罗斯', 'RU', '🇷🇺'],
    ['马来西亚', 'MY', '🇲🇾'],
  ]

  const value = String(name || '')
  for (const [pattern, country, emoji] of regions) {
    if (matchesRegion(value, pattern)) {
      return { country, emoji }
    }
  }
  return { country: '', emoji: '🌐' }
}

function matchesRegion(value, pattern) {
  const text = String(value || '')
  const token = String(pattern || '')
  if (/^[A-Z]{2,3}$/.test(token)) {
    return new RegExp(`(^|[^A-Za-z])${escapeRegExp(token)}([^A-Za-z]|$)`, 'i').test(text)
  }
  return text.toLowerCase().includes(token.toLowerCase())
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compactProtocolName(protocol) {
  const value = String(protocol || '').trim()
  const normalized = value.toLowerCase()
  if (normalized === 'hysteria2' || normalized === 'hy2') return 'HY2'
  if (normalized === 'anytls') return 'AT'
  if (normalized === 'vision') return 'V'
  if (normalized === 'trojan') return 'Trojan'
  if (normalized === 'socks5') return 'Socks'
  return value
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

function cleanupVirtualProxyNodes(config) {
  if (Array.isArray(config.proxies)) {
    config.proxies = config.proxies.filter((proxy) => !isVirtualChainProxy(proxy))
  }

  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []
  for (const group of groups) {
    if (Array.isArray(group.proxies)) {
      group.proxies = group.proxies.filter((proxy) => !isVirtualProxyRef(proxy))
    }
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

async function refreshKernelProvider(config, providerId) {
  if (typeof Plugins.HttpPut !== 'function') return

  const controller = normalizeController(config['external-controller'])
  if (!controller || !providerId) return

  const headers = {}
  if (config.secret) headers.Authorization = `Bearer ${config.secret}`

  await Plugins.HttpPut(
    `${controller}/providers/proxies/${encodeURIComponent(providerId)}`,
    headers,
    ''
  ).catch(() => null)
}

function normalizeController(controller) {
  if (!controller) return ''
  const value = String(controller).trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '')
  return `http://${value.replace(/\/+$/, '')}`
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
    const { targetName, viaName } = resolveRuleNames(rule, context)
    const displayTargetName = targetName || rule.targetId
    const displayViaName = viaName || rule.viaId
    const chainName = makeChainProxyName(targetName, viaName, new Set(Object.values(context.idToName)))
    return {
      ...rule,
      targetName: displayTargetName,
      viaName: displayViaName,
      chainName,
      preview: `本地 -> ${displayViaName} -> ${displayTargetName} -> 目标网站`,
      invalid: rule.targetId === rule.viaId || !targetName || !viaName,
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
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-top: 4px;">
                <div style="opacity: 0.62; line-height: 1.4;">清理生成物和策略组残留，保留当前链式规则。</div>
                <Button size="small" style="height: 26px; padding: 0 10px; color: #d4380d; border-color: rgba(212,56,13,0.22);" @click="clearGeneratedArtifacts">清空链式输出</Button>
              </div>
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

        const targetName = context.idToName[draftTargetId.value] || ''
        const viaName = context.idToName[draftViaId.value] || ''
        const existing = rules.value.find((rule) => rule.targetId === draftTargetId.value || rule.targetName === targetName)
        if (existing) {
          existing.targetId = draftTargetId.value
          existing.viaId = draftViaId.value
          existing.targetName = targetName
          existing.viaName = viaName
          existing.enabled = true
        } else {
          rules.value.push({ targetId: draftTargetId.value, viaId: draftViaId.value, targetName, viaName, enabled: true, note: '' })
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

      async function clearGeneratedArtifacts() {
        const confirmed = await Plugins.confirm('清空链式输出', '将删除“链式出口”本地订阅、策略组引用、当前生成配置里的历史链式字段，并清理旧链式插件对当前配置留下的映射；保留本插件的链路规则。确认继续？')
        if (!confirmed) return

        const profilesStore = Plugins.useProfilesStore()
        await clearVirtualArtifacts({
          subscribesStore,
          profilesStore,
          profileId: profile.id,
          clearProfileUses: true,
          cleanupGeneratedConfig: true,
          clearLegacyForProfile: true,
        })
        Plugins.message.success('已深度清空链式输出；需要恢复时重新保存链路并应用配置')
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
        clearGeneratedArtifacts,
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
        const descriptor = await writeVirtualSubscribe(chainProxies, subscribesStore)
        await saveState(profile.id, {
          version: 1,
          options: options.value,
          rules: rules.value,
        })
        await refreshKernelProvider(config, descriptor.id)
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
