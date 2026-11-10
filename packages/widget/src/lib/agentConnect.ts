/**
 * Agent connect handoff (client-side, pure).
 *
 * When a user authorizes an agent, the client mints a per-agent stream key
 * (`topicId`, see `agentRegistry.ts`). To let the agent actually post activity
 * into the user's feed, the user hands that key to the agent out of band. This
 * module builds the exact config the raxol agent pastes in, and gates the key so
 * the UI can keep it hidden until the user chooses to reveal it.
 *
 * These are pure and dependency-free so the key is never transmitted or logged
 * here. See raxol#578 for the side that consumes the config.
 */

/**
 * The ready-to-paste agent config. `=` aligned so both keys line up:
 *   xochi_api_url = <apiUrl>
 *   topic_id      = <topicId>
 */
export function buildAgentConnectSnippet(apiUrl: string, topicId: string): string {
  return `xochi_api_url = ${apiUrl}\ntopic_id      = ${topicId}`;
}

/**
 * The stream key to show, gated on reveal. Returns the topic only when the user
 * has revealed it; otherwise null, so the caller renders nothing.
 */
export function revealedTopic(topicId: string, revealed: boolean): string | null {
  return revealed ? topicId : null;
}
