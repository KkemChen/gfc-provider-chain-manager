const PATH = 'data/third/provider-chain-manager'
const LEGACY_PATH = 'data/third/proxy-chain-manager'

const DEFAULT_OPTIONS = {
  inlineProviders: true,
  removeInlinedProviders: true,
}

/* Trigger: on::generate */
const onGenerate = async (config, profile) => {
  const subscribesStore = Plugins.useSubscribesStore()
  const state = await loadState(profile.id)
  const options = { ...DEFAULT_OPTIONS, ...(state.options || {}) }
  const context = await collectContext(config, profile, subscribesStore)
  const activeRules = normalizeRules(state).filter((rule) => rule.enabled !== false)

  applyRulesToProxies(config, context, activeRules)

  if (options.inlineProviders) {
    inlineProviderGroups(config, context)
  }

  if (options.removeInlinedProviders) {
    removeInlinedProviders(config, context.inlinedProviderIds)
  }

  return config
}

function applyRulesToProxies(config, context, rules) {
  const localProxies = Array.isArray(config.proxies) ? Plugins.deepClone(config.proxies) : []
  const sourceProxies = [...localProxies, ...context.providerProxies]
  const proxyMap = new Map()
  const usedNames = new Set()

  for (const proxy of sourceProxies) {
    if (!proxy?.name) continue
    proxyMap.set(proxy.name, proxy)
    usedNames.add(proxy.name)
  }

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

    proxyMap.set(chainName, chainProxy)
    usedNames.add(chainName)
    context.chainNameByTargetId[rule.targetId] = chainName
    context.chainNameByTargetName[targetName] = chainName
  }

  config.proxies = [...proxyMap.values()]
}

async function collectContext(config, profile, subscribesStore) {
  const idToName = {}
  const nameToId = {}
  const providerProxies = []
  const providerNodes = {}
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
    sections.push({ id: providerId, name: sub.name, type: 'provider', nodes: metaNodes })
  }

  sections.unshift({
    id: 'groups',
    name: '策略组',
    type: 'group',
    nodes: (profile.proxyGroupsConfig || []).map((group) => ({ id: group.id, name: group.name, type: 'group' })),
  })

  return { idToName, nameToId, providerProxies, providerNodes, inlinedProviderIds, chainNameByTargetId, chainNameByTargetName, sections }
}

function addKnown(idToName, nameToId, id, name) {
  if (!id || !name) return
  idToName[id] = name
  nameToId[name] = id
}

function inlineProviderGroups(config, context) {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []

  for (const group of groups) {
    if (!Array.isArray(group.use) || group.use.length === 0) continue

    const explicit = Array.isArray(group.proxies) ? group.proxies : []
    const expanded = []
    const remainingUse = []

    for (const providerId of group.use) {
      const nodes = context.providerNodes[providerId]
      if (!nodes) {
        remainingUse.push(providerId)
        continue
      }

      for (const proxy of nodes) {
        if (!proxy?.name) continue
        expanded.push(proxy.name)

        const chainName = context.chainNameByTargetName[proxy.name]
        if (chainName) expanded.push(chainName)
      }
      context.inlinedProviderIds.add(providerId)
    }

    group.proxies = uniqueNames([...explicit, ...expanded])
    group.use = remainingUse
  }

  appendChainedNodesToGroups(config, context)
}

function appendChainedNodesToGroups(config, context) {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []

  for (const group of groups) {
    if (!Array.isArray(group.proxies) || group.proxies.length === 0) continue

    const next = []
    for (const name of group.proxies) {
      next.push(name)
      const chainName = context.chainNameByTargetName[name]
      if (chainName) next.push(chainName)
    }
    group.proxies = uniqueNames(next)
  }
}

function makeChainProxyName(targetName, viaName, usedNames) {
  const base = `链式出口 | ${targetName} | 前置 ${viaName}`
  if (!usedNames.has(base)) return base

  let index = 2
  while (usedNames.has(`${base} #${index}`)) index += 1
  return `${base} #${index}`
}

function removeInlinedProviders(config, inlinedProviderIds) {
  if (!config['proxy-providers'] || inlinedProviderIds.size === 0) return

  for (const providerId of inlinedProviderIds) {
    delete config['proxy-providers'][providerId]
  }

  if (Object.keys(config['proxy-providers']).length === 0) {
    delete config['proxy-providers']
  }
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
      <div class="pb-8 pr-8" style="display: grid; grid-template-columns: minmax(360px, 1fr) minmax(420px, 1.25fr); gap: 14px;">
        <section style="display: flex; flex-direction: column; gap: 12px;">
          <div class="p-14 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
            <div class="flex justify-between items-center gap-10 mb-12">
              <div>
                <div class="font-bold text-18">新建链路</div>
                <div class="text-12 mt-4" style="opacity: .68">先选最终出口，再选前置节点。</div>
              </div>
              <div class="text-12 px-8 py-4 rounded-6" style="background: rgba(64, 128, 255, .12); color: #1677ff;">
                已启用 {{ enabledRuleCount }}
              </div>
            </div>

            <div class="mb-10" style="border: 1px solid var(--border-color); border-radius: 8px; background: linear-gradient(180deg, rgba(255,255,255,.48), rgba(128,128,128,.04)); padding: 12px;">
              <div class="text-12 mb-10" style="opacity: .68">运行路径</div>
              <div style="width: min(430px, 100%); margin: 0 auto; display: grid; grid-template-columns: 1fr; gap: 0;">
                <div :style="routeStepStyle(false, false)">
                  <div :style="routeDotStyle(false, '1')">1</div>
                  <div style="min-width: 0;">
                    <div style="opacity: .62; font-size: 12px; line-height: 1.35;">起点</div>
                    <div style="font-weight: 700; line-height: 1.35; overflow-wrap: anywhere;">本机</div>
                  </div>
                </div>
                <div :style="routeConnectorStyle()"><span :style="routeArrowStyle()"></span></div>
                <div :style="routeStepStyle(pickMode === 'via', true)" @click="pickMode = 'via'">
                  <div :style="routeDotStyle(pickMode === 'via', '2')">{{ pickMode === 'via' ? '' : '2' }}</div>
                  <div style="min-width: 0;">
                    <div style="opacity: .62; font-size: 12px; line-height: 1.35;">前置节点</div>
                    <div :style="routeValueStyle(!selectedViaName)">{{ selectedViaName || '点击选择' }}</div>
                  </div>
                </div>
                <div :style="routeConnectorStyle()"><span :style="routeArrowStyle()"></span></div>
                <div :style="routeStepStyle(pickMode === 'target', true)" @click="pickMode = 'target'">
                  <div :style="routeDotStyle(pickMode === 'target', '3')">{{ pickMode === 'target' ? '' : '3' }}</div>
                  <div style="min-width: 0;">
                    <div style="opacity: .62; font-size: 12px; line-height: 1.35;">最终出口</div>
                    <div :style="routeValueStyle(!selectedTargetName)">{{ selectedTargetName || '点击选择' }}</div>
                  </div>
                </div>
                <div :style="routeConnectorStyle()"><span :style="routeArrowStyle()"></span></div>
                <div :style="routeStepStyle(false, false)">
                  <div :style="routeDotStyle(false, '4')">4</div>
                  <div style="min-width: 0;">
                    <div style="opacity: .62; font-size: 12px; line-height: 1.35;">目标</div>
                    <div style="font-weight: 700; line-height: 1.35; overflow-wrap: anywhere;">网站</div>
                  </div>
                </div>
              </div>
              <div class="text-12 mt-8" style="opacity: .64">生成结果：新增一个链式出口节点，原节点保持不变。</div>
            </div>

            <div class="flex gap-8 mb-10">
              <Button :type="pickMode === 'target' ? 'primary' : 'default'" @click="pickMode = 'target'">选择出口</Button>
              <Button :type="pickMode === 'via' ? 'primary' : 'default'" @click="pickMode = 'via'">选择前置</Button>
              <Button type="primary" style="margin-left: auto;" @click="addRule">保存链路</Button>
            </div>

            <input v-model="query" :placeholder="pickMode === 'target' ? '搜索出口节点，例如 trojan / hy2 / 新加坡' : '搜索前置节点，例如 anytls / x-air / 新加坡'" style="width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px;" />
          </div>

          <div class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
            <div class="flex justify-between items-center mb-8">
              <div class="font-bold text-15">节点选择</div>
              <div class="text-12" style="opacity: .64">当前：{{ pickMode === 'target' ? '出口' : '前置' }}</div>
            </div>
            <div style="max-height: 430px; overflow: auto; padding-right: 4px;">
              <div v-for="section in filteredSections" :key="section.name" class="mb-10">
                <div class="text-12 mb-6" style="opacity: .58">{{ section.name }}</div>
                <div style="display: grid; gap: 6px;">
                  <button v-for="node in section.nodes" :key="node.id" :style="nodeRowStyle(node.id === draftTargetId || node.id === draftViaId)" @click="chooseNode(node.id)">
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;">{{ node.name }}</span>
                    <span style="opacity: .62; font-size: 12px;">{{ node.type || section.type }}</span>
                  </button>
                </div>
              </div>
              <div v-if="filteredSections.length === 0" class="text-13 p-10" style="opacity: .68">没有匹配的节点。</div>
            </div>
          </div>
        </section>

        <section style="display: flex; flex-direction: column; gap: 12px;">
          <div class="p-14 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
            <div class="flex justify-between items-center mb-10">
              <div>
                <div class="font-bold text-18">已配置链路</div>
                <div class="text-12 mt-4" style="opacity: .68">生成后请在策略组里选择名称更明确的“链式出口”新节点。</div>
              </div>
            </div>

            <div v-if="ruleViews.length === 0" class="rounded-8 p-16 text-14" style="border: 1px dashed var(--border-color); opacity: .72">
              还没有链路。左侧选择一个出口和一个前置后点“保存链路”。
            </div>

            <div v-for="(rule, index) in ruleViews" :key="rule.targetId" :style="ruleCardStyle(rule)">
              <div class="flex justify-between gap-10">
                <div style="min-width: 0; flex: 1;">
                  <div class="text-12 mb-5" style="opacity: .62">本机 -> 前置 -> 出口 -> 网站</div>
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 700; line-height: 1.35;">
                    <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ rule.viaName }}</span>
                    <span style="opacity: .5; flex: 0 0 auto;">-></span>
                    <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ rule.targetName }}</span>
                  </div>
                  <div class="text-12 mt-6" style="opacity: .66">新节点：{{ rule.chainName }}</div>
                  <div class="text-12 mt-4" style="opacity: .58">基于原节点：{{ rule.targetName }}；dialer-proxy: {{ rule.viaName }}</div>
                  <div v-if="rule.invalid" class="text-12 mt-6" style="color: #d4380d">规则无效：节点不存在或出口与前置相同。</div>
                </div>
                <div class="flex flex-col gap-6 items-end">
                  <label class="text-13"><input type="checkbox" v-model="rule.enabled" @change="syncEnabled(index, rule.enabled)" /> 启用</label>
                  <div class="flex gap-6">
                    <Button size="small" @click="editRule(rule)">改</Button>
                    <Button size="small" @click="removeRule(index)">删</Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
            <div class="flex justify-between items-center" @click="showAdvanced = !showAdvanced" style="cursor: pointer;">
              <div class="font-bold text-15">高级生成选项</div>
              <div class="text-12" style="opacity: .66">{{ showAdvanced ? '收起' : '展开' }}</div>
            </div>
            <div v-if="showAdvanced" class="flex flex-col gap-8 text-13 mt-10">
              <label><input type="checkbox" v-model="options.inlineProviders" /> 展开订阅 provider 到策略组 proxies</label>
              <label><input type="checkbox" v-model="options.removeInlinedProviders" /> 删除已展开的 proxy-providers，确保策略组能看到新增链式节点</label>
            </div>
          </div>
        </section>
      </div>`,
    setup() {
      function routeStepStyle(active, pickable) {
        return {
          minHeight: '66px',
          border: `1px solid ${active ? '#1677ff' : 'var(--border-color)'}`,
          borderRadius: '8px',
          background: active ? 'rgba(64, 128, 255, .06)' : 'var(--background-color)',
          display: 'grid',
          gridTemplateColumns: '34px minmax(0, 1fr)',
          alignItems: 'center',
          columnGap: '10px',
          padding: '9px 11px',
          boxShadow: active ? '0 0 0 3px rgba(64, 128, 255, .12)' : '0 1px 0 rgba(0, 0, 0, .03)',
          cursor: pickable ? 'pointer' : 'default',
        }
      }

      function routeDotStyle(active) {
        return {
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          border: `1px solid ${active ? '#1677ff' : 'var(--border-color)'}`,
          background: active ? '#1677ff' : 'var(--background-color)',
          boxShadow: active ? 'inset 0 0 0 7px var(--background-color)' : 'none',
          display: 'grid',
          placeItems: 'center',
          opacity: active ? 1 : .72,
          color: active ? 'transparent' : 'inherit',
          fontSize: '11px',
          fontWeight: 700,
        }
      }

      function routeValueStyle(empty) {
        return {
          fontWeight: 700,
          lineHeight: 1.35,
          overflowWrap: 'anywhere',
          color: empty ? '#1677ff' : 'inherit',
        }
      }

      function routeConnectorStyle() {
        return {
          height: '28px',
          width: '1px',
          background: 'var(--border-color)',
          position: 'relative',
          margin: '-1px auto',
          opacity: .78,
        }
      }

      function routeArrowStyle() {
        return {
          position: 'absolute',
          left: '50%',
          bottom: '-1px',
          width: '6px',
          height: '6px',
          borderRight: '1px solid var(--border-color)',
          borderBottom: '1px solid var(--border-color)',
          transform: 'translateX(-50%) rotate(45deg)',
          background: 'var(--background-color)',
        }
      }

      function nodeRowStyle(selected) {
        return {
          width: '100%',
          border: `1px solid ${selected ? '#1677ff' : 'var(--border-color)'}`,
          background: selected ? 'rgba(64, 128, 255, .10)' : 'transparent',
          borderRadius: '8px',
          padding: '8px 10px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: '8px',
          alignItems: 'center',
          textAlign: 'left',
          color: 'inherit',
          cursor: 'pointer',
        }
      }

      function ruleCardStyle(rule) {
        return {
          border: `1px solid ${rule.invalid ? '#d4380d' : 'var(--border-color)'}`,
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '8px',
          opacity: rule.enabled === false ? .56 : 1,
          background: rule.invalid ? 'rgba(212, 56, 13, .06)' : 'transparent',
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
        routeStepStyle,
        routeDotStyle,
        routeValueStyle,
        routeConnectorStyle,
        routeArrowStyle,
        nodeRowStyle,
        ruleCardStyle,
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
        await saveState(profile.id, {
          version: 1,
          options: options.value,
          rules: rules.value,
        })
        Plugins.message.success('common.success')
      },
      afterClose() {
        modal.destroy()
      },
    },
    { default: () => h(component) }
  )
  modal.open()
}
