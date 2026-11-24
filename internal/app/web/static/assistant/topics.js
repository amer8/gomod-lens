// Queries and follow-ups are an allowlist. Neither natural language nor model
// output can execute code, invent graph actions, or change a module version.
/** @type {Record<string, string>} */
export const topics = {
  attention: 'Which dependencies deserve attention first?',
  advisories: 'Which modules have known advisory matches?',
  introducers: 'Which direct dependencies introduce advisory matches?',
  updates: 'Which modules are behind an observed release?',
  'direct-updates': 'Which direct dependencies have newer observed releases?',
  'major-updates': 'Which updates cross a major version?',
  unknown: 'Where are we missing evidence?',
  paths: 'How is the selected module connected to the root?',
  selected: 'What do we know about the selected module?',
  licenses: 'What license evidence is available?',
  'license-review': 'Which modules have multiple license expressions?',
  'license-gaps': 'Which modules lack usable license evidence?',
  scorecard: 'Which repository checks need investigation?',
  fixes: 'Which advisories mention fixed versions?',
  reachability: 'Can this graph establish vulnerability reachability?',
  overview: 'How is this dependency graph structured?',
  lenses: 'Which analysis lenses are available?',
}
export const topicIDs = Object.keys(topics)
