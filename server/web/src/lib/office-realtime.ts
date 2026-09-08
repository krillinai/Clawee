import type {
  ActivityFeedItem,
  ActivityItem,
  AgentActivityDetail,
  AgentActivityList,
  AgentListItem,
  OfficeFilters,
  OfficeSummary,
  SessionItem,
  SubAgentItem,
  TimelineItem,
  TurnItem,
} from "./office-api";

export type AgentUpsertPayload = {
  agent?: AgentListItem;
};

export type OfficeStatsUpdatedPayload = {
  summary?: OfficeSummary;
  filters?: OfficeFilters;
};

export type ActivityUpsertPayload = {
  activity?: ActivityItem;
};

export type SessionUpsertPayload = {
  session?: SessionItem;
};

export type TurnUpsertPayload = {
  turn?: TurnItem;
};

export type SubAgentUpsertPayload = {
  sub_agent?: SubAgentItem;
};

const SUB_AGENT_PREVIEW_LIMIT = 5;

export function applyAgentUpsert(office: AgentActivityList, payload: AgentUpsertPayload): AgentActivityList {
  const agent = payload.agent;
  if (!agent) {
    return office;
  }

  const key = agentKey(agent);
  const index = office.agents.findIndex((item) => agentKey(item) === key);

  if (index === -1) {
    return { ...office, agents: [...office.agents, agent] };
  }

  const agents = [...office.agents];
  agents[index] = agent;
  return { ...office, agents };
}

export function applyAgentUpsertToDetail(detail: AgentActivityDetail, payload: AgentUpsertPayload): AgentActivityDetail {
  const agent = payload.agent;
  if (!agent || !matchesDetailAgent(detail, agent.collector_id, agent.agent_id)) {
    return detail;
  }

  return {
    ...detail,
    agent,
    current_session: agent.current_session,
    current_turn: agent.current_turn,
    active_business_call: agent.active_business_call,
  };
}

export function applyOfficeStatsUpdated(office: AgentActivityList, payload: OfficeStatsUpdatedPayload): AgentActivityList {
  return {
    ...office,
    summary: payload.summary ?? office.summary,
    filters: payload.filters ?? office.filters,
  };
}

export function applySubAgentUpsertToOffice(office: AgentActivityList, payload: SubAgentUpsertPayload): AgentActivityList {
  const subAgent = payload.sub_agent;
  if (!subAgent) {
    return office;
  }

  const agentIndex = office.agents.findIndex(
    (agent) => agent.collector_id === subAgent.collector_id && agent.agent_id === subAgent.parent_agent_id,
  );
  if (agentIndex === -1) {
    return office;
  }

  const agents = [...office.agents];
  const agent = agents[agentIndex];
  const existingPreview = agent.sub_agents.preview ?? [];
  const previewIndex = existingPreview.findIndex((item) => subAgentKey(item) === subAgentKey(subAgent));
  let preview = existingPreview;
  let activeCount = agent.sub_agents.active_count;
  let totalCount = agent.sub_agents.total_count;

  if (previewIndex !== -1) {
    const previousSubAgent = preview[previewIndex];
    preview = [...preview];
    preview[previewIndex] = subAgent;
    activeCount += activeDelta(previousSubAgent, subAgent);
  } else if (preview.length < SUB_AGENT_PREVIEW_LIMIT) {
    preview = [...preview, subAgent];
    totalCount += 1;
    activeCount += isActiveSubAgent(subAgent) ? 1 : 0;
  } else {
    return office;
  }

  agents[agentIndex] = {
    ...agent,
    sub_agents: {
      active_count: Math.max(0, activeCount),
      total_count: totalCount,
      preview: preview.slice(0, SUB_AGENT_PREVIEW_LIMIT),
    },
  };

  return { ...office, agents };
}

export function shouldInvalidateOfficeForSubAgentUpsert(office: AgentActivityList, payload: SubAgentUpsertPayload): boolean {
  const subAgent = payload.sub_agent;
  if (!subAgent) {
    return false;
  }

  const agent = office.agents.find((item) => item.collector_id === subAgent.collector_id && item.agent_id === subAgent.parent_agent_id);
  const preview = agent?.sub_agents.preview ?? [];
  if (!agent || preview.length < SUB_AGENT_PREVIEW_LIMIT) {
    return false;
  }

  return !preview.some((item) => subAgentKey(item) === subAgentKey(subAgent));
}

export function applySubAgentUpsertToDetail(detail: AgentActivityDetail, payload: SubAgentUpsertPayload): AgentActivityDetail {
  const subAgent = payload.sub_agent;
  if (!subAgent || !matchesDetailAgent(detail, subAgent.collector_id, subAgent.parent_agent_id)) {
    return detail;
  }

  const subAgents = upsertSubAgent(detail.sub_agents, subAgent);
  const activeSubAgents = subAgents.filter(isActiveSubAgent).length;
  const totalSubAgents = subAgents.length;
  const preview = subAgents.slice(0, SUB_AGENT_PREVIEW_LIMIT);

  return {
    ...detail,
    agent: {
      ...detail.agent,
      sub_agents: {
        active_count: activeSubAgents,
        total_count: totalSubAgents,
        preview,
      },
    },
    sub_agents: subAgents,
    stats: {
      ...detail.stats,
      active_sub_agents: activeSubAgents,
      total_sub_agents: totalSubAgents,
    },
  };
}

export function applyActivityUpsertToOffice(office: AgentActivityList, payload: ActivityUpsertPayload): AgentActivityList {
  const activity = payload.activity;
  if (!activity) {
    return office;
  }

  const agent = office.agents.find((item) => item.collector_id === activity.collector_id && item.agent_id === activity.agent_id);
  if (!agent) {
    return office;
  }

  const feedItem: ActivityFeedItem = {
    collector_id: activity.collector_id,
    agent_id: activity.agent_id,
    activity_id: activity.activity_id,
    occurred_at: activity.started_at,
    text: `${agent.display_name} ${activity.activity_type}: ${activity.title || activity.summary}`,
  };
  const existingIndex = office.recent_feed.findIndex(
    (item) => item.activity_id !== undefined && matchesFeedActivity(item, activity),
  );
  const recentFeed =
    existingIndex === -1
      ? [feedItem, ...office.recent_feed].slice(0, 20)
      : office.recent_feed.map((item, index) => (index === existingIndex ? feedItem : item));

  return { ...office, recent_feed: recentFeed };
}

export function applyActivityUpsertToDetail(detail: AgentActivityDetail, payload: ActivityUpsertPayload): AgentActivityDetail {
  const activity = payload.activity;
  if (!activity || !matchesDetailAgent(detail, activity.collector_id, activity.agent_id)) {
    return detail;
  }

  const recentActivities = upsertActivity(detail.recent_activities, activity);
  const timelineItem = timelineItemFromActivity(activity);
  const timelineIndex = detail.status_timeline.findIndex(
    (item) => item.activity_id !== undefined && item.activity_id === activity.activity_id,
  );
  const statusTimeline =
    timelineIndex === -1
      ? [timelineItem, ...detail.status_timeline]
      : detail.status_timeline.map((item, index) => (index === timelineIndex ? timelineItem : item));

  return {
    ...detail,
    recent_activities: recentActivities,
    status_timeline: statusTimeline,
    stats: {
      ...detail.stats,
      recent_activity_count: recentActivities.length,
    },
  };
}

export function applyActivityCompletedToDetail(detail: AgentActivityDetail, payload: ActivityUpsertPayload): AgentActivityDetail {
  const activity = payload.activity;
  if (!activity || !activity.completed_at || !matchesDetailAgent(detail, activity.collector_id, activity.agent_id)) {
    return detail;
  }

  let didUpdateActivity = false;
  const recentActivities = detail.recent_activities.map((item) => {
    if (activityIdentity(item) !== activityIdentity(activity)) {
      return item;
    }
    didUpdateActivity = true;
    return { ...item, ...activity, completed_at: activity.completed_at };
  });

  const timelineIndex = findTimelineCompletionIndex(detail.status_timeline, activity);
  const statusTimeline = detail.status_timeline.map((item) => {
    if (timelineIndex === -1 || detail.status_timeline[timelineIndex] !== item) {
      return item;
    }
    return { ...item, completed_at: activity.completed_at };
  });

  if (!didUpdateActivity && timelineIndex === -1) {
    return detail;
  }

  return { ...detail, recent_activities: recentActivities, status_timeline: statusTimeline };
}

export function applySessionUpsertToDetail(detail: AgentActivityDetail, payload: SessionUpsertPayload): AgentActivityDetail {
  const session = payload.session;
  if (!session) {
    return detail;
  }

  const sessions = upsertSession(detail.sessions, session);
  const currentSession = detail.current_session?.session_id === session.session_id ? session : detail.current_session;
  const agentCurrentSession = detail.agent.current_session?.session_id === session.session_id ? session : detail.agent.current_session;

  return {
    ...detail,
    current_session: currentSession,
    sessions,
    agent: {
      ...detail.agent,
      current_session: agentCurrentSession,
    },
  };
}

export function applyTurnUpsertToDetail(detail: AgentActivityDetail, payload: TurnUpsertPayload): AgentActivityDetail {
  const turn = payload.turn;
  if (!turn) {
    return detail;
  }

  const turns = upsertTurn(detail.turns, turn);
  const currentTurn = detail.current_turn?.turn_id === turn.turn_id ? turn : detail.current_turn;
  const agentCurrentTurn = detail.agent.current_turn?.turn_id === turn.turn_id ? turn : detail.agent.current_turn;

  return {
    ...detail,
    current_turn: currentTurn,
    turns,
    agent: {
      ...detail.agent,
      current_turn: agentCurrentTurn,
    },
  };
}

export function applyTurnCompletedToDetail(detail: AgentActivityDetail, payload: TurnUpsertPayload): AgentActivityDetail {
  return applyTurnUpsertToDetail(detail, payload);
}

export function upsertActivity(activities: ActivityItem[], activity: ActivityItem): ActivityItem[] {
  const index = activities.findIndex((item) => activityIdentity(item) === activityIdentity(activity));
  if (index === -1) {
    return [activity, ...activities];
  }

  const next = [...activities];
  next[index] = activity;
  return next;
}

export function upsertSession(sessions: SessionItem[], session: SessionItem): SessionItem[] {
  const index = sessions.findIndex((item) => item.session_id === session.session_id);
  if (index === -1) {
    return [...sessions, session];
  }

  const next = [...sessions];
  next[index] = session;
  return next;
}

export function upsertTurn(turns: TurnItem[], turn: TurnItem): TurnItem[] {
  const index = turns.findIndex((item) => item.turn_id === turn.turn_id);
  if (index === -1) {
    return [...turns, turn];
  }

  const next = [...turns];
  next[index] = turn;
  return next;
}

export function upsertSubAgent(subAgents: SubAgentItem[], subAgent: SubAgentItem): SubAgentItem[] {
  const key = subAgentKey(subAgent);
  const index = subAgents.findIndex((item) => subAgentKey(item) === key);
  if (index === -1) {
    return [...subAgents, subAgent];
  }

  const next = [...subAgents];
  next[index] = subAgent;
  return next;
}

function agentKey(input: Pick<AgentListItem, "collector_id" | "agent_id">): string {
  return `${keySegment(input.collector_id)}/${keySegment(input.agent_id)}`;
}

function subAgentKey(input: Pick<SubAgentItem, "collector_id" | "parent_agent_id" | "sub_agent_id">): string {
  return `${keySegment(input.collector_id)}/${keySegment(input.parent_agent_id)}/${keySegment(input.sub_agent_id)}`;
}

function keySegment(segment: string): string {
  return segmentNeedsEncoding(segment) ? `${segment.length}:${encodeURIComponent(segment)}` : segment;
}

function segmentNeedsEncoding(segment: string): boolean {
  return segment.includes("/") || segment.includes("%") || segment.includes(":");
}

function matchesDetailAgent(detail: AgentActivityDetail, collectorId: string, agentId: string): boolean {
  return detail.agent.collector_id === collectorId && detail.agent.agent_id === agentId;
}

function timelineItemFromActivity(activity: ActivityItem): TimelineItem {
  return {
    activity_id: activity.activity_id,
    event_type: "activity",
    title: activity.title,
    summary: activity.summary,
    status: activity.status,
    activity_type: activity.activity_type,
    occurred_at: activity.started_at,
    completed_at: activity.completed_at,
  };
}

function matchesTimelineActivity(item: TimelineItem, activity: ActivityItem): boolean {
  if (item.activity_id !== undefined) {
    return item.activity_id === activity.activity_id;
  }

  return item.event_type === "activity" && item.activity_type === activity.activity_type && item.occurred_at === activity.started_at;
}

function findTimelineCompletionIndex(timeline: TimelineItem[], activity: ActivityItem): number {
  const activityIdIndex = timeline.findIndex((item) => item.activity_id !== undefined && item.activity_id === activity.activity_id);
  if (activityIdIndex !== -1) {
    return activityIdIndex;
  }

  return timeline.findIndex((item) => matchesTimelineActivity(item, activity));
}

function matchesFeedActivity(item: ActivityFeedItem, activity: ActivityItem): boolean {
  return item.collector_id === activity.collector_id && item.agent_id === activity.agent_id && item.activity_id === activity.activity_id;
}

function activityIdentity(activity: ActivityItem): string {
  return `${agentKey(activity)}/${activity.activity_id}`;
}

function isActiveSubAgent(subAgent: SubAgentItem): boolean {
  return !subAgent.completed_at;
}

function activeDelta(previousSubAgent: SubAgentItem, nextSubAgent: SubAgentItem): number {
  return Number(isActiveSubAgent(nextSubAgent)) - Number(isActiveSubAgent(previousSubAgent));
}
