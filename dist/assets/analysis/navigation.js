import { browserLenses, defaultLensID } from './registry.js'

export function selectedLens(id) {
  return browserLenses.some(lens => lens.id === id) ? id : defaultLensID
}

export function lensURL(href, id) {
  const url = new URL(href)
  url.searchParams.delete('v')
  const lens = selectedLens(id)
  if (lens === defaultLensID) url.searchParams.delete('lens')
  else url.searchParams.set('lens', lens)
  return url
}
