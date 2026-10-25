import createLayout from './vendor/ngraph.forcelayout.js'

// The force solver publishes positions to the native renderers and pins the root.
export function createGraphLayout(model) {
  const size = id => 10 + model.byID.get(id).dependencyScale * 18
  const layout = createLayout(model.graph, {
    springLength: 80, springCoefficient: 0.0002, gravity: -1.15,
    dragCoefficient: 0.03, theta: 0.8, timeStep: 20,
    nodeMass: id => 1 + model.graph.getLinks(id).size / 3 + size(id) * 0.1,
    springTransform(link, spring) { spring.length = Math.max(80, (size(link.fromId) + size(link.toId)) / 2 + 4) },
  })
  const root = model.byID.get(model.rootId)
  if (root) { layout.setNodePosition(root.id, 0, 0); layout.pinNode(root, true) }
  const bodies = model.nodes.map(n => layout.getBody(n.id)), positions = new Float32Array(model.positions.length)
  let stableFrames = 0
  function copy(smooth = false) {
    let energy = 0
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i], offset = i * 2
      energy += body.velocity.x ** 2 + body.velocity.y ** 2
      const weight = smooth ? 0.15 : 1
      positions[offset] += (body.pos.x - positions[offset]) * weight
      positions[offset + 1] += (body.pos.y - positions[offset + 1]) * weight
    }
    model.setPositions(positions)
    return energy
  }
  copy()
  return {
    step() {
      layout.step()
      const energy = copy(true)
      stableFrames = energy < 0.003 * Math.max(model.nodes.length, 1) ? stableFrames + 1 : 0
      if (stableFrames >= 10) copy()
      return stableFrames >= 10
    },
    finish() { copy() },
    dispose() { layout.dispose() },
  }
}
