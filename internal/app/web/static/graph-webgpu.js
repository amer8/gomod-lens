const cameraShader = `
struct Camera { transform: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
fn screen(p: vec2f) -> vec2f { return p * camera.transform.x + camera.transform.yz; }
fn clip(p: vec2f) -> vec4f { return vec4f(p / camera.viewport.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0); }
`
const nodeShader = cameraShader + `
struct Output { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) vertexID: u32, @location(0) pos: vec2f, @location(1) radius: f32, @location(2) selected: f32, @location(3) color: vec4f) -> Output {
  let corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
  let local = corners[vertexID];
  let r = max(1.0, radius * min(camera.transform.x, 2.0));
  var out: Output;
  out.position = clip(screen(pos) + local * (r + 1.0));
  out.local = local * (r + 1.0) / r;
  out.color = color;
  return out;
}
@fragment fn fragment(input: Output) -> @location(0) vec4f {
  let distance = length(input.local);
  let coverage = 1.0 - smoothstep(1.0 - fwidth(distance), 1.0, distance);
  return vec4f(input.color.rgb, input.color.a * coverage);
}`
const edgeShader = cameraShader + `
struct Output { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) vertexID: u32, @location(0) endpoints: vec4f, @location(1) geometry: vec4f, @location(2) color: vec4f) -> Output {
  let a = screen(endpoints.xy); let b = screen(endpoints.zw);
  let delta = b - a; let length = max(0.001, length(delta));
  let direction = delta / length; let normal = vec2f(-direction.y, direction.x);
  let radii = geometry.xy * min(camera.transform.x, 2.0);
  let start = a + direction * radii.x; let end = b - direction * radii.y;
  let arrow = min(7.0, max(0.0, length - radii.x - radii.y) * 0.4);
  var p: vec2f;
  if (vertexID < 6u) {
    let corners = array<vec2f, 6>(vec2f(0,-1), vec2f(1,-1), vec2f(0,1), vec2f(0,1), vec2f(1,-1), vec2f(1,1));
    let corner = corners[vertexID];
    p = mix(start, end - direction * arrow * 0.7, corner.x) + normal * corner.y * geometry.z * 0.5;
  } else {
    let corners = array<vec2f, 3>(vec2f(0,0), vec2f(-1,-0.45), vec2f(-1,0.45));
    let corner = corners[vertexID - 6u];
    p = end + (direction * corner.x + normal * corner.y) * arrow;
  }
  var out: Output; out.position = clip(p);
  out.color = vec4f(color.rgb, color.a * select(0.0, 1.0, length > radii.x + radii.y));
  return out;
}
@fragment fn fragment(input: Output) -> @location(0) vec4f { return input.color; }
`

export async function createWebGPURenderer(canvas, model, onLost, gpu = globalThis.navigator?.gpu) {
  if (!gpu) throw new Error('WebGPU is unavailable')
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter is available')
  const device = await adapter.requestDevice()
  const buffers = []
  let context, disposed = false
  const destroy = () => {
    disposed = true
    for (const buffer of buffers) buffer.destroy()
    context?.unconfigure(); device.destroy()
  }
  try {
    context = canvas.getContext('webgpu')
    if (!context) throw new Error('Unable to create a WebGPU canvas')
    const format = gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'premultiplied' })
    const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
    const buffer = (size, usage) => { const b = device.createBuffer({ size: Math.max(32, size), usage }); buffers.push(b); return b }
    const uniform = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const nodes = buffer(model.nodeData.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST)
    const edges = buffer(model.edgeData.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST)
    device.pushErrorScope('validation')
    const pipeline = (code, arrayStride, attributes) => device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code }), entryPoint: 'vertex', buffers: [{ arrayStride, stepMode: 'instance', attributes }] },
      fragment: { module: device.createShaderModule({ code }), entryPoint: 'fragment', targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list' },
    })
    const [nodePipeline, edgePipeline] = await Promise.all([
      pipeline(nodeShader, 32, [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32' }, { shaderLocation: 2, offset: 12, format: 'float32' }, { shaderLocation: 3, offset: 16, format: 'float32x4' }]),
      pipeline(edgeShader, 48, [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }, { shaderLocation: 2, offset: 32, format: 'float32x4' }]),
    ])
    const error = await device.popErrorScope()
    if (error) throw new Error(error.message)
    const bind = p => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] })
    const nodeBind = bind(nodePipeline), edgeBind = bind(edgePipeline), cameraData = new Float32Array(8)
    let revision = -1
    device.lost.then(info => { if (!disposed) { destroy(); onLost(new Error(info.message || 'WebGPU device lost')) } })
    device.addEventListener('uncapturederror', event => { if (!disposed) { destroy(); onLost(event.error) } })
    return {
      type: 'webgpu', adapterInfo: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, device: adapter.info?.device, description: adapter.info?.description },
      draw(camera, width, height) {
        if (disposed) return
        if (revision !== model.revision) {
          if (model.nodeData.length) device.queue.writeBuffer(nodes, 0, model.nodeData)
          if (model.edgeData.length) device.queue.writeBuffer(edges, 0, model.edgeData)
          revision = model.revision
        }
        cameraData.set([camera.scale, camera.x, camera.y, 0, width, height, 0, 0])
        device.queue.writeBuffer(uniform, 0, cameraData)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] })
        pass.setPipeline(edgePipeline); pass.setBindGroup(0, edgeBind); pass.setVertexBuffer(0, edges); pass.draw(9, model.links.length)
        pass.setPipeline(nodePipeline); pass.setBindGroup(0, nodeBind); pass.setVertexBuffer(0, nodes); pass.draw(6, model.nodes.length)
        pass.end(); device.queue.submit([encoder.finish()])
      },
      flush: () => disposed ? Promise.resolve() : device.queue.onSubmittedWorkDone(),
      dispose: destroy,
    }
  } catch (error) { destroy(); throw error }
}
