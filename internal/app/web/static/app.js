import './sidebar.js'
import { createApplication } from './app-controller.js'
import { createAnalysisViews } from './analysis/index.js'
import { createModuleVersionPicker } from './module-versions.js'
import * as graphView from './graph.js'
import * as client from './wasm-client.js'

createApplication({ client, graphView, createAnalysisViews, createModuleVersionPicker })
