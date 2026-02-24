/**
 * A2A Module - Agent-to-Agent Communication Protocol.
 */

export { A2AMessage, AgentIdentity, AgentRole, PREDEFINED_ROLES } from './protocol';
export {
  initA2ASchema,
  registerAgent,
  unregisterAgent,
  getActiveAgents,
  getAgentsByRole,
  sendMessage as sendA2AMessage,
  sendRequestAndWait,
  markProcessed,
  getConversationMessages as getA2AConversationMessages,
  getAgentMessages,
  getRecentA2AMessages,
  a2aEvents,
} from './bus';
export { spawnSubAgent, cancelSubAgent, getSubAgentStats } from './spawner';
export { delegateTaskTool, broadcastEventTool, queryAgentsTool, setA2AContext } from './tools';
