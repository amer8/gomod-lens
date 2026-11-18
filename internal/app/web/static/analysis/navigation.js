import { browserLenses, defaultLensID } from './registry.js'

/** @param {string | null | undefined} id */
export function selectedLens(id) {
  return id && browserLenses.some((lens) => lens.id === id) ? id : defaultLensID
}

/** @param {string | URL} href @param {string | null | undefined} id */
export function lensURL(href, id) {
  const url = new URL(href)
  url.searchParams.delete('v')
  const lens = selectedLens(id)
  if (lens === defaultLensID) url.searchParams.delete('lens')
  else url.searchParams.set('lens', lens)
  return url
}
