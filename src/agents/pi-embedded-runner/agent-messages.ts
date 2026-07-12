import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AgentMessageState = {
  state?: { messages: AgentMessage[] };
  replaceMessages?: (messages: AgentMessage[]) => void;
};

export function replaceAgentMessages(agent: AgentMessageState, messages: AgentMessage[]): void {
  if (agent.state) {
    agent.state.messages = messages;
    return;
  }
  if (typeof agent.replaceMessages === "function") {
    agent.replaceMessages(messages);
    return;
  }
  throw new Error("Agent runtime does not expose mutable message state");
}
