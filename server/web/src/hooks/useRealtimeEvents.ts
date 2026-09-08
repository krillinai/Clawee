import { useEffect, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

import type { AgentActivityDetail, AgentActivityList, RealtimeEnvelope } from "../lib/office-api";
import {
  applyActivityCompletedToDetail,
  applyActivityUpsertToDetail,
  applyActivityUpsertToOffice,
  applyAgentUpsert,
  applyAgentUpsertToDetail,
  applyOfficeStatsUpdated,
  applySessionUpsertToDetail,
  applySubAgentUpsertToDetail,
  applySubAgentUpsertToOffice,
  applyTurnCompletedToDetail,
  applyTurnUpsertToDetail,
  shouldInvalidateOfficeForSubAgentUpsert,
  type ActivityUpsertPayload,
  type AgentUpsertPayload,
  type OfficeStatsUpdatedPayload,
  type SessionUpsertPayload,
  type SubAgentUpsertPayload,
  type TurnUpsertPayload,
} from "../lib/office-realtime";
import { agentDetailQueryKey } from "./useAgentDetail";
import { appOfficeQueryKey, officeQueryKey } from "./useOfficeSnapshot";

export type RealtimeConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

const defaultSseUrl = "/api/v1/admin/activity/events";

export function useRealtimeEvents(sseUrl = defaultSseUrl, scope: "admin" | "app" = "admin"): RealtimeConnectionState {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>("connecting");
  const currentOfficeQueryKey = scope === "app" ? appOfficeQueryKey : officeQueryKey;
  const agentDetailPrefix = scope === "app" ? "app-agent-detail" : "agent-detail";

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setConnectionState("disconnected");
      return;
    }

    setConnectionState("connecting");
    const eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      setConnectionState("connected");
    };
    eventSource.onerror = () => {
      setConnectionState("reconnecting");
    };

    const listeners: Array<[string, (event: MessageEvent) => void]> = [
      ["hello", createEventHandler(handleEnvelope)],
      ["agent.upserted", createEventHandler(handleEnvelope)],
      ["session.upserted", createEventHandler(handleEnvelope)],
      ["turn.upserted", createEventHandler(handleEnvelope)],
      ["turn.completed", createEventHandler(handleEnvelope)],
      ["sub_agent.upserted", createEventHandler(handleEnvelope)],
      ["activity.upserted", createEventHandler(handleEnvelope)],
      ["activity.completed", createEventHandler(handleEnvelope)],
      ["office.stats.updated", createEventHandler(handleEnvelope)],
      ["snapshot.required", createEventHandler(handleEnvelope)],
      ["heartbeat", createEventHandler(handleEnvelope)],
    ];

    listeners.forEach(([type, listener]) => {
      eventSource.addEventListener(type, listener);
    });

    function handleEnvelope(envelope: RealtimeEnvelope) {
      switch (envelope.event_type) {
        case "agent.upserted":
          handleAgentUpsert(envelope.data as AgentUpsertPayload);
          break;
        case "office.stats.updated":
          queryClient.setQueryData<AgentActivityList>(currentOfficeQueryKey, (office) =>
            office ? applyOfficeStatsUpdated(office, envelope.data as OfficeStatsUpdatedPayload) : office,
          );
          break;
        case "session.upserted":
          handleSessionUpsert(envelope);
          break;
        case "turn.upserted":
          handleTurnUpsert(envelope);
          break;
        case "turn.completed":
          handleTurnCompleted(envelope);
          break;
        case "activity.upserted":
          handleActivityUpsert(envelope.data as ActivityUpsertPayload);
          break;
        case "activity.completed":
          handleActivityCompleted(envelope.data as ActivityUpsertPayload);
          break;
        case "sub_agent.upserted":
          handleSubAgentUpsert(envelope.data as SubAgentUpsertPayload);
          break;
        case "snapshot.required":
          invalidateOfficeAndAgentDetails();
          break;
        case "hello":
        case "heartbeat":
          break;
      }
    }

    function handleAgentUpsert(payload: AgentUpsertPayload) {
      if (!payload.agent) {
        void queryClient.invalidateQueries({ queryKey: currentOfficeQueryKey });
        return;
      }

      queryClient.setQueryData<AgentActivityList>(currentOfficeQueryKey, (office) => (office ? applyAgentUpsert(office, payload) : office));
      updateAgentDetailQueries((detail) => applyAgentUpsertToDetail(detail, payload));
    }

    function handleActivityUpsert(payload: ActivityUpsertPayload) {
      if (!payload.activity) {
        void queryClient.invalidateQueries({ queryKey: currentOfficeQueryKey });
        return;
      }

      queryClient.setQueryData<AgentActivityList>(currentOfficeQueryKey, (office) =>
        office ? applyActivityUpsertToOffice(office, payload) : office,
      );
      updateAgentDetailQueries((detail) => applyActivityUpsertToDetail(detail, payload));
    }

    function handleSessionUpsert(envelope: RealtimeEnvelope) {
      const payload = envelope.data as SessionUpsertPayload;
      if (!payload.session) {
        invalidateOfficeAndAgentDetails();
        return;
      }

      updateAgentDetailQueries((detail) => (matchesEnvelopeScope(detail, envelope) ? applySessionUpsertToDetail(detail, payload) : detail));
    }

    function handleTurnUpsert(envelope: RealtimeEnvelope) {
      const payload = envelope.data as TurnUpsertPayload;
      if (!payload.turn) {
        invalidateOfficeAndAgentDetails();
        return;
      }

      updateAgentDetailQueries((detail) => (matchesEnvelopeScope(detail, envelope) ? applyTurnUpsertToDetail(detail, payload) : detail));
    }

    function handleTurnCompleted(envelope: RealtimeEnvelope) {
      const payload = envelope.data as TurnUpsertPayload;
      if (!payload.turn) {
        invalidateOfficeAndAgentDetails();
        return;
      }

      updateAgentDetailQueries((detail) =>
        matchesEnvelopeScope(detail, envelope) ? applyTurnCompletedToDetail(detail, payload) : detail,
      );
    }

    function handleActivityCompleted(payload: ActivityUpsertPayload) {
      if (!payload.activity) {
        invalidateOfficeAndAgentDetails();
        return;
      }

      updateAgentDetailQueries((detail) => applyActivityCompletedToDetail(detail, payload));
    }

    function handleSubAgentUpsert(payload: SubAgentUpsertPayload) {
      if (!payload.sub_agent) {
        invalidateOfficeAndAgentDetails();
        return;
      }

      let shouldInvalidateOffice = false;
      queryClient.setQueryData<AgentActivityList>(currentOfficeQueryKey, (office) => {
        if (!office) {
          return office;
        }

        shouldInvalidateOffice = shouldInvalidateOfficeForSubAgentUpsert(office, payload);
        return applySubAgentUpsertToOffice(office, payload);
      });
      if (shouldInvalidateOffice) {
        void queryClient.invalidateQueries({ queryKey: currentOfficeQueryKey });
      }
      updateAgentDetailQueries((detail) => applySubAgentUpsertToDetail(detail, payload));
    }

    function updateAgentDetailQueries(updater: (detail: AgentActivityDetail) => AgentActivityDetail) {
      queryClient
        .getQueryCache()
        .findAll({ predicate: (query) => isAgentDetailQueryKey(query.queryKey, agentDetailPrefix) })
        .forEach((query) => {
          const queryKey = query.queryKey as ReturnType<typeof agentDetailQueryKey>;
          queryClient.setQueryData<AgentActivityDetail>(queryKey, (detail) => (detail ? updater(detail) : detail));
        });
    }

    function invalidateOfficeAndAgentDetails() {
      void queryClient.invalidateQueries({ queryKey: currentOfficeQueryKey });
      void queryClient.invalidateQueries({ predicate: (query) => isAgentDetailQueryKey(query.queryKey, agentDetailPrefix) });
    }

    return () => {
      listeners.forEach(([type, listener]) => {
        eventSource.removeEventListener(type, listener);
      });
      setConnectionState("disconnected");
      eventSource.close();
    };
  }, [agentDetailPrefix, currentOfficeQueryKey, queryClient, sseUrl]);

  return connectionState;
}

function createEventHandler(handleEnvelope: (envelope: RealtimeEnvelope) => void) {
  return (event: MessageEvent) => {
    const envelope = parseRealtimeEnvelope(event);
    if (envelope) {
      handleEnvelope(envelope);
    }
  };
}

function parseRealtimeEnvelope(event: MessageEvent): RealtimeEnvelope | undefined {
  try {
    return JSON.parse(String(event.data)) as RealtimeEnvelope;
  } catch {
    return undefined;
  }
}

function isAgentDetailQueryKey(queryKey: QueryKey, prefix: string): queryKey is ReturnType<typeof agentDetailQueryKey> {
  return Array.isArray(queryKey) && queryKey[0] === prefix;
}

function matchesEnvelopeScope(detail: AgentActivityDetail, envelope: RealtimeEnvelope): boolean {
  const { collector_id, agent_id } = envelope.scope;
  if (collector_id && detail.agent.collector_id !== collector_id) {
    return false;
  }
  if (agent_id && detail.agent.agent_id !== agent_id) {
    return false;
  }
  return true;
}
