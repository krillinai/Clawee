import { createContext, useContext, type ReactNode } from "react";

import { useOfficeSnapshot } from "./useOfficeSnapshot";
import { useRealtimeEvents, type RealtimeConnectionState } from "./useRealtimeEvents";

const RealtimeConnectionContext = createContext<RealtimeConnectionState>("connecting");

type RealtimeProviderProps = {
  children: ReactNode;
};

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const { data } = useOfficeSnapshot();
  const connectionState = useRealtimeEvents(data?.sse_url);

  return <RealtimeConnectionContext.Provider value={connectionState}>{children}</RealtimeConnectionContext.Provider>;
}

export function useRealtimeConnectionState(): RealtimeConnectionState {
  return useContext(RealtimeConnectionContext);
}
