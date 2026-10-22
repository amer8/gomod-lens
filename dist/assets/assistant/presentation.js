// Summarize answer text while displaying every query result.
export function answerPreview(answer) {
  const view = { paragraphs: answer.paragraphs, items: answer.items, groups: [], compact: false }
  const summary = answer.licenseSummary
  if (!summary) return view
  const errors = answer.paragraphs.filter(text => text.startsWith('The license lookup failed:'))
  const unknown = summary.unknown ? [`${summary.unknown} modules have unknown license evidence.`] : []
  if (!summary.filter) {
    view.paragraphs = [`${summary.known}/${summary.total} modules have license metadata.${summary.multiple ? ` ${summary.multiple} ${summary.multiple === 1 ? 'appears' : 'appear'} in multiple groups.` : ''}`, ...unknown, ...errors]
    view.groups = answer.licenseGroups || []
  } else {
    view.compact = true
    view.paragraphs = answer.items.length === 1 ? [...unknown, ...errors] : [answer.items.length ? `${answer.items.length} modules match ${summary.filter}.` : `No recorded ${summary.filter} matches${summary.unknown ? ' in the available observations' : ''}.`, ...unknown, ...errors]
  }
  return view
}
