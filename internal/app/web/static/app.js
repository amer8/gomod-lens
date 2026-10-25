import './sidebar.js'
import { createApplication } from './app-controller.js'
import { createAnalysisViews } from './analysis/index.js'
import { createModuleVersionPicker } from './module-versions.js'
import * as graphView from './graph.js'

const client = await import(document.documentElement.dataset.runtime === 'wasm' ? './wasm-client.js' : './http-client.js')
createApplication({ client, graphView, createAnalysisViews, createModuleVersionPicker })
