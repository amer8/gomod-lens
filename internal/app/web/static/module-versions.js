const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/

export function compareVersions(a, b) {
  const x = versionPattern.exec(a), y = versionPattern.exec(b)
  if (!x || !y) return a.localeCompare(b)
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(x[i]) - BigInt(y[i])
    if (difference) return difference > 0n ? 1 : -1
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0
  const p = x[4].split('.'), q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    if (p[i] === q[i]) continue
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i])
    if (pn && qn) return BigInt(p[i]) > BigInt(q[i]) ? 1 : -1
    if (pn !== qn) return pn ? -1 : 1
    return p[i] < q[i] ? -1 : 1
  }
  return 0
}

export function selectedModuleTarget(target, modulePath, version) {
  return target && !target.includes('@') && target === modulePath && version
    ? target + '@' + version : target
}

export async function fetchModuleVersions(modulePath, loaded, { signal, fetcher = fetch } = {}) {
  const escaped = modulePath.replace(/[A-Z]/g, c => '!' + c.toLowerCase())
    .split('/').map(encodeURIComponent).join('/')
  const base = 'https://proxy.golang.org/' + escaped
  const get = async (suffix, json) => {
    const response = await fetcher(base + suffix, { signal, credentials: 'omit' })
    if (!response.ok) throw new Error('Go module proxy HTTP ' + response.status)
    return json ? response.json() : response.text()
  }
  const [list, info] = await Promise.allSettled([get('/@v/list', false), get('/@latest', true)])
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const listed = list.status === 'fulfilled'
    ? list.value.trim().split(/\s+/).filter(v => versionPattern.test(v)) : []
  const latest = info.status === 'fulfilled' && versionPattern.test(info.value?.Version)
    ? info.value.Version : ''
  return {
    versions: [...new Set([loaded, latest, ...listed].filter(Boolean))]
      .sort((a, b) => compareVersions(b, a)),
    latest,
    partial: list.status === 'rejected' || !latest,
  }
}

export function createModuleVersionPicker(form, input) {
  const host = document.createElement('div')
  host.className = 'module-version-control'
  host.hidden = true
  const select = document.createElement('select')
  select.id = 'module-version'
  select.setAttribute('aria-label', 'Module version')
  select.setAttribute('aria-describedby', 'module-version-note')
  const note = document.createElement('span')
  note.id = 'module-version-note'
  note.className = 'module-version-note'
  note.setAttribute('role', 'status')
  host.append(select)
  form.querySelector('.input-group').insertBefore(host, form.querySelector('.input-group-btn'))
  form.querySelector('.control-stack').append(note)
  note.hidden = true

  let modulePath = '', controller = null, generation = 0
  const cache = new Map()
  const cancel = () => { generation++; controller?.abort(); controller = null }
  select.addEventListener('change', () => {
    input.value = modulePath + '@' + select.value
    form.requestSubmit()
  })

  return {
    target(value) { return selectedModuleTarget(value, modulePath, select.value) },
    loading() {
      cancel()
      select.disabled = true
      note.hidden = true
      note.textContent = 'Loading module…'
    },
    clear() {
      cancel()
      modulePath = ''
      select.replaceChildren()
      host.hidden = true
      note.hidden = true
      form.classList.remove('search-version-loaded')
    },
    async capture(graph) {
      cancel()
      const root = graph.nodes?.find(node => node.id === graph.rootId)
      if (!root?.name || !root.version) { this.clear(); return }
      const current = generation, path = root.name, loaded = root.version
      modulePath = path
      input.value = path
      host.hidden = false
      form.classList.add('search-version-loaded')
      select.replaceChildren(new Option(loaded, loaded))
      select.disabled = true
      note.hidden = false
      note.textContent = 'Loading published versions…'
      const request = new AbortController()
      controller = request
      const timer = setTimeout(() => request.abort(), 15000)
      try {
        const cached = cache.get(path)
        const data = cached && Date.now() - cached.at < 300000 ? cached.data
          : await fetchModuleVersions(path, loaded, { signal: request.signal })
        if (current !== generation) return
        if (!data.partial) cache.set(path, { at: Date.now(), data })
        const versions = [...new Set([loaded, ...data.versions])]
          .sort((a, b) => compareVersions(b, a))
        select.replaceChildren(...versions.map(version => new Option(
          version, version,
        )))
        select.value = loaded
        select.disabled = versions.length < 2
        select.title = 'Loaded: ' + loaded + (data.latest ? ' · Latest: ' + data.latest : '')
        note.hidden = !data.partial && data.latest === loaded
        note.textContent = data.partial
          ? 'Some versions are unavailable. You can still enter module@version.'
          : data.latest !== loaded ? 'Latest: ' + data.latest : 'Published versions · Go module proxy'
      } catch (error) {
        if (current !== generation) return
        note.hidden = false
        note.textContent = 'Version lookup unavailable. Enter module@version to load another version.'
      } finally {
        clearTimeout(timer)
        if (controller === request) controller = null
      }
    },
  }
}
