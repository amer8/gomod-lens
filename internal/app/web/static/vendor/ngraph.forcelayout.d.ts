import type { createGraphModel } from '../graph-model.js'

type GraphModel = ReturnType<typeof createGraphModel>
type Node = GraphModel['nodes'][number]
type Link = GraphModel['links'][number]
type Position = {x: number; y: number}
type Body = {pos: Position; velocity: Position}

export default function createLayout(graph: GraphModel['graph'], options: {
  springLength: number
  springCoefficient: number
  gravity: number
  dragCoefficient: number
  theta: number
  timeStep: number
  nodeMass(id: string): number
  springTransform(link: Link, spring: {length: number}): void
}): {
  setNodePosition(id: string, x: number, y: number): void
  pinNode(node: Node, pinned: boolean): void
  getBody(id: string): Body
  step(): boolean
  dispose(): void
}
