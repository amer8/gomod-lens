const color = (data, offset) => `rgba(${Math.round(data[offset] * 255)},${Math.round(data[offset + 1] * 255)},${Math.round(data[offset + 2] * 255)},${data[offset + 3]})`

export function createCanvasRenderer(canvas, model) {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unable to create a graph canvas')
  return {
    type: 'canvas',
    draw(camera, width, height) {
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const scale = camera.scale, nodeScale = Math.min(scale, 2), edges = model.edgeData, nodes = model.nodeData
      for (let i = 0; i < edges.length; i += 12) {
        const ax = edges[i] * scale + camera.x, ay = edges[i + 1] * scale + camera.y
        const bx = edges[i + 2] * scale + camera.x, by = edges[i + 3] * scale + camera.y
        const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy)
        const sourceR = edges[i + 4] * nodeScale, targetR = edges[i + 5] * nodeScale
        if (length <= sourceR + targetR) continue
        if (Math.max(ax, bx) < 0 || Math.min(ax, bx) > width || Math.max(ay, by) < 0 || Math.min(ay, by) > height) continue
        const ux = dx / length, uy = dy / length, arrow = Math.min(7, (length - sourceR - targetR) * 0.4)
        const sx = ax + ux * sourceR, sy = ay + uy * sourceR, ex = bx - ux * targetR, ey = by - uy * targetR
        ctx.strokeStyle = ctx.fillStyle = color(edges, i + 8); ctx.lineWidth = edges[i + 6]
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex - ux * arrow * 0.7, ey - uy * arrow * 0.7); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(ex, ey)
        ctx.lineTo(ex - ux * arrow - uy * arrow * 0.45, ey - uy * arrow + ux * arrow * 0.45)
        ctx.lineTo(ex - ux * arrow + uy * arrow * 0.45, ey - uy * arrow - ux * arrow * 0.45)
        ctx.closePath(); ctx.fill()
      }
      for (let i = 0; i < nodes.length; i += 8) {
        const x = nodes[i] * scale + camera.x, y = nodes[i + 1] * scale + camera.y, r = Math.max(1, nodes[i + 2] * nodeScale)
        if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue
        ctx.fillStyle = color(nodes, i + 4); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      }
    },
    flush: () => Promise.resolve(), dispose() {},
  }
}

// Both renderers share readable labels, collision suppression and zoom detail.
export function createGraphLabels(canvas, model) {
  const ctx = canvas.getContext('2d'), hits = [], widths = new Map()
  const ranked = [...model.nodes].sort((a, b) => b.importance - a.importance || a.index - b.index)
  return {
    hits,
    draw(camera, width, height) {
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0)
      ctx.clearRect(0, 0, width, height); hits.length = 0
      if (camera.scale < 0.7) return
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      const cells = new Map(), scale = camera.scale, nodeScale = Math.min(scale, 2)
      for (const node of ranked) {
        if (node.alpha < 1 || node.importance < Math.max(0, 0.65 - scale * 0.2)) continue
        const x = model.positions[node.index * 2] * scale + camera.x, y = model.positions[node.index * 2 + 1] * scale + camera.y
        const radius = node.radius * nodeScale, font = Math.round(11 + node.importance ** 2 * 8)
        const label = node.data.name || node.id, key = `${font}:${label}`
        if (x < -150 || x > width + 150 || y < -80 || y > height + 80) continue
        ctx.font = `${font}px system-ui, sans-serif`
        if (!widths.has(key)) widths.set(key, ctx.measureText(label).width)
        const textWidth = widths.get(key), bottom = y - radius - 5
        const box = { left: x - textWidth / 2 - 3, right: x + textWidth / 2 + 3, top: bottom - font - 2, bottom: scale >= 2.3 && node.data.version ? y + radius + 20 : bottom + 2, id: node.id }
        if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) continue
        const keys = []
        for (let a = Math.floor(box.left / 100); a <= Math.floor(box.right / 100); a++) for (let b = Math.floor(box.top / 40); b <= Math.floor(box.bottom / 40); b++) keys.push(`${a},${b}`)
        if (keys.some(key => cells.get(key)?.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top))) continue
        for (const key of keys) { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(box) }
        ctx.fillStyle = node.color; ctx.fillText(label, x, bottom)
        if (scale >= 2.3 && node.data.version) {
          ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(node.data.version, x, y + radius + 18)
        }
        hits.push(box)
      }
    },
  }
}
