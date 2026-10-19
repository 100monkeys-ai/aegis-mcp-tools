// This file holds the prompts the orchestrator injects into context for
// connection families. Each family is keyed by its provider id: the stored
// identifier of the remote MCP server (imap, github, carbon-forge, ...).

export const CONTEXT_SENTENCES: Record<string, string> = {
  calendar: "for calendar, the tools whose names begin with calendar.",
  github: "for GitHub, the tools whose names begin with github.",
  "carbon-forge":
    "for Carbon Forge, the tools whose names begin with carbon-forge.",
  mailbox: "for mailbox, the tools whose names begin with mail.",
};

export const PROFILE_NO_CHOICE_SENTENCE: Record<string, string> = {
  github: "the profile you chose for GitHub is",
  "carbon-forge": "the profile you chose for Carbon Forge is",
};

export function connectionNeedsSentence(family: string): string {
  return `A message needs ${CONTEXT_SENTENCES[family] ?? "a connection"} to continue.`;
}

export function connectionNeedsSentenceForProfile(family: string): string {
  return `A message needs ${CONTEXT_SENTENCES[family] ?? "a connection"} to continue. It will use the binding your profile names, if it holds one.`;
}

export function profileNoChoiceSentence(family: string): string {
  return `This run has no profile that names ${PROFILE_NO_CHOICE_SENTENCE[family] ?? "the connection"}.`;
}

export const CONNECTION_NEEDS = "A message needs a connection to continue.";

export const CONNECTION_NEEDS_TEACHING = `A message needs a connection to continue. It will use the binding your profile names, if it holds one. For GitHub, the tools whose names begin with github. For Carbon Forge, the tools whose names begin with carbon-forge.`;

export const CARBON_FORGE_TEACHING = `For Carbon Forge, the tools whose names begin with carbon-forge.`;

export const NUCLEAR_NOTES_TEACHING = CARBON_FORGE_TEACHING;