import assert from 'node:assert/strict'

export async function verifyBrowser(page) {
  await page.evaluate(async () => {
    const { createGraphModel } = await import('/internal/app/web/static/graph-model.js')
    const { createGraphScene } = await import('/internal/app/web/static/graph-scene.js')
    const { makeFixture } = await import('./fixture.js')
    window.check = { createGraphModel, createGraphScene, makeFixture, container: document.getElementById('graph'), selected: [] }
    const model = createGraphModel(makeFixture(35))
    model.setPositions(new Float32Array(model.nodes.flatMap((_, i) => [Math.cos(i) * (i + 1) * 12, Math.sin(i) * (i + 1) * 12])))
    check.model = model
    check.scene = createGraphScene(check.container, model, { renderer: 'webgpu', onNodeSelected: node => check.selected.push(node?.id || '') })
    await check.scene.ready; check.scene.fit(); check.scene.draw()
  })
  assert.equal(await page.evaluate(() => check.scene.renderer), 'webgpu')
  const target = await page.evaluate(() => {
    const { camera, model } = check.scene
    return { x: model.positions[0] * camera.scale + camera.x, y: model.positions[1] * camera.scale + camera.y, id: model.nodes[0].id }
  })
  await page.mouse.click(target.x, target.y)
  assert.equal(await page.evaluate(() => check.selected.at(-1)), target.id)
  const before = await page.evaluate(() => ({ ...check.scene.camera }))
  await page.mouse.move(800, 600); await page.mouse.down(); await page.mouse.move(850, 630, { steps: 4 }); await page.mouse.up()
  const after = await page.evaluate(() => ({ ...check.scene.camera }))
  assert(Math.abs(after.x - before.x - 50) < 1); assert(Math.abs(after.y - before.y - 30) < 1)
  assert.equal(await page.evaluate(() => check.selected.length), 1, 'dragging must not select a node')
  await page.mouse.wheel(0, -200)
  await page.waitForFunction(scale => check.scene.camera.scale > scale, after.scale)
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForFunction(() => check.scene.dimensions.width === 390)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.screenshot({ path: '/private/tmp/gomod-lens-webgpu-mobile.png' })
  await page.setViewportSize({ width: 1280, height: 800 })

  // Exercise actual device loss, not just feature detection.
  await page.evaluate(async () => {
    check.scene.dispose(); check.nativeGPU = navigator.gpu
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
      requestAdapter: async () => {
        const adapter = await check.nativeGPU.requestAdapter()
        return { info: adapter.info, requestDevice: async () => { check.device = await adapter.requestDevice(); return check.device } }
      },
      getPreferredCanvasFormat: () => check.nativeGPU.getPreferredCanvasFormat(),
    } })
    check.scene = check.createGraphScene(check.container, check.model, { renderer: 'webgpu' })
    await check.scene.ready; check.scene.fit(); check.scene.draw()
    check.device.destroy()
  })
  await page.waitForFunction(() => check.scene.renderer === 'canvas')
  assert(await page.evaluate(() => check.scene.fallbackReason.length > 0))
  assert.equal(await page.evaluate(() => check.container.querySelectorAll('canvas').length), 2)

  // Adapter refusal must leave a working Canvas graph.
  await page.evaluate(async () => {
    check.scene.dispose()
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => null } })
    check.scene = check.createGraphScene(check.container, check.model, { renderer: 'webgpu' })
    await check.scene.ready; check.scene.fit(); check.scene.draw()
  })
  assert.equal(await page.evaluate(() => check.scene.renderer), 'canvas')

  // A GPU request completing after a new graph mounts cannot replace it.
  await page.evaluate(async () => {
    check.scene.dispose()
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
      requestAdapter: () => new Promise(resolve => { check.resolveAdapter = resolve }),
      getPreferredCanvasFormat: () => check.nativeGPU.getPreferredCanvasFormat(),
    } })
    check.old = check.createGraphScene(check.container, check.model, { renderer: 'webgpu' })
  })
  await page.waitForFunction(() => !!check.resolveAdapter)
  await page.evaluate(async () => {
    check.old.dispose()
    check.scene = check.createGraphScene(check.container, check.model, { renderer: 'canvas' })
    check.resolveAdapter(await check.nativeGPU.requestAdapter())
    await check.old.ready
    delete navigator.gpu
  })
  assert.equal(await page.evaluate(() => check.scene.renderer), 'canvas')
  assert.equal(await page.evaluate(() => check.container.dataset.graphRenderer), 'canvas')
  assert.equal(await page.evaluate(() => check.container.querySelectorAll('canvas').length), 2)

  // Pinch and cancellation use real PointerEvents with two distinct contacts.
  const touch = await page.evaluate(() => {
    const target = check.container, camera = check.scene.camera, start = camera.scale
    const send = (type, id, x, y) => target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y }))
    // Synthetic pointer IDs do not have native capture; keep this assertion
    // focused on gesture math while mouse tests above exercise real capture.
    const capture = target.setPointerCapture; target.setPointerCapture = () => {}
    try {
      send('pointerdown', 11, 100, 100); send('pointerdown', 12, 200, 100)
      send('pointermove', 12, 250, 100)
      send('pointercancel', 11, 100, 100); send('pointerup', 12, 250, 100)
      return { before: start, after: camera.scale }
    } finally { target.setPointerCapture = capture }
  })
  assert(touch.after > touch.before)
  await page.evaluate(() => check.scene.dispose())
  return { nativeWebGPU: true, selection: true, panZoom: true, touch: true, resize390px: true, deviceLossFallback: true, refusedAdapterFallback: true, canceledInitialization: true }
}
