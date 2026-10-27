import assert from 'node:assert/strict'

export async function verifyBrowser(page) {
  const initialCamera = await page.evaluate(async () => {
    const { createGraphModel } = await import('/internal/app/web/static/graph-model.js')
    const { createGraphScene, fitCamera } = await import('/internal/app/web/static/graph-scene.js')
    const { makeFixture } = await import('./fixture.js')
    window.check = { createGraphModel, createGraphScene, makeFixture, container: document.getElementById('graph'), selected: [] }
    const model = createGraphModel(makeFixture(35))
    model.setPositions(new Float32Array(model.nodes.flatMap((_, i) => [Math.cos(i) * (i + 1) * 12, Math.sin(i) * (i + 1) * 12])))
    check.model = model
    check.scene = createGraphScene(check.container, model, { renderer: 'webgpu', onNodeSelected: node => check.selected.push(node?.id || '') })
    await check.scene.ready; check.scene.draw()
    return { actual: { ...check.scene.camera }, expected: fitCamera(model.positions, check.scene.dimensions.width, check.scene.dimensions.height) }
  })
  assert.deepEqual(initialCamera.actual, initialCamera.expected, 'the scene must fit before its first draw')
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
  const beforeResize = await page.evaluate(() => ({ camera: { ...check.scene.camera }, ...check.scene.dimensions }))
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForFunction(() => check.scene.dimensions.width === 390)
  const afterResize = await page.evaluate(() => ({ camera: { ...check.scene.camera }, ...check.scene.dimensions }))
  assert.equal(afterResize.camera.scale, beforeResize.camera.scale, 'resizing must retain the user\'s zoom')
  for (const [axis, dimension] of [['x', 'width'], ['y', 'height']]) {
    assert(Math.abs((beforeResize[dimension] / 2 - beforeResize.camera[axis]) - (afterResize[dimension] / 2 - afterResize.camera[axis])) < 1e-8, 'resizing must retain the world point at the viewport center')
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.screenshot({ path: '/private/tmp/gomod-lens-webgpu-mobile.png' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForFunction(() => check.scene.dimensions.width === 1280)
  assert.deepEqual(await page.evaluate(() => ({ ...check.scene.camera })), beforeResize.camera)

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

  // Exercise the production layout timeout after the user changes the view.
  // The backdrop properties reflect the live camera without exposing the
  // private production scene just for verification.
  for (const mode of ['canvas', 'webgpu']) {
    const initial = await page.evaluate(async mode => {
      check.graph = await import('/internal/app/web/static/graph.js')
      check.cameraStyle = () => ['pan-x', 'pan-y', 'band-pan-x', 'band-pan-y', 'scale', 'band-scale'].map(name => check.container.style.getPropertyValue(`--galaxy-${name}`))
      await check.graph.renderGraph(check.container, check.makeFixture(500), { renderer: mode })
      return { camera: check.cameraStyle(), renderer: check.container.dataset.graphRenderer }
    }, mode)
    assert.equal(initial.renderer, mode)
    assert(initial.camera.every(Boolean), 'the initial graph must be fitted before readiness')
    await page.mouse.move(800, 600); await page.mouse.down(); await page.mouse.move(860, 640); await page.mouse.up()
    await page.mouse.wheel(0, -200)
    await page.waitForFunction(initial => check.cameraStyle().some((value, i) => value !== initial[i]), initial.camera)
    // Let the wheel event land before testing that the timeout preserves it.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const completion = await page.evaluate(async () => {
      const before = check.cameraStyle(), descriptor = Object.getOwnPropertyDescriptor(performance, 'now'), now = performance.now.bind(performance)
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 13000 })
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return { before, after: check.cameraStyle() }
      } finally {
        if (descriptor) Object.defineProperty(performance, 'now', descriptor)
        else delete performance.now
      }
    })
    assert.deepEqual(completion.after, completion.before, `${mode}: layout completion must preserve pan and zoom`)
    await page.evaluate(() => check.graph.disposeGraph())
  }

  await page.evaluate(async () => {
    const ready = check.graph.renderGraph(check.container, check.makeFixture(1500), { renderer: 'canvas' })
    await new Promise(requestAnimationFrame)
    check.graph.disposeGraph()
    await ready
    await new Promise(requestAnimationFrame)
  })
  assert.equal(await page.evaluate(() => check.container.querySelectorAll('canvas').length), 0, 'canceled preparation cannot mount a graph later')
  return { nativeWebGPU: true, selection: true, panZoom: true, touch: true, resize390px: true, resizePreservesCamera: true, layoutCompletionPreservesCamera: true, canceledPreparation: true, deviceLossFallback: true, refusedAdapterFallback: true, canceledInitialization: true }
}
