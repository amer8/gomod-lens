// Recognize common license identifiers even when the question omits "license".
// Match whole identifiers: ISC must not match DISCARD, and MIT must not match
// LicenseRef-MIT. This is an inventory filter, not a compatibility assessment.
const identifier = /(?<![\w.+/-])(?:MIT|ISC|0BSD|BSD-(?:2|3|4)-Clause(?:-Clear)?|Apache-[12]\.0|(?:AGPL|GPL|LGPL)-(?:[123]\.0|2\.1)(?:-(?:only|or-later)|\+)?|MPL-[12]\.[01]|EPL-[12]\.0|CC0-1\.0|Unlicense|Zlib|BSL-1\.0)(?![\w.+/-])/gi
const queryText = question => question.replace(/-licensed\b/gi, ' licensed')
export function licenseIDsIn(question) {
  return [...new Map([...queryText(question).matchAll(identifier)].map(match => [match[0].toLowerCase(), match[0]])).values()]
}
export function licenseQuery(question) {
  const text = queryText(question), ids = licenseIDsIn(text)
  if (!ids.length || !/\b(which|what|list|show|find|identify|how many|any)\b/i.test(question) || !/\b(modules?|dependencies|dependency|packages?)\b/i.test(question)) return null
  // Leave negation, exact-only expressions, and explanatory/mixed questions to
  // custom generation rather than silently answering a different filter.
  const intent = text.replace(identifier, ' ')
  const filterWords = new Set('which what list show find identify how many any all both either of these those the a an me our we have do does modules module dependencies dependency packages package has have having carries carry carrying use uses using with under licensed licenses license and or are is in this graph loaded current currently please'.split(' '))
  if ((intent.toLowerCase().match(/[a-z0-9]+/g) || []).some(word => !filterWords.has(word))) return null
  if (ids.length > 1) {
    const between = text.slice(text.toLowerCase().indexOf(ids[0].toLowerCase()) + ids[0].length, text.toLowerCase().lastIndexOf(ids.at(-1).toLowerCase()))
    if (/\band\b/i.test(between) && /\bor\b/i.test(between)) return null
    return { ids, mode: /\band\b/i.test(between) ? 'all' : 'any' }
  }
  return { ids, mode: 'any' }
}
export function hasLicenseEvidence(record) {
  return ['observed', 'nonstandard'].includes(record?.status) && Boolean(record.expressions?.length)
}
export function matchesLicense(record, query) {
  if (!hasLicenseEvidence(record)) return false
  const tokens = new Set(record.expressions.flatMap(expression => {
    // Preserve the original expression for display; tokens only select matches.
    // An exception following WITH is not an independently recorded license.
    let exception = false
    return expression.split(/[\s()]+/).filter(token => {
      if (/^WITH$/i.test(token)) { exception = true; return false }
      if (exception) { exception = false; return false }
      return token && !/^(AND|OR)$/i.test(token)
    }).map(token => token.toLowerCase())
  }))
  return query.ids[query.mode === 'all' ? 'every' : 'some'](id => tokens.has(id.toLowerCase()))
}
