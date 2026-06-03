const PATH = 'data/third/provider-chain-manager'
const LEGACY_PATH = 'data/third/proxy-chain-manager'

const DEFAULT_OPTIONS = {
  inlineProviders: true,
  removeInlinedProviders: true,
  keepUnmappedDialerProxyField: false,
}

/* Trigger: on::generate */
const onGenerate = async (config, profile) => {
  const subscribesStore = Plugins.useSubscribesStore()
  const state = await loadState(profile.id)
  const options = { ...DEFAULT_OPTIONS, ...(state.options || {}) }
  const context = await collectContext(config, profile, subscribesStore)
  const activeRules = normalizeRules(state).filter((rule) => rule.enabled !== false)

  applyRulesToProxies(config, context, activeRules, options)

  if (options.inlineProviders) {
    inlineProviderGroups(config, context)
  }

  if (options.removeInlinedProviders) {
    removeInlinedProviders(config, context.inlinedProviderIds)
  }

  return config
}

function applyRulesToProxies(config, context, rules, options) {
  const localProxies = Array.isArray(config.proxies) ? Plugins.deepClone(config.proxies) : []
  const proxyMap = new Map()

  for (const proxy of [...localProxies, ...context.providerProxies]) {
    if (!proxy?.name) continue

    const targetId = context.nameToId[proxy.name]
    const rule = rules.find((item) => item.targetId === targetId)
    const viaName = rule ? context.idToName[rule.viaId] : undefined

    if (viaName) {
      proxy['dialer-proxy'] = viaName
    } else if (!options.keepUnmappedDialerProxyField) {
      delete proxy['dialer-proxy']
    }

    proxyMap.set(proxy.name, proxy)
  }

  config.proxies = [...proxyMap.values()]
}

async function collectContext(config, profile, subscribesStore) {
  const idToName = {}
  const nameToId = {}
  const providerProxies = []
  const providerNodes = {}
  const inlinedProviderIds = new Set()
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

  return { idToName, nameToId, providerProxies, providerNodes, inlinedProviderIds, sections }
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

      expanded.push(...nodes.map((proxy) => proxy.name).filter(Boolean))
      context.inlinedProviderIds.add(providerId)
    }

    group.proxies = uniqueNames([...explicit, ...expanded])
    group.use = remainingUse
  }
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
    return {
      ...rule,
      targetName,
      viaName,
      preview: `本地 -> ${viaName} -> ${targetName} -> 目标网站`,
      invalid: rule.targetId === rule.viaId || !context.idToName[rule.targetId] || !context.idToName[rule.viaId],
    }
  }))

  const component = {
    template: `
      <div class="flex flex-col gap-12 pb-8 pr-8">
        <section class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
          <div class="font-bold text-16 mb-8">生成行为</div>
          <div class="flex flex-col gap-6 text-14">
            <label><input type="checkbox" v-model="options.inlineProviders" /> 将订阅 provider 展开到策略组 proxies</label>
            <label><input type="checkbox" v-model="options.removeInlinedProviders" /> 删除已展开的 proxy-providers，避免策略组选到未链式原始节点</label>
            <label><input type="checkbox" v-model="options.keepUnmappedDialerProxyField" /> 保留未配置节点已有的 dialer-proxy 字段</label>
          </div>
        </section>

        <section class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
          <div class="font-bold text-16 mb-8">新增链式规则</div>
          <div class="grid grid-cols-3 gap-8 items-end">
            <label class="flex flex-col gap-4">
              <span>目标节点（最终出口）</span>
              <select v-model="draftTargetId">
                <option value="">选择目标节点</option>
                <option v-for="node in nodeOptions" :key="'target-' + node.id" :value="node.id">
                  {{ node.name }} · {{ node.section }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-4">
              <span>前置节点</span>
              <select v-model="draftViaId">
                <option value="">选择前置节点</option>
                <option v-for="node in nodeOptions" :key="'via-' + node.id" :value="node.id">
                  {{ node.name }} · {{ node.section }}
                </option>
              </select>
            </label>
            <Button type="primary" @click="addRule">添加 / 更新</Button>
          </div>
          <div class="text-12 mt-8" style="opacity: .72">方向：本地先连接“前置节点”，再由前置节点拨“目标节点”，最后由目标节点访问网站。</div>
        </section>

        <section class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
          <div class="font-bold text-16 mb-8">当前链式规则</div>
          <div v-if="ruleViews.length === 0" class="text-14" style="opacity: .72">暂无规则。</div>
          <div v-for="(rule, index) in ruleViews" :key="rule.targetId" class="p-10 mb-8 rounded-6" style="border: 1px solid var(--border-color);">
            <div class="flex justify-between gap-8">
              <div>
                <div class="font-bold">{{ rule.targetName }}</div>
                <div class="text-13">dialer-proxy: {{ rule.viaName }}</div>
                <div class="text-12 mt-4" style="opacity: .72">{{ rule.preview }}</div>
                <div v-if="rule.invalid" class="text-12 mt-4" style="color: #d4380d">规则无效：节点不存在或目标与前置相同。</div>
              </div>
              <div class="flex gap-8 items-start">
                <label class="text-13"><input type="checkbox" v-model="rule.enabled" @change="syncEnabled(index, rule.enabled)" /> 启用</label>
                <Button size="small" @click="editRule(rule)">编辑</Button>
                <Button size="small" @click="removeRule(index)">删除</Button>
              </div>
            </div>
          </div>
        </section>

        <section class="p-12 rounded-8" style="background: var(--background-color); border: 1px solid var(--border-color);">
          <div class="font-bold text-16 mb-8">可选节点</div>
          <input v-model="query" placeholder="搜索节点或协议" style="width: 100%; box-sizing: border-box; margin-bottom: 8px;" />
          <div v-for="section in filteredSections" :key="section.name" class="mb-10">
            <div class="font-bold text-14 mb-6">{{ section.name }}</div>
            <div class="grid grid-cols-2 gap-6">
              <div v-for="node in section.nodes" :key="node.id" class="p-8 rounded-6" style="border: 1px solid var(--border-color);">
                <div class="font-bold">{{ node.name }}</div>
                <div class="text-12" style="opacity: .7">{{ node.type || section.type }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>`,
    setup() {
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
        draftTargetId,
        draftViaId,
        query,
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
